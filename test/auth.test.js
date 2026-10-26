/**
 * ISSystem Integration Tests - Authentication API
 * Jest & Supertest を使用した認証エンドポイントの統合テスト
 * 招待コード発行 → 新規教員登録 → ログイン → プロフィール取得 の一連フローを検証
 */

import request from 'supertest';
import app from '../src/app.js';
import { closePool } from './helpers.js';

describe('Auth API Endpoints (/api/auth)', () => {
  // scripts/seed.js に種目されている教務主任アカウントと連動
  const seededAdmin = { staff_code: 'T2026001', password: 'password123' };

  // 実行ごとに衝突しない新規教職員番号
  const newStaffCode = `T99${String(Date.now()).slice(-6)}`;
  const newPassword = 'Password123!';

  let adminToken = '';
  let invitationCode = '';

  // 1. 既存教員アカウントでのログイン
  it('POST /api/auth/login - 既存教員アカウントでJWTを取得できること', async () => {
    const res = await request(app).post('/api/auth/login').send(seededAdmin);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toHaveProperty('staff_code', seededAdmin.staff_code);
    adminToken = res.body.token;
  });

  // 2. プロフィール取得
  it('GET /api/auth/me - JWTトークンを使用してプロフィールを取得できること', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${adminToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.user).toHaveProperty('staff_code', seededAdmin.staff_code);
  });

  // 3. 招待コード発行
  it('POST /api/auth/generate-invitation - 教員が自主分散招待コードを発行できること', async () => {
    const res = await request(app)
      .post('/api/auth/generate-invitation')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});

    expect(res.statusCode).toBe(201);
    expect(res.body.invitation.code).toMatch(/^[0-9A-F]{8}$/);
    invitationCode = res.body.invitation.code;
  });

  // 4. 招待コードによる新規教員登録
  it('POST /api/auth/register-invitation - 招待コードで新規教員を登録できること', async () => {
    const res = await request(app).post('/api/auth/register-invitation').send({
      invitationCode,
      staff_code: newStaffCode,
      password: newPassword,
      name: 'テスト 太郎',
    });

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.token).toBeTruthy();
    expect(res.body.user).toHaveProperty('staff_code', newStaffCode);
  });

  // 5. 登録直後の新規アカウントでログイン
  it('POST /api/auth/login - 登録直後の新規アカウントでログインできること', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ staff_code: newStaffCode, password: newPassword });

    expect(res.statusCode).toBe(200);
    expect(res.body.user).toHaveProperty('staff_code', newStaffCode);
    expect(res.body.user.name).toBe('テスト 太郎');
  });

  // 6. 招待コード消費後の再利用拒否と重複登録拒否
  it('POST /api/auth/register-invitation - 消費済み招待コードは 400、既存教職員番号は 409', async () => {
    const reuseRes = await request(app).post('/api/auth/register-invitation').send({
      invitationCode,
      staff_code: `T98${String(Date.now()).slice(-6)}`,
      password: newPassword,
    });
    expect(reuseRes.statusCode).toBe(400);

    const newInv = await request(app)
      .post('/api/auth/generate-invitation')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({});
    expect(newInv.statusCode).toBe(201);

    const dupRes = await request(app).post('/api/auth/register-invitation').send({
      invitationCode: newInv.body.invitation.code,
      staff_code: newStaffCode,
      password: newPassword,
    });
    expect(dupRes.statusCode).toBe(409);
  });

  // 7. 未認証アクセス
  it('GET /api/auth/me - トークンなしの場合 401 エラーを返すこと', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.statusCode).toBe(401);
  });

  // 8. 誤ったパスワード (旧バグ: console.warn の inputHash 参照で 500 化していた)
  it('POST /api/auth/login - 誤ったパスワードは 401 で返ること', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ staff_code: 'T2026001', password: 'wrong-password' });
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  afterAll(async () => {
    await closePool();
  });
});
