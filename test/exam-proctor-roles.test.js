/**
 * ISSystem 定期考査 試験監督 役割モデル（Creator / Patroller）検証
 * ----------------------------------------------------------------
 * 役割の定義（ISSystem仕様書 §8.5）:
 *   Creator（出題者・作成者）= 自科目の実施コマで試験監督をしない。
 *     負荷は 1科目=1単位として算入（count_creator）。
 *   Patroller（巡回者）= 実施階梯を巡回する。負荷 0（count_patrol=false）。
 *     自科目コマの監督兼任と同一コマの二重巡回は HARD で禁止。
 *   負荷公式: 実効負荷 = 監督コマ + 出題単位（巡回者は 0）
 * 対象: src/utils/exam-proctor-solver.js（DB 不要の純粋ユニット）
 * run: npm run test:one -- test/exam-proctor-roles.test.js
 */
import {
  solveProctor,
  validateProctor,
  DEFAULT_PROCTOR_RULES,
} from '../src/utils/exam-proctor-solver.js';

/** 全コマを通常教室（1-1）で埋めた room_cells */
function roomCells(grade, days, slots) {
  const rows = [];
  for (let d = 1; d <= days; d++) {
    for (let s = 1; s <= slots; s++) rows.push({ grade, day: d, slot: s, room_name: '1-1' });
  }
  return rows;
}

const TEACHERS = [
  { id: 't1', name: '出題者1', is_parttime: false },
  { id: 't2', name: '出題者2', is_parttime: false },
  { id: 't3', name: '出題者3', is_parttime: false },
  { id: 'p1', name: '巡回者1', is_parttime: false },
  { id: 'p2', name: '巡回者2', is_parttime: false },
  { id: 'p3', name: '巡回者3', is_parttime: false },
  { id: 'z1', name: '監督専門1', is_parttime: false },
  { id: 'z2', name: '監督専門2', is_parttime: false },
];

const UNITS = [
  { id: 'u1', subject_name: '国語', grade: 1, duration_slots: 1, setter_teacher_id: 't1', patrol_teacher_id: 'p1' },
  { id: 'u2', subject_name: '数学', grade: 1, duration_slots: 2, setter_teacher_id: 't2', patrol_teacher_id: 'p2' },
  { id: 'u3', subject_name: '英語', grade: 1, duration_slots: 1, setter_teacher_id: 't3', patrol_teacher_id: 'p3' },
];

const TIMETABLE = [
  { unit_id: 'u1', grade: 1, day: 1, slot: 1, duration_slots: 1, class_id: 'c1' },
  { unit_id: 'u2', grade: 1, day: 1, slot: 2, duration_slots: 2, class_id: 'c1' },
  { unit_id: 'u3', grade: 1, day: 2, slot: 1, duration_slots: 1, class_id: 'c1' },
];

const INPUT = {
  days: 2,
  slots: 4,
  units: UNITS,
  timetable: TIMETABLE,
  room_cells: roomCells(1, 2, 4),
  teachers: TEACHERS,
  room_config: { special_rooms: [], room2_grades: [] },
  rules: {},
};

/** 役割占有キー集合（作成者・巡回者の実施コマ）を入力から再現する */
function roleBusyKeys() {
  const keys = new Set();
  for (const t of TIMETABLE) {
    const u = UNITS.find((x) => x.id === t.unit_id);
    const duration = Math.min(Number(t.duration_slots) || 1, INPUT.slots - t.slot + 1);
    for (let s = t.slot; s < t.slot + duration; s++) {
      if (u?.setter_teacher_id) keys.add(`${u.setter_teacher_id}|${t.day}|${s}`);
      if (u?.patrol_teacher_id) keys.add(`${u.patrol_teacher_id}|${t.day}|${s}`);
    }
  }
  return keys;
}

