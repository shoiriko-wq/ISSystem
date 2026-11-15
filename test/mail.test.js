/**
 * メール接続設定 + 接続テスト API 統合テスト (mail)
 * 設定保存 → フォーム値プレテスト → 設定メニューのテスト (account_id + フォーム値で status 更新) → 保存済み設定テスト (status 更新) → 削除 を検証する
 * ※ テストサーバー名は存在しないドメイン (issystem.example) なので接続テストは必ず失敗する
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import app from '../src/app.js';
import { setProbeOverrides } from '../src/services/mail.service.js';
import mailService from '../src/services/mail.service.js';
import mailModel from '../src/models/mail.model.js';
import { query } from '../config/database.js';
import { onlineUserIds } from '../src/utils/presence.js';
import { parseMessage } from '../src/services/mail.transport.js';
import { loginToken, bearer, closePool } from './helpers.js';
import config from '../config/default.js';
import { makeIdleHarness } from './mail.idle.mock.js';

describe('Mail API (/api/mail)', () => {
  let token;
  let accountId = null;

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
    accountId = res.body.account.id;
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

  it('POST /api/mail/test - account_id 付きのフォーム値テスト（メール設定メニュー内の接続テスト）は成否をそのアカウントの status へ保存する', async () => {
    // 直前のテストで status=VERIFIED になっている。到達不能サーバーのフォーム値テストで FAILED へ更新されることを実測する
    const res = await request(app)
      .post('/api/mail/test')
      .set('Authorization', bearer(token))
      .send({
        account_id: accountId,
        email_address: 'mail.test@issystem.example',
        password: 'mail-secret-123',
        imap_host: 'imap.issystem.example',
        imap_port: 993,
        smtp_host: 'smtp.issystem.example',
        smtp_port: 465,
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('FAILED');
    expect(res.body.account?.status).toBe('FAILED');
    expect(JSON.stringify(res.body)).not.toContain('mail-secret-123');

    const after = await request(app).get('/api/mail/account').set('Authorization', bearer(token));
    expect(after.body.account.status).toBe('FAILED');
    expect(after.body.account.last_checked_at).toBeTruthy();
  });

  it('POST /api/mail/test - 他人の account_id 付きフォーム値テストは status を書き換えない', async () => {
    const res = await request(app)
      .post('/api/mail/test')
      .set('Authorization', bearer(token))
      .send({
        account_id: 'someone-else-account',
        email_address: 'probe.test@issystem.example',
        password: 'probe-secret-123',
        imap_host: 'imap.issystem.example',
        imap_port: 993,
        smtp_host: 'smtp.issystem.example',
        smtp_port: 465,
      });
    expect(res.statusCode).toBe(200);
    expect(res.body.status).toBe('FAILED');
    expect(res.body.account).toBeUndefined();

    const after = await request(app).get('/api/mail/account').set('Authorization', bearer(token));
    expect(after.body.account.status).toBe('FAILED'); // 自分（1件目）の status は変わらない
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
 * メール送信 (POST /api/mail/send)
 * SMTP 成功形 (文字列 / { ok, message }) を両方受け取り、成功時は送信ボックスへ記録し、
 * 失敗時は 502 と日本語メッセージ (undefined を出さない) で送信ボックスへ記録を残さない
 */
