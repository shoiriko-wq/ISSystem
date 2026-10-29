/**
 * ISSystem 定期考査 試験監督割当自動作成ソルバー
 * ----------------------------------------------------------------
 * 入力（service 由来）:
 *   days, slots
 *   units      [{id, subject_name, grade, duration_slots, setter_teacher_id, solo_subject}]
 *   timetable  [{unit_id, grade, day, slot, duration_slots}]
 *   teachers   [{id, name, is_parttime, is_kyomu, daily_limit, max_consecutive}]
 *   parttime_staff [{teacher_id, daily_limit, max_consecutive, consecutive_rule}]
 *   parttime_availability [{teacher_id, day_number, slot_number, can_work}]
 *   trips      [{teacher_id, day_number, slot_number}]
 *   room_cells [{grade, day, slot, room_name}]
 *   room_config {special_rooms:[{type,room_name,grades}], room2_grades:[]}
 *   exempted_ids []
 *   rules       DEFAULT_PROCTOR_RULES とのマージ
 * 出力:
 *   { assignments:[{unit_id, grade, subject_name, day, slot, kind, proctor_teacher_id, room_type}],
 *     unassigned, penalty, diagnostics, stats }
 *
 * 手法: 特別教室ローテーション/ソロ科目の確定割当 → 残りコマを MRV DFS で構築
 *       → 局所スワップによる負荷均等化（乱数不使用・決定的）
 */

export const DEFAULT_PROCTOR_RULES = {
  solo_subject_self: true,
  special_room_rotation: [],
  avoid_setter: true,
  enforce_parttime_availability: true,
  trips_block: true,
  balance_groups: true,
  considerations: [],
  kyomu_priority: 4,
  parttime_prefer: 6,
  weights: { load: 40, fairness: 10, special_extra: 40, parttime_late: 6, unassigned: 1000, rotation_outside: 25, spread: 30 },
};

function normRules(rules) {
  const base = { ...DEFAULT_PROCTOR_RULES, ...(rules || {}) };
  base.weights = { ...DEFAULT_PROCTOR_RULES.weights, ...(rules?.weights || {}) };
  base.special_room_rotation = (base.special_room_rotation || []).map((r) => ({
    type: String(r.type || '').toUpperCase(),
    teacher_ids: (r.teacher_ids || []).map(String),
    pattern: String(r.pattern || 'ALL').toUpperCase(),
  }));
  base.considerations = (base.considerations || []).map((c) => ({
    teacher_id: String(c.teacher_id),
    max_slots_per_day: Number(c.max_slots_per_day) || null,
  }));
  return base;
}

/** 試験コマ（監督が必要最小の単位。スパンは各コマに展開） */
export function buildProctorCells(input, ctx) {
  const cells = [];
  for (const t of input.timetable || []) {
    const u = ctx.unitById.get(t.unit_id) || {};
    const duration = Math.min(Number(t.duration_slots) || u.duration || 1, ctx.slots - t.slot + 1);
    const roomName = ctx.roomCell.get(`${t.grade}|${t.day}|${t.slot}`) ?? null;
    for (let s = t.slot; s < t.slot + duration; s++) {
      const rn = s === t.slot ? roomName : ctx.roomCell.get(`${t.grade}|${t.day}|${s}`) ?? roomName;
      cells.push({
        key: `${t.unit_id}#${t.grade}#${t.day}#${s}`,
        unit_id: t.unit_id,
        grade: Number(t.grade),
        subject_name: t.subject_name ?? u.subject_name ?? null,
        day: Number(t.day),
        slot: s,
        is_start: s === t.slot,
        duration,
        room_name: rn,
        special_type: ctx.specialByRoom.get(rn) ?? null,
        solo: !!u.solo,
        setter: u.setter_teacher_id ?? null,
      });
    }
  }
  return cells;
}

