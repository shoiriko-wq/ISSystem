/**
 * ISSystem 定期考査 時間割自動作成ソルバー
 * -------------------------------------------------------------
 * 制約（HARD = 必須 / SOFT = 重み付き軟制約）:
 *  H1. 1限は「生徒全員が受ける科目(scope=ALL)」でなければならない
 *  H2. 最終日はすべてのコマを「生徒全員が受ける科目」で埋めなければならない
 *  H3. duration_slots=2（数学Ⅲ 100分）は fixed_slot（既定2限）から連続コマで配置
 *  H4. shared_slot（公共）は全学年で同じ日・同じ時間に配置
 *  H5. broadcast_slot（英語Comm・リスニング）は学年ごとに異なる時限に配置
 *  S1. day_stream_mix: 同じ日の試験を「すべて理系」「すべて文系」にしない
 *  S2. balance_even: 同一科目が前半・後半に偏らず均等になるよう配置
 *  S3. history_balance: 過去考査の分布（exam_slot_history）と照らし合わせて偏りを抑える
 *
 * 手法: MRV(最少ドメイン)順序付け + 深さ優先探索 + 局所交換 hill-climbing（乱数不使用・決定的）
 */

export const DEFAULT_TIMETABLE_RULES = {
  first_period_all: true,
  last_day_all: true,
  day_stream_mix: true,
  balance_even: true,
  history_balance: true,
  weights: { stream_mix: 120, balance: 45, history: 30 },
};

/** 時限の正規化位置 (0=最初, 1=最後) */
function normalizedPosition(day, slot, days, slots) {
  const idx = (day - 1) * slots + (slot - 1);
  return idx / Math.max(1, days * slots - 1);
}

/**
 * 実施単位（科目 × 学年）を生成する
 * grade=0 の科目は対象全学年のインスタンスへ展開（scope=ALL）
 * @param {Array} units exam_subject_plan rows
 * @param {Array<number>} grades
 */
export function expandUnits(units, grades) {
  const items = [];
  for (const u of units) {
    const gradeList = Number(u.grade) === 0 ? grades : [Number(u.grade)];
    for (const g of gradeList) {
      const duration = Math.max(1, Number(u.duration_slots) || 1);
      const scope = Number(u.grade) === 0 ? 'ALL' : (String(u.scope || '').toUpperCase() === 'ALL' ? 'ALL' : 'GRADE');
      items.push({
        id: `${u.id}#${g}`,
        unit_id: u.id,
        subject_name: u.subject_name,
        grade: g,
        scope,
        stream: String(u.stream || 'OTHER').toUpperCase(),
        duration_slots: duration,
        fixed_slot: u.fixed_slot ? Number(u.fixed_slot) : null,
        shared_slot: !!u.shared_slot,
        broadcast_slot: !!u.broadcast_slot,
        setter_teacher_id: u.setter_teacher_id ?? null,
        group_key: u.shared_slot ? `shared:${u.subject_name}` : null,
      });
    }
  }
  return items;
}

/**
 * shared 科目を「ブロック」（同一配置単位）へまとめる
 * 決定順序: 共有ブロック → 固定コマ → 2コマ科目 → 全員受験 → 科目名
 */
export function buildBlocks(items) {
  const groups = new Map();
  const blocks = [];

  for (const item of items) {
    if (item.group_key) {
      if (!groups.has(item.group_key)) groups.set(item.group_key, []);
      groups.get(item.group_key).push(item);
    } else {
      blocks.push([item]);
    }
  }
  for (const list of groups.values()) blocks.push(list);

  const rank = (b) =>
    [
      b[0].group_key ? 0 : 1,
      b[0].fixed_slot ? 0 : 1,
      b[0].duration_slots > 1 ? 0 : 1,
      b[0].scope === 'ALL' ? 0 : 1,
      b[0].subject_name,
    ].join('|');

  blocks.sort((a, b) => rank(a).localeCompare(rank(b)));
  return blocks;
}