describe('Mail 送信 (POST /api/mail/send)', () => {
  let token;
  const sendSettings = {
    email_address: 'send.test@issystem.example',
    password: 'send-secret-123',
    imap_host: 'imap.issystem.example',
    imap_port: 993,
    smtp_host: 'smtp.issystem.example',
    smtp_port: 465,
  };

  const sendBody = (over = {}) => ({
    to: 'teacher1@issystem.example',
    subject: '出欠確認',
    body: '5時間目の教室へ',
    ...over,
  });

  const sentSubjects = async () => {
    const res = await request(app).get('/api/mail/messages?folder=sent').set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    return res.body.messages.map((m) => m.subject);
  };

  beforeAll(async () => {
    token = await loginToken(app);
    const created = await request(app).post('/api/mail/account').set('Authorization', bearer(token)).send(sendSettings);
    expect(created.statusCode).toBe(201);
  });

  afterAll(async () => {
    setProbeOverrides({});
    await request(app).delete('/api/mail/account').set('Authorization', bearer(token));
  });

  it('プローブが文字列を返す実装 (smtpSend の成功形) でも 201 になり、送信ボックスへ記録される', async () => {
    setProbeOverrides({
      send: async () => 'SMTP 送信完了 (mock): 宛先 1 件',
      append: async () => true,
    });

    const res = await request(app).post('/api/mail/send').set('Authorization', bearer(token)).send(sendBody());
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.message).toBe('送信しました。');
    expect(res.body.message_row.folder).toBe('sent');
    expect(res.body.message_row.subject).toBe('出欠確認');
    expect(res.body.message_row.recipients).toEqual(['teacher1@issystem.example']);

    expect(await sentSubjects()).toContain('出欠確認');
  });

  it('プローブが { ok: true, message } を返す形でも 201 になる (成功形の両対応)', async () => {
    setProbeOverrides({
      send: async () => ({ ok: true, message: 'mock 送信完了' }),
      append: async () => true,
    });

    const res = await request(app)
      .post('/api/mail/send')
      .set('Authorization', bearer(token))
      .send(sendBody({ subject: '両対応検証' }));
    expect(res.statusCode).toBe(201);
    expect(res.body.message_row.subject).toBe('両対応検証');
    expect(await sentSubjects()).toContain('両対応検証');
  });

  it('プローブが ok:false を返すと 502 で応答メッセージが付き、送信ボックスへ記録が残らない', async () => {
    setProbeOverrides({
      send: async () => ({ ok: false, message: 'SMTP 認証失敗 (code=535)' }),
      append: async () => true,
    });

    const res = await request(app)
      .post('/api/mail/send')
      .set('Authorization', bearer(token))
      .send(sendBody({ subject: '未送信' }));
    expect(res.statusCode).toBe(502);
    expect(res.body.error || res.body.message).toContain('SMTP 認証失敗');
    expect(res.body.error || res.body.message).not.toContain('undefined');

    expect(await sentSubjects()).not.toContain('未送信');
  });

  it('プローブが空虚値を返しても 502 の応答に undefined が出ない', async () => {
    setProbeOverrides({ send: async () => undefined, append: async () => true });

    const res = await request(app)
      .post('/api/mail/send')
      .set('Authorization', bearer(token))
      .send(sendBody({ subject: '空虚値' }));
    expect(res.statusCode).toBe(502);
    const text = res.body.error || res.body.message;
    expect(text).toContain('送信に失敗しました');
    expect(text).not.toContain('undefined');

    expect(await sentSubjects()).not.toContain('空虚値');
  });

  it('SMTP 送信の例外 (DNS・接続) は 502 で日本語メッセージがそのまま出る', async () => {
    setProbeOverrides({
      send: async () => { throw new Error('SMTP: サーバーへ到達できません。'); },
      append: async () => true,
    });

    const res = await request(app)
      .post('/api/mail/send')
      .set('Authorization', bearer(token))
      .send(sendBody({ subject: 'DNS失敗' }));
    expect(res.statusCode).toBe(502);
    expect(res.body.error || res.body.message).toContain('サーバーへ到達できません');

    expect(await sentSubjects()).not.toContain('DNS失敗');
  });

  it('送信済みフォルダへの APPEND 失敗は送信成功を消さない (201 + 警告文)', async () => {
    setProbeOverrides({
      send: async () => ({ ok: true, message: 'mock 送信完了' }),
      append: async () => { throw new Error('フォルダ「Sent」を開けません'); },
    });

    const res = await request(app)
      .post('/api/mail/send')
      .set('Authorization', bearer(token))
      .send(sendBody({ subject: '警告付き' }));
    expect(res.statusCode).toBe(201);
    expect(res.body.message).toContain('送信しました');
    expect(res.body.message).toContain('送信済みフォルダに保存できませんでした');
    expect(await sentSubjects()).toContain('警告付き');
  });

  it('件名・本文未入力は 400 で送信しない', async () => {
    setProbeOverrides({ send: async () => ({ ok: true, message: 'mock' }), append: async () => true });

    const noSubject = await request(app).post('/api/mail/send').set('Authorization', bearer(token)).send(sendBody({ subject: '' }));
    expect(noSubject.statusCode).toBe(400);
    const noBody = await request(app).post('/api/mail/send').set('Authorization', bearer(token)).send(sendBody({ body: '' }));
    expect(noBody.statusCode).toBe(400);
  });

  it('未認証では 401', async () => {
    const noAuth = await request(app).post('/api/mail/send').send(sendBody());
    expect(noAuth.statusCode).toBe(401);
  });
});