/** 教員プール（非常勤条件・個別制約・免除・出欠反映） */
export function buildProctorPool(input, ctx) {
  const pool = new Map();
  for (const t of input.teachers || []) {
    pool.set(t.id, {
      id: t.id,
      name: t.name,
      parttime: !!t.is_parttime,
      kyomu: !!t.is_kyomu,
      daily_limit: t.daily_limit ?? null,
      max_consecutive: t.max_consecutive ?? null,
    });
  }
  for (const p of input.parttime_staff || []) {
    const cur = pool.get(p.teacher_id);
    if (cur) {
      cur.parttime = true;
      cur.daily_limit = p.daily_limit ?? cur.daily_limit;
      cur.max_consecutive = p.max_consecutive ?? cur.max_consecutive;
    } else {
      pool.set(p.teacher_id, {
        id: p.teacher_id,
        name: p.staff_name ?? p.teacher_id,
        parttime: true,
        kyomu: false,
        daily_limit: p.daily_limit ?? 1,
        max_consecutive: p.max_consecutive ?? 1,
      });
    }
  }
  const exempted = new Set((input.exempted_ids || []).map(String));
  const list = [...pool.values()].filter((t) => !exempted.has(t.id));
  for (const t of list) {
    const c = ctx.considerationMax.get(t.id);
    if (c) t.daily_limit = Math.min(t.daily_limit ?? c, c);
  }
  return list;
}

/** 教員のそのコマの可否（出張・非常勤出勤可能・連続上限・日上限） */
export function teacherCan(ctx, teacher, cell) {
  const key = `${teacher.id}|${cell.day}|${cell.slot}`;
  if (ctx.rules.trips_block && ctx.tripsSet.has(key)) return false;
  if (teacher.parttime && ctx.rules.enforce_parttime_availability && !ctx.availabilitySet.has(key)) return false;
  const dayCount = ctx.dayCount.get(`${teacher.id}|${cell.day}`) ?? 0;
  const limit = teacher.daily_limit;
  if (limit && dayCount >= limit) return false;
  const maxConsec = teacher.max_consecutive;
  if (maxConsec && maxConsec > 1) {
    const slotsDay = ctx.daySlotsSet.get(`${teacher.id}|${cell.day}`) ?? new Set();
    let run = 1;
    let s = cell.slot - 1;
    while (slotsDay.has(s)) { run++; s--; }
    s = cell.slot + 1;
    while (slotsDay.has(s)) { run++; s++; }
    if (run > maxConsec) return false;
  } else if (maxConsec === 1) {
    const slotsDay = ctx.daySlotsSet.get(`${teacher.id}|${cell.day}`) ?? new Set();
    if (slotsDay.has(cell.slot - 1) || slotsDay.has(cell.slot + 1)) return false;
  }
  // 特別教室ローテーション: ローテーション外の教員は担当不可（HARD）。ソロ科目（本人監督）は例外
  if (cell.special_type && !(cell.solo && ctx.rules.solo_subject_self)) {
    const rot = ctx.rules.special_room_rotation.find((r) => r.type === cell.special_type);
    if (rot && rot.teacher_ids.length && !rot.teacher_ids.includes(teacher.id)) return false;
  }
  // ソロ科目は出題者本人が監督（HARD）
  if (cell.solo && ctx.rules.solo_subject_self && teacher.id !== cell.setter) return false;
  // 出題者本人は自科目の監督を避ける（HARD、ソロ科目を除く）
  if (!cell.solo && ctx.rules.avoid_setter && teacher.id === cell.setter) return false;
  return true;
}

/** 候補教員スコア（小さいほど良い）: 負荷・日負荷・教務・遅コマ避勤・特別教室余計割当 */
export function proctorScore(ctx, teacher, cell) {
  const w = ctx.rules.weights;
  const load = ctx.totalLoad.get(teacher.id) ?? 0;
  const dayLoad = ctx.dayCount.get(`${teacher.id}|${cell.day}`) ?? 0;
  let score = w.load * load + w.fairness * dayLoad;
  if (teacher.kyomu) score -= ctx.rules.kyomu_priority;
  if (teacher.parttime) {
    if (cell.slot >= ctx.slots - 1) score += w.parttime_late;
    score -= ctx.rules.parttime_prefer;
  }
  if (cell.special_type && ctx.specialLoad.get(teacher.id)) score += w.special_extra;
  if (cell.solo && teacher.id === cell.setter) score -= w.load * 2;
  return score;
}

