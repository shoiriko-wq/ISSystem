/**
 * ISSystem Integration Tests - Authentication API
 * Jest & Supertest を使用した認証エンドポイントの統合テスト
 */

import request from 'supertest';
import app from '../src/app.js';

describe('Auth API Endpoints (/api/auth)', () => {
  const testUser = {
    email: 'test_teacher@school.ed.jp',
    password: 'Password123!',
    name: 'テスト太郎',
    role: 'TEACHER',
  };

  let token = '';

  // 1. 新規ユーザー登録テスト
  it('POST /api/auth/register - ユーザーを正常に登録できること', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send(testUser);

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.user).toHaveProperty('email', testUser.email);
  });

  // 2. ログインテスト
  it('POST /api/auth/login - 正しい資格情報でJWTを取得できること', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({
        email: testUser.email,
        password: testUser.password,
      });

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('token');
    token = res.body.token; // 他のテスト用にトークンを保存
  });

  // 3. プロフィール取得テスト
  it('GET /api/auth/me - JWTトークンを使用してプロフィールを取得できること', async () => {
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.user).toHaveProperty('email', testUser.email);
  });

  // 4. 未認証アクセスエラーテスト
  it('GET /api/auth/me - トークンなしの場合 401 エラーを返すこと', async () => {
    const res = await request(app).get('/api/auth/me');

    expect(res.statusCode).toBe(401);
  });
});