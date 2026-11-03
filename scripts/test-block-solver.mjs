/**
 * 時間割コマ組みソルバー 検証スクリプト
 * 1限目は全員受験・最終日は全員受験で埋める・数学Ⅲ 2コマ連続・公共同日同時・放送排他・文理偏り禁止・入れ条件 を検証する
 */
import { solveBlockTimetable, validateBlockPlacements, DEFAULT_TIMETABLE_RULES_BLOCK } from '../src/utils/exam-block-solver.js';

const rows = [
  { id: 'c11', grade: 1, name: '1年1組' },
  { id: 'c21', grade: 2, name: '2年1組' },
  { id: 'c31', grade: 3, name: '3年1組' },
];

const daySlots = [1, 2, 3, 4].map((d) => ({ day: d, enabled_slots: [1, 2, 3, 4, 5] }));
const slots = 5;

const commands = [
  { id: 'kok', name: '国A', duration_slots: 1 },
  { id: 'kob', name: '国B', duration_slots: 1 },
  { id: 'mai', name: '数I', duration_slots: 1 },
  { id: 'maii', name: '数II', duration_slots: 1 },
  { id: 'eec', name: '英C', duration_slots: 1 },
  { id: 'kyo', name: '公共', duration_slots: 1 },
  { id: 'jou', name: '情報', duration_slots: 1 },
  { id: 'tek', name: '適験', duration_slots: 1 },
  { id: 'm3k', name: '家庭情報', duration_slots: 1 },
  { id: 'm3f', name: '数学Ⅲ前', duration_slots: 1 },
  { id: 'm3r', name: '数学Ⅲ後', duration_slots: 1 },
  { id: 'phy', name: '物基', duration_slots: 1 },
  { id: 'che', name: '化基', duration_slots: 1 },
  { id: 'bio', name: '生基', duration_slots: 1 },
  { id: 'his', name: '日本史', duration_slots: 1 },
  { id: 'geo', name: '地理', duration_slots: 1 },
];

const allRows = rows.map((r) => r.id);
const blockOf = (name, rowIds, commandIds, span = commandIds.length, constraints = {}) => ({
  id: `B:${name}`,
  name,
  span,
  constraints,
  cells: rowIds.flatMap((r) => commandIds.map((c, i) => ({ class_course_id: r, offset: i, command_id: c }))),
});

const blocks = [
  blockOf('国A', allRows, ['kok']),
  blockOf('国B', allRows, ['kob']),
  blockOf('数I', allRows, ['mai']),
  blockOf('数II', allRows, ['maii']),
  blockOf('英C', allRows, ['eec']),
  blockOf('公共', allRows, ['kyo']),
  blockOf('情報', allRows, ['jou']),
  blockOf('適験', allRows, ['tek']),
  blockOf('家庭情報', ['c31'], ['m3k']),
  blockOf('数学Ⅲ', ['c31'], ['m3f', 'm3r'], 2, { fixed_start_slot: 2 }),
  blockOf('物基', ['c31'], ['phy']),
  blockOf('化基', ['c31'], ['che']),
  blockOf('生基', ['c31'], ['bio']),
  blockOf('日本史', ['c11'], ['his']),
  blockOf('地理', ['c11'], ['geo']),
];

const groups = [
  {
    id: 'g_all',
    name: '全員受験',
    kind: 'ALL_STUDENTS',
    members: ['B:国A', 'B:国B', 'B:数I', 'B:数II', 'B:英C', 'B:公共', 'B:情報', 'B:適験'],
    constraints: { first_slot_required: true, last_day_required: true },
  },
  { id: 'g_science', name: '理系', kind: 'SCIENCE', members: ['B:物基', 'B:化基', 'B:生基', 'B:数学Ⅲ'], constraints: { day_purity_forbid: true } },
  { id: 'g_arts', name: '文系', kind: 'ARTS', members: ['B:日本史', 'B:地理'], constraints: { day_purity_forbid: true } },
  { id: 'g_broadcast', name: '放送', kind: 'BROADCAST', members: ['B:英C'], constraints: { slot_exclusive: true } },
];

const conditions = [
  // 3年生の物基は 2日目の 2限目に配置できない（入れ条件）
  { block_shape_id: 'B:物基', class_course_id: 'c31', day_number: 2, slot_number: 2, allowed: false },
];

const history = [
  { subject_name: '数学Ⅲ', day_number: 2, slot_number: 3 },
  { subject_name: '物基', day_number: 3, slot_number: 2 },
];

const input = {
  daySlots,
  slots,
  rows,
  commands,
  blocks,
  groups,
  conditions,
  history,
  rules: DEFAULT_TIMETABLE_RULES_BLOCK,
};

const result = solveBlockTimetable(input);

console.log('feasible=', result.feasible, 'relaxed=', result.relaxed, 'penalty=', result.penalty);
console.log('stats=', JSON.stringify(result.stats));
console.log('hard=', JSON.stringify(result.diagnostics.hard, null, 2));