export function candidateList(ctx, cell) {
  const list = ctx.pool.filter((t) => teacherCan(ctx, t, cell));
  if (cell.solo) {
    const self = ctx.pool.find((t) => t.id === cell.setter);
    if (self && teacherCan(ctx, self, cell)) return [self, ...list.filter((t) => t.id !== self.id)];
  }
  if (ctx.rules.avoid_setter) {
    const filtered = list.filter((t) => t.id !== cell.setter);
    if (filtered.length) return filtered;
  }
  list.sort((a, b) => proctorScore(ctx, a, cell) - proctorScore(ctx, b, cell) || String(a.name).localeCompare(String(b.name)));
  // 候補数を制限して DFS の探索枝を削減（局所改善で品質は回復）
  return list.slice(0, 12);
}

export function applyAssign(ctx, cell, teacher) {
  ctx.assignment.set(cell.key, teacher.id);
  ctx.totalLoad.set(teacher.id, (ctx.totalLoad.get(teacher.id) ?? 0) + 1);
  const dk = `${teacher.id}|${cell.day}`;
  ctx.dayCount.set(dk, (ctx.dayCount.get(dk) ?? 0) + 1);
  if (!ctx.daySlotsSet.has(dk)) ctx.daySlotsSet.set(dk, new Set());
  ctx.daySlotsSet.get(dk).add(cell.slot);
  if (cell.special_type) ctx.specialLoad.set(teacher.id, (ctx.specialLoad.get(teacher.id) ?? 0) + 1);
}

export function unassign(ctx, cell) {
  const tid = ctx.assignment.get(cell.key);
  if (!tid) return;
  ctx.assignment.delete(cell.key);
  ctx.totalLoad.set(tid, (ctx.totalLoad.get(tid) ?? 1) - 1);
  const dk = `${tid}|${cell.day}`;
  ctx.dayCount.set(dk, (ctx.dayCount.get(dk) ?? 1) - 1);
  const set = ctx.daySlotsSet.get(dk);
  if (set) set.delete(cell.slot);
  if (cell.special_type) ctx.specialLoad.set(tid, (ctx.specialLoad.get(tid) ?? 1) - 1);
}

export function totalScore(ctx) {
  const w = ctx.rules.weights;
  let score = 0;
  for (const [key, tid] of ctx.assignment.entries()) {
    const cell = ctx.cellByKey.get(key);
    const teacher = ctx.teacherById.get(tid);
    const load = ctx.totalLoad.get(tid) ?? 0;
    score += w.load * load;
    score += w.fairness * (ctx.dayCount.get(`${tid}|${cell.day}`) ?? 0);
    if (teacher?.kyomu) score += ctx.rules.kyomu_priority;
    if (teacher?.parttime && cell.slot >= ctx.slots - 1) score += w.parttime_late;
    if (cell.special_type && (ctx.specialLoad.get(tid) ?? 0) > 1) score += w.special_extra;
  }
  const unassigned = ctx.cells.length - ctx.assignment.size;
  score += w.unassigned * unassigned;

  // ローテーション外の教員が特別教室を担当するペナルティ
  for (const [key, tid] of ctx.assignment.entries()) {
    const cell = ctx.cellByKey.get(key);
    if (!cell.special_type) continue;
    const rot = ctx.rules.special_room_rotation.find((r) => r.type === cell.special_type);
    if (rot && !rot.teacher_ids.includes(tid)) score += w.rotation_outside;
  }

  // 全教員（未割当を含む）の負荷分布の広がり
  const allLoads = ctx.pool.map((t) => ctx.totalLoad.get(t.id) ?? 0);
  if (allLoads.length > 1) score += w.spread * (Math.max(...allLoads) - Math.min(...allLoads));

  if (ctx.rules.balance_groups) {
    const regular = [...ctx.pool].filter((t) => !t.parttime).reduce((s, t) => s + (ctx.totalLoad.get(t.id) ?? 0), 0);
    const parttime = [...ctx.pool].filter((t) => t.parttime).reduce((s, t) => s + (ctx.totalLoad.get(t.id) ?? 0), 0);
    const perRegular = Math.max(1, [...ctx.pool].filter((t) => !t.parttime).length);
    const perParttime = Math.max(1, [...ctx.pool].filter((t) => t.parttime).length);
    score += w.fairness * Math.abs(Math.round((regular / perRegular) * 10 - (parttime / perParttime) * 10));
  }
  return score;
}

