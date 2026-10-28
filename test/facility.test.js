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
});
