/**
 *  periodic 考査 E2E テスト（実データ + 実サービス + 実ソルバー）
 * 実行: npm run test:exam  (= node --env-file=.env scripts/test-exam-e2e.mjs)
 * 実行後は登録データ（users / exam_*）をクリーンアップする。
 */
import bcrypt from 'bcrypt';
import { query, pool } from '../config/database.js';
import config from '../config/default.js';
import examService from '../src/services/exam.service.js';
import examModel from '../src/models/exam.model.js';
import { DEFAULT_TIMETABLE_RULES } from '../src/utils/exam-timetable-solver.js';

const EXAM_ID = 'e2e-exam';
const DAYS = 5;
const SLOTS = 6;
const GRADES = [1, 2, 3];
const KYOMU = { id: 'et-kyomu', role: 'KYOMU' };

const FULLTIME = [];
for (const g of GRADES) {
  for (let i = 1; i <= 8; i++) {
    FULLTIME.push({ id: `et-${g}0${i}`, name: `E2E教員${g}-${i}`, grade: g, is_parttime: false });
  }
}
const PARTTIMES = [
  { id: 'etp-1', name: 'E2E非常勤1', grade: null, is_parttime: true },
  { id: 'etp-2', name: 'E2E非常勤2', grade: null, is_parttime: true },
  { id: 'etp-3', name: 'E2E非常勤3', grade: null, is_parttime: true },
];
const USERS = [...FULLTIME, ...PARTTIMES, { id: KYOMU.id, name: 'E2E教頭', grade: null, is_parttime: false }];

const SUBJECTS = [
  { name: '国語', scope: 'ALL', slots: 1 },
  { name: '数学', scope: 'ALL', slots: 1 },
  { name: '英語', scope: 'ALL', slots: 1 },
  { name: '科学', scope: 'ALL', slots: 2, fixed_slot: 2 },
  { name: '社会', scope: 'ALL', slots: 1, broadcast_slot: true },
  { name: '保健体育理論', scope: 'ALL', slots: 1, solo_subject: true },
  { name: '技術家庭理論', scope: 'GRADE', slots: 1 },
];

const ROOMS = [];
for (const g of GRADES) {
  ROOMS.push({ name: `${g}年A教室`, room_type: 'CLASS', capacity: 100, grades: [g], is_alternate: false });
  ROOMS.push({ name: `${g}年B教室`, room_type: 'CLASS', capacity: 100, grades: [g], is_alternate: true });
}
ROOMS.push({ name: 'SP1', room_type: 'SP1', capacity: 60, grades: [], is_alternate: false });
ROOMS.push({ name: 'SP2', room_type: 'SP2', capacity: 60, grades: [], is_alternate: false });
ROOMS.push({ name: 'PREP1', room_type: 'PREP1', capacity: 60, grades: [], is_alternate: false });

const SP1_ROT = ['et-101', 'et-201', 'et-301'];
const SP2_ROT = ['etp-1', 'etp-2', 'etp-3'];
const TRIPS = [
  { teacher_id: 'et-101', day_number: 1, slot_number: 4 },
  { teacher_id: 'et-101', day_number: 5, slot_number: 1 },
  { teacher_id: 'et-201', day_number: 3, slot_number: 2 },
];
const EXEMPTED = 'et-108';
const CONSIDERATION_LIMIT = 1; // et-103: 1日あたり1コマまで（rules.considerations）
const CONSTRAINT_LIMIT = 1;    // et-104: 1日あたり1コマまで（exam_teacher_constraints）

const failures = [];
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
};

async function cleanup() {
  await query(`DELETE FROM exam_masters WHERE id = ?`, [EXAM_ID]);
  const tables = [
    'exam_slots', 'exam_subject_plan', 'exam_trips', 'exam_proctor_assignments',
    'exam_phases', 'exam_parttime_staff', 'exam_parttime_availability', 'exam_rooms',
    'exam_room_config', 'exam_room_assignments', 'exam_teacher_constraints',
    'exam_proctor_rules', 'exam_timetable_rules', 'exam_room_rules',
  ];
  for (const t of tables) {
    await query(`DELETE FROM ${t} WHERE exam_master_id = ?`, [EXAM_ID]);
  }
  await query(`DELETE FROM exam_teacher_exemptions WHERE exam_master_id = ? OR teacher_id = ?`, [EXAM_ID, EXEMPTED]);
  await query(`DELETE FROM users WHERE id LIKE 'et-%' OR id LIKE 'etp-%'`, []);
}

