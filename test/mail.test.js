/**
 * メール接続設定 + 接続テスト API 統合テスト (mail)
 * 設定保存 → フォーム値プレテスト → 保存済み設定テスト (status 更新) → 削除 を検証する
 * ※ テストサーバー名は存在しないドメイン (issystem.example) なので接続テストは必ず失敗する
 */
import request from 'supertest';
import app from '../src/app.js';
import { setProbeOverrides } from '../src/services/mail.service.js';
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
    await closePool();
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
