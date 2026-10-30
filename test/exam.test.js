/**
 * ISSystem Integration Tests - 定期考査 (Exam) API
 * 教務権限者 (KYOMU) の 6 メニュー操作と一般教員 (TEACHER) の公表閲覧・自己担当操作を検証する
 * サイドメニュー「定期考査」の教務 6 メニューは教務権限者のみ表示される (public/js/modules/exam/exam.module.js)
 */

import request from 'supertest';
import app from '../src/app.js';
import { query, closeDatabase } from '../src/utils/db.js';

describe('Exam API Endpoints (/api/exam)', () => {
  const PASSWORD = 'password123';
  const TEST_TITLE = '統合テスト考査2099';

  let kyomuToken = '';
  let teacherToken = '';
  let kyomuUser = null;
  let teacherUser = null;
  let examId = null;

  const login = (staffCode) => request(app).post('/api/auth/login').send({ staff_code: staffCode, password: PASSWORD });

  /** 作成した考査を cascade 削除し監査ログも掃除する */
  const cleanExam = async () => {
    if (!examId) return;
    await query('DELETE FROM exam_masters WHERE id = ?', [examId]);
    await query('DELETE FROM audit_logs WHERE resource_id = ?', [examId]);
    examId = null;
  };

  const boardOf = (token) => request(app).get(`/api/exam/${examId}/board`).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    await cleanExam();
    const k = await login('T2026001');
    const t = await login('T2026002');
    kyomuToken = k.body.token;
    teacherToken = t.body.token;
    kyomuUser = k.body.user;
    teacherUser = t.body.user;
  });

  afterAll(async () => {
    await cleanExam();
    await closeDatabase();
  });

  // 1. 未認証アクセス
  it('GET /api/exam/masters - トークンなしは 401 になること', async () => {
    const res = await request(app).get('/api/exam/masters');
    expect(res.statusCode).toBe(401);
  });

  // 2. 考査登録は教務権限必須
  it('POST /api/exam - 一般教員は 403（教務権限が必要）であること', async () => {
    const res = await request(app)
      .post('/api/exam')
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ title: TEST_TITLE, start_date: '2099-11-01', end_date: '2099-11-03', days_count: 3, daily_slots: 8, grades: [1, 2, 3] });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('教務権限');
  });

  // 3. 教務による考査登録
  it('POST /api/exam - 教務主任は考査を登録できること', async () => {
    const res = await request(app)
      .post('/api/exam')
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ title: TEST_TITLE, start_date: '2099-11-01', end_date: '2099-11-03', days_count: 3, daily_slots: 8, grades: [1, 2, 3] });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.title).toBe(TEST_TITLE);
    examId = res.body.data.id;
    expect(typeof examId).toBe('string');
  });

  // 4. 権限表示（board.is_kyomu と編集可否フラグ）
  it('GET /api/exam/:id/board - 一般教員は is_kyomu=false で閲覧専用の編集フラグになること', async () => {
    const res = await boardOf(teacherToken);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.is_kyomu).toBe(false);
    expect(res.body.data.editable.subject_kyomu).toBe(false);
    expect(res.body.data.editable.timetable).toBe(false);
    expect(res.body.data.editable.room).toBe(false);
    expect(res.body.data.editable.proctor).toBe(false);
  });

  it('GET /api/exam/:id/board - 教務主任は is_kyomu=true で全作成メニューの編集権限を持つこと', async () => {
    const res = await boardOf(kyomuToken);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.is_kyomu).toBe(true);
    expect(res.body.data.editable.subject_kyomu).toBe(true);
    expect(res.body.data.editable.timetable).toBe(true);
    expect(res.body.data.editable.room).toBe(true);
    expect(res.body.data.editable.proctor).toBe(true);
  });

  // 5. フェーズ制御は教務のみ
  it('POST /api/exam/:id/phase - 一般教員は 403 になること', async () => {
    const res = await request(app)
      .post(`/api/exam/${examId}/phase`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ phase_key: 'subject_phase', phase_value: 'SURVEY' });

    expect(res.statusCode).toBe(403);
  });

  // 6. 実施科目調査の開始（教務のみ）とプラン種付け
  it('POST /api/exam/:id/subject-survey/start - 一般教員は 403 になること', async () => {
    const res = await request(app)
      .post(`/api/exam/${examId}/subject-survey/start`)
      .set('Authorization', `Bearer ${teacherToken}`);

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('教務権限');
  });

  it('POST /api/exam/:id/subject-survey/start - 教務主任は調査を開始し実施科目プランを種付けできること', async () => {
    const res = await request(app)
      .post(`/api/exam/${examId}/subject-survey/start`)
      .set('Authorization', `Bearer ${kyomuToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.subject_phase).toBe('SURVEY');

    const list = await request(app).get(`/api/exam/${examId}/subjects`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(list.statusCode).toBe(200);
    expect(list.body.data.subjects.length).toBeGreaterThan(0);
  });

  // 7. 教員は調査期間中に自分の出題コマだけ登録できる
  it('POST /api/exam/:id/subject-row - 一般教員は自分の出題者コマを登録できること', async () => {
    const list = await request(app).get(`/api/exam/${examId}/subjects`).set('Authorization', `Bearer ${kyomuToken}`);
    const row = list.body.data.subjects.find((r) => Number(r.grade) === Number(teacherUser.grade)) || list.body.data.subjects[0];

    const res = await request(app)
      .post(`/api/exam/${examId}/subject-row`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ ...row, setter_teacher_id: teacherUser.id });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.setter_teacher_id).toBe(teacherUser.id);
  });

  it('POST /api/exam/:id/subject-row - 一般教員が他人の出題コマを変更すると 403 になること', async () => {
    const list = await request(app).get(`/api/exam/${examId}/subjects`).set('Authorization', `Bearer ${kyomuToken}`);
    const row = list.body.data.subjects.find((r) => Number(r.grade) === Number(teacherUser.grade)) || list.body.data.subjects[0];

    const res = await request(app)
      .post(`/api/exam/${examId}/subject-row`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ ...row, setter_teacher_id: kyomuUser.id });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('自分の出題コマ');
  });

  // 8. 時間割の自動作成は教務のみ
  it('POST /api/exam/:id/timetable - 一般教員は 403 になること', async () => {
    const res = await request(app).post(`/api/exam/${examId}/timetable`).set('Authorization', `Bearer ${teacherToken}`);
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/exam/:id/timetable - 教務主任は時間割を自動作成できること', async () => {
    const res = await request(app).post(`/api/exam/${examId}/timetable`).set('Authorization', `Bearer ${kyomuToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);

    const slots = await request(app).get(`/api/exam/${examId}/slots`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(slots.statusCode).toBe(200);
    expect(Array.isArray(slots.body.data.slots)).toBe(true);
    expect(slots.body.data.slots.length).toBeGreaterThan(0);
    expect(slots.body.data.is_kyomu).toBe(true);
  });

  // 8-5. ×（使用不能コマ）: 全学年共通 × は暦日グリッド / 学年固有 × は実施日グリッド
  it('GET /api/exam/:id/schedule-cells - 一般教員は×グリッドを閲覧できること', async () => {
    const res = await request(app).get(`/api/exam/${examId}/schedule-cells`).set('Authorization', `Bearer ${teacherToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.is_kyomu).toBe(false);
    expect(res.body.data.calendar.length).toBe(3);
    expect(res.body.data.calendar[0].slots.length).toBe(8);
    expect(res.body.data.day_slots.length).toBe(3);
    expect(res.body.data.grade_blocks).toEqual([]);
  });

  it('PUT /api/exam/:id/schedule-cells - 一般教員は 403 になること', async () => {
    const res = await request(app)
      .put(`/api/exam/${examId}/schedule-cells`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ cells: [{ day: 2, slot: 1 }] });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('教務');
  });

  it('PUT /api/exam/:id/schedule-cells - 教務主任は全時限×で実施日を圧縮し関連レコードを再採番できること', async () => {
    // 圧縮前に出張等を 1・2・3日目の実施日番号で登録する
    const trips = await request(app)
      .post(`/api/exam/${examId}/trips`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send([
        { teacher_id: teacherUser.id, day_number: 1, slot_number: 1, reason: '出張A' },
        { teacher_id: teacherUser.id, day_number: 2, slot_number: 1, reason: '出張B' },
        { teacher_id: teacherUser.id, day_number: 3, slot_number: 1, reason: '出張C' },
      ]);
    expect(trips.statusCode).toBe(200);
    expect(trips.body.data.saved).toBe(3);

    const cells = [];
    for (let s = 1; s <= 8; s++) cells.push({ day: 2, slot: s });

    const res = await request(app)
      .put(`/api/exam/${examId}/schedule-cells`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ cells });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.saved).toBe(8);
    expect(res.body.data.calendar_days).toBe(3);
    expect(res.body.data.enabled_days).toEqual([1, 3]);
    expect(res.body.data.day_slots.length).toBe(2);
    expect(res.body.data.renumbered).toBeGreaterThan(0);
    expect(res.body.data.deleted).toBeGreaterThan(0);

    const slots = await request(app).get(`/api/exam/${examId}/slots`).set('Authorization', `Bearer ${kyomuToken}`);
    const usedDays = [...new Set(slots.body.data.slots.map((s) => Number(s.day_number)))];
    expect(usedDays.every((d) => d >= 1 && d <= 2)).toBe(true);

    const board = await request(app).get(`/api/exam/${examId}/board`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(board.body.data.day_slots.map((d) => d.cal_day)).toEqual([1, 3]);
    expect(board.body.data.day_slots.map((d) => d.date)).toEqual(['2099-11-01', '2099-11-03']);

    // 出張等: 旧2日目は実施日外で削除、旧3日目は新2日目へ再採番される
    const tripDays = board.body.data.trips.map((t) => Number(t.day_number)).sort((a, b) => a - b);
    expect(tripDays).toEqual([1, 2]);
  });

  it('PUT /api/exam/:id/timetable/blocked - 一般教員は 403 になること', async () => {
    const res = await request(app)
      .put(`/api/exam/${examId}/timetable/blocked`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ grade: 1, slots: [{ day_number: 1, slot_number: 1 }] });

    expect(res.statusCode).toBe(403);
  });

  it('PUT /api/exam/:id/timetable/blocked - 教務主任は学年固有×を保存し実施日外の×は 400 になること', async () => {
    const ok = await request(app)
      .put(`/api/exam/${examId}/timetable/blocked`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ grade: 1, slots: [{ day_number: 1, slot_number: 1 }] });

    expect(ok.statusCode).toBe(200);
    expect(ok.body.data.saved).toBe(1);

    const cells = await request(app).get(`/api/exam/${examId}/schedule-cells`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(cells.body.data.grade_blocks).toEqual(expect.arrayContaining([{ grade: 1, day: 1, slot: 1 }]));

    const slots = await request(app).get(`/api/exam/${examId}/slots`).set('Authorization', `Bearer ${kyomuToken}`);
    const blockedRow = slots.body.data.slots.find((s) => s.is_blocked);
    expect(blockedRow).toBeTruthy();
    expect(blockedRow.subject_name).toBeNull();

    const bad = await request(app)
      .put(`/api/exam/${examId}/timetable/blocked`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ grade: 2, slots: [{ day_number: 3, slot_number: 1 }] });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.error).toContain('試験実施日');

    const after = await request(app).get(`/api/exam/${examId}/schedule-cells`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(after.body.data.grade_blocks.length).toBe(1);
  });

  it('POST /api/exam/:id/timetable/validate - 教務主任は×コマへの科目配置を BLOCKED_CELL として診断できること', async () => {
    const res = await request(app)
      .post(`/api/exam/${examId}/timetable/validate`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send([{ grade: 1, day_number: 1, slot_number: 1, slot_span: 1, subject_name: '数学Ⅰ' }]);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.violations.some((v) => v.type === 'BLOCKED_CELL')).toBe(true);

    const clean = await request(app)
      .post(`/api/exam/${examId}/timetable/validate`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send([{ grade: 1, day_number: 1, slot_number: 2, slot_span: 1, subject_name: '数学Ⅰ' }]);

    expect(clean.statusCode).toBe(200);
    expect(clean.body.data.violations.some((v) => v.type === 'BLOCKED_CELL')).toBe(false);
  });

  // 8-6. 手動配置の保存（POST /timetable/slots）
  it('POST /api/exam/:id/timetable/slots - 一般教員は 403 になること', async () => {
    const res = await request(app)
      .post(`/api/exam/${examId}/timetable/slots`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send([{ grade: 1, day_number: 1, slot_number: 2, slot_span: 1, subject_name: '数学Ⅰ' }]);

    expect(res.statusCode).toBe(403);
  });

  it('POST /api/exam/:id/timetable/slots - 教務主任は×コマ配置を 400 で拒否し手動編集と学年固有×を保存できること', async () => {
    const bad = await request(app)
      .post(`/api/exam/${examId}/timetable/slots`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send([{ grade: 1, day_number: 1, slot_number: 1, slot_span: 1, subject_name: '数学Ⅰ' }]);

    expect(bad.statusCode).toBe(400);
    expect(bad.body.details.some((v) => v.type === 'BLOCKED_CELL')).toBe(true);

    const plan = await request(app).get(`/api/exam/${examId}/subjects`).set('Authorization', `Bearer ${kyomuToken}`);
    const math = plan.body.data.plan.find((p) => p.grade === 1 && p.subject_name === '数学Ⅰ');
    const science = plan.body.data.plan.find((p) => p.grade === 2 && p.subject_name === '理科');

    const okRes = await request(app)
      .post(`/api/exam/${examId}/timetable/slots`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send([
        { grade: 1, day_number: 1, slot_number: 1, is_blocked: true },
        { grade: 1, day_number: 1, slot_number: 2, slot_span: 1, subject_id: math.subject_id, subject_name: '数学Ⅰ' },
        { grade: 2, day_number: 2, slot_number: 3, slot_span: 2, subject_id: science.subject_id, subject_name: '理科' },
      ]);

    expect(okRes.statusCode).toBe(200);
    expect(okRes.body.data.saved).toBe(3);
    expect(okRes.body.data.blocked_saved).toBe(1);

    const slots = await request(app).get(`/api/exam/${examId}/slots`).set('Authorization', `Bearer ${kyomuToken}`);
    const blocked = slots.body.data.slots.filter((s) => s.is_blocked);
    expect(blocked.length).toBe(1);
    expect(Number(blocked[0].day_number)).toBe(1);
    expect(Number(blocked[0].slot_number)).toBe(1);
  });



  // 9. 教室割の自動作成（教務のみ・教室マスタ未登録は 400）
  it('POST /api/exam/:id/room-assign - 一般教員は 403 になること', async () => {
    const res = await request(app).post(`/api/exam/${examId}/room-assign`).set('Authorization', `Bearer ${teacherToken}`);
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/exam/:id/room-assign - 教務主任は教室マスタ未登録時に 400 で案内されること', async () => {
    const res = await request(app).post(`/api/exam/${examId}/room-assign`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toContain('教室マスタ');
  });

  // 10. 出張等登録（教員は登録開始前のため編集不可）
  it('POST /api/exam/:id/trips - 一般教員は出張登録開始前で 403 になること', async () => {
    const res = await request(app)
      .post(`/api/exam/${examId}/trips`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ teacher_id: teacherUser.id, day_number: 1, slot_number: 1, reason: 'テスト出張' });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('登録期間中');
  });

  // 11. 公表ビューは全教員が閲覧可能
  it('GET /api/exam/:id/view - 一般教員は公表ビューを閲覧できること', async () => {
    const res = await request(app).get(`/api/exam/${examId}/view`).set('Authorization', `Bearer ${teacherToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.is_kyomu).toBe(false);
    expect(res.body.data.master.title).toBe(TEST_TITLE);
    expect(Array.isArray(res.body.data.timetable)).toBe(true);
  });

  // 12. 存在しない考査
  it('GET /api/exam/:id/board - 存在しない考査は 404 になること', async () => {
    const res = await request(app).get('/api/exam/exam-not-exist/board').set('Authorization', `Bearer ${kyomuToken}`);
    expect(res.statusCode).toBe(404);
  });

  // 13. 考査削除（ON DELETE CASCADE で関連レコードも消えること）
  it('DELETE 後 - 考査ボードは 404 になり実施科目プランも消滅すること', async () => {
    const before = await request(app).get(`/api/exam/${examId}/board`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(before.statusCode).toBe(200);

    const id = examId;
    examId = null;
    await query('DELETE FROM exam_masters WHERE id = ?', [id]);

    const after = await request(app).get(`/api/exam/${id}/board`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(after.statusCode).toBe(404);

    const planCount = await query('SELECT COUNT(*) AS c FROM exam_subject_plan WHERE exam_master_id = ?', [id]);
    expect(Number(planCount.rows[0].c)).toBe(0);

    await query('DELETE FROM audit_logs WHERE resource_id = ?', [id]);
  });
});
