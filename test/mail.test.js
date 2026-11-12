/**
 * メール接続設定 + 接続テスト API 統合テスト (mail)
 * 設定保存 → フォーム値プレテスト → 保存済み設定テスト (status 更新) → 削除 を検証する
 * ※ テストサーバー名は存在しないドメイン (issystem.example) なので接続テストは必ず失敗する
 */
import request from 'supertest';
import app from '../src/app.js';
import { setProbeOverrides } from '../src/services/mail.service.js';
import { parseMessage } from '../src/services/mail.transport.js';
import { loginToken, bearer, closePool } from './helpers.js';

describe('Mail API (/api/mail)', () => {
  let token;

  const settings = {
    email_address: 'mail.test@issystem.example',
    password: 'mail-secret-123',
    imap_host: 'imap.issystem.example',
    imap_port: 993,
    smtp_host: 'smtp.issystem.example',
    smtp_port: 465,
  };

  beforeAll(async () => {
    token = await loginToken(app);
    // 残存設定があれば消して初回 (needs_setup) 状態に戻す
    await request(app).delete('/api/mail/account').set('Authorization', bearer(token));
  });

  afterAll(async () => {
    await request(app).delete('/api/mail/account').set('Authorization', bearer(token));
  });

  it('GET /api/mail/account - 未設定は needs_setup: true で .env プリフィルが返ること', async () => {
    const res = await request(app).get('/api/mail/account').set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.account.needs_setup).toBe(true);
    expect(res.body.account.password).toBeUndefined();
  });

  it('POST /api/mail/account - 設定を 201 で保存し status は UNVERIFIED', async () => {
    const res = await request(app)
      .post('/api/mail/account')
      .set('Authorization', bearer(token))
      .send(settings);
    expect(res.statusCode).toBe(201);
    expect(res.body.account.email_address).toBe('mail.test@issystem.example');
    expect(res.body.account.status).toBe('UNVERIFIED');
    expect(JSON.stringify(res.body)).not.toContain('mail-secret-123');
  });

  it('POST /api/mail/test - 未保存フォーム値のプレテストは失敗 (status は DB に書き込まない)', async () => {
    const res = await request(app)
      .post('/api/mail/test')
      .set('Authorization', bearer(token))
      .send({
        email_address: 'probe.test@issystem.example',
        password: 'probe-secret-123',
        imap_host: 'imap.issystem.example',
        imap_port: 993,
        smtp_host: 'smtp.issystem.example',
        smtp_port: 465,
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('FAILED');
    expect(res.body.imap.ok).toBe(false);
    expect(res.body.smtp.ok).toBe(false);
    expect(typeof res.body.imap.message).toBe('string');
    // プレテストは DB の status を変えない
    const after = await request(app).get('/api/mail/account').set('Authorization', bearer(token));
    expect(after.body.account.status).toBe('UNVERIFIED');
    expect(JSON.stringify(res.body)).not.toContain('probe-secret-123');
  });

  it('POST /api/mail/test - 保存済み設定のテストは status=FAILED を DB へ保存する', async () => {
    const res = await request(app).post('/api/mail/test').set('Authorization', bearer(token)).send({});
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('FAILED');
    expect(res.body.account.status).toBe('FAILED');
    expect(res.body.message).toContain('接続テスト');

    const after = await request(app).get('/api/mail/account').set('Authorization', bearer(token));
    expect(after.body.account.status).toBe('FAILED');
    expect(after.body.account.last_checked_at).toBeTruthy();
  });

  it('POST /api/mail/test - 接続成功時は status=VERIFIED になる (プローブを成功へ差し替えて検証)', async () => {
    const succeed = async () => ({ ok: true, message: 'mock 接続成功' });
    setProbeOverrides({ imap: succeed, smtp: succeed });

    try {
      const res = await request(app).post('/api/mail/test').set('Authorization', bearer(token)).send({});
      expect(res.statusCode).toBe(200);
      expect(res.body.status).toBe('VERIFIED');
      expect(res.body.imap.ok).toBe(true);
      expect(res.body.smtp.ok).toBe(true);
      expect(res.body.account.status).toBe('VERIFIED');

      const after = await request(app).get('/api/mail/account').set('Authorization', bearer(token));
      expect(after.body.account.status).toBe('VERIFIED');
      expect(after.body.account.last_checked_at).toBeTruthy();
    } finally {
      setProbeOverrides({});
    }
  });

  it('POST /api/mail/test - 未設定では 409、不正メールは 400、未認証は 401', async () => {
    const bad = await request(app)
      .post('/api/mail/test')
      .set('Authorization', bearer(token))
      .send({ email_address: 'not-an-email', password: 'mail-secret-123' });
    expect(bad.statusCode).toBe(400);

    await request(app).delete('/api/mail/account').set('Authorization', bearer(token));
    const none = await request(app).post('/api/mail/test').set('Authorization', bearer(token)).send({});
    expect(none.statusCode).toBe(409);
    expect(none.body.error || none.body.message).toContain('登録');

    const noAuth = await request(app).post('/api/mail/test').send({});
    expect(noAuth.statusCode).toBe(401);
  });
});

/**
 * 受信ボックス (POST /api/mail/inbox/refresh)
 * IMAP 取得結果を DB へ書き込む経路。Date ヘッダー欠損・+0900 オフセット・UID 重複を扱う
 */
describe('Mail 受信ボックス (inbox/refresh)', () => {
  let token;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const inboxSettings = {
    email_address: 'mail.test@issystem.example',
    password: 'mail-secret-123',
    imap_host: 'imap.issystem.example',
    imap_port: 993,
    smtp_host: 'smtp.issystem.example',
    smtp_port: 465,
  };
  /** naive TIMESTAMP を格納値 ('YYYY-MM-DD HH:MM:SS' = JST 壁時計) へ正規化する (node の TZ に依存しない) */
  const wall = (value) => {
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('sv-SE').replace('T', ' ');
  };

  const fetchStub = () => [
    {
      uid: '9101',
      seen: false,
      raw: `From: 山田 太郎 <yamada@issystem.example>\r\nSubject: =?UTF-8?B?${b64('ユーザー2')}?=\r\nDate: Mon, 12 Nov 2026 10:00:00 +0900\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nhello`,
      internaldate: '12 Nov 2026 09:00:00 +0900',
    },
    {
      uid: '9102',
      seen: true,
      raw: 'From: B <b@x.jp>\r\nSubject: no date\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nbody',
      internaldate: '11 Nov 2026 12:00:00 +0900',
    },
    {
      uid: '9103',
      seen: false,
      raw: 'Subject: sender missing\r\nDate: 2026-11-12T12:00:00+09:00\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\nx',
      internaldate: '12 Nov 2026 12:00:00 +0900',
    },
  ];

  beforeAll(async () => {
    token = await loginToken(app);
    const created = await request(app).post('/api/mail/account').set('Authorization', bearer(token)).send(inboxSettings);
    expect(created.statusCode).toBe(201);
  });

  afterAll(async () => {
    setProbeOverrides({});
    await request(app).delete('/api/mail/account').set('Authorization', bearer(token));
    await closePool();
  });

  it('Date ヘッダー欠損メールでも 500 にならず受信日時が埋まる (INTERNALDATE フォールバック)', async () => {
    setProbeOverrides({ fetch: fetchStub });

    const res = await request(app).post('/api/mail/inbox/refresh').set('Authorization', bearer(token)).send({});
    expect(res.statusCode).toBe(200);
    expect(res.body.fetched).toBe(3);
    expect(res.body.added).toBe(3);

    const byUid = Object.fromEntries(res.body.messages.map((m) => [m.uid, m]));
    expect(byUid['9101'].sender_name).toBe('山田 太郎');
    expect(byUid['9101'].sender_email).toBe('yamada@issystem.example');
    expect(byUid['9101'].subject).toBe('ユーザー2');
    expect(byUid['9101'].body).toBe('hello');
    expect(byUid['9101'].is_read).toBe(false);
    // +0900 を絶対時刻として扱う (V8 の Date.parse はオフセットを無視して UTC 扱いにすることがある)
    expect(wall(byUid['9101'].received_at)).toBe('2026-11-12 10:00:00');

    // Date ヘッダーが無いメールは INTERNALDATE を受信日時へ使う
    expect(wall(byUid['9102'].received_at)).toBe('2026-11-11 12:00:00');
    expect(byUid['9102'].is_read).toBe(true);

    // 差出人欠損はアカウントアドレスで埋まる (sender_email / sender_name は NOT NULL)
    expect(byUid['9103'].sender_email).toBe('mail.test@issystem.example');
    expect(byUid['9103'].sender_name).toBe('mail.test@issystem.example');
    expect(wall(byUid['9103'].received_at)).toBe('2026-11-12 12:00:00');

    expect(res.body.unread).toBe(2);
  });

  it('既読・未読は IMAP の \Seen フラグが優先される (DB 既定値は未読)', async () => {
    const res = await request(app).get('/api/mail/messages?folder=inbox').set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.unread).toBe(2);
    expect(res.body.messages.find((m) => m.uid === '9102').is_read).toBe(true);
  });

  it('再取得は既存 UID を重複登録しない (uniqueMailMessagesUid で防御)', async () => {
    const res = await request(app).post('/api/mail/inbox/refresh').set('Authorization', bearer(token)).send({});
    expect(res.statusCode).toBe(200);
    expect(res.body.fetched).toBe(3);
    expect(res.body.added).toBe(0);
    expect(res.body.messages.length).toBe(3);
  });


  it('IMAP 取得失敗は 502 で返る (500 にならない)', async () => {
    setProbeOverrides({ fetch: async () => { throw new Error('IMAP 接続に失敗しました'); } });
    const res = await request(app).post('/api/mail/inbox/refresh').set('Authorization', bearer(token)).send({});
    expect(res.statusCode).toBe(502);
    setProbeOverrides({});
  });
});

