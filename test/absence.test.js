/**
 * ISSystem Integration Tests - 年休等・出張 (Absence) API
 * Supertest を使用した /api/absences エンドポイントと教務・管理職権限の統合テスト
 */

import request from 'supertest';
import app from '../src/app.js';
import { query, closeDatabase } from '../src/utils/db.js';

describe('Absence API Endpoints (/api/absences)', () => {
  // 既存シードデータと衝突しない未来日を検証用に使用
  const TEST_DATE = '2099-01-01';
  const PASSWORD = 'password123';

  let kyomuToken = '';
  let teacherToken = '';
  let kyomuUser = null;
  let teacherUser = null;
  let leaveRecordId = null;

  const login = async (staffCode) => request(app).post('/api/auth/login').send({ staff_code: staffCode, password: PASSWORD });

  // 教務主任 (KYOMU) と一般教員 (TEACHER) のトークンを取得
  beforeAll(async () => {
    await query('DELETE FROM absence_records WHERE record_date = ?', [TEST_DATE]);

    const k = await login('T2026001');
    const t = await login('T2026002');
    kyomuToken = k.body.token;
    teacherToken = t.body.token;
    kyomuUser = k.body.user;
    teacherUser = t.body.user;
  });

  // テスト期間のデータと監査ログを掃除して DB を元に戻す
  afterAll(async () => {
    await query('DELETE FROM absence_records WHERE record_date = ?', [TEST_DATE]);
    await query("DELETE FROM system_audit_logs WHERE target = 'ABSENCE_RECORD'");
    await closeDatabase();
  });

  // 1. 未認証アクセス
  it('GET /api/absences - トークンなしは 401 になること', async () => {
    const res = await request(app).get('/api/absences');
    expect(res.statusCode).toBe(401);
  });

  // 2. 教務主任によるサマリー取得 (空日)
  it('GET /api/absences?date= - 教務主任は can_record と区分別人数を取得できること', async () => {
    const res = await request(app).get(`/api/absences?date=${TEST_DATE}`).set('Authorization', `Bearer ${kyomuToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.date).toBe(TEST_DATE);
    expect(res.body.counts).toEqual({ LEAVE: 0, TRIP: 0 });
    expect(res.body.can_record).toBe(true);
    expect(res.body.labels).toEqual({ LEAVE: '年休等', TRIP: '出張' });
  });

  // 3. 教務主任は他教員分を記入可能
  it('POST /api/absences - 教務主任は他教員の「年休等」を登録できること', async () => {
    const res = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ user_id: teacherUser.id, record_type: 'LEAVE', record_date: TEST_DATE, reason: '年休（テスト登録）' });

    expect(res.statusCode).toBe(201);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body.record).toHaveProperty('user_name', teacherUser.name);
    expect(res.body.record).toHaveProperty('recorded_by_name', kyomuUser.name);
    leaveRecordId = res.body.record.id;
  });

  // 4. 一般教員による他教員分の記入拒否
  it('POST /api/absences - 一般教員が他教員分を記入しようすると 422 になること', async () => {
    const res = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ user_id: kyomuUser.id, record_type: 'TRIP', record_date: TEST_DATE });

    expect(res.statusCode).toBe(422);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body.message).toContain('権限');
  });

  // 5. 一般教員は自分の分だけ記入可能
  it('POST /api/absences - 一般教員は自分の「出張」を登録できること', async () => {
    const res = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ user_id: teacherUser.id, record_type: 'TRIP', record_date: TEST_DATE, reason: '研修会（テスト登録）' });

    expect(res.statusCode).toBe(201);
    expect(res.body.record).toHaveProperty('record_type', 'TRIP');
    expect(res.body.record).toHaveProperty('record_type_label', '出張');
    expect(res.body.record).toHaveProperty('user_id', teacherUser.id);
  });

  // 6. バリデーション
  it('POST /api/absences - 不正な区分・日付は 400 になること', async () => {
    const badType = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ user_id: teacherUser.id, record_type: 'SICK', record_date: TEST_DATE });
    expect(badType.statusCode).toBe(400);

    const badDate = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ user_id: teacherUser.id, record_type: 'LEAVE', record_date: '2099-13-01' });
    expect(badDate.statusCode).toBe(400);

    const missingUser = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ record_type: 'LEAVE', record_date: TEST_DATE });
    expect(missingUser.statusCode).toBe(400);
  });

  // 7. 区分別人数の集計
  it('GET /api/absences?date= - LEAVE と TRIP がそれぞれ計上されること', async () => {
    const res = await request(app).get(`/api/absences?date=${TEST_DATE}`).set('Authorization', `Bearer ${kyomuToken}`);

    expect(res.body.counts).toEqual({ LEAVE: 1, TRIP: 1 });
    expect(res.body.records).toHaveLength(2);
    const leave = res.body.records.find((r) => r.record_type === 'LEAVE');
    expect(leave).toHaveProperty('record_type_label', '年休等');
    expect(leave).toHaveProperty('user_name', teacherUser.name);
  });

  // 8. 教員セレクトの選択可否
  it('GET /api/absences/teachers - 教務主任は全教員選択可、一般教員は自分のみ選択可であること', async () => {
    const k = await request(app).get('/api/absences/teachers').set('Authorization', `Bearer ${kyomuToken}`);
    expect(k.statusCode).toBe(200);
    expect(k.body.teachers.length).toBeGreaterThan(1);
    expect(k.body.teachers.every((t) => t.selectable)).toBe(true);

    const t = await request(app).get('/api/absences/teachers').set('Authorization', `Bearer ${teacherToken}`);
    const selectableIds = t.body.teachers.filter((x) => x.selectable).map((x) => x.id);
    expect(selectableIds).toEqual([teacherUser.id]);
  });

  // 9. 一般教員による他教員分の取消拒否
  it('DELETE /api/absences/:id - 一般教員は他教員分を取消できないこと', async () => {
    const created = await request(app)
      .post('/api/absences')
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ user_id: kyomuUser.id, record_type: 'LEAVE', record_date: TEST_DATE, reason: '教務主任の年休（テスト）' });
    kyomuRecordId = created.body.record.id;

    const res = await request(app).delete(`/api/absences/${kyomuRecordId}`).set('Authorization', `Bearer ${teacherToken}`);

    expect(res.statusCode).toBe(422);
    expect(res.body).toHaveProperty('success', false);
    expect(res.body.message).toContain('権限');
  });

  // 10. 自分の分と教務による取消
  it('DELETE /api/absences/:id - 本人分・教務主任の取消は成功すること', async () => {
    const list = await request(app).get(`/api/absences?date=${TEST_DATE}`).set('Authorization', `Bearer ${teacherToken}`);
    const trip = list.body.records.find((r) => r.record_type === 'TRIP');

    const mine = await request(app).delete(`/api/absences/${trip.id}`).set('Authorization', `Bearer ${teacherToken}`);
    expect(mine.statusCode).toBe(200);
    expect(mine.body).toHaveProperty('success', true);

    const byKyomu = await request(app).delete(`/api/absences/${leaveRecordId}`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(byKyomu.statusCode).toBe(200);

    const kyomuSelf = await request(app).delete(`/api/absences/${kyomuRecordId}`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(kyomuSelf.statusCode).toBe(200);

    const finalRes = await request(app).get(`/api/absences?date=${TEST_DATE}`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(finalRes.body.counts).toEqual({ LEAVE: 0, TRIP: 0 });
    expect(finalRes.body.records).toHaveLength(0);
  });

  // 11. 存在しないレコード
  it('DELETE /api/absences/:id - 存在しない ID は 404 になること', async () => {
    const res = await request(app).delete('/api/absences/abs_999999').set('Authorization', `Bearer ${kyomuToken}`);
    expect(res.statusCode).toBe(404);
    expect(res.body).toHaveProperty('success', false);
  });
});

