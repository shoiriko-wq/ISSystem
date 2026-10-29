/**
 * ISSystem Integration Tests - 招待コード (新規登録・パスワード再設定の共用)
 * 招待コードは発行時点で利用目的が確定せず、ログイン画面でユーザーが目的を選ぶ
 * used_for (REGISTER / PASSWORD_RESET) はコード消費時に記録される
 */

import request from 'supertest';
import app from '../src/app.js';
import { closePool, bearer, loginToken } from './helpers.js';
import { pool } from '../config/database.js';

describe('Invitation code API (/api/auth 招待コード)', () => {
  // 実行ごとに衝突しない教職員番号とパスワード
  const newStaffCode = `T97${String(Date.now()).slice(-6)}`;
  const firstPassword = 'Password111!';
  const secondPassword = 'Password222!';

  let adminToken = '';
  let code1 = '';
  let code2 = '';
  let newUserId = '';

  beforeAll(async () => {
    adminToken = await loginToken(app);
  });

  it('POST /api/auth/generate-invitation - code / expiresAt がトップレベルで返ること', async () => {
    const res = await request(app)
      .post('/api/auth/generate-invitation')
      .set('Authorization', bearer(adminToken))
      .send({});

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    // フロントエンド (main.js) は res.code を参照するため、トップレベルに code が必須
    expect(res.body.code).toMatch(/^[0-9A-F]{8}$/);
    expect(res.body.code).toBe(res.body.invitation.code);
    expect(res.body.expiresAt).toBeTruthy();
    code1 = res.body.code;
  });

  it('POST /api/auth/register-invitation - 招待コードで新規登録できる', async () => {
    const res = await request(app).post('/api/auth/register-invitation').send({
      invitationCode: code1,
      staff_code: newStaffCode,
      name: '招待 新人',
      password: firstPassword,
      department: '１学年',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.staff_code).toBe(newStaffCode);
    newUserId = res.body.user.id || res.body.user._id;
  });

  it('POST /api/auth/reset-password-invitation - 招待コードでパスワードを再設定できる', async () => {
    const gen = await request(app)
      .post('/api/auth/generate-invitation')
      .set('Authorization', bearer(adminToken))
      .send({});
    code2 = gen.body.code;

    const res = await request(app).post('/api/auth/reset-password-invitation').send({
      invitationCode: code2,
      staff_code: newStaffCode,
      newPassword: secondPassword,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user.staff_code).toBe(newStaffCode);
  });

  it('POST /api/auth/login - 再設定した新パスワードでログインできる', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ staff_code: newStaffCode, password: secondPassword });

    expect(res.statusCode).toBe(200);
    expect(res.body.user.staff_code).toBe(newStaffCode);
  });

  it('POST /api/auth/login - 旧パスワードではログインできない', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ staff_code: newStaffCode, password: firstPassword });

    expect(res.statusCode).toBe(401);
  });

  it('POST /api/auth/reset-password-invitation - 消費済みコードは 400', async () => {
    const res = await request(app).post('/api/auth/reset-password-invitation').send({
      invitationCode: code2,
      staff_code: newStaffCode,
      newPassword: 'Password333!',
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/auth/reset-password-invitation - 新規登録で消費されたコードは再設定に流用できない (400)', async () => {
    const res = await request(app).post('/api/auth/reset-password-invitation').send({
      invitationCode: code1,
      staff_code: newStaffCode,
      newPassword: 'Password555!',
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/auth/reset-password-invitation - 未登録の教職員番号は 404', async () => {
    const gen = await request(app)
      .post('/api/auth/generate-invitation')
      .set('Authorization', bearer(adminToken))
      .send({});

    const res = await request(app).post('/api/auth/reset-password-invitation').send({
      invitationCode: gen.body.code,
      staff_code: `T97009999`,
      newPassword: 'Password444!',
    });
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/auth/reset-password-invitation - 8文字未満と項目欠金は 400', async () => {
    const gen = await request(app)
      .post('/api/auth/generate-invitation')
      .set('Authorization', bearer(adminToken))
      .send({});

    const shortRes = await request(app).post('/api/auth/reset-password-invitation').send({
      invitationCode: gen.body.code,
      staff_code: newStaffCode,
      newPassword: 'short',
    });
    expect(shortRes.statusCode).toBe(400);

    const missingRes = await request(app).post('/api/auth/reset-password-invitation').send({
      invitationCode: gen.body.code,
      newPassword: 'Password666!',
    });
    expect(missingRes.statusCode).toBe(400);
  });

  it('DB: used_for が REGISTER / PASSWORD_RESET として記録される', async () => {
    const regRow = await pool.query(
      `SELECT used_for, is_used, used_by_user_id FROM invitation_codes WHERE code = $1`,
      [code1]
    );
    const resetRow = await pool.query(
      `SELECT used_for, is_used, used_by_user_id FROM invitation_codes WHERE code = $1`,
      [code2]
    );

    expect(regRow.rows[0].used_for).toBe('REGISTER');
    expect(regRow.rows[0].is_used).toBe(1);
    expect(resetRow.rows[0].used_for).toBe('PASSWORD_RESET');
    expect(resetRow.rows[0].used_by_user_id).toBe(newUserId);
  });

  afterAll(async () => {
    // テスト用の仮アカウントを削除し、シードデータを汚さない
    if (newUserId) {
      await request(app).delete(`/api/users/${newUserId}`).set('Authorization', bearer(adminToken));
    }
    await closePool();
  });
});