describe('試験監督 役割モデル（出題者=1負荷 / 巡回者=0負荷 / 同一コマ占有禁止）', () => {
  const result = solveProctor(INPUT);

  test('ルール既定値に役割モデルが組み込まれている', () => {
    expect(DEFAULT_PROCTOR_RULES.role_model).toBe(true);
    expect(DEFAULT_PROCTOR_RULES.count_creator).toBe(true);
    expect(DEFAULT_PROCTOR_RULES.count_patrol).toBe(false);
  });

  test('全実施コマ（スパン展開 4コマ）に監督教員が立つ', () => {
    expect(result.stats.cells).toBe(4);
    expect(result.unassigned).toBe(0);
    expect(result.assignments.length).toBe(4);
    expect(result.assignments.every((a) => a.proctor_teacher_id)).toBe(true);
  });

  test('出題者・巡回者は自科目コマの監督を兼任しない', () => {
    for (const a of result.assignments) {
      expect(a.proctor_teacher_id).not.toBe(a.creator_teacher_id);
      expect(a.proctor_teacher_id).not.toBe(a.patrol_teacher_id);
    }
  });

  test('作成者・巡回者は占有コマで監督と兼任しない（HARD）', () => {
    const busy = roleBusyKeys();
    for (const a of result.assignments) {
      expect(busy.has(`${a.proctor_teacher_id}|${a.day}|${a.slot}`)).toBe(false);
    }
    const clashes = result.diagnostics.filter((d) =>
      ['PROCTOR_ROLE_CLASH', 'PATROL_CLASH', 'SETTER_CLASH', 'PATROL_MULTI_CLASH'].includes(d.code)
    );
    expect(clashes).toEqual([]);
  });

  test('負荷公式 = 監督コマ + 出題単位（巡回者は 0）', () => {
    for (const l of result.stats.loads) {
      expect(l.load).toBe(l.proctor + l.creator);
    }
    // 巡回者3 は巡回 1単位のみ。巡回は負荷0 なので実効負荷は監督コマと一致
    const p3 = result.stats.loads.find((l) => l.id === 'p3');
    expect(p3.patrol).toBe(1);
    expect(p3.creator).toBe(0);
    expect(p3.load).toBe(p3.proctor);
  });

  test('役割内訳（作成者4コマ・巡回者4コマ）を INFO 診断で報告する', () => {
    expect(result.stats.creators).toBe(4);
    expect(result.stats.patrols).toBe(4);
    const info = result.diagnostics.find((d) => d.code === 'PROCTOR_ROLE_MODEL');
    expect(info).toBeDefined();
    expect(info.level).toBe('INFO');
    expect(info.msg).toContain('作成者 4コマ');
    expect(info.msg).toContain('巡回者 4コマ');
  });

  test('候補が出題者・巡回者だけなら監督を立てられない（未割当＋HARD診断）', () => {
    const tight = { ...INPUT, teachers: [TEACHERS[0], TEACHERS[3]] }; // t1(出題) と p1(巡回) のみ
    const r = solveProctor(tight);
    expect(r.unassigned).toBeGreaterThan(0);
    expect(r.diagnostics.some((d) => d.code === 'PROCTOR_UNASSIGNED' && d.level === 'HARD')).toBe(true);
    // u1 のコマでは t1 も p1 も占有されているため監督候補がいない
    expect(r.assignments.filter((a) => a.unit_id === 'u1').every((a) => !a.proctor_teacher_id)).toBe(true);
  });

  test('validateProctor は巡回者の自科目兼任を HARD で弾く', () => {
    const rows = [
      {
        grade: 1,
        class_id: 'c1',
        day_number: 1,
        slot_number: 1,
        subject_name: '国語',
        duration_slots: 1,
        setter_teacher_id: 't1',
        patrol_teacher_id: 'p1',
        proctor_teacher_id: 'p1',
      },
    ];
    const out = validateProctor({ ...INPUT, teachers: TEACHERS }, rows);
    expect(out.some((d) => d.code === 'PATROL_CLASH' && d.level === 'HARD')).toBe(true);
  });

  test('validateProctor は同一コマの二重巡回を HARD で弾く', () => {
    const rows = [
      {
        grade: 1,
        class_id: 'c1',
        day_number: 1,
        slot_number: 1,
        subject_name: '国語',
        duration_slots: 1,
        setter_teacher_id: 't1',
        patrol_teacher_id: 'p1',
        proctor_teacher_id: 'z1',
      },
      {
        grade: 1,
        class_id: 'c2',
        day_number: 1,
        slot_number: 1,
        subject_name: '数学',
        duration_slots: 1,
        setter_teacher_id: 't2',
        patrol_teacher_id: 'p1',
        proctor_teacher_id: 'z2',
      },
    ];
    const out = validateProctor({ ...INPUT, teachers: TEACHERS }, rows);
    expect(out.some((d) => d.code === 'PATROL_MULTI_CLASH' && d.level === 'HARD')).toBe(true);
  });
});

