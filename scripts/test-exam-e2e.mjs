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
import basicinfoModel from '../src/models/basicinfo.model.js';
import { DEFAULT_TIMETABLE_RULES } from '../src/utils/exam-timetable-solver.js';
import { solveRooms } from '../src/utils/exam-room-solver.js';

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

// クラス・コースマスタ（考査学年の全クラスをクラス別キーとして扱う）
const CLASSES_BY_GRADE = new Map(); // grade -> [class]
const ALL_CLASSES = [];
const CLASS_ROOM = new Map(); // class.id -> 教室名
const SP1_NAMES = new Set();
const SP2_NAMES = new Set();
let SLOT_TOTAL = 0;
let ROOM_TOTAL = 0;

function slotRowsOfGrade(g) {
  return CLASSES_BY_GRADE.get(g).length * 7;
}
function roomRowsOfGrade(g) {
  return CLASSES_BY_GRADE.get(g).length * 8; // 7時限 + 科学2限目のスパン分
}
function totalsAfterClasses() {
  SLOT_TOTAL = GRADES.reduce((a, g) => a + slotRowsOfGrade(g), 0);
  ROOM_TOTAL = GRADES.reduce((a, g) => a + roomRowsOfGrade(g), 0);
}
const classIdsOfGrade = (g) => new Set(CLASSES_BY_GRADE.get(g).map((c) => String(c.id)));

// 特別教室ローテーション対象（学年別）
// room2 対象科目（学年ごとの第2教室科目）と特別教室名
const ROOM2_SUBJECTS = new Map([[2, '技術家庭理論'], [3, '科学']]);
const room2OfGrade = (g) => ROOM2_SUBJECTS.get(Number(g)) ?? null;
const spRoomsOfGrade = (g) => (Number(g) === 2 ? [...SP1_NAMES] : Number(g) === 3 ? [...SP2_NAMES] : []);

const SP1_ROT = ['et-101', 'et-201', 'et-301'];
const SP2_ROT = ['et-301', 'et-302', 'et-303', 'et-304', 'et-305', 'et-306', 'et-307', 'et-308'];
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
  await query(`DELETE FROM curriculum_subjects WHERE id LIKE 'e2e-csub-%'`, []);
  await query(`DELETE FROM classes WHERE id LIKE 'e2e-cls-%'`, []);
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
  // --- クラス・コースマスタ（考査学年の全クラス）---
  for (const g of GRADES) {
    const cs = await basicinfoModel.listClasses(g);
    let extra = 0;
    while (cs.length < 2) {
      const c = await basicinfoModel.createClass({
        id: `e2e-cls-${g}-${extra + 1}`,
        grade: g,
        name: `E2E${g}年${extra + 1}組`,
        short_name: `E2E${g}${extra + 1}`,
        updated_by: KYOMU.id,
      });
      cs.push(c);
      extra++;
    }
    CLASSES_BY_GRADE.set(g, cs);
    ALL_CLASSES.push(...cs);
    for (const c of cs) CLASS_ROOM.set(String(c.id), `E2E-${c.id}教室`);
  }
  totalsAfterClasses();

  // --- 教室マスタ（クラス毎の標準教室 + 特別教室は必要クラス数分）---
  // 容量は実在学年の在籍数（getGradeStudents）を超過しないよう大きめに設定
  const ROOMS = ALL_CLASSES.map((c) => ({
    name: CLASS_ROOM.get(String(c.id)),
    room_type: 'CLASS',
    capacity: 400,
    grades: [Number(c.grade)],
    is_alternate: false,
  }));
  for (let i = 1; i <= CLASSES_BY_GRADE.get(2).length; i++) {
    const n = `SP1-${i}`;
    SP1_NAMES.add(n);
    ROOMS.push({ name: n, room_type: 'SP1', capacity: 400, grades: [], is_alternate: false });
  }
  for (let i = 1; i <= CLASSES_BY_GRADE.get(3).length; i++) {
    const n = `SP2-${i}`;
    SP2_NAMES.add(n);
    ROOMS.push({ name: n, room_type: 'SP2', capacity: 400, grades: [], is_alternate: false });
  }
  ROOMS.push({ name: 'PREP1', room_type: 'PREP1', capacity: 400, grades: [], is_alternate: false });

  await examService.saveRooms(EXAM_ID, ROOMS.map((r) => ({ ...r, exam_master_id: EXAM_ID })), KYOMU);

  // --- 基本情報マッピング（科目 × クラス → 標準教室）---
  const examRoomIdByName = new Map((await examModel.listRooms(EXAM_ID)).map((r) => [r.name, r.id]));
  for (const s of SUBJECTS) {
    const offers = ALL_CLASSES.map((c) => ({
      grade: Number(c.grade),
      class_course_id: String(c.id),
      room_id: examRoomIdByName.get(CLASS_ROOM.get(String(c.id))),
    }));
    await basicinfoModel.createSubject({
      id: `e2e-csub-${s.name}`,
      name: s.name,
      grade: GRADES[0],
      offerings: offers,
      updated_by: KYOMU.id,
    });
  }
}