/** RFC822 解析の単体検証 (UI が期待するキー名・Date ヘッダー解析・INTERNALDATE フォールバック) */
describe('parseMessage (mail.transport)', () => {
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

  it('差出人・件名・本文・受信日時を UI 用のキー名 (sender_name / sender_email / received_at) で返す', () => {
    const parsed = parseMessage(`From: 山田 太郎 <yamada@issystem.example>\r\nSubject: =?UTF-8?B?${b64('ユーザー2')}?=\r\nDate: Mon, 12 Nov 2026 10:00:00 +0900\r\n\r\nhello`);
    expect(parsed.sender_name).toBe('山田 太郎');
    expect(parsed.sender_email).toBe('yamada@issystem.example');
    expect(parsed.subject).toBe('ユーザー2');
    expect(parsed.body).toBe('hello');
    // V8 の Date.parse は "+0900" を無視して UTC 扱いにすることがあるため自前でオフセットを反映する
    expect(parsed.received_at).toBe('2026-11-12T01:00:00.000Z');
  });

  it('Date ヘッダー欠損は internaldate をフォールバックへ使う', () => {
    const parsed = parseMessage('From: B <b@x.jp>\r\nSubject: no date\r\n\r\nbody', '11 Nov 2026 12:00:00 +0900');
    expect(parsed.sender_name).toBe('B');
    expect(parsed.received_at).toBe('2026-11-11T03:00:00.000Z');
  });

  it('Date ヘッダーも internaldate も無ければ received_at は null (モデル側でサーバー時刻へ埋める)', () => {
    const parsed = parseMessage('From: a@x.jp\r\nSubject: x\r\n\r\nbody');
    expect(parsed.received_at).toBeNull();
  });

  it('GMT 表記のオフセットも扱う', () => {
    expect(parseMessage('Date: Mon, 12 Nov 2026 10:00:00 GMT\r\n\r\nx').received_at).toBe('2026-11-12T10:00:00.000Z');
  });
});

