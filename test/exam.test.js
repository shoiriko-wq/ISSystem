/**
 * ISSystem Integration Tests - 定期考査 (Exam) API
 * 教務権限者 (KYOMU) の 6 メニュー操作と一般教員 (TEACHER) の公表閲覧・自己担当操作を検証する
 * サイドメニュー「定期考査」の教務 6 メニューは教務権限者のみ表示される (public/js/modules/exam/exam.module.js)
 */

import request from 'supertest';
import app from '../src/app.js';
import { query, closeDatabase } from '../src/utils/db.js';
import { examModel } from '../src/models/exam.model.js';

describe('Exam API Endpoints (/api/exam)', () => {
  const PASSWORD = 'password123';
  const TEST_TITLE = '統合テスト考査2099';

  let kyomuToken = '';
  let teacherToken = '';
  let kyomuUser = null;
  let teacherUser = null;
  let examId = null;
  let decisionId = null;

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

  // 3b. ① 考査名だけ登録 → ② 調査開始 → ③ 期間登録 の作業順
  it('① 考査名のみで登録でき、② 調査開始は期間未設定でも成功し、③ で期間を登録できること', async () => {
    const stepTitle = '作業順テスト考査2099';
    const created = await request(app)
      .post('/api/exam')
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ title: stepTitle, grades: [1, 2, 3] });

    expect(created.statusCode).toBe(200);
    const stepId = created.body.data.id;
    expect(created.body.data.start_date).toBeNull();
    expect(created.body.data.end_date).toBeNull();
    expect(created.body.data.days_count).toBe(0);
    expect(created.body.data.daily_slots).toBe(0);

    // ② 期間未設定でも実施科目調査を開始できる
    const survey = await request(app)
      .post(`/api/exam/${stepId}/subject-survey/start`)
      .set('Authorization', `Bearer ${kyomuToken}`);
    expect(survey.statusCode).toBe(200);
    expect(survey.body.data.subject_phase).toBe('SURVEY');

    // ③ で期間・1日のコマ数を登録する
    const registered = await request(app)
      .post(`/api/exam/${stepId}/plan/register`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ start_date: '2099-12-01', end_date: '2099-12-04', days_count: 4, daily_slots: 8, default_duration: 50 });
    expect(registered.statusCode).toBe(200);
    expect(registered.body.data.phases.plan_phase).toBe('REGISTERED');
    expect(registered.body.data.master.daily_slots).toBe(8);

    await query('DELETE FROM exam_masters WHERE id = ?', [stepId]);
    await query('DELETE FROM audit_logs WHERE resource_id = ?', [stepId]);
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
    const planRows = plan.body.data.plan;
    // 基本情報カタログ（curriculum_subjects）から種付けされた実施科目プラン行を使う（科目名に依存しない）
    const math = planRows.find((p) => Number(p.grade) === 1) || planRows[0];
    const science = planRows.find((p) => Number(p.grade) === 2);
    expect(math).toBeTruthy();
    expect(science).toBeTruthy();

    const okRes = await request(app)
      .post(`/api/exam/${examId}/timetable/slots`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send([
        { grade: 1, day_number: 1, slot_number: 1, is_blocked: true },
        { grade: 1, day_number: 1, slot_number: 2, slot_span: 1, subject_id: math.subject_id, subject_name: math.subject_name },
        { grade: 2, day_number: 2, slot_number: 3, slot_span: 2, subject_id: science.subject_id, subject_name: science.subject_name },
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



  // 8-7. 実施科目の決定（② の調査値＝計画値をデフォルト値として決定行を作り、教務が編集する）
  it('POST /api/exam/:id/decisions/seed - 一般教員は 403 になること', async () => {
    const res = await request(app).post(`/api/exam/${examId}/decisions/seed`).set('Authorization', `Bearer ${teacherToken}`);
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/exam/:id/decisions/seed - 教務は②の調査プランから決定行を作成し、default_json に計画値を保存できること', async () => {
    const res = await request(app).post(`/api/exam/${examId}/decisions/seed`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(res.statusCode).toBe(200);
    const summary = res.body.data;
    expect(summary.total).toBeGreaterThan(0);
    expect(summary.plan_total).toBe(summary.total);
    expect(summary.seed.added).toBe(summary.total);
    expect(summary.changed).toBe(0);

    const list = await request(app).get(`/api/exam/${examId}/decisions`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(list.statusCode).toBe(200);
    const rows = list.body.data.decisions;
    expect(rows.length).toBe(summary.total);
    const own = rows.find((r) => String(r.setter_teacher_id) === String(teacherUser.id)) || rows[0];
    expect(own.defaults).toBeTruthy();
    expect(own.changed).toHaveLength(0);
    expect(own.source_plan_id).toBeTruthy();
    decisionId = own.id;
  });

  it('POST /api/exam/:id/decisions/survey/start - 教務は決定調査を開始できること', async () => {
    const res = await request(app).post(`/api/exam/${examId}/decisions/survey/start`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.decision_phase).toBe('SURVEY');
  });

  it('POST /api/exam/:id/decision-rows - 教員は決定調査中に自分の決定行を編集でき、変更項目がデフォルト値との差分として記録されること', async () => {
    const list = await request(app).get(`/api/exam/${examId}/decisions`).set('Authorization', `Bearer ${teacherToken}`);
    const row = list.body.data.decisions.find((r) => String(r.setter_teacher_id) === String(teacherUser.id));
    expect(row).toBeTruthy();
    const baseMinutes = Number(row.duration_minutes) || 50;

    const res = await request(app)
      .post(`/api/exam/${examId}/decision-rows`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ ...row, duration_minutes: baseMinutes + 10 });
    expect(res.statusCode).toBe(200);

    const after = await request(app).get(`/api/exam/${examId}/decisions`).set('Authorization', `Bearer ${teacherToken}`);
    const edited = after.body.data.decisions.find((r) => String(r.id) === String(row.id));
    expect(Number(edited.duration_minutes)).toBe(baseMinutes + 10);
    expect(edited.changed).toContain('duration_minutes');
    expect(Number(edited.defaults.duration_minutes)).toBe(baseMinutes);
    expect(after.body.data.summary.changed).toBeGreaterThan(0);
    decisionId = row.id;
  });

  it('POST /api/exam/:id/decision-rows - 教員は他人の決定行を編集できないこと', async () => {
    const list = await request(app).get(`/api/exam/${examId}/decisions`).set('Authorization', `Bearer ${teacherToken}`);
    const other = list.body.data.decisions.find((r) => String(r.setter_teacher_id) !== String(teacherUser.id));
    expect(other).toBeTruthy();
    const res = await request(app)
      .post(`/api/exam/${examId}/decision-rows`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ ...other, duration_minutes: 60 });
    expect(res.statusCode).toBe(403);
    expect(res.body.error).toContain('出題者本人');
  });

  it('POST /api/exam/decision/:id/submit - 教員は自分の決定行を提出できること', async () => {
    const res = await request(app).post(`/api/exam/decision/${decisionId}/submit`).set('Authorization', `Bearer ${teacherToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.submitted).toBeGreaterThan(0);
  });

  it('POST /api/exam/decision/:id/reset-default - 一般教員は 403（計画値戻しは教務のみ）になること', async () => {
    const res = await request(app).post(`/api/exam/decision/${decisionId}/reset-default`).set('Authorization', `Bearer ${teacherToken}`);
    expect(res.statusCode).toBe(403);
  });

  it('POST /api/exam/decision/:id/reset-default - 教務は決定行を計画値（② の調査値）へ戻せること', async () => {
    const res = await request(app).post(`/api/exam/decision/${decisionId}/reset-default`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.changed).toBe(0);

    const list = await request(app).get(`/api/exam/${examId}/decisions`).set('Authorization', `Bearer ${kyomuToken}`);
    const row = list.body.data.decisions.find((r) => String(r.id) === String(decisionId));
    expect(row.changed).toHaveLength(0);
  });

  it('POST /api/exam/:id/decisions と DELETE /api/exam/decision/:id - 教務は決定行を追加・削除できること', async () => {
    const before = await request(app).get(`/api/exam/${examId}/decisions`).set('Authorization', `Bearer ${kyomuToken}`);
    const total = before.body.data.summary.total;

    const added = await request(app)
      .post(`/api/exam/${examId}/decisions`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ exam_master_id: examId, subject_name: '決定テスト科目', grade: 1, duration_minutes: 50, duration_slots: 1, class_ids: [] });
    expect(added.statusCode).toBe(200);
    expect(added.body.data.total).toBe(total + 1);

    const list = await request(app).get(`/api/exam/${examId}/decisions`).set('Authorization', `Bearer ${kyomuToken}`);
    const extra = list.body.data.decisions.find((r) => r.subject_name === '決定テスト科目');
    expect(extra).toBeTruthy();
    expect(extra.decision_status).toBe('CONFIRMED');

    const del = await request(app).delete(`/api/exam/decision/${extra.id}`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(del.statusCode).toBe(200);
    expect(del.body.data.total).toBe(total);
  });

  it('POST /api/exam/:id/decisions/survey/end - 教務は決定調査を終了でき、終了後は教員が編集できないこと', async () => {
    const res = await request(app).post(`/api/exam/${examId}/decisions/survey/end`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.decision_phase).toBe('ENDED');

    const list = await request(app).get(`/api/exam/${examId}/decisions`).set('Authorization', `Bearer ${teacherToken}`);
    const own = list.body.data.decisions.find((r) => String(r.setter_teacher_id) === String(teacherUser.id));
    const save = await request(app)
      .post(`/api/exam/${examId}/decision-rows`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ ...own, duration_minutes: 70 });
    expect(save.statusCode).toBe(403);
    expect(save.body.error).toContain('決定調査終了中');
  });

  it('POST /api/exam/:id/decisions/decide - 未提出行があれば 400、全行提出後に教務が実施科目を確定できること', async () => {
    const pending = await request(app).post(`/api/exam/${examId}/decisions/decide`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(pending.statusCode).toBe(400);
    expect(pending.body.error).toContain('未提出');

    await query(`UPDATE exam_subject_decisions SET submit_status = 'SUBMITTED' WHERE exam_master_id = ?`, [examId]);

    const res = await request(app).post(`/api/exam/${examId}/decisions/decide`).set('Authorization', `Bearer ${kyomuToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.decision_phase).toBe('DECIDED');

    const board = await request(app).get(`/api/exam/${examId}/board`).set('Authorization', `Bearer ${kyomuToken}`);
    const rows = board.body.data.decisions;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.filter((d) => d.decision_status === 'CONFIRMED').length).toBe(rows.length);
    expect(board.body.data.decision_summary.confirmed).toBe(rows.length);
  });

  it('GET /api/exam-survey-status - 考査名ごとに②の調査数と決定行数・確定数が返ること', async () => {
    const res = await request(app).get('/api/exam-survey-status').set('Authorization', `Bearer ${kyomuToken}`);
    expect(res.statusCode).toBe(200);
    const row = res.body.data.find((m) => String(m.id) === String(examId));
    expect(row).toBeTruthy();
    expect(row.plan_rows).toBeGreaterThan(0);
    expect(row.decision_rows).toBe(row.plan_rows);
    expect(row.decided).toBe(row.decision_rows);
  });

  it('conductSubjects - 決定行が調査プランより優先され、決定行の編集値が正式データになること', async () => {
    const decisions = await request(app).get(`/api/exam/${examId}/decisions`).set('Authorization', `Bearer ${kyomuToken}`);
    const row = decisions.body.data.decisions.find((r) => r.source_plan_id) || decisions.body.data.decisions[0];
    const planRes = await request(app).get(`/api/exam/${examId}/subjects`).set('Authorization', `Bearer ${kyomuToken}`);
    const planRow = planRes.body.data.plan.find((p) => String(p.id) === String(row.source_plan_id));
    expect(planRow).toBeTruthy();

    const minutes = Number(planRow.duration_minutes) + 10;
    const saved = await request(app)
      .post(`/api/exam/${examId}/decision-rows`)
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ ...row, duration_minutes: minutes });
    expect(saved.statusCode).toBe(200);

    // 決定行が優先され、決定行の編集値が正式データ（時間割・教室割・監督割・公表ビューの元データ）になる
    const units = await examModel.conductSubjects(examId);
    const unit = units.find((u) => String(u.id) === String(row.source_plan_id));
    expect(unit).toBeTruthy();
    expect(Number(unit.duration_minutes)).toBe(minutes);

    // 決定行が存在しない考査では ② 実施科目調査のプランへフォールバックする
    const created = await request(app)
      .post('/api/exam')
      .set('Authorization', `Bearer ${kyomuToken}`)
      .send({ title: 'フォールバック考査2099', grades: [1] });
    const fbId = created.body.data.id;
    await request(app).post(`/api/exam/${fbId}/subject-survey/start`).set('Authorization', `Bearer ${kyomuToken}`);
    const fbUnits = await examModel.conductSubjects(fbId);
    expect(fbUnits.length).toBeGreaterThan(0);
    expect(fbUnits[0].source_plan_id).toBeUndefined();
    await query(`DELETE FROM exam_masters WHERE id = ?`, [fbId]);
    await query(`DELETE FROM audit_logs WHERE resource_id = ?`, [fbId]);
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

    const decisionCount = await query('SELECT COUNT(*) AS c FROM exam_subject_decisions WHERE exam_master_id = ?', [id]);
    expect(Number(decisionCount.rows[0].c)).toBe(0);

    await query('DELETE FROM audit_logs WHERE resource_id = ?', [id]);
  });
});