async function prep2() {
  // --- 教室設定（クラス別標準・予備） ---
  for (const g of GRADES) {
    const classRooms = CLASSES_BY_GRADE.get(g).map((c) => CLASS_ROOM.get(String(c.id)));
    for (const s of SUBJECTS) {
      await examService.saveRoomConfig(EXAM_ID, {
        subject_name: s.name,
        grade: g,
        standard_room: classRooms[0],
        alt_rooms: classRooms.slice(1),
        special_rooms: room2OfGrade(g) === s.name ? spRoomsOfGrade(g) : [],
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

  // 実施科目調査サマリ（実施教科数・必要コマ数・考査期間キャパティ）
  const summary = await examService.surveySummary(EXAM_ID, KYOMU);
  const expectedByGrade = new Map();
  for (const p of plan) {
    const g = Number(p.grade);
    const e = expectedByGrade.get(g) || { subjects: 0, needed: 0 };
    e.subjects += 1;
    e.needed += Number(p.duration_slots) || 1;
    expectedByGrade.set(g, e);
  }
  ok(summary.total === 21 && summary.per_grade.length === 3, `調査サマリ 実施教科数 (${summary.total}/${summary.per_grade.length})`);
  ok(
    summary.per_grade.every((g) => g.subjects === (expectedByGrade.get(g.grade) || {}).subjects && g.needed_slots === (expectedByGrade.get(g.grade) || {}).needed),
    '学年別 実施教科数・必要コマ数'
  );
  ok(summary.capacity_slots === DAYS * SLOTS && summary.per_grade.every((g) => g.capacity_slots === DAYS * SLOTS && g.feasible), `考査期間キャパティ ${DAYS}日×${SLOTS}時限`);
  ok(summary.default_duration === 50, '標準試験時間50分');

  console.log('=== 2. 時間割 ===');
  const t = await examService.solveTimetable(EXAM_ID, KYOMU);
  ok(t.saved === 21, `time table 保存 21スロット (${t.saved})`);
  ok(t.stats.unplacedUnits === 0, `未配置 0 (${t.stats.unplacedUnits})`);
  const tHard = (t.diagnostics.hard || []);
  ok(tHard.length === 0, `時間割 HARD 0 (${tHard.map((d) => d.type).join(',')})`);

  const slots = await examModel.listSlots(EXAM_ID);
  ok(slots.length === 21, `exam_slots 21件 (${slots.length})`);
  ok(
    GRADES.every((g) => new Set(slots.filter((c) => c.grade === g).map((c) => String(c.class_id))).size === 1),
    'exam_slots 学年キー（時間割は学年単位）'
  );
  ok(slots.every((c) => classIdsOfGrade(c.grade).has(String(c.class_id))), 'exam_slots クラスID整合');

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
    const sciStart = slots.find((c) => c.grade === g && c.subject_name === '科学' && c.slot_number === 2);
    const sciNext = slots.find((c) => c.grade === g && c.subject_name === '科学' && c.slot_number === 3);
    if (!sciStart || Number(sciStart.duration_slots) !== 2 || !sciNext) h3 = false;
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
  if (r.stats.unassignedUnits > 0) {
    const roomList = await examModel.listRooms(EXAM_ID);
    const gradeRoomCount = {};
    for (const rm of roomList) {
      const k = (rm.grades || []).join(',') || 'ANY';
      gradeRoomCount[`${k}/${rm.room_type}`] = (gradeRoomCount[`${k}/${rm.room_type}`] || 0) + 1;
    }
    console.log('  ROOM COUNTS', JSON.stringify(gradeRoomCount));
    console.log('  UNASSIGNED', JSON.stringify(r.assignments.filter((a) => !a.room_name).map((a) => `${a.grade}|${a.day}|${a.slot}`)));
    const dbgRooms = roomList.map((rm) => ({
      id: rm.id,
      name: rm.name,
      room_type: rm.room_type,
      capacity: rm.capacity ? Number(rm.capacity) : null,
      grades: (rm.grades || []).map(Number),
    }));
    const dbgAssign = r.assignments.map((a) => ({
      unit_id: a.unit_id,
      class_id: a.class_id,
      class_name: a.class_name,
      grade: a.grade,
      subject_name: a.subject_name,
      day: a.day,
      slot: a.slot,
      duration_slots: a.duration_slots,
    }));
    const dbgOut = solveRooms({
      days: DAYS,
      slots: SLOTS,
      grades: GRADES,
      rooms: dbgRooms,
      room_config: [],
      assignments: dbgAssign,
      broadcast_subjects: ['社会'],
      students: {},
      rules: { rules_by_grade: {}, rules_by_subject: {}, reserved_rooms: [], weights: {} },
    });
    const roomNameById2 = new Map(roomList.map((rm) => [rm.id, rm.name]));
    const dbgConfig = (await examModel.listRoomConfig(EXAM_ID)).map((c) => ({
      subject_name: c.subject_name,
      grade: Number(c.grade),
      class_id: c.class_id ?? null,
      standard_room: c.standard_room,
      alt_rooms: c.alt_rooms,
    }));
    for (const s of await basicinfoModel.listSubjects()) {
      for (const o of s.offerings || []) {
        const cid = String(o?.class_course_id ?? '');
        const rn = o?.room_id ? roomNameById2.get(String(o.room_id)) : null;
        if (!cid || !rn) continue;
        dbgConfig.push({ subject_name: s.name, grade: Number(o.grade) || 0, class_id: cid, standard_room: rn, alt_rooms: [] });
      }
    }
    const dbgRules = {
      rules_by_grade: { 2: 'SP1' },
      rules_by_subject: { '3|科学': 'SP2' },
      reserved_rooms: [],
      weights: {},
      reserve_prep_before_broadcast: true,
    };
    const dbgOut2 = solveRooms({
      days: DAYS,
      slots: SLOTS,
      grades: GRADES,
      rooms: dbgRooms,
      room_config: dbgConfig,
      assignments: dbgAssign,
      broadcast_subjects: ['社会'],
      students: {},
      rules: dbgRules,
    });
    console.log('  DBG2 UNASSIGNED', JSON.stringify(dbgOut2.assignments.filter((a) => !a.room_name).map((a) => `${a.grade}|${a.day}|${a.slot}`).slice(0, 24)));
  }

  const roomRows = await examModel.listRoomAssignments(EXAM_ID);
  ok(roomRows.length === 24, `exam_room_assignments 24 (${roomRows.length})`);
  ok(GRADES.every((g) => roomRows.filter((x) => x.grade === g).length === 8), '教室割当 学年×8スパン');
  ok(GRADES.every((g) => new Set(roomRows.filter((x) => x.grade === g).map((x) => String(x.class_id))).size === 1), '教室割当 学年キー');
  ok(roomRows.filter((x) => x.grade === 2).every((x) => SP1_NAMES.has(x.room_name)), '学年2=SP1 固定');
  ok(
    roomRows.filter((x) => x.grade === 3 && x.subject_name === '科学').every((x) => SP2_NAMES.has(x.room_name)),
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
      .every((x) => x.room_name === CLASS_ROOM.get(String(x.class_id))),
    '通常コマはクラス標準教室'
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
  ok(proctors.length === ROOM_TOTAL, `監督行 ${ROOM_TOTAL}件 (${proctors.length})`);
  ok(proctors.every((p) => classIdsOfGrade(p.grade).has(String(p.class_id))), '監督割当 クラスID整合');
  ok(proctors.every((p) => p.room_name), '監督行に教室割当（クラス別）');
  ok(proctors.filter((p) => p.room_name === CLASS_ROOM.get(String(p.class_id))).every((p) => p.room_type === 'CLASS'), '標準教室マッピング');

  ok(
    proctors.filter((p) => p.subject_name === room2OfGrade(p.grade)).every((p) => p.room_type === 'SP1' || p.room_type === 'SP2' || p.room_type === 'PREP1'),
    'room2科目は特別教室'
  );

  ok(
    proctors.filter((x) => SP1_NAMES.has(x.room_name)).every((x) => SP1_ROT.includes(x.proctor_teacher_id)),
    'SP1ローテーション'
  );
  ok(
    proctors.filter((x) => SP2_NAMES.has(x.room_name)).every((x) => SP2_ROT.includes(x.proctor_teacher_id)),
    'SP2ローテーション(学年3教員)'
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
  ok(soloRows.length === ALL_CLASSES.length && soloRows.every((x) => x.proctor_teacher_id === x.setter_teacher_id), 'ソロ科目=本人監督');

  const loads = (p.stats?.loads || []).map((l) => l.load);
  const range = Math.max(...loads) - Math.min(...loads);
  const topLoads = (p.stats?.loads || []).sort((a, b) => b.load - a.load).slice(0, 4).map((l) => `${l.name}=${l.load}`);
  ok(range <= 8, `負荷均等 幅${range} (top=${topLoads.join(',')} loads=${loads.sort((a, b) => b - a).join(',')})`);

  console.log('=== 6. 手動検証・公表 ===');
  const board = await examService.getProctorBoard(EXAM_ID, KYOMU);
  const manualRows = board.cells.map((c) => ({
    grade: c.grade,
    class_id: c.class_id,
    class_name: c.class_name,
    day_number: c.day_number,
    slot_number: c.slot_number,
    subject_name: c.subject_name,
    room_name: c.room_name,
    room_type: c.room_type,
    proctor_teacher_id: c.proctor_teacher_id,
    setter_teacher_id: c.setter_teacher_id,
  }));
  ok(manualRows.length === ROOM_TOTAL, `board.cells ${ROOM_TOTAL} (${manualRows.length})`);
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
  ok(savedManual.saved === ROOM_TOTAL, `手動保存 ${ROOM_TOTAL}件 (${savedManual.saved})`);

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
  ok(view.rooms.length === 8, `view rooms 8 (${view.rooms.length})`);
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