/** MRV DFS（全コマ割当を試みる。時刻超過で打ち切り） */
export function dfs(ctx, cells, deadline) {
  if (ctx.assignment.size === cells.length) return true;
  if (Date.now() > deadline) return false;
  const unassigned = cells.filter((c) => !ctx.assignment.has(c.key));
  let best = null;
  for (const c of unassigned) {
    const n = candidateList(ctx, c).length;
    if (!best || n < best.n) best = { c, n };
  }
  if (!best || best.n === 0) return false;
  const cands = candidateList(ctx, best.c);
  for (const t of cands) {
    applyAssign(ctx, best.c, t);
    if (dfs(ctx, cells, deadline)) return true;
    unassign(ctx, best.c);
  }
  return false;
}

/** 局所改善: 2コマスワップでスコアを下げる */
export function localSwap(ctx, maxPasses = 6) {
  for (let pass = 0; pass < maxPasses; pass++) {
    const keys = [...ctx.assignment.keys()];
    let bestSwap = null;
    const before = totalScore(ctx);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const ca = ctx.cellByKey.get(keys[i]);
        const cb = ctx.cellByKey.get(keys[j]);
        const ta = ctx.teacherById.get(ctx.assignment.get(keys[i]));
        const tb = ctx.teacherById.get(ctx.assignment.get(keys[j]));
        if (!ca || !cb || !ta || !tb) continue;
        if (ta.id === tb.id) continue;
        if (ctx.rules.avoid_setter && (ta.id === cb.setter || tb.id === ca.setter)) continue;
        if (ca.solo || cb.solo) continue;
        unassign(ctx, ca);
        unassign(ctx, cb);
        const okA = teacherCan(ctx, tb, ca);
        const okB = teacherCan(ctx, ta, cb);
        const afterScore = okA && okB ? (applyAssign(ctx, ca, tb), applyAssign(ctx, cb, ta), totalScore(ctx)) : Infinity;
        if (okA && okB) { unassign(ctx, ca); unassign(ctx, cb); }
        applyAssign(ctx, ca, ta);
        applyAssign(ctx, cb, tb);
        if (afterScore < before && (!bestSwap || afterScore < bestSwap.score)) {
          bestSwap = { ka: keys[i], kb: keys[j], ta: tb.id, tb: ta.id, score: afterScore };
        }
      }
    }
    if (!bestSwap) break;
    unassign(ctx, ctx.cellByKey.get(bestSwap.ka));
    unassign(ctx, ctx.cellByKey.get(bestSwap.kb));
    applyAssign(ctx, ctx.cellByKey.get(bestSwap.ka), ctx.teacherById.get(bestSwap.ta));
    applyAssign(ctx, ctx.cellByKey.get(bestSwap.kb), ctx.teacherById.get(bestSwap.tb));
  }
}