async function prep() {
  await cleanup();
  const hash = bcrypt.hashSync('e2etest', config.auth.bcryptSaltRounds);
  for (const u of USERS) {
    await query(
      `INSERT INTO users (id, staff_code, name, password_hash, role, grade, is_parttime)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [u.id, u.id, u.name, hash, u.id === KYOMU.id ? 'KYOMU' : 'TEACHER', u.grade, u.is_parttime]
    );
  }

  await examService.createMaster({
    id: EXAM_ID,
    title: 'E2E考査',
    start_date: '2026-02-16',
    end_date: '2026-02-20',
    days_count: DAYS,
    daily_slots: SLOTS,
    grades: GRADES,
    created_by: KYOMU.id,
  }, KYOMU);

  // --- 科目調査 ---
  await examService.startSubjectSurvey(EXAM_ID, KYOMU);
  const plan = [];
  for (const g of GRADES) {
    const teachers = FULLTIME.filter((t) => t.grade === g);
    SUBJECTS.forEach((s, i) => {
      plan.push({
        exam_master_id: EXAM_ID,
        subject_name: s.name,
        grade: g,
        scope: s.scope,
        stream: null,
        setter_teacher_id: teachers[i % teachers.length].id,
        duration_slots: s.slots,
        fixed_slot: s.fixed_slot || null,
        shared_slot: !!s.shared_slot,
        broadcast_slot: !!s.broadcast_slot,
        solo_subject: !!s.solo_subject,
        submit_status: 'SUBMITTED',
      });
    });
  }
  await examModel.bulkInsertSubjectPlan(EXAM_ID, plan, KYOMU.id);
  await examService.saveTimetableRules(EXAM_ID, { ...DEFAULT_TIMETABLE_RULES }, KYOMU);
  await examService.saveRooms(EXAM_ID, ROOMS.map((r) => ({ ...r, exam_master_id: EXAM_ID })), KYOMU);
}

async function prep2() {
  // --- 教室設定（標準・予備） ---
  for (const g of GRADES) {
    for (const s of SUBJECTS) {
      await examService.saveRoomConfig(EXAM_ID, {
        subject_name: s.name,
        grade: g,
        standard_room: `${g}年A教室`,
        alt_rooms: [`${g}年B教室`],
        notes: null,
      }, KYOMU);
    }
  }
  await examService.saveRoomRules(EXAM_ID, {
    rules_by_grade: { 2: 'SP1' },
    rules_by_subject: { '3|科学': 'SP2' },
    reserved_rooms: [],
    weights: {},
  }, KYOMU);

  // --- 出張 ---
  for (const t of TRIPS) {
    await examService.addTripRow(EXAM_ID, { ...t, reason: '研修', kind: '研修', notes: null }, KYOMU);
  }

  // --- 非常勤スタッフ・出勤可能コマ ---
  for (const p of PARTTIMES) {
    await examService.saveParttimeStaff(EXAM_ID, {
      staff_id: p.id,
      slot_condition: { max_slots_per_day: 2, max_consecutive_slots: 1, allow_consecutive: false },
    }, KYOMU);
  }
  const avail = [];
  for (const p of PARTTIMES) {
    for (let d = 1; d <= DAYS; d++) {
      for (let s = 1; s <= SLOTS; s++) {
        avail.push({ staff_id: p.id, day_number: d, slot_number: s, available: !(d === 2 && s >= 5) });
      }
    }
  }
  await examService.setParttimeAvailability(EXAM_ID, avail, KYOMU);

  // --- 個別配慮・免除 ---
  await examService.saveTeacherConstraint(EXAM_ID, {
    teacher_id: 'et-104', max_slots_per_day: CONSTRAINT_LIMIT, notes: 'E2E制約',
  }, KYOMU);
  await examService.addExemption(EXAM_ID, { teacher_id: EXEMPTED, reason: 'E2E免除' }, KYOMU);

  await examService.saveProctorRules(EXAM_ID, {
    special_room_rotation: [
      { type: 'SP1', teacher_ids: SP1_ROT, pattern: 'ALL' },
      { type: 'SP2', teacher_ids: SP2_ROT, pattern: 'ALL' },
    ],
    considerations: [{ teacher_id: 'et-103', max_slots_per_day: CONSIDERATION_LIMIT, reason: 'E2E配慮' }],
    avoid_setter: true,
    solo_subject_self: true,
    kyomu_priority: 4,
    parttime_prefer: 1,
    weights: { balance: 50, kyomu: 12, parttime: 25, consecutive: 20, special_balance: 18, outside_rotation: 30, no_candidate: 200 },
  }, KYOMU);
}

// 非常勤: 2日目5-6限は出勤不可
const UNAVAILABLE = new Set();
for (const p of PARTTIMES) {
  UNAVAILABLE.add(`${p.id}|2|5`);
  UNAVAILABLE.add(`${p.id}|2|6`);
}
const PARTTIME_IDS = new Set(PARTTIMES.map((p) => p.id));

async function main() {
  await prep();
  await prep2();

  console.log('=== 1. 科目調査 ===');
  const phases0 = await examModel.getPhases(EXAM_ID);
  ok(phases0.subject_phase === 'SURVEY', 'subject_phase=SURVEY');
  const plan = await examModel.listSubjectPlan(EXAM_ID);
  ok(plan.length === 21, `科目プラン 21件 (${plan.length})`);
  const scopeBySubject = new Map(plan.map((p) => [p.subject_name, p.scope]));
  const soloSubjects = new Set(plan.filter((p) => p.solo_subject).map((p) => p.subject_name));

  console.log('=== 2. 時間割 ===');
  const t = await examService.solveTimetable(EXAM_ID, KYOMU);
  ok(t.saved === 21, `time table 保存 21ユニット (${t.saved})`);
  ok(t.stats.unplacedUnits === 0, `未配置 0 (${t.stats.unplacedUnits})`);
  const tHard = (t.diagnostics.hard || []);
  ok(tHard.length === 0, `時間割 HARD 0 (${tHard.map((d) => d.type).join(',')})`);

  const slots = await examModel.listSlots(EXAM_ID);
  ok(slots.length === 21, `exam_slots 21件 (${slots.length})`);

  // H1: 1限目を埋める科目は全て全範囲
  let h1 = true;
  for (const s of slots) {
    if (s.slot_number === 1 && scopeBySubject.get(s.subject_name) !== 'ALL') h1 = false;
  }
  ok(h1, 'H1 毎日の1限目=全範囲科目');

  // H2: 最終日を埋める科目は全て全範囲
  let h2 = true;
  for (const s of slots) {
    if (s.day_number === DAYS && scopeBySubject.get(s.subject_name) !== 'ALL') h2 = false;
  }
  ok(h2, 'H2 最終日は全範囲科目');

  let h3 = true;
  for (const g of GRADES) {
    const sci = slots.filter((c) => c.grade === g && c.subject_name === '科学');
    if (sci.length !== 1 || sci[0].slot_number !== 2 || Number(sci[0].duration_slots) !== 2) h3 = false;
  }
  ok(h3, 'H3 科学は2限開始・2コマ連続');

  const socialSlots = GRADES.map((g) => slots.find((c) => c.grade === g && c.subject_name === '社会')?.slot_number);
  ok(new Set(socialSlots).size === GRADES.length, `broadcast(社会) slot 学年で別 (${socialSlots.join(',')})`);

  for (const g of GRADES) {
    const uniq = new Set(slots.filter((c) => c.grade === g).map((c) => c.subject_name));
    ok(uniq.size === 7, `学年${g} 7科目`);
  }

  const pubT = await examService.publishTimetable(EXAM_ID, KYOMU);
  ok(pubT.timetable_phase === 'PUBLISHED', 'timetable_phase PUBLISHED');

  console.log('=== 3. 教室 ===');
  const r = await examService.solveRoomAssignments(EXAM_ID, KYOMU);
  ok(r.stats.unassignedUnits === 0, `教室 未割当 0 (${r.stats.unassignedUnits})`);

  const roomRows = await examModel.listRoomAssignments(EXAM_ID);
  ok(roomRows.length === 24, `exam_room_assignments 24 (${roomRows.length})`);
  ok(roomRows.filter((x) => x.grade === 2).every((x) => x.room_name === 'SP1'), '学年2=SP1 固定');
  ok(
    roomRows.filter((x) => x.grade === 3 && x.subject_name === '科学').every((x) => x.room_name === 'SP2'),
    '学年3 科学=SP2'
  );

  const occ = new Map();
  let dup = 0;
  for (const x of roomRows) {
    for (let s = x.slot_number; s < x.slot_number + Number(x.duration_slots || 1); s++) {
      const k = `${x.room_name}|${x.day_number}|${s}`;
      if (occ.has(k)) dup++;
      occ.set(k, x.subject_name);
    }
  }
  ok(dup === 0, `教室 同一コマ重複 0 (${dup})`);

  ok(
    roomRows
      .filter((x) => !(x.grade === 2) && !(x.grade === 3 && x.subject_name === '科学'))
      .every((x) => x.room_name === `${x.grade}年A教室` || x.room_name === `${x.grade}年B教室`),
    '通常コマは標準/予備教室'
  );

  const pubR = await examService.publishRoomAssignments(EXAM_ID, KYOMU);
  ok(pubR.room_phase === 'PUBLISHED', 'room_phase PUBLISHED');

  console.log('=== 4. 出張 ===');
  const trips = await examModel.listTrips(EXAM_ID);
  ok(trips.length === 3, `trips 3件 (${trips.length})`);

  console.log('=== 5. 監督割当 ===');
  const p = await examService.solveProctorBoard(EXAM_ID, KYOMU);
  ok(p.unassigned === 0, `監督 未割当 0 (${p.unassigned})`);
  const pHard = (p.diagnostics || []).filter((d) => d.level === 'HARD');
  ok(pHard.length === 0, `監督 HARD 0 (${pHard.map((d) => d.code).join(',')})`);

  const proctors = await examModel.listProctorAssignments(EXAM_ID);
  ok(proctors.length === 24, `監督行 24件 (${proctors.length})`);

  ok(
    proctors.filter((x) => x.grade === 2 && !soloSubjects.has(x.subject_name)).every((x) => SP1_ROT.includes(x.proctor_teacher_id)),
    'SP1ローテーション'
  );
  ok(
    proctors.filter((x) => x.grade === 3 && x.subject_name === '科学').every((x) => SP2_ROT.includes(x.proctor_teacher_id)),
    'SP2ローテーション(非常勤)'
  );
  ok(!proctors.some((x) => x.proctor_teacher_id === EXEMPTED), '免除教員 未割当');

  const dayLoad = new Map();
  for (const x of proctors) {
    const k = `${x.proctor_teacher_id}|${x.day_number}`;
    dayLoad.set(k, (dayLoad.get(k) || 0) + 1);
  }
  ok(
    [...dayLoad.entries()].filter(([k, v]) => k.startsWith('et-103|') && v > CONSIDERATION_LIMIT).length === 0,
    'et-103 日上限1(配慮)'
  );
  ok(
    [...dayLoad.entries()].filter(([k, v]) => k.startsWith('et-104|') && v > CONSTRAINT_LIMIT).length === 0,
    'et-104 日上限1(個別設定)'
  );

  const tripViol = proctors.filter((x) =>
    TRIPS.some((tr) => tr.teacher_id === x.proctor_teacher_id && tr.day_number === x.day_number && tr.slot_number === x.slot_number)
  );
  ok(tripViol.length === 0, `出張尊重 (${tripViol.length})`);

  const parttimeBad = proctors.filter((x) =>
    PARTTIME_IDS.has(x.proctor_teacher_id) && UNAVAILABLE.has(`${x.proctor_teacher_id}|${x.day_number}|${x.slot_number}`)
  );
  ok(parttimeBad.length === 0, `非常勤 出勤不可コマ回避 (${parttimeBad.length})`);

  const parttimeDayOver = [...dayLoad.entries()].filter(([k, v]) => PARTTIME_IDS.has(k.split('|')[0]) && v > 2);
  ok(parttimeDayOver.length === 0, `非常勤 日上限2 (${parttimeDayOver.length})`);

  const parttimeConsec = new Set();
  for (const x of proctors) {
    if (!PARTTIME_IDS.has(x.proctor_teacher_id)) continue;
    const key = `${x.proctor_teacher_id}|${x.day_number}`;
    const slotsOf = proctors.filter((y) => y.proctor_teacher_id === x.proctor_teacher_id && y.day_number === x.day_number).map((y) => y.slot_number).sort((a, b) => a - b);
    for (let i = 1; i < slotsOf.length; i++) {
      if (slotsOf[i] === slotsOf[i - 1] + 1) parttimeConsec.add(key);
    }
  }
  ok(parttimeConsec.size === 0, `非常勤 連続コマ禁止 (${parttimeConsec.size})`);

  const setterClash = proctors.filter(
    (x) => !soloSubjects.has(x.subject_name) && x.proctor_teacher_id === x.setter_teacher_id
  );
  ok(setterClash.length === 0, `出題者回避 (${setterClash.length})`);

  const soloRows = proctors.filter((x) => soloSubjects.has(x.subject_name));
  ok(soloRows.length === 3 && soloRows.every((x) => x.proctor_teacher_id === x.setter_teacher_id), 'ソロ科目=本人監督');

  const loads = (p.stats?.loads || []).map((l) => l.load);
  const range = Math.max(...loads) - Math.min(...loads);
  ok(range <= 6, `負荷均等 幅${range} (loads=${loads.sort((a, b) => b - a).join(',')})`);

  console.log('=== 6. 手動検証・公表 ===');
  const board = await examService.getProctorBoard(EXAM_ID, KYOMU);
  const manualRows = board.cells.map((c) => ({
    grade: c.grade,
    day_number: c.day_number,
    slot_number: c.slot_number,
    subject_name: c.subject_name,
    room_name: c.room_name,
    room_type: c.room_type,
    proctor_teacher_id: c.proctor_teacher_id,
    setter_teacher_id: c.setter_teacher_id,
  }));
  const vOk = await examService.validateProctorRows(EXAM_ID, manualRows, KYOMU);
  ok(vOk.hard_count === 0, `手動行検証 OK (${vOk.hard_count})`);

  // 出張と衝突するコマを実在のコマから選ぶ
  const tripCell = board.cells.find((c) => TRIPS.some((tr) => tr.day_number === c.day_number && tr.slot_number === c.slot_number));
  const tripForCell = TRIPS.find((tr) => tr.day_number === tripCell.day_number && tr.slot_number === tripCell.slot_number);
  const badRows = manualRows.map((r) =>
    r.grade === tripCell.grade && r.day_number === tripCell.day_number && r.slot_number === tripCell.slot_number
      ? { ...r, proctor_teacher_id: tripForCell.teacher_id }
      : r
  );
  const vBad = await examService.validateProctorRows(EXAM_ID, badRows, KYOMU);
  ok(vBad.hard_count > 0 && vBad.diagnostics.some((d) => d.code === 'TRIP_CONFLICT'), '手動行: 出張衝突を検出');

  const savedManual = await examService.saveProctorAssignments(EXAM_ID, manualRows, KYOMU);
  ok(savedManual.saved === 24, `手動保存 24件 (${savedManual.saved})`);

  const pubP = await examService.publishProctor(EXAM_ID, KYOMU);
  ok(pubP.proctor_phase === 'PUBLISHED', 'proctor_phase PUBLISHED');

  console.log('=== 7. 公表ビュー ===');
  const gradeById = new Map(USERS.map((u) => [u.id, u.grade]));
  const busy = (p.stats?.loads || []).find((l) => l.load > 0 && !l.parttime && l.id.startsWith('et-') && l.id !== 'et-kyomu');
  const viewUser = { id: busy.id, grade: gradeById.get(busy.id), role: 'TEACHER' };
  const view = await examService.getPublishedView(EXAM_ID, viewUser);
  ok(view.master.id === EXAM_ID, 'view master');
  ok(
    view.timetable.length === 7 && view.timetable.every((c) => c.grade === viewUser.grade),
    `view timetable 7件 学年${viewUser.grade} (${view.timetable.length})`
  );
  const expectedRooms = roomRows.filter((x) => x.grade === viewUser.grade).length;
  ok(view.rooms.length === expectedRooms, `view rooms ${expectedRooms} (${view.rooms.length})`);
  ok(view.my_proctor.length === busy.load, `view my_proctor ${busy.load} (${view.my_proctor.length})`);

  const viewKyomu = await examService.getPublishedView(EXAM_ID, KYOMU);
  ok(viewKyomu.timetable.length === 21, `教務view 全時間割 (${viewKyomu.timetable.length})`);
  ok(viewKyomu.my_trips.length === 0, '教務 出張なし');

  console.log(`\n=== 結果: ${failures.length} 件の失敗 ===`);
  if (failures.length) {
    for (const f of failures) console.log(` - ${f}`);
  }
}

main()
  .then(async () => {
    if (!process.argv.includes('--keep')) await cleanup();
    await pool.end();
    process.exit(failures.length ? 1 : 0);
  })
  .catch(async (err) => {
    console.error('FATAL', err);
    try {
      if (!process.argv.includes('--keep')) await cleanup();
    } catch (e) {
      console.error('cleanup failed', e);
    }
    await pool.end();
    process.exit(1);
  });