/** grade -> day -> slot 配列のグリッド生成 */
function createGrid(grades, days, slots) {
  const grid = new Map();
  for (const g of grades) {
    const perDay = [];
    for (let d = 0; d <= days; d++) perDay.push(new Array(slots + 1).fill(null));
    grid.set(g, perDay);
  }
  return grid;
}

/** 求解コンテキスト（可変台帳）を生成
 * @param {Set<string>} [blocked] 学年固有×の集合 `${grade}|${day}|${slot}`
 * @param {Map<number, number[]>} [enabledSlots] day → 使用可能時限（省略時は全時限）
 *        （全学年共通の×は「試験実施日そのもの」を day 数から除外して渡す）
 */
function createContext(blocks, grades, days, slots, rules, options = {}) {
  const dayStreams = new Map();
  for (let d = 1; d <= days; d++) dayStreams.set(d, { SCIENCE: 0, ARTS: 0, OTHER: 0 });

  const allSlots = Array.from({ length: slots }, (_, i) => i + 1);
  const enabledSlots = new Map();
  for (let d = 1; d <= days; d++) {
    const given = options.enabledSlots?.get(d);
    enabledSlots.set(d, given ? allSlots.filter((s) => given.includes(s)) : allSlots.slice());
  }

  return {
    grid: createGrid(grades, days, slots),
    placements: new Map(),
    dayStreams,
    sharedPlacements: new Map(),
    broadcastSlots: new Map(),
    grades,
    days,
    slots,
    rules,
    blockDuration: 1,
    blocked: options.blocked instanceof Set ? options.blocked : new Set(),
    enabledSlots,
  };
}

/** その (grade, day, slot) が使用可能コマか（× を除く） */
export function isCellUsable(ctx, grade, day, slot) {
  const list = ctx.enabledSlots?.get(day);
  if (list && !list.includes(slot)) return false;
  return !(ctx.blocked && ctx.blocked.has(`${Number(grade)}|${Number(day)}|${Number(slot)}`));
}

/** その日の使用可能時限リスト */
export function enabledSlotsForDay(ctx, day) {
  return (ctx.enabledSlots?.get(day) || Array.from({ length: ctx.slots }, (_, i) => i + 1)).slice();
}


/** ブロックの全アイテムが同一 (day, startSlot) に配置可能か（HARD 判定） */
export function canPlaceBlock(ctx, block, day, startSlot) {
  const { days, slots, rules, grid, sharedPlacements, broadcastSlots } = ctx;

  // 最長 duration に揃える（shared ブロックは同一長さでなければならない）
  const blockDuration = Math.max(...block.map((i) => i.duration_slots));
  ctx.blockDuration = blockDuration;

  if (startSlot + blockDuration - 1 > slots) return false;

  for (const item of block) {
    if (item.fixed_slot && startSlot !== item.fixed_slot) return false;
    if (rules.first_period_all && startSlot === 1 && item.scope !== 'ALL') return false;
    if (rules.last_day_all && day === days && item.scope !== 'ALL') return false;
    if (block.length > 1 && item.duration_slots !== blockDuration) return false;

    const perDay = grid.get(item.grade);
    if (!perDay) return false;
    for (let s = startSlot; s < startSlot + item.duration_slots; s++) {
      if (perDay[day][s]) return false;
      if (!isCellUsable(ctx, item.grade, day, s)) return false;
    }
  }

  // shared: 同一グループは全学年で同じ日・同じ時間
  if (block.length > 1) {
    const prev = sharedPlacements.get(block[0].group_key);
    if (prev && (prev.day !== day || prev.startSlot !== startSlot)) return false;
  }

  // broadcast: 同一科目の学年間で時限番号の重複禁止（放送設備の同時使用不可）
  for (const item of block) {
    if (!item.broadcast_slot) continue;
    const used = broadcastSlots.get(`bc:${item.subject_name}`) || new Set();
    for (let s = startSlot; s < startSlot + item.duration_slots; s++) {
      if (used.has(s)) return false;
    }
  }

  return true;
}

