/**
 * ISSystem 定期考査 試験日程ヘルパ
 * -------------------------------------------------------------
 * 「×（使用不能コマ）」を扱うための共通ロジック
 *  - 全学年共通の × : exam_masters.schedule_cells（暦日 × 時限 の排除リスト）
 *      → 暦日 1 日を全時限 × にすると「試験実施日」そのものから除外される
 *  - 学年固有の ×  : exam_slots.is_blocked = true（subject_name = NULL）
 *
 * day_number は常に「試験実施日番号」（暦日を飛ばした実施日の連番 1..N）で、
 * exam_slots / exam_trips / exam_proctor_assignments / exam_room_assignments /
 * exam_parttime_availability で共通する。
 */

import { parseJson } from './db.js';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 期間（開始日〜終了日）の暦日リスト */
export function examDateRange(start, end) {
  const out = [];
  const d1 = new Date(String(start).slice(0, 10));
  const d2 = new Date(String(end).slice(0, 10));
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return out;
  for (const d = new Date(d1); d <= d2; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** 暦日の曜日ラベル */
export function weekdayOf(date) {
  const d = new Date(String(date).slice(0, 10));
  if (Number.isNaN(d.getTime())) return '';
  return WEEKDAY_LABELS[d.getDay()];
}

/**
 * schedule_cells（全学年共通の ×）を正規化する
 * @param {string|Array} value JSON文字列 / [{day, slot}]
 * @param {number} days 暦日数（1..days_count）
 * @param {number} slots 1日あたりコマ数（1..daily_slots）
 * @returns {Array<{day:number, slot:number}>}
 */
export function normalizeScheduleCells(value, days, slots) {
  const list = parseJson(value, []);
  const out = [];
  const seen = new Set();
  for (const c of Array.isArray(list) ? list : []) {
    const day = Number(c?.day ?? c?.day_number) || 0;
    const slot = Number(c?.slot ?? c?.slot_number) || 0;
    if (day < 1 || day > days || slot < 1 || slot > slots) continue;
    const key = `${day}|${slot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ day, slot });
  }
  out.sort((a, b) => a.day - b.day || a.slot - b.slot);
  return out;
}

/**
 * 試験実施日（暦日）× 時限のグリッドを構築する
 * 全時限が × の暦日は「試験実施日」から除外され、day 番号は実施日の連番になる。
 * @param {{start_date:string, end_date:string, days_count:number, daily_slots:number, schedule_cells:string|Array}} master
 * @returns {Array<{day:number, cal_day:number, date:string, weekday:string, slots:Array<{slot:number, blocked:boolean}>, enabled_slots:number[]}>}
 */
export function buildDaySlots(master) {
  const days = Number(master.days_count) || 0;
  const slots = Number(master.daily_slots) || 0;
  const dates = examDateRange(master.start_date, master.end_date);
  const blocked = new Set(normalizeScheduleCells(master.schedule_cells, days, slots).map((c) => `${c.day}|${c.slot}`));

  const out = [];
  for (let cal = 1; cal <= days; cal++) {
    const date = dates[cal - 1] || '';
    const cells = [];
    for (let s = 1; s <= slots; s++) cells.push({ slot: s, blocked: blocked.has(`${cal}|${s}`) });
    const enabled = cells.filter((c) => !c.blocked).map((c) => c.slot);
    if (!enabled.length) continue;
    out.push({
      day: out.length + 1,
      cal_day: cal,
      date,
      weekday: weekdayOf(date),
      slots: cells,
      enabled_slots: enabled,
    });
  }
  return out;
}

/** 暦日番号 → 試験実施日番号（実施日でない暦日は null） */
export function calendarToExamDay(daySlots, calDay) {
  const d = daySlots.find((x) => x.cal_day === Number(calDay));
  return d ? d.day : null;
}

/** 試験実施日番号 → 暦日番号（旧-daySlots マッピング用） */
export function examDayToCalendar(daySlots, day) {
  const d = daySlots[Number(day) - 1];
  return d ? d.cal_day : null;
}

/** 試験実施日番号 → 日付 */
export function examDayDate(daySlots, day) {
  const d = daySlots[Number(day) - 1];
  return d ? d.date : null;
}

/** 暦日付 → 試験実施日番号（出欠記録の日付を出張等候補へ変換する際に使用） */
export function dateToExamDay(daySlots, date) {
  const key = String(date || '').slice(0, 10);
  const d = daySlots.find((x) => x.date === key);
  return d ? d.day : null;
}

/**
 * ソルバーへ渡す「使用可能コマ」情報
 * @param {Array} daySlots buildDaySlots の結果
 * @returns {Array<{day:number, slots:number[]}>}
 */
export function toSolverDaySlots(daySlots) {
  return daySlots.map((d) => ({ day: d.day, slots: d.enabled_slots }));
}

/**
 * × セットの構築（全学年共通 × + 学年固有 ×）
 * @param {Array} daySlots buildDaySlots の結果
 * @param {Array<{grade:number, day:number, slot:number}>} gradeBlocks 学年固有 ×（exam_slots.is_blocked 行）
 * @returns {Set<string>} `${grade}|${day}|${slot}` 形式のキー集合
 */
export function buildBlockedSet(daySlots, gradeBlocks, grades) {
  const set = new Set();
  for (const d of daySlots) {
    for (const c of d.slots) {
      if (!c.blocked) continue;
      for (const g of grades) set.add(`${Number(g)}|${d.day}|${c.slot}`);
    }
  }
  for (const b of gradeBlocks || []) {
    set.add(`${Number(b.grade)}|${Number(b.day)}|${Number(b.slot)}`);
  }
  return set;
}

/** × セットに含まれるか（grade が含まれない学年は × を考慮しない） */
export function isBlockedCell(blockedSet, grade, day, slot) {
  return blockedSet.has(`${Number(grade)}|${Number(day)}|${Number(slot)}`);
}

/** 実配置コマ数（充填率の分母）: 使用可能コマから学年固有 × を除いた数 */
export function availableCellCount(daySlots, grades, blockedSet) {
  let total = 0;
  for (const g of grades) {
    for (const d of daySlots) {
      for (const s of d.enabled_slots) {
        if (!blockedSet.has(`${Number(g)}|${d.day}|${s}`)) total += 1;
      }
    }
  }
  return total;
}

/** 試験実施日として残っている暦日番号リスト（全時限 × の暦日は除外済み） */
export function enabledDays(daySlots) {
  return daySlots.map((d) => d.cal_day);
}

/**
 * 実施日番号の新旧マッピング（暦日の × 追加で実施日が圧縮された後の追随）
 * @param {Array} oldDaySlots 変更前の buildDaySlots 結果
 * @param {Array} newDaySlots 変更後の buildDaySlots 結果
 * @param {Iterable<number>} oldDays 旧実施日番号（exam_* テーブルに現れている値）
 * @returns {Map<number, number>} 旧実施日番号 → 新実施日番号（実施日外は除外）
 */
export function remapDays(oldDaySlots, newDaySlots, oldDays) {
  const mapping = new Map();
  const oldEnabled = enabledDays(oldDaySlots);
  const newEnabled = enabledDays(newDaySlots);
  for (const d of oldDays) {
    const old = Number(d);
    const calendarIndex = oldEnabled[old - 1];
    if (calendarIndex == null) continue;
    const idx = newEnabled.indexOf(calendarIndex);
    if (idx >= 0) mapping.set(old, idx + 1);
  }
  return mapping;
}

/**
 * 未割当科目（実施科目プランにあり、かつ 使用可能コマ数 > 実配置コマ数）
 * @param {Array} plan 実施科目プラン（exam_subject_plan）
 * @param {Array} slots exam_slots の試験実施行（is_blocked=false）
 * @param {Array} daySlots buildDaySlots の結果
 * @param {Array} gradeBlocks 学年固有 ×
 * @param {Array<number>} grades 対象学年
 * @returns {Array<{grade:number, subject_name:string, planned:number, placed:number}>}
 */
export function unassignedUnits(plan, slots, daySlots, gradeBlocks, grades) {
  const blockedSet = buildBlockedSet(daySlots, gradeBlocks, grades);
  const capacity = new Map();
  for (const g of grades) {
    let usable = 0;
    for (const d of daySlots) {
      for (const s of d.enabled_slots) {
        if (!blockedSet.has(`${Number(g)}|${d.day}|${s}`)) usable += 1;
      }
    }
    capacity.set(Number(g), usable);
  }

  const plannedByGrade = new Map();
  for (const p of plan || []) {
    const g = Number(p.grade) || 0;
    const name = String(p.subject_name || '').trim();
    if (!name) continue;
    const key = g === 0 ? `ALL:${name}` : `${g}:${name}`;
    const need = Number(p.duration_slots) || 1;
    plannedByGrade.set(key, (plannedByGrade.get(key) || 0) + need);
  }

  const placedByGrade = new Map();
  for (const s of slots || []) {
    if (s.is_blocked) continue;
    const g = Number(s.grade) || 0;
    const name = String(s.subject_name || '').trim();
    if (!name) continue;
    const key = g === 0 ? `ALL:${name}` : `${g}:${name}`;
    placedByGrade.set(key, (placedByGrade.get(key) || 0) + (Number(s.slot_span) || 1));
  }

  const out = [];
  for (const [key, planned] of plannedByGrade.entries()) {
    const placed = placedByGrade.get(key) || 0;
    if (placed >= planned) continue;
    const grade = key.startsWith('ALL:') ? 0 : Number(key.split(':')[0]);
    out.push({
      grade,
      subject_name: key.split(':').slice(1).join(':'),
      planned,
      placed,
      capacity: capacity.get(grade) ?? null,
    });
  }
  out.sort((a, b) => a.grade - b.grade || a.subject_name.localeCompare(b.subject_name, 'ja'));
  return out;
}

/**
 * 実施日番号の対応（現実施日セット → 新実施日セット）。
 * 両セットを昇順で並べ、先頭から対応付ける（実施日が減った場合、末尾は対応なし）。
 * @param {Iterable<number>} oldDays 旧実施日番号
 * @param {Iterable<number>} newDays 新実施日番号
 * @returns {Map<number, number>} 旧実施日番号 → 新実施日番号
 */
export function mapExamDays(oldDays, newDays) {
  const oldSorted = [...new Set([...oldDays].map(Number))].sort((a, b) => a - b);
  const newSorted = [...new Set([...newDays].map(Number))].sort((a, b) => a - b);
  const mapping = new Map();
  for (let i = 0; i < Math.min(oldSorted.length, newSorted.length); i++) {
    mapping.set(oldSorted[i], newSorted[i]);
  }
  return mapping;
}

/**
 * ×（使用不能コマ）数の集計
 * 全学年共通 × は対象学年分のコマ数、学年固有 × は 1 コマとして数える。
 * @param {Array} daySlots buildDaySlots の結果
 * @param {Set<string>} blockedSet buildBlockedSet の結果（`${grade}|${day}|${slot}`）
 * @param {Array<number>} grades 対象学年
 * @returns {number} × コマ数の合計
 */
export function countBlocked(daySlots, blockedSet, grades) {
  const gradeList = (grades || []).map(Number);
  let total = 0;
  for (const d of daySlots) {
    for (const c of d.slots) {
      if (c.blocked) total += gradeList.length;
    }
  }
  for (const d of daySlots) {
    for (const s of d.enabled_slots) {
      for (const g of gradeList) {
        if (blockedSet.has(`${g}|${d.day}|${s}`)) total += 1;
      }
    }
  }
  return total;
}

export default buildDaySlots;
