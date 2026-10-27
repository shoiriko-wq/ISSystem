/**
 * ISSystem 定期考査 教室割自動作成ソルバー
 * -------------------------------------------------------------
 * 入力:
 *   - 時間割（科目 × 学年 × 日 × 時限）
 *   - 教室マスタ rooms [{id,name,room_type,capacity,grades}]
 *   - 科目別標準教室 room_config [{subject_name, grade, standard_room, alt_rooms}]
 * 制約:
 *   H1. 同一教室を同一日・同一時限で複数科目に重複割り当てしない
 *   H2. 教室の対応学年（grades）と実施学年が一致する
 *   H3. 2コマ扱い（duration_slots=2）は全スパンが同じ教室で空いている
 *   H4. ルールで指定された特殊教室の予約（英語Comm リスニング準備は直前コマ）
 * 軟制約:
 *   S1. 標準教室を最大化（予備教室利用を最小化）
 *   S2. 予備教室は指定順（alt_rooms の先頭）を優先
 *   S3. 特殊教室（SP1/SP2/PREP1）は本来用途以外に割り当てない
 * 手法: 最拘束順 greedy + 標準教室へのスワップ局所改善（乱数不使用・決定的）
 */

export const DEFAULT_ROOM_RULES = {
  reserve_prep_before_broadcast: true,
  allow_alternate: true,
  weights: { alt_used: 100, no_standard: 40, special_penalty: 25, capacity: 1 },
};

/** 教室マスタの正規化 */
export function normalizeRooms(rooms) {
  return (rooms || []).map((r) => ({
    id: r.id ?? r.name,
    name: r.name,
    room_type: String(r.room_type || 'CLASS').toUpperCase(),
    capacity: r.capacity ? Number(r.capacity) : null,
    grades: Array.isArray(r.grades) ? r.grades.map(Number) : [],
  }));
}

/** 特殊教室タイプ（SP1/SP2/PREP1。試験監督ローテーション・専用用途対象） */
export const SPECIAL_TYPES = new Set(['SP1', 'SP2', 'PREP1']);

/** 実施ユニットに要求される特殊教室タイプ（学年+科目ルール → 学年ルール） */
export function requiredRoomType(u, ctx) {
  const bySubject = ctx.rules.rules_by_subject || {};
  const byGrade = ctx.rules.rules_by_grade || {};
  const raw = bySubject[`${u.grade}|${u.subject_name}`] ?? byGrade[u.grade];
  const type = raw ? String(raw).toUpperCase() : null;
  return SPECIAL_TYPES.has(type) ? type : null;
}

/** 教室がそのユニットに許されるか（特殊教室は専用用途の科目のみ、標準科目は特殊教室を使わない） */
export function roomAllowedFor(u, room, ctx) {
  const type = String(room.room_type).toUpperCase();
  const req = requiredRoomType(u, ctx);
  if (req) return type === req;
  return !SPECIAL_TYPES.has(type);
}

/** 科目別標準教室・予備教室マップの構築 */
export function buildRoomConfigMaps(config) {
  const standard = new Map();
  const alternates = new Map();
  for (const c of config || []) {
    const subject = String(c.subject_name || '').trim();
    const grade = Number(c.grade) || 0;
    const key = `${subject}#${grade}`;
    const alts = Array.isArray(c.alt_rooms)
      ? c.alt_rooms.map((a) => String(a).trim())
      : typeof c.alt_rooms === 'string'
        ? JSON.parse(c.alt_rooms || '[]')
        : [];

    if (c.standard_room) {
      standard.set(key, String(c.standard_room).trim());
      // grade=0 の設定は全学年共通の標準教室として扱う
      if (grade === 0) standard.set(subject, String(c.standard_room).trim());
    }
    if (alts.length) {
      alternates.set(key, alts);
      if (grade === 0) alternates.set(subject, alts);
    }
  }
  return { standard, alternates };
}