/** ブロックを (day, startSlot) に配置 */
export function placeBlock(ctx, block, day, startSlot) {
  for (const item of block) {
    const perDay = ctx.grid.get(item.grade);
    for (let s = startSlot; s < startSlot + item.duration_slots; s++) perDay[day][s] = item.id;
    ctx.placements.set(item.id, { day, slot: startSlot, duration: item.duration_slots });

    const streams = ctx.dayStreams.get(day);
    if (streams) streams[item.stream] = (streams[item.stream] || 0) + 1;

    if (item.group_key) ctx.sharedPlacements.set(item.group_key, { day, startSlot, duration: ctx.blockDuration });
    if (item.broadcast_slot) {
      const key = `bc:${item.subject_name}`;
      if (!ctx.broadcastSlots.has(key)) ctx.broadcastSlots.set(key, new Set());
      for (let s = startSlot; s < startSlot + item.duration_slots; s++) ctx.broadcastSlots.get(key).add(s);
    }
  }
}

/** 配置の取り消し */
export function unplaceBlock(ctx, block, day, startSlot) {
  for (const item of block) {
    const perDay = ctx.grid.get(item.grade);
    for (let s = startSlot; s < startSlot + item.duration_slots; s++) perDay[day][s] = null;
    ctx.placements.delete(item.id);

    const streams = ctx.dayStreams.get(day);
    if (streams) streams[item.stream] = Math.max(0, (streams[item.stream] || 0) - 1);

    if (item.group_key) ctx.sharedPlacements.delete(item.group_key);
    if (item.broadcast_slot) {
      const used = ctx.broadcastSlots.get(`bc:${item.subject_name}`);
      if (used) {
        for (let s = startSlot; s < startSlot + item.duration_slots; s++) used.delete(s);
      }
    }
  }
}

/**
 * 軟制約ペナルティ（小さいほど良い）
 * @param {Map<string,{day,slot,duration}>} placements
 * @param {Array<object>} items
 * @param {{days:number,slots:number,rules:object,history:Array}} meta
 */
export function softPenalty(placements, items, { days, slots, rules, history }) {
  let penalty = 0;
  const posBySubject = new Map();

  for (const item of items) {
    const p = placements.get(item.id);
    if (!p) continue;
    const pos = normalizedPosition(p.day, p.slot, days, slots);
    if (!posBySubject.has(item.subject_name)) posBySubject.set(item.subject_name, []);
    posBySubject.get(item.subject_name).push({ pos, stream: item.stream, day: p.day });
  }

  // S1. 同日の理系/文系偏り（同日の全試験が理系のみ／文系のみ を禁止）
  if (rules.day_stream_mix) {
    const byDay = new Map();
    for (const list of posBySubject.values()) {
      for (const e of list) {
        if (!byDay.has(e.day)) byDay.set(e.day, []);
        byDay.get(e.day).push(e.stream);
      }
    }
    for (const [, streams] of byDay.entries()) {
      if (streams.length < 2) continue;
      const allScience = streams.every((s) => s === 'SCIENCE');
      const allArts = streams.every((s) => s === 'ARTS');
      if (allScience || allArts) penalty += rules.weights.stream_mix;
    }
  }

  // S2. 同一科目の前半/後半偏り（全体平均との差）
  if (rules.balance_even) {
    const allPos = [...posBySubject.values()].flat().map((e) => e.pos);
    const globalMean = allPos.length ? allPos.reduce((s, x) => s + x, 0) / allPos.length : 0;
    for (const list of posBySubject.values()) {
      const mean = list.reduce((s, e) => s + e.pos, 0) / list.length;
      penalty += Math.abs(mean - globalMean) * rules.weights.balance;
    }
  }

  // S3. 過去分布との乖離
  if (rules.history_balance && Array.isArray(history) && history.length > 0) {
    const hist = new Map();
    for (const h of history) {
      const key = String(h.subject_name || h.subjectName || '').trim();
      const pos = normalizedPosition(Number(h.day_number) || h.dayNumber, Number(h.slot_number) || h.slotNumber, days, slots);
      if (!hist.has(key)) hist.set(key, []);
      hist.get(key).push(pos);
    }
    for (const [key, list] of posBySubject.entries()) {
      const hlist = hist.get(key);
      if (!hlist || hlist.length === 0) continue;
      const cur = list.reduce((s, e) => s + e.pos, 0) / list.length;
      const prev = hlist.reduce((s, x) => s + x, 0) / hlist.length;
      penalty += Math.abs(cur - prev) * rules.weights.history;
    }
  }

  return Math.round(penalty * 100) / 100;
}