/** 局所改善: 1コマを低負荷教員へ移してスコアを下げる（スワップでは未割当教員に入れない） */
export function localMove(ctx, maxPasses = 6) {
  for (let pass = 0; pass < maxPasses; pass++) {
    const before = totalScore(ctx);
    const keys = [...ctx.assignment.keys()];
    const sortedByLoad = ctx.pool.slice().sort((a, b) => (ctx.totalLoad.get(a.id) ?? 0) - (ctx.totalLoad.get(b.id) ?? 0));
    let best = null;
    for (const key of keys) {
      const cell = ctx.cellByKey.get(key);
      const cur = ctx.assignment.get(key);
      if (cell.solo) continue;
      for (const t of sortedByLoad) {
        if (t.id === cur) break; // 昇順なので現担当より重い教員は検討しない
        if (ctx.rules.avoid_setter && !cell.solo && t.id === cell.setter) continue;
        unassign(ctx, cell);
        let afterScore = Infinity;
        if (teacherCan(ctx, t, cell)) {
          applyAssign(ctx, cell, t);
          afterScore = totalScore(ctx);
          unassign(ctx, cell);
        }
        applyAssign(ctx, cell, ctx.teacherById.get(cur)); // 元の状態へ復元
        if (afterScore < before && (!best || afterScore < best.score)) {
          best = { key, from: cur, to: t.id, score: afterScore };
        }
        if (best && best.score <= before - 20) break;
      }
    }
    if (!best) break;
    unassign(ctx, ctx.cellByKey.get(best.key));
    applyAssign(ctx, ctx.cellByKey.get(best.key), ctx.teacherById.get(best.to));
  }
}

function patternMatches(pattern, day) {
  if (pattern === 'ODD') return day % 2 === 1;
  if (pattern === 'EVEN') return day % 2 === 0;
  return true;
}

/** 監督割当の検証結果 */
export function proctorDiagnostics(ctx, assignments) {
  const out = [];

  for (const a of assignments) {
    if (!a.proctor_teacher_id) {
      out.push({ code: 'PROCTOR_UNASSIGNED', level: 'HARD', grade: a.grade, day: a.day, slot: a.slot, subject_name: a.subject_name, msg: `${a.day}日目${a.slot}限「${a.subject_name}」(${a.grade}年) に監督教員を割り当てできませんでした。` });
    }
  }

  for (const cell of ctx.cells) {
    if (!cell.special_type) continue;
    const rot = ctx.rules.special_room_rotation.find((r) => r.type === cell.special_type);
    if (!rot) continue;
    const tid = ctx.assignment.get(cell.key);
    if (tid && !rot.teacher_ids.includes(tid)) {
      out.push({ code: 'SPECIAL_ROTATION_OUTSIDE', level: 'SOFT', room_type: cell.special_type, day: cell.day, slot: cell.slot, teacher_id: tid, msg: `${cell.special_type}教室(${cell.day}日目${cell.slot}限) はローテーション外の教員 ${ctx.teacherById.get(tid)?.name ?? tid} が担当しています。` });
    }
  }

  for (const [key, count] of ctx.dayCount.entries()) {
    const [tid, dayStr] = key.split('|');
    const limit = ctx.considerationMax.get(tid);
    if (limit && count > limit) {
      out.push({ code: 'CONSIDERATION_EXCEEDED', level: 'HARD', teacher_id: tid, day: Number(dayStr), msg: `${ctx.teacherById.get(tid)?.name ?? tid} 教員は${dayStr}日目に配慮上限(${limit}コマ)を超えて${count}コマ担当しています。` });
    }
  }

  for (const [key, set] of ctx.daySlotsSet.entries()) {
    const [tid, dayStr] = key.split('|');
    const sorted = [...set].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i] === sorted[i - 1] + 1) {
        out.push({ code: 'PROCTOR_CONSECUTIVE', level: 'SOFT', teacher_id: tid, day: Number(dayStr), slot: sorted[i], msg: `${ctx.teacherById.get(tid)?.name ?? tid} 教員が${dayStr}日目に連続コマ (${sorted[i - 1]}→${sorted[i]}限) を担当しています。` });
        break;
      }
    }
  }

  const loads = ctx.pool.map((t) => ctx.totalLoad.get(t.id) ?? 0);
  if (loads.length > 1) {
    const mx = Math.max(...loads);
    const mn = Math.min(...loads);
    if (mx - mn > 3) {
      out.push({ code: 'PROCTOR_IMBALANCE', level: 'INFO', msg: `監督コマ数の偏りが ${mn}〜${mx} コマあります（均等化を推奨）。` });
    }
  }

  for (const t of ctx.pool) {
    if (t.parttime && (ctx.totalLoad.get(t.id) ?? 0) === 0) {
      out.push({ code: 'PARTTIME_UNUSED', level: 'INFO', teacher_id: t.id, msg: `非常勤の${t.name} 教員は出勤可能コマがあるため、${ctx.cells.length}コマの負荷分担対象です。` });
    }
  }

  for (const cell of ctx.cells) {
    if (cell.solo && ctx.assignment.get(cell.key) && ctx.assignment.get(cell.key) !== cell.setter) {
      out.push({ code: 'SOLO_NOT_SELF', level: 'SOFT', subject_name: cell.subject_name, day: cell.day, slot: cell.slot, msg: `ソロ科目「${cell.subject_name}」(${cell.day}日目${cell.slot}限) の監督が出題者本人ではありません。` });
    }
    if (!cell.solo && ctx.rules.avoid_setter && ctx.assignment.get(cell.key) === cell.setter) {
      out.push({ code: 'SETTER_CLASH', level: 'HARD', grade: cell.grade, day: cell.day, slot: cell.slot, subject_name: cell.subject_name, teacher_id: cell.setter, msg: `出題者「${ctx.teacherById.get(cell.setter)?.name ?? cell.setter}」本人が自科目「${cell.subject_name}」(${cell.grade}年 ${cell.day}日目${cell.slot}限) の監督に割当られています。` });
    }
  }

  return out;
}


