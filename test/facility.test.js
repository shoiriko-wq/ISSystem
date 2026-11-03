/**
 * 施設・備品予約 API 統合テスト (PostgreSQL 連携)
 * 二重予約の 409 Conflict とソフトキャンセルを検証する
 */
import request from 'supertest';
import app from '../src/app.js';
import { loginToken, bearer, pickId, closePool } from './helpers.js';

let reservationId = null;

const uniqueSlot = {
  facility_id: '3',
  title: 'Jest確認予約',
  target_date: '2027-01-15',
  start_time: '09:00',
  end_time: '10:00',
};

describe('Facility Reservation API (/api/facilities)', () => {
  let token;

  beforeAll(async () => {
    token = await loginToken(app);
  });

  afterAll(async () => {
    await closePool();
  });

  it('GET /api/facilities - 施設・備品マスターを取得できること', async () => {
    const res = await request(app).get('/api/facilities').set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.count).toBeGreaterThanOrEqual(5);
    expect(res.body.facilities.some((f) => f.name === '第一会議室')).toBe(true);
    expect(res.body.facilities.some((f) => f.name === '体育館')).toBe(true);
  });

  it('GET /api/facilities - トークンなしでは 401 になること', async () => {
    const res = await request(app).get('/api/facilities');
    expect(res.statusCode).toBe(401);
  });

  it('GET /api/facilities/daily-overview - 指定日の予約状況を返すこと', async () => {
    const res = await request(app)
      .get('/api/facilities/daily-overview?date=2026-11-20')
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.targetDate).toBe('2026-11-20');
    expect(Array.isArray(res.body.facilitiesOverview)).toBe(true);
    expect(res.body.facilitiesOverview.every((f) => 'facility' in f && 'available' in f)).toBe(true);
  });

  it('POST /api/facilities/reservations - 新規予約を 201 で登録できること', async () => {
    const res = await request(app)
      .post('/api/facilities/reservations')
      .set('Authorization', bearer(token))
      .send(uniqueSlot);
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    reservationId = pickId(res.body);
    expect(reservationId).toBeTruthy();
    expect(res.body.reservation.title).toBe('Jest確認予約');
  });

  it('POST /api/facilities/reservations - 同一時間帯の重複は 409 Conflict', async () => {
    const res = await request(app)
      .post('/api/facilities/reservations')
      .set('Authorization', bearer(token))
      .send(uniqueSlot);
    expect(res.statusCode).toBe(409);
    expect(res.body.success).toBe(false);
    expect(res.body.message).toContain('重複');
  });

  it('GET /api/facilities/:facilityId/reservations - 登録した予約が日付範囲で返ること', async () => {
    const res = await request(app)
      .get('/api/facilities/3/reservations?date=2027-01-15')
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.reservations.some((r) => r.id === reservationId)).toBe(true);
    expect(res.body.reservations.every((r) => 'avatar_url' in r)).toBe(true);
  });

  it('DELETE /api/facilities/reservations/:id - 予約をキャンセルできること', async () => {
    const res = await request(app)
      .delete(`/api/facilities/reservations/${reservationId}`)
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/facilities/reservations - 終了時刻が開始時刻以前なら 400', async () => {
    const res = await request(app)
      .post('/api/facilities/reservations')
      .set('Authorization', bearer(token))
      .send({ ...uniqueSlot, start_time: '11:00', end_time: '10:00' });
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/facilities/reservations - キャンセル後同じ時間帯は再予約可能', async () => {
    const res = await request(app)
      .post('/api/facilities/reservations')
      .set('Authorization', bearer(token))
      .send({ ...uniqueSlot, title: 'Jest再予約' });
    expect(res.statusCode).toBe(201);
    const reId = pickId(res.body);
    await request(app).delete(`/api/facilities/reservations/${reId}`).set('Authorization', bearer(token));
  });

  describe('施設・備品マスタ CRUD (教務部 KYOMU)', () => {
    const FACILITY_NAME = 'Jest検証部屋';

    it('POST /api/facilities - 施設を追加できる（教務部）', async () => {
      const res = await request(app)
        .post('/api/facilities')
        .set('Authorization', bearer(token))
        .send({ name: FACILITY_NAME, category: 'ROOM' });
      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.facility.name).toBe(FACILITY_NAME);
      expect(res.body.facility.id).toBeTruthy();
    });

    it('POST /api/facilities - 同名の追加は 409', async () => {
      const res = await request(app)
        .post('/api/facilities')
        .set('Authorization', bearer(token))
        .send({ name: FACILITY_NAME, category: 'ROOM' });
      expect(res.statusCode).toBe(409);
      expect(res.body.success).toBe(false);
    });

    it('POST /api/facilities - 教務部以外 (TEACHER) は 403', async () => {
      const teacherToken = await loginToken(app, { staff_code: 'T2026002', password: 'password123' });
      const res = await request(app)
        .post('/api/facilities')
        .set('Authorization', bearer(teacherToken))
        .send({ name: 'Jest権限確認部屋', category: 'ROOM' });
      expect(res.statusCode).toBe(403);
      expect(res.body.message).toContain('教務');
    });

    it('POST /api/facilities - 空名・未定義カテゴリは 400', async () => {
      const empty = await request(app)
        .post('/api/facilities')
        .set('Authorization', bearer(token))
        .send({ name: '   ', category: 'ROOM' });
      expect(empty.statusCode).toBe(400);

      const badCat = await request(app)
        .post('/api/facilities')
        .set('Authorization', bearer(token))
        .send({ name: 'Jestカテゴリ確認', category: 'NOT_A_CATEGORY' });
      expect(badCat.statusCode).toBe(400);
    });

    it('PUT /api/facilities/:id - 改名が予約表示へ反映される', async () => {
      const list = await request(app).get('/api/facilities').set('Authorization', bearer(token));
      const created = list.body.facilities.find((f) => f.name === FACILITY_NAME);
      expect(created).toBeTruthy();

      const renames = await request(app)
        .put(`/api/facilities/${created.id}`)
        .set('Authorization', bearer(token))
        .send({ name: 'Jest検証会議室', category: 'SPECIAL' });
      expect(renames.statusCode).toBe(200);
      expect(renames.body.facility.name).toBe('Jest検証会議室');
      expect(renames.body.facility.category).toBe('SPECIAL');

      const after = await request(app).get('/api/facilities').set('Authorization', bearer(token));
      expect(after.body.facilities.some((f) => f.name === 'Jest検証会議室')).toBe(true);
      expect(after.body.facilities.some((f) => f.name === FACILITY_NAME)).toBe(false);
    });

    it('DELETE /api/facilities/:id - 有効予約が残ると 409、キャンセル後は削除できる', async () => {
      const list = await request(app).get('/api/facilities').set('Authorization', bearer(token));
      const target = list.body.facilities.find((f) => f.name === 'Jest検証会議室');
      expect(target).toBeTruthy();

      const book = await request(app)
        .post('/api/facilities/reservations')
        .set('Authorization', bearer(token))
        .send({
          facility_id: target.id,
          title: 'Jestマスタ削除確認',
          target_date: '2027-02-20',
          start_time: '13:00',
          end_time: '14:00',
        });
      expect(book.statusCode).toBe(201);

      const blocked = await request(app)
        .delete(`/api/facilities/${target.id}`)
        .set('Authorization', bearer(token));
      expect(blocked.statusCode).toBe(409);
      expect(blocked.body.success).toBe(false);

      const bookId = pickId(book.body);
      await request(app)
        .delete(`/api/facilities/reservations/${bookId}`)
        .set('Authorization', bearer(token));

      const removed = await request(app)
        .delete(`/api/facilities/${target.id}`)
        .set('Authorization', bearer(token));
      expect(removed.statusCode).toBe(200);
      expect(removed.body.success).toBe(true);

      const after = await request(app).get('/api/facilities').set('Authorization', bearer(token));
      expect(after.body.facilities.some((f) => f.id === target.id)).toBe(false);
    });

    it('DELETE /api/facilities/:id - 存在しない施設は 404', async () => {
      const res = await request(app)
        .delete('/api/facilities/does-not-exist')
        .set('Authorization', bearer(token));
      expect(res.statusCode).toBe(404);
    });
  });
});