/** 時間割から教室割当ユニット（科目 × 学年 × 日 × 時限）を生成 */
export function buildRoomUnits(assignments, days, slots) {
  const units = [];
  for (const a of assignments || []) {
    const day = Number(a.day);
    const slot = Number(a.slot);
    const duration = Math.max(1, Number(a.duration_slots) || 1);
    if (day < 1 || day > days || slot < 1 || slot > slots) continue;
    units.push({
      key: `${a.unit_id ?? a.subject_name}#${a.grade}#${day}#${slot}`,
      unit_id: a.unit_id ?? null,
      grade: Number(a.grade),
      subject_name: String(a.subject_name || '').trim(),
      day,
      slot,
      duration_slots: Math.min(duration, slots - slot + 1),
    });
  }
  // 決定順序: 特殊教室指定(予備指定が狭い) → 日 → 時限 → 科目名
  units.sort(
    (a, b) => a.day - b.day || a.slot - b.slot || String(a.subject_name).localeCompare(String(b.subject_name)) || a.grade - b.grade
  );
  return units;
}

/** 教室がスパン全体で空いているかの判定 */
function roomFree(occupancy, room, unit) {
  for (let s = unit.slot; s < unit.slot + unit.duration_slots; s++) {
    if (occupancy.has(`${room.name}|${unit.day}|${s}`)) return false;
  }
  return true;
}

/** 学年対応・容量条件の判定 */
function roomCompatible(room, unit) {
  if (room.grades.length > 0 && !room.grades.includes(unit.grade)) return false;
  if (room.capacity && unit.students && room.capacity < unit.students) return false;
  return true;
}

/**
 * 教室スコア（小さいほど良い）
 * 標準教室 → 負の強優先、予備教室 → 指定順、それ以外 → 大きなペナルティ
 */
export function roomScore(unit, room, ctx) {
  const w = ctx.rules.weights;
  let score = 0;
  const keyG = `${unit.subject_name}#${unit.grade}`;
  const keyS = unit.subject_name;

  const std = ctx.standard.get(keyG) ?? ctx.standard.get(keyS);
  const req = requiredRoomType(unit, ctx);
  if (req) {
    if (room.name === std) score -= 1000;
    return score;
  }

  if (std) {
    if (room.name === std) score -= 1000;
    else score += w.alt_used;
  } else {
    score += w.no_standard;
  }

  const alts = ctx.alternates.get(keyG) ?? ctx.alternates.get(keyS) ?? [];
  const idx = alts.indexOf(room.name);
  if (idx >= 0) score += idx;
  else score += 20;

  if (room.room_type !== 'CLASS') score += w.special_penalty;

  if (room.capacity && unit.students) score += Math.max(0, room.capacity - unit.students) * w.capacity;

  return score;
}

/** greedy 構築（最拘束ユニット順に標準→予備→その他） */
export function greedyRooms(units, ctx) {
  const assigned = new Map(); // key -> room_name
  const occupancy = new Map(); // `${room}|${day}|${slot}` -> unit.key

  // 特殊予約（英語Comm リスニング準備コマを リスニング準備室(PREP2) で押さえる）
  ctx.reserved = new Map();
  if (ctx.rules.reserve_prep_before_broadcast) {
    for (const u of units) {
      if (!u.broadcast_slot || u.slot <= 1) continue;
      const prepRoom = ctx.rooms.find(
        (r) => ['PREP2', 'LISTENING'].includes(String(r.room_type).toUpperCase()) && roomCompatible(r, u)
      );
      if (prepRoom) {
        const key = `${prepRoom.name}|${u.day}|${u.slot - 1}`;
        ctx.reserved.set(key, `prep:${u.key}`);
        occupancy.set(key, `prep:${u.key}`);
      }
    }
  }

  for (const u of units) {
    const candidates = ctx.rooms
      .filter((r) => roomCompatible(r, u) && roomAllowedFor(u, r, ctx) && roomFree(occupancy, r, u))
      .map((r) => ({ r, score: roomScore(u, r, ctx) }))
      .sort((a, b) => a.score - b.score || String(a.r.name).localeCompare(String(b.r.name)));

    if (candidates.length === 0) {
      assigned.set(u.key, null);
      continue;
    }
    const pick = candidates[0].r;
    assigned.set(u.key, pick.name);
    for (let s = u.slot; s < u.slot + u.duration_slots; s++) occupancy.set(`${pick.name}|${u.day}|${s}`, u.key);
  }

  return { assigned, occupancy };
}