/**
 * 試験監督割当ソルバー
 * @param {object} input service 由来の入力
 * @returns {{assignments:Array, unassigned:number, penalty:number, diagnostics:Array, stats:object}}
 */
export function solveProctor(input) {
  const days = Number(input.days) || 3;
  const slots = Number(input.slots) || 3;
  const rules = normRules(input.rules);

  const ctx = {
    days,
    slots,
    rules,
    unitById: new Map((input.units || []).map((u) => [u.id, {
      id: u.id,
      subject_name: String(u.subject_name || '').trim(),
      grade: Number(u.grade) || 0,
      duration: Number(u.duration_slots) || 1,
      setter_teacher_id: u.setter_teacher_id || null,
      solo: !!u.solo_subject,
    }])),
    specialByRoom: new Map((input.room_config?.special_rooms || []).map((s) => [s.room_name, String(s.type).toUpperCase()])),
    roomCell: new Map((input.room_cells || []).map((c) => [`${c.grade}|${c.day}|${c.slot}`, c.room_name])),
    tripsSet: new Set((input.trips || []).map((t) => `${t.teacher_id}|${t.day_number}|${t.slot_number}`)),
    availabilitySet: new Set((input.parttime_availability || []).filter((a) => a.can_work !== false).map((a) => `${a.teacher_id}|${a.day_number}|${a.slot_number}`)),
    considerationMax: new Map(rules.considerations.filter((c) => c.max_slots_per_day).map((c) => [c.teacher_id, c.max_slots_per_day])),
    totalLoad: new Map(),
    dayCount: new Map(),
    daySlotsSet: new Map(),
    specialLoad: new Map(),
    assignment: new Map(),
    cells: [],
    cellByKey: new Map(),
    pool: [],
    teacherById: new Map(),
  };

  ctx.cells = buildProctorCells(input, ctx);
  ctx.cellByKey = new Map(ctx.cells.map((c) => [c.key, c]));
  ctx.pool = buildProctorPool(input, ctx);
  ctx.teacherById = new Map(ctx.pool.map((t) => [t.id, t]));

  // 1. 特別教室ローテーション（SP1/SP2/PREP1）を先に確定。ローテーション内は循環割当で負荷を均分する
  const specialCellsByType = new Map();
  for (const cell of ctx.cells) {
    if (!cell.special_type) continue;
    if (!specialCellsByType.has(cell.special_type)) specialCellsByType.set(cell.special_type, []);
    specialCellsByType.get(cell.special_type).push(cell);
  }

  for (const [type, cells] of specialCellsByType.entries()) {
    const rot = rules.special_room_rotation.find((r) => r.type === type);
    if (!rot) continue;
    const list = rot.teacher_ids.map((id) => ctx.teacherById.get(id)).filter(Boolean);
    if (!list.length) continue; // 教員指定なし → 一般候補と同じ扱い（DFS へ委ねる）
    const cellsSorted = cells.slice().sort((a, b) => a.day - b.day || a.slot - b.slot);
    const patternCells =
      rot.pattern === 'ODD' ? cellsSorted.filter((c) => c.day % 2 === 1)
      : rot.pattern === 'EVEN' ? cellsSorted.filter((c) => c.day % 2 === 0)
      : cellsSorted;
    const ordered = list.slice().sort((a, b) => {
      const pa = (a.kyomu ? -ctx.rules.kyomu_priority : 0) + (a.parttime ? -ctx.rules.parttime_prefer : 0);
      const pb = (b.kyomu ? -ctx.rules.kyomu_priority : 0) + (b.parttime ? -ctx.rules.parttime_prefer : 0);
      return pa - pb || String(a.name).localeCompare(String(b.name));
    });
    let cursor = 0;
    for (const cell of patternCells) {
      let assigned = false;
      for (let i = 0; i < ordered.length; i++) {
        const t = ordered[(cursor + i) % ordered.length];
        if (teacherCan(ctx, t, cell)) {
          applyAssign(ctx, cell, t);
          cursor = (cursor + i + 1) % ordered.length;
          assigned = true;
          break;
        }
      }
      if (!assigned) {
        for (const t of candidateList(ctx, cell)) {
          if (teacherCan(ctx, t, cell)) {
            applyAssign(ctx, cell, t);
            break;
          }
        }
      }
    }
  }

  // 2. ソロ科目は出題者本人
  if (rules.solo_subject_self) {
    for (const cell of ctx.cells) {
      if (!cell.solo || ctx.assignment.has(cell.key)) continue;
      const self = ctx.teacherById.get(cell.setter);
      if (self && teacherCan(ctx, self, cell)) applyAssign(ctx, cell, self);
    }
  }

  // 3. 残りコマを構築: まず MRV DFS を短時間で試み、失敗（時間切れ）则是 Greedy で全コマを埋める
  const deadline = Date.now() + 800;
  const completed = dfs(ctx, ctx.cells, deadline);
  if (!completed) {
    const remaining = ctx.cells.filter((c) => !ctx.assignment.has(c.key));
    remaining.sort((a, b) => candidateList(ctx, a).length - candidateList(ctx, b).length);
    for (const cell of remaining) {
      const cands = candidateList(ctx, cell);
      if (!cands.length) continue;
      applyAssign(ctx, cell, cands[0]);
    }
  }
  localSwap(ctx);
  localMove(ctx);
  localSwap(ctx);
  localMove(ctx);

  const assignments = ctx.cells.map((c) => {
    const tid = ctx.assignment.get(c.key) ?? null;
    return {
      unit_id: c.unit_id,
      unit_key: c.key,
      grade: c.grade,
      subject_name: c.subject_name,
      day: c.day,
      slot: c.slot,
      kind: c.solo ? 'SOLO' : c.special_type ? 'SPECIAL' : 'REGULAR',
      proctor_teacher_id: tid,
      room_type: c.special_type,
    };
  });

  const unassigned = assignments.filter((a) => !a.proctor_teacher_id).length;

  return {
    assignments,
    unassigned,
    penalty: totalScore(ctx),
    diagnostics: proctorDiagnostics(ctx, assignments),
    stats: {
      cells: ctx.cells.length,
      teachers: ctx.pool.length,
      assigned: ctx.assignment.size,
      unassigned,
      rotationSpecial: ctx.cells.filter((c) => c.special_type && ctx.assignment.has(c.key)).length,
      soloSelf: ctx.cells.filter((c) => c.solo && ctx.assignment.get(c.key) === c.setter).length,
      loads: ctx.pool.map((t) => ({
        id: t.id,
        name: t.name,
        parttime: t.parttime,
        kyomu: t.kyomu,
        load: ctx.totalLoad.get(t.id) ?? 0,
      })),
    },
  };
}