const byPos = new Map();
for (const p of result.placements) {
  for (const c of p.cells) {
    byPos.set(`${c.class_course_id}|${p.day}|${p.slot + c.offset}`, p.name);
  }
}

for (const r of rows) {
  const line = [];
  for (const d of daySlots) {
    const cells = [];
    for (let s = 1; s <= slots; s++) cells.push(byPos.get(`${r.id}|${d.day}|${s}`) || '空');
    line.push(`day${d.day}[${cells.join(',')}]`);
  }
  console.log(`${r.name}: ${line.join(' ')}`);
}

// 検証
const assert = (cond, label) => console.log(cond ? `PASS ${label}` : `FAIL ${label}`);

// 1. 1限目は全員受験グループ
const allGroup = new Set(groups.find((g) => g.kind === 'ALL_STUDENTS').members);
const firstSlotAll = rows.every((r) => allGroup.has(`B:${byPos.get(`${r.id}|1|1`)}`));
assert(firstSlotAll, '1限目は全員受験科目');

// 2. 最終日は全員受験で埋まる
const lastDay = daySlots[daySlots.length - 1].day;
const lastFilled = rows.every((r) =>
  daySlots[daySlots.length - 1].enabled_slots.every((s) => allGroup.has(`B:${byPos.get(`${r.id}|${lastDay}|${s}`)}`))
);
assert(lastFilled, '最終日は全員受験科目で埋まる');

// 3. 数学Ⅲは 2コマ連続・固定 2限開始
const m3 = result.placements.find((p) => p.name === '数学Ⅲ');
assert(m3 && m3.slot === 2 && m3.span === 2, '数学Ⅲは 2限からの 2コマ連続');

// 4. 公共は全学年同じ日・同じ時限
const publicBlock = result.placements.find((p) => p.name === '公共');
const publicCells = publicBlock.cells;
const samePos = publicCells.every((c) => byPos.get(`${c.class_course_id}|${publicBlock.day}|${publicBlock.slot}`) === '公共');
assert(samePos && publicCells.length === 3, '公共は 3学年同日前同時間');

// 5. 英語Comm の放送排他
const bc = result.placements.filter((p) => p.name === '英C');
assert(bc.length === 1, '放送（英C）は同日同時刻に複数配置されない');

// 6. 入れ条件：物基は 2日目2限に配置されない
assert(!(byPos.get('c31|2|2') === '物基'), '入れ条件（物基 2日目2限 禁止）遵守');

// 7. 文理偏り：同日を理系のみ／文系のみで埋めない
const dayNames = new Map();
for (const p of result.placements) {
  if (!dayNames.has(p.day)) dayNames.set(p.day, []);
  if (!dayNames.get(p.day).includes(p.name)) dayNames.get(p.day).push(p.name);
}
const sciSet = new Set(groups.find((g) => g.kind === 'SCIENCE').members.map((m) => m.replace('B:', '')));
const artsSet = new Set(groups.find((g) => g.kind === 'ARTS').members.map((m) => m.replace('B:', '')));
const purityOk = [...dayNames.values()].every(
  (names) => !(names.every((n) => sciSet.has(n))) && !(names.every((n) => artsSet.has(n)))
);
assert(purityOk, '同日を理系のみ／文系のみで埋めない');

// 8. 配置コマ組み数
assert(result.placements.length === blocks.length, '全コマ組みが配置される');

// 9. 手動配置（物基を 2日2限に置く）は検証で弾かれる
const manual = result.placements.map((p) => (p.name === '物基' ? { ...p, day: 2, slot: 2 } : p));
const v = validateBlockPlacements({ ...input, placements: manual, commandNames: new Map(commands.map((c) => [c.id, c.name])) });
assert(v.hard.some((h) => h.type === 'CONDITION_FORBIDDEN'), '検証は入れ条件違反を検出する');

// ===== テスト2: 1限目は 1コマ・クラス別入れ条件・連続配置・グループ排他 =====
const rows2 = [
  { id: 'r11', grade: 1, name: '1年1組' },
  { id: 'r21', grade: 2, name: '2年1組' },
];
const daySlots2 = [{ day: 1, enabled_slots: [1, 2, 3] }, { day: 2, enabled_slots: [1, 2, 3] }];
const commands2 = [
  { id: 'k1', name: '1限目', duration_slots: 1 },
  { id: 'k2', name: '2限目', duration_slots: 1 },
  { id: 'k3', name: '3限目', duration_slots: 1 },
];
const blocks2 = [
  // 1限目は 1コマ形状（H2）: 両クラス同位置で置く
  { id: 'B2:all1', name: '全員1限', span: 1, constraints: {}, cells: [
    { class_course_id: 'r11', offset: 0, command_id: 'k1' },
    { class_course_id: 'r21', offset: 0, command_id: 'k1' },
  ] },
  // 2コマ科目（複数時限で 1コマ）: 1年1組
  { id: 'B2:ren1', name: '2限目', span: 2, constraints: {}, cells: [
    { class_course_id: 'r11', offset: 0, command_id: 'k2' },
    { class_course_id: 'r11', offset: 1, command_id: 'k3' },
  ] },
  { id: 'B2:ren2', name: '2限目B', span: 2, constraints: {}, cells: [
    { class_course_id: 'r21', offset: 0, command_id: 'k2' },
    { class_course_id: 'r21', offset: 1, command_id: 'k3' },
  ] },
];
const groups2 = [
  { id: 'g2_all', name: '全員受験', kind: 'ALL_STUDENTS', members: ['B2:all1'], constraints: { first_slot_required: true } },
];
// クラス別入れ条件: 1年1組の 1日目1限 に「2限目」は入れない（×）
const conditions2 = [{ block_shape_id: 'B2:ren1', class_course_id: 'r11', day_number: 1, slot_number: 1, allowed: false }];
const rules2 = { total_slots: 3, day_count: 2, consecutive_min_slots: 0 };

