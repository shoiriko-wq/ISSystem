/**
 * 掲示板・回覧板 API 統合テスト (bulletins)
 * 投稿作成 → コメント → 既読 → 電子承認のフローを検証する
 */
import request from 'supertest';
import app from '../src/app.js';
import { loginToken, bearer, pickId, closePool } from './helpers.js';

describe('Bulletin API (/api/bulletins)', () => {
  let token;
  let bulletinId = null;

  beforeAll(async () => {
    token = await loginToken(app);
  });

  afterAll(async () => {
    await closePool();
  });

  it('GET /api/bulletins - 回覧板一覧が返ること', async () => {
    const res = await request(app).get('/api/bulletins').set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(3);
    expect(res.body.data.some((p) => p.id === 'post_1')).toBe(true);
    expect(res.body.data.every((p) => ('author_avatar' in p) || ('authorAvatar' in p))).toBe(true);
  });

  it('GET /api/bulletins/post_1 - 詳細と既読・確認率統計を取得できること', async () => {
    const res = await request(app).get('/api/bulletins/post_1').set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.data.id).toBe('post_1');
    expect(res.body.data.title).toContain('教務部');
    expect(Array.isArray(res.body.data.acknowledgements)).toBe(true);
    expect(Array.isArray(res.body.data.comments)).toBe(true);
    expect(typeof res.body.data.ack_percentage).toBe('number');
    expect(res.body.data.target_user_count).toBeGreaterThan(0);
  });

  it('POST /api/bulletins - 新規投稿を 201 で作成できること', async () => {
    const res = await request(app)
      .post('/api/bulletins')
      .set('Authorization', bearer(token))
      .send({
        title: 'Jest確認回覧',
        content: 'テストによる自動生成投稿',
        post_type: 'NOTICE',
        priority: 'NORMAL',
      });
    expect(res.statusCode).toBe(201);
    bulletinId = pickId(res.body);
    expect(bulletinId).toBeTruthy();
    expect(res.body.data.title).toBe('Jest確認回覧');
  });

  it('POST /api/bulletins - 件名・本文欠落は 400', async () => {
    const res = await request(app)
      .post('/api/bulletins')
      .set('Authorization', bearer(token))
      .send({ title: '本文なし' });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain('必須');
  });

  it('POST /api/bulletins/:id/comments - コメントを 201 で登録できること', async () => {
    const res = await request(app)
      .post(`/api/bulletins/${bulletinId}/comments`)
      .set('Authorization', bearer(token))
      .send({ comment: 'Jest確認コメント' });
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('PUT /api/bulletins/post_1/read - 既読状態を更新できること', async () => {
    const res = await request(app)
      .put('/api/bulletins/post_1/read')
      .set('Authorization', bearer(token))
      .send({ status: 'READ' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('PUT /api/bulletins/:id/approve - 電子承認を 200 で登録できること', async () => {
    const res = await request(app)
      .put(`/api/bulletins/${bulletinId}/approve`)
      .set('Authorization', bearer(token))
      .send({ approved: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/bulletins/:id - 存在しない投稿は 404', async () => {
    const res = await request(app)
      .get('/api/bulletins/ghost-post')
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(404);
  });
});