/** 割当全体のペナルティ（小さいほど良い、未割当は大きい罰） */
export function totalRoomPenalty(assigned, units, ctx) {
  let total = 0;
  for (const u of units) {
    const name = assigned.get(u.key);
    if (!name) {
      total += 5000;
      continue;
    }
    const room = ctx.roomsByName.get(name);
    if (room) total += roomScore(u, room, ctx);
  }
  return total;
}

/** assigned から占有マップを再構築（予約コマも復元） */
function rebuildOccupancy(assigned, units, ctx) {
  const occ = new Map();
  for (const [k, v] of (ctx.reserved || new Map()).entries()) occ.set(k, v);
  for (const u of units) {
    const name = assigned.get(u.key);
    if (!name) continue;
    for (let s = u.slot; s < u.slot + u.duration_slots; s++) occ.set(`${name}|${u.day}|${s}`, u.key);
  }
  return occ;
}

/**
 * 局所改善: 各ユニットを「外して→最もペナルティの低い教室へ再割当」を繰り返す
 * 標準教室が埋まっていることによる予備教室利用を、スワップで減らす。
 */
export function localImproveRooms(assigned, units, ctx, maxPasses = 5) {
  const occ = rebuildOccupancy(assigned, units, ctx);
  let bestTotal = totalRoomPenalty(assigned, units, ctx);

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    for (const u of units) {
      const curName = assigned.get(u.key) ?? null;
      const curScore = curName ? roomScore(u, ctx.roomsByName.get(curName), ctx) : 5000;

      if (curName) {
        for (let s = u.slot; s < u.slot + u.duration_slots; s++) {
          if (occ.get(`${curName}|${u.day}|${s}`) === u.key) occ.delete(`${curName}|${u.day}|${s}`);
        }
      }

      let best = { name: curName, score: bestTotal };
      for (const r of ctx.rooms) {
        if (!roomCompatible(r, u) || !roomAllowedFor(u, r, ctx) || !roomFree(occ, r, u)) continue;
        for (let s = u.slot; s < u.slot + u.duration_slots; s++) occ.set(`${r.name}|${u.day}|${s}`, u.key);
        const score = bestTotal - curScore + roomScore(u, r, ctx);
        for (let s = u.slot; s < u.slot + u.duration_slots; s++) occ.delete(`${r.name}|${u.day}|${s}`);
        if (score < best.score) best = { name: r.name, score };
      }

      if (best.name) {
        for (let s = u.slot; s < u.slot + u.duration_slots; s++) occ.set(`${best.name}|${u.day}|${s}`, u.key);
      }
      assigned.set(u.key, best.name);
      if (best.name !== curName) {
        bestTotal = best.score;
        improved = true;
      }
    }

    if (!improved) break;
  }
  return assigned;
}