const result2 = solveBlockTimetable({
  daySlots: daySlots2,
  slots: 3,
  rows: rows2,
  commands: commands2,
  blocks: blocks2,
  groups: groups2,
  conditions: conditions2,
  history: [],
  rules: rules2,
});

const byPos2 = new Map();
for (const p of result2.placements) {
  for (const c of p.cells) byPos2.set(`${c.class_course_id}|${p.day}|${p.slot + c.offset}`, p.name);
}

assert(result2.stats.unplacedBlocks === 0, 'テスト2: 全コマ組みが配置される');
assert(result2.placements.filter((p) => p.name === '全員1限').every((p) => p.span === 1 && p.slot === 1), 'テスト2: 1限目は 1コマ形状で配置');
assert(byPos2.get('r11|1|1') === '全員1限', 'テスト2: クラス別入れ条件（1年1組 1日目1限 に 2限目を置かない）遵守');

const ren1 = result2.placements.find((p) => p.name === '2限目');
assert(
  byPos2.get(`r11|${ren1.day}|${ren1.slot}`) === '2限目' && byPos2.get(`r11|${ren1.day}|${ren1.slot + 1}`) === '2限目',
  'テスト2: 2コマ科目は連続する時限に配置'
);

// グループ排他: 同一マスに SCIENCE と ARTS が同時配置されない
const groups3 = [
  { id: 'gA', name: 'A', kind: 'SCIENCE', members: ['B2:all1'], constraints: { exclusive_with: ['gB'] } },
  { id: 'gB', name: 'B', kind: 'ARTS', members: ['B2:all1'], constraints: { exclusive_with: ['gA'] } },
];
const v3 = validateBlockPlacements({
  daySlots: daySlots2,
  slots: 3,
  rows: rows2,
  commands: commands2,
  blocks: blocks2,
  groups: groups3,
  conditions: [],
  history: [],
  rules: rules2,
  placements: result2.placements,
  commandNames: new Map(commands2.map((c) => [c.id, c.name])),
});
assert(v3.hard.some((h) => h.type === 'GROUP_EXCLUSIVE'), 'テスト2: グループ排他違反を検出する');

// ===== テスト3: 排他グループは同じ開始コマを共有しない（ソルバー遵守） =====
const blocks3 = [
  { id: 'B3:a', name: 'A科目', span: 1, constraints: {}, cells: [{ class_course_id: 'r11', offset: 0, command_id: 'k2' }] },
  { id: 'B3:b', name: 'B科目', span: 1, constraints: {}, cells: [{ class_course_id: 'r21', offset: 0, command_id: 'k3' }] },
];
const groups4 = [
  { id: 'gA', name: 'A', kind: 'SCIENCE', members: ['B3:a'], constraints: { exclusive_with: ['gB'] } },
  { id: 'gB', name: 'B', kind: 'ARTS', members: ['B3:b'], constraints: { exclusive_with: ['gA'] } },
];
const res3 = solveBlockTimetable({
  daySlots: daySlots2,
  slots: 3,
  rows: rows2,
  commands: commands2,
  blocks: blocks3,
  groups: groups4,
  conditions: [],
  history: [],
  rules: rules2,
});
const pa = res3.placements.find((p) => p.block_id === 'B3:a');
const pb = res3.placements.find((p) => p.block_id === 'B3:b');
assert(pa && pb, 'テスト3: 排他グループの配置が完成する');
assert(!(pa.day === pb.day && pa.slot === pb.slot), 'テスト3: 排他グループは同じ開始コマを共有しない');
const v5 = validateBlockPlacements({
  daySlots: daySlots2,
  slots: 3,
  rows: rows2,
  commands: commands2,
  blocks: blocks3,
  groups: groups4,
  conditions: [],
  history: [],
  rules: rules2,
  placements: res3.placements,
  commandNames: new Map(commands2.map((c) => [c.id, c.name])),
});
assert(v5.hard.length === 0, 'テスト3: 排他配置の検証はクリーン');