/** 最終日が使用可能コマで埋まっているか（全員受験科目で覆われているか） */
function lastDayCoveredCtx(ctx) {
  if (!ctx.rules.last_day_all) return true;
  for (const g of ctx.grades) {
    const perDay = ctx.grid.get(g);
    if (!perDay) return false;
    for (const s of enabledSlotsForDay(ctx, ctx.days)) {
      if (!isCellUsable(ctx, g, ctx.days, s)) continue;
      if (!perDay[ctx.days][s]) return false;
    }
  }
  return true;
}

/**
 * MRV(最少ドメイン)順序付け + 深さ優先探索
 * @returns {Map|null} 全実施単位を配置した placements（HARD 制約で不可なら null）
 */
export function searchPlacements(blocks, ctx, nodeLimit = 120000) {
  let nodes = 0;

  const candidatePositions = (block) => {
    const positions = [];
    for (let d = 1; d <= ctx.days; d++) {
      for (let s = 1; s <= ctx.slots; s++) {
        if (canPlaceBlock(ctx, block, d, s)) positions.push({ d, s });
      }
    }
    // 最終日を全員受験科目で埋める必要がある場合、ALL.scope のブロックは最終日を優先試行する
    if (ctx.rules.last_day_all && block[0].scope === 'ALL') {
      positions.sort((a, b) => (b.d === ctx.days) - (a.d === ctx.days) || a.d - b.d || a.s - b.s);
    }
    return positions;
  };

  const dfs = (remaining) => {
    if (remaining.length === 0) return lastDayCoveredCtx(ctx);

    let bestIdx = 0;
    let bestPositions = candidatePositions(remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const pos = candidatePositions(remaining[i]);
      if (pos.length === 0) {
        bestIdx = i;
        bestPositions = pos;
        break;
      }
      if (pos.length < bestPositions.length) {
        bestIdx = i;
        bestPositions = pos;
      }
    }

    if (bestPositions.length === 0) return false;

    const block = remaining[bestIdx];
    const nextRemaining = remaining.filter((_, i) => i !== bestIdx);

    for (const { d, s } of bestPositions) {
      if (nodes++ > nodeLimit) return false;
      placeBlock(ctx, block, d, s);
      if (dfs(nextRemaining)) return true;
      unplaceBlock(ctx, block, d, s);
    }
    return false;
  };

  const ok = dfs(blocks.slice());
  return ok ? ctx.placements : null;
}

/**
 * 軟制約ペナルティを下げる局所交換（hill-climbing）
 * 各ブロックを「外して→最もペナルティの低い位置へ再配置」を改善がなくなるまで繰り返す。
 */
export function localImprove(blocks, ctx, meta, maxPasses = 8) {
  const items = blocks.flat();

  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;

    for (const block of blocks) {
      const cur = ctx.placements.get(block[0].id);
      if (!cur) continue;

      unplaceBlock(ctx, block, cur.day, cur.slot);
      const before = softPenalty(ctx.placements, items, meta);

      let best = { day: cur.day, slot: cur.slot, score: before };
      for (let d = 1; d <= ctx.days; d++) {
        for (let s = 1; s <= ctx.slots; s++) {
          if (!canPlaceBlock(ctx, block, d, s)) continue;
          placeBlock(ctx, block, d, s);
          // 軟制約改善でも最終日の全員受験coverageを壊さない
          const okCoverage = lastDayCoveredCtx(ctx);
          const score = okCoverage ? softPenalty(ctx.placements, items, meta) : Infinity;
          unplaceBlock(ctx, block, d, s);
          if (score < best.score) best = { day: d, slot: s, score };
        }
      }

      placeBlock(ctx, block, best.day, best.slot);
      if (best.day !== cur.day || best.slot !== cur.slot) improved = true;
    }

    if (!improved) break;
  }

  repairLastDay(ctx, blocks);
}

