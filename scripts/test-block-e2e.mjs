/**
 * コマ組み（block）時間割 E2E テスト（実 DB + 実サービス + 実ソルバー）
 * 実行: node --env-file=.env scripts/test-block-e2e.mjs
 * 流れ: 考査作成 → 実施科目プラン → コマ生成 → コマ組み生成 → グループ初期化
 *       → 入れ条件設定 → コマ組みソルバー（save）→ 検証（保存済み配置）→ クリーンアップ
 */
import bcrypt from 'bcrypt';
import { query, pool } from '../config/database.js';
import config from '../config/default.js';
import examService from '../src/services/exam.service.js';
import examModel from '../src/models/exam.model.js';
import basicinfoModel from '../src/models/basicinfo.model.js';

const EXAM_ID = 'blk-e2e';
const DAYS = 4;
const SLOTS = 3;
const GRADES = [1, 2];
const CLASSES_PER_GRADE = 2;
const KYOMU = { id: 'bt-kyomu', role: 'KYOMU' };

// 実施科目（全員受験＝1限目・最終日必須／理系／放送／2コマ連続）
// 全員受験科目は 1限目（全日）＋最終日の全コマを埋める必要があるので、6コマ分以上を用意する
const SUBJECTS = [
  { name: '公共', slots: 1, group: 'ALL_STUDENTS' },
  { name: '国語A', slots: 1, group: 'ALL_STUDENTS' },
  { name: '国語B', slots: 1, group: 'ALL_STUDENTS' },
  { name: '国語C', slots: 1, group: 'ALL_STUDENTS' },
  { name: '英語A', slots: 1, group: 'ALL_STUDENTS' },
  { name: '数学', slots: 2, group: 'ALL_STUDENTS' },
  { name: '理科基礎', slots: 1, group: 'SCIENCE' },
  { name: '社会', slots: 1, group: 'BROADCAST' },
];

// 入れ条件: 1年1組の 2日目2限 に 理科基礎 は入れない（×）
const FORBIDDEN = { shape_grade: 1, subject: '理科基礎', class_id: 'blk-cls-1-1', day: 2, slot: 2 };

const expectedCells = GRADES.length * CLASSES_PER_GRADE * SUBJECTS.reduce((a, s) => a + s.slots, 0);

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
    'exam_slots', 'exam_subject_plan', 'exam_phases', 'exam_timetable_rules',
    'exam_commands', 'exam_block_shapes', 'exam_block_groups', 'exam_block_conditions',
  ];
  for (const t of tables) {
    await query(`DELETE FROM ${t} WHERE exam_master_id = ?`, [EXAM_ID]);
  }
  await query(`DELETE FROM classes WHERE id LIKE 'blk-cls-%'`, []);
  await query(`DELETE FROM users WHERE id LIKE 'bt-%'`, []);
}

