/**
 * 校内行事予定 API 統合テスト (schedules)
 * 月別カレンダー範囲取得 → 行事作成 → 本日タイムライン → 削除 を検証する
 */
import request from 'supertest';
import app from '../src/app.js';
import { loginToken, bearer, pickId, closePool } from './helpers.js';

describe('Schedule API (/api/schedules)', () => {
  const targetDate = '2027-02-15';
  let token;
  let scheduleId = null;

  beforeAll(async () => {
    token = await loginToken(app);
  });

  afterAll(async () => {
    if (scheduleId) {
      await request(app).delete(`/api/schedules/${scheduleId}`).set('Authorization', bearer(token));
    }
  });

  it('GET /api/schedules?year=2027&month=2 - 月範囲が 2027-02-01〜2027-02-28 に補正されること', async () => {
    const res = await request(app).get('/api/schedules?year=2027&month=2').set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.startDate).toBe('2027-02-01');
    expect(res.body.endDate).toBe('2027-02-28');
    expect(res.body.data.every((s) => s.event_date >= '2027-02-01' && s.event_date <= '2027-02-28')).toBe(true);
    expect(res.body.data.every((s) => 'created_by_avatar' in s)).toBe(true);
  });

  it('POST /api/schedules - 行事を 201 で登録できること', async () => {
    const res = await request(app)
      .post('/api/schedules')
      .set('Authorization', bearer(token))
      .send({
        title: 'Jest確認行事',
        description: 'カレンダー検証用',
        event_date: targetDate,
        start_time: '10:00',
        end_time: '11:00',
        category: 'EVENT',
      });
    expect(res.statusCode).toBe(201);
    scheduleId = pickId(res.body);
    expect(scheduleId).toBeTruthy();
    expect(res.body.schedule.title).toBe('Jest確認行事');
  });

  it('GET /api/schedules - 作成行事が created_by_name / created_by_avatar を伴って月別一覧に出ること', async () => {
    const res = await request(app).get('/api/schedules?year=2027&month=2').set('Authorization', bearer(token));
    const created = res.body.schedules.find((s) => s.id === scheduleId);
    expect(created).toBeTruthy();
    expect('created_by_avatar' in created).toBe(true);
    expect(created.created_by_name).toBeTruthy();
  });

  it('GET /api/schedules/today?date= - 指定日のタイムラインに登録行事が含まれること', async () => {
    const res = await request(app)
      .get(`/api/schedules/today?date=${targetDate}`)
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body.timeline)).toBe(true);
    expect(res.body.timeline.some((t) => t.title === 'Jest確認行事')).toBe(true);
  });

  it('DELETE /api/schedules/:id - 行事を削除して月別一覧から消せること', async () => {
    const res = await request(app).delete(`/api/schedules/${scheduleId}`).set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    scheduleId = null;

    const afterRes = await request(app).get('/api/schedules?year=2027&month=2').set('Authorization', bearer(token));
    expect(afterRes.body.schedules.some((s) => s.title === 'Jest確認行事')).toBe(false);
  });
});

/**
 * 部署カテゴリ (プロフィール部署マスタ・複数カテゴリ登録・フィルタ・教務部 KYOMU 権限) を検証する
 */
