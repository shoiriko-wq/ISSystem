/**
 * 掲示 API 統合テスト (bulletins)
 * 投稿作成 → コメント → 既読 → 電子承認のフローを検証する
 * ※ 区分 (post_type)・優先度 (priority) カラムは撤廃済み
 */
import request from 'supertest';
import app from '../src/app.js';
import { loginToken, bearer, pickId, closePool } from './helpers.js';

describe('Bulletin API (/api/bulletins)', () => {
  let token;
  let bulletinId = null;
  let displayPostId = null;
  let targetPostId = null;

  beforeAll(async () => {
    token = await loginToken(app);
  });

  afterAll(async () => {
    await closePool();
  });

  it('GET /api/bulletins - 掲示一覧が返ること（区分・優先度カラムは撤廃済み）', async () => {
    const res = await request(app).get('/api/bulletins').set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(3);
    expect(res.body.data.some((p) => p.id === 'post_1')).toBe(true);
    expect(res.body.data.every((p) => ('author_avatar' in p) || ('authorAvatar' in p))).toBe(true);
    expect(res.body.data.every((p) => !('post_type' in p) && !('priority' in p))).toBe(true);
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
        title: 'Jest確認掲示',
        content: 'テストによる自動生成投稿',
      });
    expect(res.statusCode).toBe(201);
    bulletinId = pickId(res.body);
    expect(bulletinId).toBeTruthy();
    expect(res.body.data.title).toBe('Jest確認掲示');
    // 掲示開始日・掲示終了日とも任意。開始日は未指定なら投稿日が既定、終了日は未指定なら null
    expect(res.body.data.display_start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.body.data.display_start_date).toBe(res.body.data.posted_day);
    expect(res.body.data.display_end_date).toBeNull();
  });

  it('POST /api/bulletins - 掲示期間を指定できること（掲示開始日・掲示終了日とも任意）', async () => {
    const res = await request(app)
      .post('/api/bulletins')
      .set('Authorization', bearer(token))
      .send({
        title: '表示期間テスト',
        content: '表示開始日と表示終了日の検証',
        display_start_date: '2026-12-01',
        display_end_date: '2026-12-10',
      });
    expect(res.statusCode).toBe(201);
    displayPostId = pickId(res.body);
    expect(res.body.data.display_start_date).toBe('2026-12-01');
    expect(res.body.data.display_end_date).toBe('2026-12-10');
    expect(res.body.data.displayStart).toBe('2026-12-01');
    expect(res.body.data.displayEnd).toBe('2026-12-10');
  });

  it('POST /api/bulletins - 掲示終了日が掲示開始日より前なら 400', async () => {
    const res = await request(app)
      .post('/api/bulletins')
      .set('Authorization', bearer(token))
      .send({
        title: '掲示期間逆転テスト',
        content: '掲示終了日が掲示開始日より前',
        display_start_date: '2026-12-10',
        display_end_date: '2026-12-01',
      });
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain('掲示終了日');
  });

  it('GET /api/bulletins?display_on_date= - 掲示期間で絞り込めること', async () => {
    const target = '2026-12-05';
    const res = await request(app)
      .get('/api/bulletins')
      .query({ display_on_date: target })
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    // 期間内の投稿が含まれる
    expect(res.body.data.some((p) => p.id === displayPostId)).toBe(true);
    // 期間外の投稿は返らない
    expect(
      res.body.data.every((p) => {
        const start = p.display_start_date;
        const end = p.display_end_date;
        return (!start || start <= target) && (!end || end >= target);
      })
    ).toBe(true);
  });

  it('POST /api/bulletins - 対象日を指定できること（日別表示は対象日に所属）', async () => {
    const targetDay = '2027-01-09';
    const res = await request(app)
      .post('/api/bulletins')
      .set('Authorization', bearer(token))
      .send({
        title: '対象日テスト掲示',
        content: '対象日による日別表示の検証',
        target_date: targetDay,
      });
    expect(res.statusCode).toBe(201);
    targetPostId = pickId(res.body);
    expect(res.body.data.target_date).toBe(targetDay);
    expect(res.body.data.targetDate).toBe(targetDay);

    // 対象日での絞り込みには含まれる（その日の掲示として扱われる）
    const dayRes = await request(app)
      .get('/api/bulletins')
      .query({ target_day: targetDay })
      .set('Authorization', bearer(token));
    expect(dayRes.statusCode).toBe(200);
    expect(dayRes.body.data.some((p) => p.id === targetPostId)).toBe(true);

    // 本日の対象日での絞り込みには含まれない（投稿日が本日でも対象日は 2027-01-09）
    const todayRes = await request(app)
      .get('/api/bulletins')
      .query({ target_day: 'today' })
      .set('Authorization', bearer(token));
    expect(todayRes.statusCode).toBe(200);
    expect(todayRes.body.data.some((p) => p.id === targetPostId)).toBe(false);
  });

  it('POST /api/bulletins - 対象日未指定なら投稿日が対象日になること', async () => {
    const res = await request(app)
      .post('/api/bulletins')
      .set('Authorization', bearer(token))
      .send({ title: '対象日既定化テスト', content: '対象日未指定時の投稿日補完を検証' });
    expect(res.statusCode).toBe(201);
    const id = pickId(res.body);
    expect(res.body.data.target_date).toBe(res.body.data.posted_day);

    const detail = await request(app).get(`/api/bulletins/${id}`).set('Authorization', bearer(token));
    expect(detail.statusCode).toBe(200);
    expect(detail.body.data.target_date).toBe(res.body.data.posted_day);
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

  it('コメントは bulletin_comments に永続化され、詳細取得の comments に返ること', async () => {
    const res = await request(app)
      .get(`/api/bulletins/${bulletinId}`)
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    const found = (res.body.data.comments || []).some((c) => c.comment_text === 'Jest確認コメント');
    expect(found).toBe(true);
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