async function prep() {
  await cleanup();
  const hash = bcrypt.hashSync('blktest', config.auth.bcryptSaltRounds);
  await query(
    `INSERT INTO users (id, staff_code, name, password_hash, role, grade, is_parttime)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [KYOMU.id, KYOMU.id, 'BLK教務', hash, 'KYOMU', null, false]
  );

  await examService.createMaster(
    {
      id: EXAM_ID,
      title: 'コマ組みE2E',
      start_date: '2026-02-16',
      end_date: '2026-02-19',
      days_count: DAYS,
      daily_slots: SLOTS,
      grades: GRADES,
      created_by: KYOMU.id,
    },
    KYOMU
  );

  const classesByGrade = new Map();
  for (const g of GRADES) {
    const cs = [];
    for (let i = 1; i <= CLASSES_PER_GRADE; i += 1) {
      const c = await basicinfoModel.createClass({
        id: `blk-cls-${g}-${i}`,
        grade: g,
        name: `BLK${g}年${i}組`,
        short_name: `B${g}${i}`,
        updated_by: KYOMU.id,
      });
      cs.push(c);
    }
    classesByGrade.set(g, cs);
  }

  const plan = [];
  for (const g of GRADES) {
    const cs = classesByGrade.get(g).map((c) => String(c.id));
    for (const s of SUBJECTS) {
      plan.push({
        exam_master_id: EXAM_ID,
        subject_name: s.name,
        grade: g,
        scope: 'ALL',
        stream: s.group === 'SCIENCE' ? 'SCIENCE' : 'OTHER',
        setter_teacher_id: KYOMU.id,
        duration_slots: s.slots,
        broadcast_slot: s.group === 'BROADCAST',
        submit_status: 'SUBMITTED',
        class_ids: cs,
        courses: cs.map((cid) => ({ class_course_id: cid })),
      });
    }
  }
  await examModel.bulkInsertSubjectPlan(EXAM_ID, plan, KYOMU.id);
  return classesByGrade;
}


async function main() {
  console.log('=== 1. 準備（考査・クラス・実施科目） ===');
  const classesByGrade = await prep();
  const rows = GRADES.flatMap((g) => classesByGrade.get(g).map((c) => String(c.id)));
  ok(rows.length === GRADES.length * CLASSES_PER_GRADE, `クラス行 ${rows.length} (${GRADES.length * CLASSES_PER_GRADE})`);

  console.log('=== 2. コマ生成 ===');
  const cmdRes = await examService.generateCommands(EXAM_ID, KYOMU);
  const expectedCommands = SUBJECTS.length;
  ok(cmdRes.inserted === expectedCommands, `コマ生成 ${cmdRes.inserted}件 (${expectedCommands})`);
  const commands = await examModel.listCommands(EXAM_ID);
  ok(commands.length === expectedCommands, `exam_commands ${commands.length}件 (${expectedCommands})`);
  ok(
    commands.every((c) => (c.courses || []).length === CLASSES_PER_GRADE * GRADES.length),
    'コマは対象学年の全クラスを含む'
  );

  console.log('=== 3. コマ組み生成 ===');
  const shapeRes = await examService.generateBlockShapes(EXAM_ID, KYOMU);
  ok(shapeRes.inserted === expectedCommands, `コマ組み生成 ${shapeRes.inserted}件 (${expectedCommands})`);
  const shapes = await examModel.listBlockShapes(EXAM_ID);
  ok(shapes.length === expectedCommands, `exam_block_shapes ${shapes.length}件 (${expectedCommands})`);
  const mathShape = shapes.find((s) => s.name === '数学');
  ok(
    mathShape &&
      Number(mathShape.span) === 2 &&
      mathShape.cells.length === 2 * CLASSES_PER_GRADE * GRADES.length,
    '2コマ科目の形状はコマ数2・全クラスセル'
  );

  console.log('=== 4. グループ初期化 ===');
  const seed = await examService.seedBlockGroups(EXAM_ID, KYOMU);
  ok(seed.created >= 4, `グループ初期化 ${seed.created}件`);
  const cmdIds = (await examModel.listCommands(EXAM_ID)).map((c) => String(c.id));
  const idsOf = (name) => cmdIds.filter((id) => id.endsWith(`:${name}`));
  const memberNames = {
    ALL_STUDENTS: ['公共', '国語A', '国語B', '国語C', '英語A', '数学'],
    SCIENCE: ['理科基礎'],
    BROADCAST: ['社会'],
  };
  for (const g of seed.groups) {
    const names = memberNames[g.kind] || [];
    const members = [...new Set(names.flatMap(idsOf))];
    await examModel.upsertBlockGroup({ ...g, exam_master_id: EXAM_ID, members, updated_by: KYOMU.id });
  }
  const groups = await examModel.listBlockGroups(EXAM_ID);
  const allGroup = groups.find((g) => g.kind === 'ALL_STUDENTS');
  const allExpected = SUBJECTS.filter((s) => s.group === 'ALL_STUDENTS').length;
  ok(allGroup && allGroup.members.length === allExpected, `全員受験メンバー ${allGroup?.members?.length ?? 0}件 (${allExpected})`);

  console.log('=== 5. 入れ条件設定 ===');
  const shapeId = `blk:${FORBIDDEN.subject}`;
  const condRes = await examService.saveBlockConditions(
    EXAM_ID,
    shapeId,
    [{ class_course_id: FORBIDDEN.class_id, day_number: FORBIDDEN.day, slot_number: FORBIDDEN.slot, allowed: false }],
    KYOMU
  );
  ok((condRes.saved || []).length >= 1, `入れ条件保存 ${(condRes.saved || []).length}件`);

  console.log('=== 6. コマ組みソルバー（save） ===');
  const result = await examService.solveBlockTimetable(EXAM_ID, KYOMU, { save: true });
  console.log(`  stats=${JSON.stringify(result.stats)} relaxed=${result.relaxed}`);
  ok(result.feasible, `ソルバー feasible (HARD ${result.diagnostics.hard.length}件)`);
  ok(result.stats.unplacedBlocks === 0, `全コマ組み配置（未配置 ${result.stats.unplacedBlocks}）`);
  ok(result.saved === expectedCells, `保存 ${result.saved}コマ (${expectedCells})`);

  // 1限目＝全員受験（H1）と最終日全コマ全員受験（H2）
  const allShapeIds = new Set(SUBJECTS.filter((s) => s.group === 'ALL_STUDENTS').map((s) => `blk:${s.name}`));
  const cellMap = new Map();
  for (const p of result.placements) {
    for (const c of p.cells) cellMap.set(`${c.class_course_id}|${p.day}|${p.slot + c.offset}`, p.block_id);
  }
  ok(rows.every((r) => allShapeIds.has(cellMap.get(`${r}|1|1`))), '1限目は全員受験コマ組み');
  const lastSlots = [...Array(SLOTS).keys()].map((i) => i + 1);
  ok(
    rows.every((r) => lastSlots.every((s) => allShapeIds.has(cellMap.get(`${r}|${DAYS}|${s}`)))),
    `最終日（${DAYS}日目）は全員受験で全コマ埋まる`
  );

  // 2コマ科目は連続配置（学年横断で1つのコマ組み）
  const mathPl = result.placements.filter((p) => p.name === '数学');
  ok(mathPl.length === 1 && mathPl.every((p) => p.slot + 1 <= SLOTS), '2コマ科目は連続時限に配置');

  // 放送は同日同時刻に複数配置しない
  const bcPos = result.placements.filter((p) => p.name === '社会').map((p) => `${p.day}|${p.slot}`);
  ok(new Set(bcPos).size === bcPos.length, `放送（社会）は同日同時刻に重複なし (${bcPos.length}配置)`);

  // 入れ条件遵守
  ok(
    cellMap.get(`${FORBIDDEN.class_id}|${FORBIDDEN.day}|${FORBIDDEN.slot}`) !== shapeId,
    `入れ条件（${FORBIDDEN.class_id} ${FORBIDDEN.day}日目${FORBIDDEN.slot}限 に ${FORBIDDEN.subject} ×）遵守`
  );

  console.log('=== 7. 保存済み配置の検証 ===');
  const check = await examService.validateBlockTimetable(EXAM_ID, null, KYOMU);
  for (const h of check.hard || []) console.log(`  HARD ${h.type}: ${h.message}`);
  ok((check.hard || []).length === 0, `検証 HARD 0件（软 ${(check.soft || []).length}件）`);
  const slotRows = (await examModel.listSlots(EXAM_ID)).filter((s) => !s.is_blocked && s.subject_name);
  ok(slotRows.length === expectedCells, `exam_slots ${slotRows.length}件 (${expectedCells})`);

  console.log('=== 8. 手動配置（入れ条件違反）は検証で弾かれる ===');
  const manual = result.placements.map((p) => (p.block_id === shapeId ? { ...p, day: FORBIDDEN.day, slot: FORBIDDEN.slot } : p));
  const v = await examService.validateBlockTimetable(EXAM_ID, manual, KYOMU);
  for (const h of v.hard || []) console.log(`  HARD ${h.type}: ${h.message}`);
  ok((v.hard || []).some((h) => h.type === 'CONDITION_FORBIDDEN'), '検証は入れ条件違反を検出する');

  console.log('=== 9. 手動配置 API（placeBlockShape: 保存と HARD 検証） ===');
  const shape = (await examModel.listBlockShapes(EXAM_ID)).find((s) => String(s.id) === shapeId);
  const shapeRows = [...new Set((shape?.cells || []).map((c) => String(c.class_course_id)))];
  let placed = null;
  for (let d = 1; d <= DAYS && !placed; d++) {
    for (let s = 1; s <= SLOTS && !placed; s++) {
      const rowsPayload = shapeRows.map((r) => ({ class_course_id: r, day_number: d, slot_number: s }));
      const res = await examService.placeBlockShape(EXAM_ID, shapeId, { rows: rowsPayload }, KYOMU);
      if (res.ok) placed = { d, s, res };
    }
  }
  ok(!!placed && placed.res.saved === shapeRows.length, `手動配置の保存 ${placed?.res.saved ?? 0}コマ (${shapeRows.length})`);
  const afterSlots = (await examModel.listSlots(EXAM_ID)).filter((s) => !s.is_blocked && s.subject_name);
  ok(afterSlots.length === expectedCells, `手動配置後も exam_slots ${expectedCells}件 (${afterSlots.length})`);
  ok(
    shapeRows.every((r) =>
      afterSlots.some(
        (s) =>
          String(s.class_id) === r &&
          Number(s.day_number) === placed.d &&
          Number(s.slot_number) === placed.s &&
          String(s.block_shape_id) === shapeId
      )
    ),
    '移動した位置が exam_slots に保存されている'
  );

  const bad = await examService.placeBlockShape(
    EXAM_ID,
    shapeId,
    { rows: [{ class_course_id: FORBIDDEN.class_id, day_number: FORBIDDEN.day, slot_number: FORBIDDEN.slot }] },
    KYOMU
  );
  for (const h of bad.hard || []) console.log(`  HARD ${h.code}: ${h.message}`);
  ok(bad.ok === false && (bad.hard || []).some((h) => h.code === 'CONDITION_FORBIDDEN'), '入れ条件マスへの手動配置は HARD で弾かれる');
  const afterBad = (await examModel.listSlots(EXAM_ID)).filter((s) => !s.is_blocked && s.subject_name);
  ok(
    afterBad.length === expectedCells &&
      !afterBad.some(
        (s) =>
          String(s.class_id) === FORBIDDEN.class_id &&
          Number(s.day_number) === FORBIDDEN.day &&
          Number(s.slot_number) === FORBIDDEN.slot &&
          String(s.block_shape_id) === shapeId
      ),
    '弾かれた手動配置は exam_slots を変更しない'
  );
}

try {
  await main();
} catch (e) {
  failures.push(`例外: ${e.message}`);
  console.log('  ✗ 例外', e);
}

console.log(`\n=== 結果: ${failures.length} 件の失敗 ===`);
for (const f of failures) console.log(` - ${f}`);

await cleanup();
await pool.end();
process.exit(failures.length ? 1 : 0);