describe('Schedule categories (/api/schedules/categories)', () => {
  const adminCreds = { staff_code: 'T2026000', password: 'password123' };
  const targetDate = '2027-03-10';
  const COLOR_KEYS = ['ACCENT', 'SUCCESS', 'WARNING', 'INFO', 'PURPLE', 'SLATE', 'DANGER'];

  let kyomuToken;
  let adminToken;
  let baseCatId = null;   // seed 済みのカテゴリ
  let otherCatId = null;  // 作成行事に紐付けないカテゴリ
  let newCatId = null;    // 教務部 (KYOMU) が作成したテスト用部署カテゴリ
  let eventId = null;

  const monthQuery = (ids) =>
    `/api/schedules?year=2027&month=3${ids ? `&categoryIds=${ids}` : ''}`;

  beforeAll(async () => {
    kyomuToken = await loginToken(app);
    adminToken = await loginToken(app, adminCreds);
  });

  afterAll(async () => {
    if (eventId) {
      await request(app).delete(`/api/schedules/${eventId}`).set('Authorization', bearer(kyomuToken));
    }
    if (newCatId) {
      await request(app).delete(`/api/schedules/categories/${newCatId}`).set('Authorization', bearer(kyomuToken));
    }
  });

  it('GET /api/schedules/categories - 色キー・並び・使用行事件数を持つこと', async () => {
    const res = await request(app).get('/api/schedules/categories').set('Authorization', bearer(kyomuToken));
    expect(res.statusCode).toBe(200);
    const cats = res.body.categories;
    expect(Array.isArray(cats) && cats.length > 0).toBe(true);
    expect(cats.every((c) => Number.isInteger(c.id) && c.name && COLOR_KEYS.includes(c.color_key))).toBe(true);
    expect(cats.every((c) => Number.isInteger(c.sort_order) && Number.isInteger(c.event_count))).toBe(true);
    baseCatId = cats[0].id;
    otherCatId = cats[1].id;
    expect(baseCatId).not.toBe(otherCatId);
  });

  it('POST /api/schedules/categories - 部署マスタは教務部限定 (ADMIN は 403)', async () => {
    const res = await request(app)
      .post('/api/schedules/categories')
      .set('Authorization', bearer(adminToken))
      .send({ name: 'JEST権限確認', color_key: 'PURPLE' });
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/schedules/categories - 教務部 (KYOMU) は新規部署カテゴリを作成できること (名前は12文字以内)', async () => {
    const tooLong = await request(app)
      .post('/api/schedules/categories')
      .set('Authorization', bearer(kyomuToken))
      .send({ name: 'カテ'.repeat(13), color_key: 'PURPLE' });
    expect(tooLong.statusCode).toBe(400);

    const res = await request(app)
      .post('/api/schedules/categories')
      .set('Authorization', bearer(kyomuToken))
      .send({ name: 'JESTcat', color_key: 'PURPLE', sort_order: 90 });
    expect(res.statusCode).toBe(201);
    newCatId = res.body.category.id;
    expect(newCatId).toEqual(expect.any(Number));
    expect(res.body.category.name).toBe('JESTcat');
    expect(res.body.category.color_key).toBe('PURPLE');
  });

  it('POST /api/schedules - category_ids で複数カテゴリを登録できること', async () => {
    const res = await request(app)
      .post('/api/schedules')
      .set('Authorization', bearer(kyomuToken))
      .send({
        title: 'Jest複数カテゴリ行事',
        description: 'カテゴリフィルタ検証',
        event_date: targetDate,
        category_ids: [baseCatId, newCatId],
      });
    expect(res.statusCode).toBe(201);
    eventId = pickId(res.body);
    expect(eventId).toBeTruthy();
    const ids = res.body.schedule.categoryIds.map((n) => Number(n)).sort((a, b) => a - b);
    expect(ids).toEqual([baseCatId, newCatId].sort((a, b) => a - b));
    expect(res.body.schedule.categoryNames.length).toBe(2);
  });

  it('GET /api/schedules?categoryIds= - OR 条件で該当行事のみ返すこと', async () => {
    const without = await request(app).get(monthQuery(otherCatId)).set('Authorization', bearer(kyomuToken));
    expect(without.body.data.some((s) => s.id === eventId)).toBe(false);

    const byBase = await request(app).get(monthQuery(baseCatId)).set('Authorization', bearer(kyomuToken));
    expect(byBase.body.data.some((s) => s.id === eventId)).toBe(true);

    const byNew = await request(app).get(monthQuery(newCatId)).set('Authorization', bearer(kyomuToken));
    expect(byNew.body.data.some((s) => s.id === eventId)).toBe(true);

    const multi = await request(app).get(monthQuery(`${otherCatId},${newCatId}`)).set('Authorization', bearer(kyomuToken));
    expect(multi.body.data.some((s) => s.id === eventId)).toBe(true);

    const all = await request(app).get(monthQuery(null)).set('Authorization', bearer(kyomuToken));
    const created = all.body.data.find((s) => s.id === eventId);
    expect(created).toBeTruthy();
    expect(created.categoryIds.length).toBe(2);
    expect(created.categoryNames.length).toBe(2);
    expect(created.categoryNames.every((n) => typeof n === 'string')).toBe(true);
  });

  it('PUT /api/schedules/:id - カテゴリ紐付けを差し替えできること', async () => {
    const res = await request(app)
      .put(`/api/schedules/${eventId}`)
      .set('Authorization', bearer(kyomuToken))
      .send({ category_ids: [newCatId] });
    expect(res.statusCode).toBe(200);
    expect(res.body.schedule.categoryIds.map((n) => Number(n))).toEqual([newCatId]);

    const afterBase = await request(app).get(monthQuery(baseCatId)).set('Authorization', bearer(kyomuToken));
    expect(afterBase.body.data.some((s) => s.id === eventId)).toBe(false);

    const afterNew = await request(app).get(monthQuery(newCatId)).set('Authorization', bearer(kyomuToken));
    expect(afterNew.body.data.some((s) => s.id === eventId)).toBe(true);
  });

  it('DELETE /api/schedules/categories/:id - 教務部 (KYOMU) のみ削除できること', async () => {
    const forbidden = await request(app)
      .delete(`/api/schedules/categories/${newCatId}`)
      .set('Authorization', bearer(adminToken));
    expect(forbidden.statusCode).toBe(403);

    const ok = await request(app)
      .delete(`/api/schedules/categories/${newCatId}`)
      .set('Authorization', bearer(kyomuToken));
    expect(ok.statusCode).toBe(200);

    const after = await request(app).get('/api/schedules/categories').set('Authorization', bearer(kyomuToken));
    expect(after.body.categories.some((c) => c.id === newCatId)).toBe(false);

    const afterEvents = await request(app).get(monthQuery(null)).set('Authorization', bearer(kyomuToken));
    const created = afterEvents.body.data.find((s) => s.id === eventId);
    expect(created.categoryIds.some((n) => Number(n) === newCatId)).toBe(false);
    newCatId = null;
  });
});


// プールはファイル最後で一度だけ閉じる (複数 describe で共有)
afterAll(async () => {
  await closePool();
});