/**
 * 局所改善後に最終日の空きコマを全員受験科目で埋めるrepair
 * （HARD 制約 LAST_DAY_ALL を維持する）
 */
export function repairLastDay(ctx, blocks) {
  if (!ctx.rules.last_day_all) return;

  for (const g of ctx.grades) {
    const perDay = ctx.grid.get(g);
    if (!perDay) continue;

    for (let s = 1; s <= ctx.slots; s++) {
      if (!isCellUsable(ctx, g, ctx.days, s)) continue;
      if (perDay[ctx.days][s]) continue;

      for (const block of blocks) {
        const item = block.find((i) => i.grade === g && i.scope === 'ALL');
        if (!item) continue;
        const cur = ctx.placements.get(item.id);
        if (!cur) continue;
        if (cur.day === ctx.days && cur.slot === s) continue;

        unplaceBlock(ctx, block, cur.day, cur.slot);
        if (canPlaceBlock(ctx, block, ctx.days, s) && lastDayCoveredCtx(ctx)) break;
        placeBlock(ctx, block, cur.day, cur.slot);
      }
    }
  }
}

/** assignments( [{unit_id, grade, day, slot}] ) からコンテキストを再構築 */
export function ctxFromAssignments(assignments, blocks, grades, days, slots, rules, options = {}) {
  const ctx = createContext(blocks, grades, days, slots, rules, options);
  const byId = new Map();
  for (const item of blocks.flat()) byId.set(item.id, item);

  for (const a of assignments) {
    const grade = Number(a.grade);
    const day = Number(a.day);
    const slot = Number(a.slot);
    const item = byId.get(`${a.unit_id}#${grade}`);
    if (!item) continue;
    const perDay = ctx.grid.get(grade);
    if (!perDay) continue;
    for (let s = slot; s < slot + item.duration_slots && s <= slots; s++) perDay[day][s] = item.id;
    ctx.placements.set(item.id, { day, slot, duration: item.duration_slots });

    const streams = ctx.dayStreams.get(day);
    if (streams) streams[item.stream] = (streams[item.stream] || 0) + 1;

    if (item.group_key) {
      const prev = ctx.sharedPlacements.get(item.group_key);
      if (prev && (prev.day !== day || prev.startSlot !== slot)) prev.conflict = true;
      else ctx.sharedPlacements.set(item.group_key, { day, startSlot: slot, duration: item.duration_slots });
    }
    if (item.broadcast_slot) {
      const key = `bc:${item.subject_name}`;
      if (!ctx.broadcastSlots.has(key)) ctx.broadcastSlots.set(key, new Set());
      for (let s = slot; s < slot + item.duration_slots && s <= slots; s++) ctx.broadcastSlots.get(key).add(s);
    }
  }
  return ctx;
}

/**
 * 時間割（手動編集を含む）の検証
 * @param {{days,slots,grades,units,rules,history,assignments}} input
 * @returns {{hard:Array<{type,message}>, soft:Array<{type,message}>, stats:object}}
 */