/**
 * 返信・転送 (POST /api/mail/send に reply_to_id / reply_mode を添える)
 * In-Reply-To / References ヘッダー、\Answered /\Forwarded、監査コード、IMAP best-effort を検証する
 */
describe('Mail 返信・転送 (reply / forward)', () => {
  let token;
  let userId;
  let accountId;
  let sourceId;
  const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
  const replySettings = {
    email_address: 'reply.test@issystem.example',
    password: 'reply-secret-123',
    imap_host: 'imap.issystem.example',
    imap_port: 993,
    smtp_host: 'smtp.issystem.example',
    smtp_port: 465,
  };
  const srcRaw = [
    'From: 田中 <tanaka@issystem.example>',
    'To: reply.test@issystem.example',
    `Subject: =?UTF-8?B?${b64('出欠確認')}?=`,
    'Date: Mon, 12 Nov 2026 10:00:00 +0900',
    'Message-ID: <src-1@issystem.example>',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64('5時間目の教室へ'),
  ].join('\r\n');

  const flagsOf = async (id) => String((await mailModel.getMessageById(id, userId))?.imap_flags || '');
  const lastAudit = async (targetId) => {
    const res = await query('SELECT action FROM audit_logs WHERE resource_id = ? ORDER BY id DESC LIMIT 1', [targetId]);
    return res.rows[0]?.action ?? null;
  };

  beforeAll(async () => {
    token = await loginToken(app);
    const created = await request(app).post('/api/mail/account').set('Authorization', bearer(token)).send(replySettings);
    expect(created.statusCode).toBe(201);
    accountId = created.body.account.id;
    const me = await request(app).get('/api/auth/me').set('Authorization', bearer(token));
    userId = String(me.body.user?.id ?? me.body.id);
    // 返信・転送元メールを IMAP 受信経路でDBへ入れる (Message-ID を mail_messages へ保存する)
    setProbeOverrides({ fetch: async () => [{ uid: '9201', seen: true, raw: srcRaw, internaldate: '12 Nov 2026 10:00:00 +0900' }] });
    const refreshed = await request(app).post('/api/mail/inbox/refresh').set('Authorization', bearer(token)).send({});
    expect(refreshed.statusCode).toBe(200);
    sourceId = refreshed.body.messages.find((m) => m.uid === '9201').id;
  });

  afterAll(async () => {
    setProbeOverrides({});
    await request(app).delete('/api/mail/account').set('Authorization', bearer(token));
  });

  it('受信メールの Message-ID が DB へ保存される', async () => {
    const row = await mailModel.getMessageById(sourceId, userId);
    expect(row.message_id).toBe('<src-1@issystem.example>');
    expect(row.uid).toBe('9201');
  });

  it('返信は In-Reply-To を付け、返信元へ \\Answered を付け、監査 MAIL_REPLY を残す', async () => {
    const captured = [];
    setProbeOverrides({
      send: async (params) => { captured.push(params.raw); return { ok: true, message: 'mock 送信完了' }; },
      append: async () => true,
      setKeywords: async () => true,
    });

    const res = await request(app).post('/api/mail/send').set('Authorization', bearer(token)).send({
      to: 'tanaka@issystem.example',
      subject: 'Re: 出欠確認',
      body: 'はい、行きます',
      reply_to_id: sourceId,
      reply_mode: 'reply',
    });
    expect(res.statusCode).toBe(201);
    expect(res.body.message).toBe('返信を送信しました。');
    expect(captured[0]).toContain('In-Reply-To: <src-1@issystem.example>');
    expect(res.body.message_row.in_reply_to).toBe('<src-1@issystem.example>');
    expect(await flagsOf(sourceId)).toContain('\\Answered');
    expect(await lastAudit(res.body.message_row.id)).toBe('MAIL_REPLY');
  });

  it('転送は References にスレッド連鎖を付け、転送元へ \\Forwarded を付け、監査 MAIL_FORWARD を残す', async () => {
    const captured = [];
    setProbeOverrides({
      send: async (params) => { captured.push(params.raw); return { ok: true, message: 'mock 送信完了' }; },
      append: async () => true,
      setKeywords: async () => true,
    });

    const res = await request(app).post('/api/mail/send').set('Authorization', bearer(token)).send({
      to: 'suzuki@issystem.example',
      subject: 'Fwd: 出欠確認',
      body: '共有します',
      reply_to_id: sourceId,
      reply_mode: 'forward',
    });
    expect(res.statusCode).toBe(201);
    expect(res.body.message).toBe('転送を送信しました。');
    expect(captured[0]).toContain('In-Reply-To: <src-1@issystem.example>');
    expect(captured[0]).toContain('References: <src-1@issystem.example>');
    expect(await flagsOf(sourceId)).toContain('\\Forwarded');
    expect(await flagsOf(sourceId)).toContain('\\Answered'); // 既存の返信マークは保持される
    expect(await lastAudit(res.body.message_row.id)).toBe('MAIL_FORWARD');
  });

  it('IMAP のマーク付け失敗は送信成功を消さない (201 + 警告、DB のマークは残る)', async () => {
    setProbeOverrides({
      send: async () => ({ ok: true, message: 'mock 送信完了' }),
      append: async () => { throw new Error('フォルダ「Sent」を開けません'); },
      setKeywords: async () => { throw new Error('IMAP: サーバーへ到達できません。'); },
    });

    const res = await request(app).post('/api/mail/send').set('Authorization', bearer(token)).send({
      to: 'tanaka@issystem.example',
      subject: 'Re: 出欠確認',
      body: '追送',
      reply_to_id: sourceId,
      reply_mode: 'reply',
    });
    expect(res.statusCode).toBe(201);
    expect(res.body.message).toContain('返信を送信しました。');
    expect(res.body.message).toContain('送信済みフォルダに保存できませんでした');
    expect(res.body.message).toContain('マークを付けられませんでした');
    expect(await flagsOf(sourceId)).toContain('\\Answered');
  });

  it('返信元が無ければ 404、reply_mode が無ければ 400 で送信ボックスへ記録しない', async () => {
    setProbeOverrides({ send: async () => ({ ok: true, message: 'mock' }), append: async () => true, setKeywords: async () => true });

    const missing = await request(app).post('/api/mail/send').set('Authorization', bearer(token)).send({
      to: 'tanaka@issystem.example', subject: 'Re: 不存在', body: 'x', reply_to_id: 'mail_missing', reply_mode: 'reply',
    });
    expect(missing.statusCode).toBe(404);

    const noMode = await request(app).post('/api/mail/send').set('Authorization', bearer(token)).send({
      to: 'tanaka@issystem.example', subject: 'Re: 形式なし', body: 'x', reply_to_id: sourceId,
    });
    expect(noMode.statusCode).toBe(400);

    const sent = await request(app).get('/api/mail/messages?folder=sent').set('Authorization', bearer(token));
    const subjects = sent.body.messages.map((m) => m.subject);
    expect(subjects).not.toContain('Re: 不存在');
    expect(subjects).not.toContain('Re: 形式なし');
  });
});