/** 教室割の検証（手動編集にも対応） */
export function roomDiagnostics(assigned, units, ctx) {
  const out = [];
  const occ = rebuildOccupancy(assigned, units, ctx);

  // 1. 同一教室・同一コマの重複使用
  const counts = new Map();
  for (const [k, v] of occ.entries()) {
    if (String(v).startsWith('prep:')) continue;
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  for (const [k, c] of counts.entries()) {
    if (c > 1) {
      const [room, day, slot] = k.split('|');
      out.push({ code: 'ROOM_CONFLICT', level: 'HARD', room_name: room, day: Number(day), slot: Number(slot), msg: `教室「${room}」が ${day}日目${slot}限で複数科目に重複割り当てされています。` });
    }
  }

  // 2. ユニットごとのチェック
  for (const u of units) {
    const name = assigned.get(u.key) ?? null;
    const std = ctx.standard.get(`${u.subject_name}#${u.grade}`) ?? ctx.standard.get(u.subject_name) ?? null;

    if (!name) {
      out.push({ code: 'NO_ROOM', level: 'HARD', subject_name: u.subject_name, grade: u.grade, day: u.day, slot: u.slot, msg: `「${u.subject_name}」(${u.grade}年) ${u.day}日目${u.slot}限 に利用可能な教室がありません。` });
      continue;
    }

    const room = ctx.roomsByName.get(name);
    if (!room) {
      out.push({ code: 'UNKNOWN_ROOM', level: 'HARD', msg: `教室「${name}」が教室マスタに登録されていません。` });
      continue;
    }
    if (room.grades.length > 0 && !room.grades.includes(u.grade)) {
      out.push({ code: 'GRADE_MISMATCH', level: 'HARD', room_name: name, grade: u.grade, msg: `教室「${name}」は${u.grade}学年に対応していません。` });
    }
    if (room.capacity && u.students && room.capacity < u.students) {
      out.push({ code: 'CAPACITY', level: 'SOFT', room_name: name, msg: `教室「${name}」の収容人数(${room.capacity}) が実施人数(${u.students}) を下回っています。` });
    }

    const req = requiredRoomType(u, ctx);
    const rtype = String(room.room_type).toUpperCase();
    if (req && rtype !== req) {
      out.push({ code: 'SPECIAL_ROOM_RULE', level: 'HARD', room_name: name, subject_name: u.subject_name, grade: u.grade, day: u.day, slot: u.slot, msg: `「${u.subject_name}」(${u.grade}年) ${u.day}日目${u.slot}限 はルールで「${req}」指定ですが「${name}」(${rtype}) が割り当てられています。` });
    }
    if (!req && SPECIAL_TYPES.has(rtype)) {
      out.push({ code: 'SPECIAL_ROOM_MISUSE', level: 'HARD', room_name: name, subject_name: u.subject_name, grade: u.grade, day: u.day, slot: u.slot, msg: `「${u.subject_name}」(${u.grade}年) ${u.day}日目${u.slot}限 に特別教室「${name}」(${rtype}) を割り当てられません（特別教室は指定科目専用）。` });
    }
    if (std && name !== std) {
      out.push({ code: 'ALTERNATE_ROOM', level: 'INFO', room_name: name, standard_room: std, day: u.day, slot: u.slot, grade: u.grade, subject_name: u.subject_name, msg: `「${u.subject_name}」(${u.grade}年) ${u.day}日目${u.slot}限 は標準教室「${std}」が使用中のため「${name}」を割り当てました。` });
    }
  }

  return out;
}

/**
 * 教室割自動作成ソルバー
 * @param {{days,slots,grades,assignments,rooms,room_config,broadcast_subjects,rules}} input
 * @returns {{assignments:Array, diagnostics:Array, stats:object, penalty:number}}
 */
export function solveRooms(input) {
  const days = Number(input.days) || 3;
  const slots = Number(input.slots) || 3;

  const rules = { ...DEFAULT_ROOM_RULES, ...(input.rules || {}) };
  rules.weights = { ...DEFAULT_ROOM_RULES.weights, ...(rules.weights || {}) };

  const rooms = normalizeRooms(input.rooms);
  const { standard, alternates } = buildRoomConfigMaps(input.room_config);

  const broadcastSet = new Set((input.broadcast_subjects || []).map((s) => String(s).trim()));

  const units = buildRoomUnits(input.assignments, days, slots).map((u) => ({
    ...u,
    broadcast_slot: broadcastSet.has(u.subject_name),
    students: input.students ? (input.students[u.grade] ?? null) : null,
  }));

  const ctx = {
    days,
    slots,
    rules,
    rooms,
    standard,
    alternates,
    roomsByName: new Map(rooms.map((r) => [r.name, r])),
    reserved: new Map(),
  };

  const { assigned } = greedyRooms(units, ctx);
  localImproveRooms(assigned, units, ctx);

  const diagnostics = roomDiagnostics(assigned, units, ctx);

  const assignments = units.map((u) => {
    const name = assigned.get(u.key) ?? null;
    const room = name ? ctx.roomsByName.get(name) : null;
    const std = ctx.standard.get(`${u.subject_name}#${u.grade}`) ?? ctx.standard.get(u.subject_name) ?? null;
    return {
      key: u.key,
      unit_id: u.unit_id,
      subject_name: u.subject_name,
      grade: u.grade,
      day: u.day,
      slot: u.slot,
      duration_slots: u.duration_slots,
      room_name: name,
      room_type: room ? room.room_type : null,
      is_standard: std ? name === std : true,
    };
  });

  const stats = {
    totalUnits: units.length,
    standardUnits: assignments.filter((a) => a.is_standard && a.room_name).length,
    alternateUnits: assignments.filter((a) => !a.is_standard).length,
    unassignedUnits: assignments.filter((a) => !a.room_name).length,
  };

  return {
    assignments,
    diagnostics,
    stats,
    penalty: totalRoomPenalty(assigned, units, ctx),
  };
}

export default solveRooms;