export function validateTimetable(input) {
  const { days, slots, grades, units } = input;
  const rules = { ...DEFAULT_TIMETABLE_RULES, ...(input.rules || {}) };
  rules.weights = { ...DEFAULT_TIMETABLE_RULES.weights, ...(rules.weights || {}) };
  const assignments = input.assignments || [];
  const options = solverOptions(input);

  const items = expandUnits(units, grades);
  const blocks = buildBlocks(items);
  const ctx = ctxFromAssignments(assignments, blocks, grades, days, slots, rules, options);

  const hard = [];
  const soft = [];
  const placedByGrade = new Map();
  const cellCount = new Map();

  // 1. 全実施単位の配置・収まり・固定コマ
  for (const item of items) {
    const p = ctx.placements.get(item.id);
    if (!p) {
      hard.push({ type: 'UNPLACED', message: `「${item.subject_name}」(${item.grade}学年) が時間割に配置されていません。` });
      continue;
    }
    if (p.slot + item.duration_slots - 1 > slots) {
      hard.push({ type: 'OVERFLOW', message: `「${item.subject_name}」(${item.grade}学年) は ${slots}限を超えて配置されています。` });
    }
    if (item.fixed_slot && p.slot !== item.fixed_slot) {
      hard.push({ type: 'FIXED_SLOT', message: `「${item.subject_name}」(${item.grade}学年) は固定コマ(${item.fixed_slot}限)以外に配置されています。` });
    }
    for (let s = p.slot; s < p.slot + item.duration_slots && s <= slots; s++) {
      if (!isCellUsable(ctx, item.grade, p.day, s)) {
        hard.push({ type: 'BLOCKED_CELL', message: `「${item.subject_name}」(${item.grade}学年) は ×（使用不能コマ）: ${p.day}日目 ${s}限 に配置されています。` });
        break;
      }
    }
    if (!placedByGrade.has(item.grade)) placedByGrade.set(item.grade, []);
    placedByGrade.get(item.grade).push({ day: p.day, slot: p.slot, item });
  }

  // 2. セルの二重使用（同一コマに複数科目）
  for (const g of grades) {
    const perDay = ctx.grid.get(g) || [];
    for (let d = 1; d <= days; d++) {
      for (let s = 1; s <= slots; s++) {
        const id = (perDay[d] || [])[s];
        if (!id) continue;
        cellCount.set(id, (cellCount.get(id) || 0) + 1);
      }
    }
  }
  const seenConflict = new Set();
  for (const item of items) {
    const p = ctx.placements.get(item.id);
    if (!p) continue;
    const need = Math.min(item.duration_slots, slots - p.slot + 1);
    if ((cellCount.get(item.id) || 0) > need) {
      const key = `${item.grade}-${p.day}-${p.slot}`;
      if (!seenConflict.has(key)) {
        seenConflict.add(key);
        hard.push({ type: 'CELL_CONFLICT', message: `${item.grade}学年 ${p.day}日目 ${p.slot}限に複数科目が重複しています。` });
      }
    }
  }

  // 3. 1限は全員受験科目
  if (rules.first_period_all) {
    for (const g of grades) {
      for (const rec of placedByGrade.get(g) || []) {
        if (rec.slot === 1 && rec.item.scope !== 'ALL') {
          hard.push({ type: 'FIRST_PERIOD_ALL', message: `${g}学年 ${rec.day}日目の1限は「全員受験科目」でなければなりません（${rec.item.subject_name}）。` });
        }
      }
    }
  }

  // 4. 最終日は全員受験科目で埋める
  if (rules.last_day_all) {
    for (const g of grades) {
      const lastDayCells = new Array(slots + 1).fill(null);
      for (const rec of placedByGrade.get(g) || []) {
        if (rec.day !== days) continue;
        for (let s = rec.slot; s < rec.slot + rec.item.duration_slots; s++) {
          if (s <= slots) lastDayCells[s] = rec.item;
        }
      }
      for (let s = 1; s <= slots; s++) {
        if (!isCellUsable(ctx, g, days, s)) continue;
        if (!lastDayCells[s]) {
          hard.push({ type: 'LAST_DAY_ALL', message: `最終日(${days}日目) ${g}学年 ${s}限が空いています。全員受験科目で埋める必要があります。` });
        } else if (lastDayCells[s].scope !== 'ALL') {
          hard.push({ type: 'LAST_DAY_ALL', message: `最終日(${days}日目) ${g}学年 ${s}限は全員受験科目でなければなりません（${lastDayCells[s].subject_name}）。` });
        }
      }
    }
  }

  // 5. shared(公共) は全学年で同じ日・同じ時間
  const sharedSubjects = new Map();
  for (const item of items) {
    if (!item.shared_slot) continue;
    const p = ctx.placements.get(item.id);
    if (!p) continue;
    if (!sharedSubjects.has(item.subject_name)) sharedSubjects.set(item.subject_name, new Set());
    sharedSubjects.get(item.subject_name).add(`${p.day}-${p.slot}`);
  }
  for (const [subject, set] of sharedSubjects.entries()) {
    if (set.size > 1) {
      hard.push({ type: 'SHARED_SLOT', message: `共有科目「${subject}」は3学年ともに同じ日・同じ時間に実施してください。` });
    }
  }

  // 6. broadcast(放送) は学年ごとに異なる時限
  const broadcastPerSubject = new Map();
  for (const item of items) {
    if (!item.broadcast_slot) continue;
    const p = ctx.placements.get(item.id);
    if (!p) continue;
    if (!broadcastPerSubject.has(item.subject_name)) broadcastPerSubject.set(item.subject_name, []);
    broadcastPerSubject.get(item.subject_name).push(p.slot);
  }
  for (const [subject, slotList] of broadcastPerSubject.entries()) {
    if (new Set(slotList).size !== slotList.length) {
      hard.push({ type: 'BROADCAST_SLOT', message: `放送設備を使う「${subject}」は3学年で異なる時間に実施してください（時限が重複しています）。` });
    }
  }


  // 7. 同日の理系/文系偏り
  if (rules.day_stream_mix) {
    const streamsByDay = new Map();
    for (const g of grades) {
      for (const rec of placedByGrade.get(g) || []) {
        if (!streamsByDay.has(rec.day)) streamsByDay.set(rec.day, []);
        streamsByDay.get(rec.day).push(rec.item.stream);
      }
    }
    for (const [day, streams] of streamsByDay.entries()) {
      if (streams.length < 2) continue;
      if (streams.every((s) => s === 'SCIENCE')) {
        soft.push({ type: 'DAY_STREAM_MIX', message: `${day}日目は理系科目のみです。全コマが同一系にならないよう調整してください。` });
      } else if (streams.every((s) => s === 'ARTS')) {
        soft.push({ type: 'DAY_STREAM_MIX', message: `${day}日目は文系科目のみです。全コマが同一系にならないよう調整してください。` });
      }
    }
  }

  // 8. 前半/後半の偏り・過去分布との乖離
  const posBySubject = new Map();
  for (const item of items) {
    const p = ctx.placements.get(item.id);
    if (!p) continue;
    const pos = normalizedPosition(p.day, p.slot, days, slots);
    if (!posBySubject.has(item.subject_name)) posBySubject.set(item.subject_name, []);
    posBySubject.get(item.subject_name).push(pos);
  }

  const allPos = [...posBySubject.values()].flat();
  const globalMean = allPos.length ? allPos.reduce((s, x) => s + x, 0) / allPos.length : 0;

  for (const [subject, list] of posBySubject.entries()) {
    const mean = list.reduce((s, x) => s + x, 0) / list.length;
    const deviation = mean - globalMean;
    if (Math.abs(deviation) > 0.34) {
      soft.push({ type: 'BALANCE', message: `「${subject}」は${deviation > 0 ? '後半' : '前半'}に偏っています（中央との差 ${Math.round(Math.abs(deviation) * 100) / 100}）。` });
    }

    const hlist = (input.history || [])
      .filter((h) => String(h.subject_name || h.subjectName || '').trim() === subject)
      .map((h) => normalizedPosition(Number(h.day_number) || h.dayNumber, Number(h.slot_number) || h.slotNumber, days, slots));
    if (hlist.length > 0) {
      const prevMean = hlist.reduce((s, x) => s + x, 0) / hlist.length;
      if (Math.abs(mean - prevMean) > 0.22) {
        soft.push({ type: 'HISTORY_BALANCE', message: `「${subject}」は過去考査（中央 ${Math.round(prevMean * 100)}%の位置）と比べ ${Math.round(Math.abs(mean - prevMean) * 100)}% 偏っています。` });
      }
    }
  }

  // 9. 統計
  const usableCells = usableCellCount(ctx, grades, days, slots);
  const totalCells = usableCells;
  const uniqueCells = [...cellCount.values()].reduce((s, v) => s + v, 0);

  return {
    hard,
    soft,
    stats: {
      totalCells,
      filledCells: uniqueCells,
      fillRate: totalCells ? Math.round((uniqueCells / totalCells) * 100) : 0,
      unplacedUnits: items.filter((i) => !ctx.placements.get(i.id)).length,
      penalty: softPenalty(ctx.placements, items, { days, slots, rules, history: input.history || [] }),
    },
  };
}

