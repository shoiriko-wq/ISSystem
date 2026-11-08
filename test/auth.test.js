/**
 * ISSystem Integration Tests - Authentication API
 * Jest & Supertest を使用した認証エンドポイントの統合テスト
 * 招待コード発行 → 新規教員登録 → ログイン → プロフィール取得 の一連フローを検証
 */

import request from 'supertest';
import app from '../src/app.js';
import { closePool } from './helpers.js';
import { authService, clearLoginLockForTests } from '../src/services/auth.service.js';
import { query } from '../config/database.js';

describe('Auth API Endpoints (/api/auth)', () => {
  // scripts/seed.js に種目されている教務主任アカウントと連動
  const seededAdmin = { staff_code: 'T2026001', password: 'password123' };

  // 実行ごとに衝突しない新規教職員番号
  const newStaffCode = `T99${String(Date.now()).slice(-6)}`;
  const newPassword = 'Password123!';

  let adminToken = '';
  let invitationCode = '';
  let newUserToken = '';

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
    // v3.0.7: 128bit 系 = 32文字16進大写
    expect(res.body.invitation.code).toMatch(/^[0-9A-F]{32}$/);
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
    newUserToken = res.body.token;
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

  // 8b. ユーザー単位ロックアウト (v3.0.7) — サービス直接呼び出し（レート制限はミドルウェアなのでバイパス）
  it('ログイン失敗5回でアカウントが一時ロック (423) となり LOGIN_FAILED が監査記録されること', async () => {
    const target = newStaffCode; // 登録済みユーザー (newPassword)
    const ip = '198.51.100.7';
    for (let i = 0; i < 5; i++) {
      let status = 0;
      try {
        await authService.login(target, 'wrong-password', ip);
      } catch (e) {
        status = e.statusCode;
      }
      expect(status).toBe(401);
    }
    // 6 回目はロック (423)
    let lockStatus = 0;
    try {
      await authService.login(target, newPassword, ip);
    } catch (e) {
      lockStatus = e.statusCode;
    }
    expect(lockStatus).toBe(423);

    // 監査ログ LOGIN_FAILED（reason: bad_password）が 5 件以上記録されていること
    const rows = await query(
      "SELECT count(*)::int AS c FROM audit_logs WHERE action = 'LOGIN_FAILED' AND new_value LIKE '%bad_password%'"
    );
    expect(Number(rows.rows[0].c)).toBeGreaterThanOrEqual(5);

    // 後片付け: ロックを解除してシード状態を維持（成功ログイン相当で Map から除去）
    clearLoginLockForTests(target);
    const okRes = await request(app).post('/api/auth/login').send({ staff_code: target, password: newPassword });
    expect(okRes.statusCode).toBe(200);
  });

  // 9. パスワード変更 (PUT /api/auth/change-password)
  it('PUT /api/auth/change-password - 新パスワードが8文字未満なら 400 になること', async () => {
    const res = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${newUserToken}`)
      .send({ currentPassword: newPassword, newPassword: 'short' });
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('PUT /api/auth/change-password - 現在のパスワードが誤りなら 401 になること', async () => {
    const res = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${newUserToken}`)
      .send({ currentPassword: 'wrong-password', newPassword: 'Password789!' });
    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
  });

  it('PUT /api/auth/change-password - 変更後は新しいパスワードでログインできること', async () => {
    const changeRes = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${newUserToken}`)
      .send({ currentPassword: newPassword, newPassword: 'Password789!' });
    expect(changeRes.statusCode).toBe(200);
    expect(changeRes.body.success).toBe(true);

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ staff_code: newStaffCode, password: 'Password789!' });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.body.user).toHaveProperty('staff_code', newStaffCode);

    // 検証後は元のパスワードへ戻し、シード状態を維持する
    const restoreRes = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', `Bearer ${loginRes.body.token}`)
      .send({ currentPassword: 'Password789!', newPassword: newPassword });
    expect(restoreRes.statusCode).toBe(200);

    const backLoginRes = await request(app)
      .post('/api/auth/login')
      .send({ staff_code: newStaffCode, password: newPassword });
    expect(backLoginRes.statusCode).toBe(200);
  });

  // 8c. v3.0.8 (§15 監査 #5): パスワード照合失敗ログに bcrypt ハッシュが出ないこと
  it('パスワード照合失敗ログは identifier のみ（bcryptハッシュ非露出）', async () => {
    const captured = [];
    const originalWarn = console.warn;
    console.warn = (...args) => {
      captured.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };
    try {
      await expect(authService.login({ staff_code: seededAdmin.staff_code, password: 'definitely-wrong' })).rejects.toMatchObject({ statusCode: 401 });
    } finally {
      console.warn = originalWarn;
    }
    const joined = captured.join('\n');
    expect(joined).toContain(seededAdmin.staff_code);
    // bcrypt ハッシュ ($2b$ / $2a$ / $2y$) がログに含まれてはならない
    expect(joined).not.toMatch(/\$2[aby]\$/);
    // この失敗はロック窓を汚さないよう消す
    clearLoginLockForTests(seededAdmin.staff_code);
  });

  afterAll(async () => {
    await closePool();
  });
});