/**
 * 受信ボックス (POST /api/mail/inbox/refresh)
 * IMAP 取得結果を DB へ書き込む経路。Date ヘッダー欠損・+0900 オフセット・UID 重複を扱う
 */
describe('Mail 受信ボックス (inbox/refresh)', () => {
  let token;
  let userId;
  let accountId;
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

  // ---- IMAP IDLE ハーネス (常時接続の openInbox / newEnvelopes / 本文 lazy を差し替える) ----
  // io.to(room).emit(event, payload) を記録するモック (to() の room 引数を捕まえないと room が undefined になる)
  const makeIo = () => {
    const emitted = [];
    return { emitted, to(room) { return { room, emit(event, payload) { emitted.push({ room, event, payload }); } } } };
  };
  const counters = { openInbox: 0, newEnvelopes: 0, bodyText: 0, attachmentBytes: 0 };
  const state = { exists: 0, uidNext: 1, maxUid: 0, lineQueue: [], envelopeQueue: {}, body: {}, attachment: {}, counters };
  const env = (uid, subject) => ({
    uid: String(uid),
    sender_name: '山田 太郎',
    sender_email: 'yamada@issystem.example',
    subject,
    date: '2026-11-12T01:00:00.000Z',
    is_html: false,
    attachments: [{ name: 'report.pdf', section: '1.2', type: 'application/pdf' }],
  });
  const harness = makeIdleHarness(state);
  const harnessOpenInbox = harness.openInbox;
  const harnessNewEnvelopes = harness.newEnvelopes;
  const harnessBodyText = harness.bodyText;
  const harnessAttachmentBytes = harness.attachmentBytes;
  const settle = async (ms = 300) => { await new Promise((r) => setTimeout(r, ms)); };

  beforeAll(async () => {
    token = await loginToken(app);
    const created = await request(app).post('/api/mail/account').set('Authorization', bearer(token)).send(inboxSettings);
    expect(created.statusCode).toBe(201);
    accountId = created.body.account.id;
    // user_id はアカウント表示 (toView) に含まれないため /api/auth/me から取る
    const me = await request(app).get('/api/auth/me').set('Authorization', bearer(token));
    userId = String(me.body.user?.id ?? me.body.id);
    console.log('[beforeAll] userId=', userId, 'accountId=', accountId);
  });

  afterAll(async () => {
    mailService.resetActiveWatch();
    setProbeOverrides({});
    await request(app).delete('/api/mail/account').set('Authorization', bearer(token));
    await closePool();
  });

  it('Date ヘッダー欠損メールでも 500 にならず受信日時が埋まる (INTERNALDATE フォールバック)', async () => {
    setProbeOverrides({ fetch: fetchStub, openInbox: harnessOpenInbox, bodyText: harnessBodyText });
    state.body['9101'] = { body: 'hello', html_stripped: false };

    const res = await request(app).post('/api/mail/inbox/refresh').set('Authorization', bearer(token)).send({});
    expect(res.statusCode).toBe(200);
    expect(res.body.fetched).toBe(3);
    expect(res.body.added).toBe(3);

    const byUid = Object.fromEntries(res.body.messages.map((m) => [m.uid, m]));
    expect(byUid['9101'].sender_name).toBe('山田 太郎');
    expect(byUid['9101'].sender_email).toBe('yamada@issystem.example');
    expect(byUid['9101'].subject).toBe('ユーザー2');
    // 一覧はヘッダのみ返す (本文は SELECT 外。本文は詳細閲覧時の lazy 取得、30日超は cron で本文だけ消す)
    expect(byUid['9101'].body).toBe('');
    expect(byUid['9101'].is_read).toBe(false);
    // +0900 を絶対時刻として扱う (V8 の Date.parse はオフセットを無視して UTC 扱いにすることがある)
    expect(wall(byUid['9101'].received_at)).toBe('2026-11-12 10:00:00');

    // 詳細閲覧の lazy 取得 (GET /api/mail/messages/:id/body) は本文を返す
    const lazy = await request(app).get(`/api/mail/messages/${byUid['9101'].id}/body`).set('Authorization', bearer(token));
    expect(lazy.statusCode).toBe(200);
    expect(lazy.body.body).toBe('hello');

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

  /**
   * Mail 常時接続 (IMAP IDLE) アクティブユーザ プル監査 + lazy 取得 (2026/11/13)
   * 接続中のユーザのアカウントだけ常時 IMAP IDLE セッションを開き、新着は EXIST で
   * 増長を確認してヘッダだけ UPSERT し、変化のあったアカウントだけ user:<id> へ通知する。
   * 本文・添付は開封/ダウンロード時に lazy 取得する。
   */
  describe('Mail 常時接続 (IMAP IDLE) アクティブユーザ プル監査 + lazy 取得', () => {
    const listAccountsForUser = async (uid) => {
      const rows = await request(app).get('/api/mail/account').set('Authorization', bearer(token));
      const account = rows.body.account;
      if (!account) return [];
      return [{
        id: accountId, user_id: uid, email_address: account.email_address,
        imap_host: account.imap_host, imap_port: account.imap_port, imap_tls: account.imap_tls,
        imap_folder: 'INBOX', smtp_host: account.smtp_host, smtp_port: account.smtp_port,
        smtp_tls: account.smtp_tls, smtp_use_imap: true, account,
      }];
    };
    // ハーネスの差し替えは beforeAll で行う (前段のテストが setProbeOverrides({}) でリセットするため、
    // describe 本体で登録すると 502 テストの後に消されて常時接続テストが実接続試行になる)
    beforeAll(async () => {
      setProbeOverrides({
        openInbox: harnessOpenInbox,
        newEnvelopes: harnessNewEnvelopes,
        bodyText: harnessBodyText,
        attachmentBytes: harnessAttachmentBytes,
      });
    });

    afterAll(async () => {
      mailService.resetActiveWatch();
      setProbeOverrides({});
    });

    it('接続中のユーザのアカウントだけ常時 IDLE セッションを開く (cron reconcile が開始/停止)', async () => {
      state.exists = 0; state.uidNext = 1; state.maxUid = 0; state.lineQueue = [];
      const io = makeIo();
      mailService.resetActiveWatch();
      onlineUserIds.add(userId);
      const opened = await mailService.reconcileActiveWatchCron(io);
      expect(opened.opened).toEqual([String(accountId)]);
      expect(counters.openInbox).toBe(1);
      onlineUserIds.delete(userId);
      const dropped = await mailService.reconcileActiveWatchCron(io);
      expect(dropped.dropped).toEqual([String(userId)]);
      expect(counters.openInbox).toBe(1);
      mailService.ensureActiveWatchForUser(userId, makeIo());
      await settle(300);
      expect(counters.openInbox).toBe(2);
    });

    it('常時 IDLE で EXIST 増長を検知してヘッダだけ UPSERT → user ルームへ mail:new_messages', async () => {
      const io = makeIo();
      setProbeOverrides({ openInbox: harnessOpenInbox, newEnvelopes: harnessNewEnvelopes, bodyText: harnessBodyText });
      // 前テストの常時接続を閉じてから新しい io で開き直す (watch は作成時の io へ emit するため、
      // 既存 watch を使い回すとこの io.emitted が空になる)
      mailService.resetActiveWatch();
      onlineUserIds.add(userId);
      mailService.ensureActiveWatchForUser(userId, io);
      await settle(300);
      const before = counters.newEnvelopes;
      state.envelopeQueue['1001'] = env(1001, '新着1');
      state.envelopeQueue['1002'] = env(1002, '新着2');
      state.exists = 2; state.uidNext = 3;
      state.lineQueue.push('* 2 EXISTS');
      await settle(300);
      expect(counters.newEnvelopes).toBeGreaterThanOrEqual(before + 1);
      expect(io.emitted.length).toBeGreaterThanOrEqual(1);
      expect(io.emitted[0].room).toBe(`user:${userId}`);
      expect(io.emitted[0].event).toBe('mail:new_messages');
      expect(io.emitted[0].payload.account_id).toBe(accountId);
      expect(io.emitted[0].payload.added).toBe(2);
      expect(io.emitted[0].payload.newest_subject).toBe('新着2');

      const listRes = await request(app).get('/api/mail/messages?folder=inbox').set('Authorization', bearer(token));
      expect(listRes.statusCode).toBe(200);
      // 前段の inbox/refresh テストが同アカウントへ 3件登録済みのため 2件ちょうどにはならない (新着2件の存在で検証)
      expect(listRes.body.messages.length).toBeGreaterThanOrEqual(2);
      expect(listRes.body.messages.find((m) => m.uid === '1001').subject).toBe('新着1');
      expect(listRes.body.messages.find((m) => m.uid === '1002').subject).toBe('新着2');

      const msg = listRes.body.messages.find((m) => m.uid === '1001');
      state.body['1001'] = { body: 'hello world', html_stripped: false };
      const bodyRes = await request(app).post(`/api/mail/messages/${msg.id}/body`).set('Authorization', bearer(token)).send({});
      expect(bodyRes.statusCode).toBe(200);
      expect(bodyRes.body.message.body).toBe('hello world');
      expect(bodyRes.body.message.html_stripped).toBe(false);
      const bodyAgain = await request(app).post(`/api/mail/messages/${msg.id}/body`).set('Authorization', bearer(token)).send({});
      expect(bodyAgain.body.message.body).toBe('hello world');
      expect(counters.bodyText).toBe(1);

      state.attachment['1.2'] = Buffer.from('PDFBYTES');
      const attRes = await request(app).get(`/api/mail/messages/${msg.id}/attachment?section=1.2`).set('Authorization', bearer(token));
      expect(attRes.statusCode).toBe(200);
      expect(Buffer.from(attRes.body).toString('utf8')).toBe('PDFBYTES');
      const attMissing = await request(app).get(`/api/mail/messages/${msg.id}/attachment?section=9`).set('Authorization', bearer(token));
      expect(attMissing.statusCode).toBe(404);

      mailService.dropWatchForUser(userId);
      onlineUserIds.delete(userId);
      const dropped = await mailService.reconcileActiveWatchCron(io);
      expect(dropped.dropped).toHaveLength(0);

      const cleaned = await mailService.cleanupBodies();
      expect(cleaned.removed).toBe(0);
    });

    it('cron 照合・再接続窓・cron パターン・設定が想定値である', async () => {
      const io = makeIo();
      state.exists = 0; state.uidNext = 1; state.maxUid = 0; state.lineQueue = [];
      mailService.resetActiveWatch();
      onlineUserIds.add(userId);
      const opened = await mailService.reconcileActiveWatchCron(io);
      expect(opened.opened).toEqual([String(accountId)]);
      mailService.resetActiveWatch();
      onlineUserIds.delete(userId);
      const closed = await mailService.reconcileActiveWatchCron(io);
      expect(closed.opened).toHaveLength(0);

      // モジュール実体は src/services と src/models に置く (配置崩れ防止の実測)
      const serviceFiles = readdirSync(path.resolve('src/services'));
      expect(serviceFiles).toContain('mail.transport.js');
      expect(serviceFiles).toContain('mail.service.js');
      expect(readdirSync(path.resolve('src/models'))).toContain('mail.model.js');
      expect(readdirSync(path.resolve('src/controllers'))).toContain('mail.controller.js');
      expect(readdirSync(path.resolve('src/sockets'))).toContain('mail.socket.js');

      const { mailPollCronPattern } = await import('../src/utils/cron.jobs.js');
      expect(mailPollCronPattern(30000)).toBe('*/30 * * * * *');
      expect(mailPollCronPattern(15000)).toBe('*/15 * * * * *');
      expect(mailPollCronPattern(10000)).toBe('*/15 * * * * *');
      expect(mailPollCronPattern(null)).toBe('0 * * * * *');
      expect(config.mail.activeSyncMs).toBe(30000);
      expect(config.mail.bodyCacheDays).toBe(30);
      expect(config.mail.reconnectMaxMs).toBe(1740000);
    });
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