/** input（validateTimetable / solveTimetable 用）から × 情報を抽出 */
export function solverOptions(input) {
  const blocked = input.blocked instanceof Set ? input.blocked : new Set(input.blocked || []);
  let enabledSlots = null;
  if (input.enabledSlots instanceof Map) {
    enabledSlots = input.enabledSlots;
  } else if (Array.isArray(input.enabledSlots)) {
    enabledSlots = new Map();
    for (const e of input.enabledSlots) {
      const list = Array.isArray(e.slots) ? e.slots.map(Number) : [];
      enabledSlots.set(Number(e.day), list);
    }
  }
  return { blocked, enabledSlots };
}

/** ctx における実配置コマ数（× を除いた総コマ数） */
export function usableCellCount(ctx, grades, days, slots) {
  let total = 0;
  for (const g of grades) {
    for (let d = 1; d <= days; d++) {
      for (let s = 1; s <= slots; s++) {
        if (isCellUsable(ctx, g, d, s)) total += 1;
      }
    }
  }
  return total;
}

/**
 * 時間割自動作成ソルバー
 * @param {{days:number, slots:number, grades:Array<number>, units:Array<object>, rules?:object, history?:Array}} input
 * @returns {{feasible:boolean, relaxed:boolean, assignments:Array, diagnostics:object, stats:object, penalty:number}}
 */