/** 手動編集済み割当の検証（solveProctor と同じ検証項目） */
export function validateProctor(input, rows) {
  const days = Number(input.days) || 3;
  const slots = Number(input.slots) || 3;
  const rules = normRules(input.rules);
  const ctx = {
    days,
    slots,
    rules,
    tripsSet: new Set((input.trips || []).map((t) => `${t.teacher_id}|${t.day_number}|${t.slot_number}`)),
    availabilitySet: new Set((input.parttime_availability || []).filter((a) => a.can_work !== false).map((a) => `${a.teacher_id}|${a.day_number}|${a.slot_number}`)),
    considerationMax: new Map(rules.considerations.filter((c) => c.max_slots_per_day).map((c) => [c.teacher_id, c.max_slots_per_day])),
    totalLoad: new Map(),
    dayCount: new Map(),
    daySlotsSet: new Map(),
    specialLoad: new Map(),
    assignment: new Map(),
    cellByKey: new Map(),
    teacherById: new Map((input.teachers || []).map((t) => [t.id, { id: t.id, name: t.name, parttime: !!t.is_parttime, kyomu: !!t.is_kyomu }])),
    cells: [],
    pool: (input.teachers || []).map((t) => ({ id: t.id, name: t.name, parttime: !!t.is_parttime, kyomu: !!t.is_kyomu })),
  };

  const soloSet = new Set((input.units || []).filter((u) => u.solo_subject).map((u) => `${Number(u.grade)}|${String(u.subject_name)}`));

  for (const r of rows || []) {
    const cell = {
      key: `${r.grade}#${r.day_number}#${r.slot_number}`,
      grade: Number(r.grade),
      day: Number(r.day_number),
      slot: Number(r.slot_number),
      subject_name: r.subject_name,
      special_type: r.room_type ? String(r.room_type).toUpperCase() : null,
      solo: soloSet.has(`${Number(r.grade)}|${String(r.subject_name)}`),
      setter: r.setter_teacher_id || null,
    };
    ctx.cells.push(cell);
    ctx.cellByKey.set(cell.key, cell);
    const tid = r.proctor_teacher_id;
    if (!tid) continue;
    ctx.assignment.set(cell.key, tid);
    ctx.totalLoad.set(tid, (ctx.totalLoad.get(tid) ?? 0) + 1);
    const dk = `${tid}|${cell.day}`;
    ctx.dayCount.set(dk, (ctx.dayCount.get(dk) ?? 0) + 1);
    if (!ctx.daySlotsSet.has(dk)) ctx.daySlotsSet.set(dk, new Set());
    ctx.daySlotsSet.get(dk).add(cell.slot);
    if (cell.special_type) ctx.specialLoad.set(tid, (ctx.specialLoad.get(tid) ?? 0) + 1);
  }

  const out = proctorDiagnostics(ctx, ctx.cells.map((c) => ({
    grade: c.grade,
    day: c.day,
    slot: c.slot,
    subject_name: c.subject_name,
    proctor_teacher_id: ctx.assignment.get(c.key) ?? null,
  })));

  for (const [key, tid] of ctx.assignment.entries()) {
    const cell = ctx.cellByKey.get(key);
    const ck = `${tid}|${cell.day}|${cell.slot}`;
    if (ctx.tripsSet.has(ck)) {
      out.push({ code: 'TRIP_CONFLICT', level: 'HARD', teacher_id: tid, day: cell.day, slot: cell.slot, msg: `${ctx.teacherById.get(tid)?.name ?? tid} 教員は${cell.day}日目${cell.slot}限に出張・外出登録があります。` });
    }
    const teacher = ctx.teacherById.get(tid);
    if (teacher?.parttime && !ctx.availabilitySet.has(ck)) {
      out.push({ code: 'PARTTIME_UNAVAILABLE', level: 'HARD', teacher_id: tid, day: cell.day, slot: cell.slot, msg: `非常勤の${teacher.name} 教員は${cell.day}日目${cell.slot}限に出勤可能設定がありません。` });
    }
  }

  return out;
}