export function solveTimetable(input) {
  const days = Number(input.days) || 3;
  const slots = Number(input.slots) || 3;
  const grades = (input.grades && input.grades.length ? input.grades : [1, 2, 3]).map(Number);
  const units = input.units || [];
  const history = input.history || [];

  const rules = { ...DEFAULT_TIMETABLE_RULES, ...(input.rules || {}) };
  rules.weights = { ...DEFAULT_TIMETABLE_RULES.weights, ...(rules.weights || {}) };

  const items = expandUnits(units, grades);
  const blocks = buildBlocks(items);
  const meta = { days, slots, rules, history };
  const options = solverOptions(input);

  // 1. HARD 制約下での完全探索
  let ctx = createContext(blocks, grades, days, slots, rules, options);
  let placements = searchPlacements(blocks, ctx);
  let relaxed = false;

  // 2. 1限/最終日制約が満たせない場合は軟制約として再探索（その旨を診断に記録）
  if (!placements) {
    relaxed = true;
    const relaxedRules = { ...rules, first_period_all: false, last_day_all: false };
    ctx = createContext(blocks, grades, days, slots, relaxedRules, options);
    placements = searchPlacements(blocks, ctx);
    meta.rules = relaxedRules;
  }

  if (!placements) {
    const stats = { totalCells: usableCellCount(ctx, grades, days, slots), filledCells: 0, fillRate: 0, unplacedUnits: items.length, penalty: 0 };
    const diag = {
      hard: [{ type: 'INFEASIBLE', message: '設定された制約では時間割を組むことができません。実施科目数・コマ数・固定コマ指定・×（使用不能コマ）を見直してください。' }],
      soft: [],
      stats,
    };
    return { feasible: false, relaxed, assignments: [], diagnostics: diag, stats, penalty: 0 };
  }

  // 3. 軟制約ペナルティの局所改善
  localImprove(blocks, ctx, meta);

  // 4. assignments 化（unit_id + grade 単位）
  const assignments = [];
  for (const item of items) {
    const p = ctx.placements.get(item.id);
    if (!p) continue;
    assignments.push({
      unit_id: item.unit_id,
      grade: item.grade,
      day: p.day,
      slot: p.slot,
      duration_slots: item.duration_slots,
    });
  }

  const diagnostics = validateTimetable({ days, slots, grades, units, rules, history, assignments, blocked: options.blocked, enabledSlots: options.enabledSlots });

  return {
    feasible: diagnostics.hard.length === 0,
    relaxed,
    assignments,
    diagnostics,
    stats: diagnostics.stats,
    penalty: diagnostics.stats.penalty,
  };
}

export default solveTimetable;
