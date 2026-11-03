/**
 * ISSystem 定期考査 時間割「コマ組み」ソルバー
 * -------------------------------------------------------------
 * 入力単位
 *  rows     : クラス・コース（行）[{id, grade, name}]
 *  commands : 時間割コマ [{id, name, stream, members, courses, duration_slots}]
 *  blocks   : コマ組み [{id, name, cells:[{class_course_id, offset, command_id}], rows, span, constraints}]
 *  groups   : コマ組みグループ [{id, name, kind, members:[block_id], constraints}]
 *  conditions: コマ組み入れ条件 [{block_shape_id, class_course_id, day_number, slot_number, allowed}]
 *
 * 表現マッピング
 *  H1 1限目は生徒全員が受ける科目  → グループ kind=ALL_STUDENTS + constraints.first_slot_required
 *  H2 最終日は全員受験科目で埋める → 同グループ + constraints.last_day_required
 *  H3 数学Ⅲ 100分（2コマ連続）     → 1コマ組みの cells(offset 0,1) + constraints.fixed_start_slot
 *  H4 公共は3学年同日前同時間       → rows に複数学年のクラス・コースを持つ 1 コマ組み
 *  H5 放送設備の同時使用不可        → グループ kind=BROADCAST + constraints.slot_exclusive
 *  H6 同日を理系のみ／文系のみ禁止  → グループ kind=SCIENCE/ARTS + constraints.day_purity_forbid（軟制約）
 *  H7 入れ条件                     → 配置不可能マスの集合（HARD）
 *  S1 同一科目の前後半偏り・過去分布 → 軟制約ペナルティ
 *
 * 手法: MRV(最少ドメイン)順序付け + 深さ優先探索 + 局所交換（乱数不使用・決定的）
 */

export const DEFAULT_GROUP_KINDS = ['ALL_STUDENTS', 'SCIENCE', 'ARTS', 'BROADCAST', 'CUSTOM'];

/** クラス・コース行キー */
function rowKey(row) {
  return String(row.class_course_id ?? row.id ?? row);
}

/**
 * コマからコマ組み（形）を自動生成する
 * 1コマ = 1コマ組み（span = duration_slots、全 rows に同一 offsets）
 * @param {Array} commands
 * @param {Array} rows
 */
export function autoBlockShapes(commands, rows) {
  const byRow = new Map(rows.map((r) => [rowKey(r), r]));
  const out = [];
  for (const c of commands) {
    const span = Math.max(1, Number(c.duration_slots) || 1);
    const cells = [];
    const useRows = (c.courses && c.courses.length ? c.courses : rows).map(rowKey).filter((k) => byRow.has(k));
    for (const k of useRows) {
      for (let o = 0; o < span; o++) cells.push({ class_course_id: k, offset: o, command_id: String(c.id) });
    }
    out.push({
      id: `auto:${c.id}`,
      name: c.name,
      cells,
      rows: useRows.map((k) => ({ grade: byRow.get(k).grade, class_course_id: k })),
      span,
      constraints: {},
      auto_created: true,
      command_ids: [String(c.id)],
    });
  }
  return out;
}

/** 入れ条件 → 配置不可能マス集合（block_id → Set(`${row}|${day}|${slot}`)） */
export function buildForbidden(conditions, blockIds) {
  const forbidden = new Map();
  const allowedOverride = new Set();
  for (const c of conditions || []) {
    const b = String(c.block_shape_id);
    if (!blockIds.has(b)) continue;
    const row = c.class_course_id ? String(c.class_course_id) : '*';
    const key = `${row}|${Number(c.day_number)}|${Number(c.slot_number)}`;
    if (c.allowed) allowedOverride.add(`${b}|${key}`);
    else forbidden.set(b, (forbidden.get(b) || new Set()).add(key));
  }
  for (const [b, set] of forbidden.entries()) {
    for (const k of [...set]) {
      if (allowedOverride.has(`${b}|${k}`)) set.delete(k);
    }
  }
  return forbidden;
}

/**
 * ソルバー用コンテキスト生成
 * @param {Array} blocks
 * @param {Array} rows
 * @param {Array} daySlots buildDaySlots 結果
 * @param {number} slots 1日の時限数
 * @param {object} rules
 * @param {object} options { blockedRowCells:Set(`${row}|${day}|${slot}`), groups, forbidden }
 */
export function createBlockContext(blocks, rows, daySlots, slots, rules, options = {}) {
  const grid = new Map();
  for (const r of rows) {
    const perDay = [];
    for (let d = 0; d <= daySlots.length; d++) perDay.push(new Array(slots + 1).fill(null));
    grid.set(rowKey(r), perDay);
  }

  const enabledByDay = new Map(daySlots.map((d) => [d.day, new Set(d.enabled_slots)]));
  const blockedRowCells = options.blockedRowCells instanceof Set ? options.blockedRowCells : new Set();

  const groups = (options.groups || []).map((g) => ({
    id: String(g.id),
    kind: String(g.kind || 'CUSTOM').toUpperCase(),
    members: new Set((g.members || []).map(String)),
    constraints: g.constraints || {},
  }));

  const groupOfBlock = new Map();
  for (const g of groups) {
    for (const m of g.members) {
      if (!groupOfBlock.has(m)) groupOfBlock.set(m, []);
      groupOfBlock.get(m).push(g);
    }
  }

  // 排他グループの組（groupA ↔ groupB）
  const exclusivePartners = new Map();
  for (const g of groups) {
    const partners = new Set((g.constraints.exclusive_with || []).map(String));
    if (partners.size) exclusivePartners.set(g.id, partners);
  }

  const blockIds = new Set(blocks.map((b) => String(b.id)));

  return {
    grid,
    rows,
    daySlots,
    days: daySlots.length,
    slots,
    rules,
    enabledByDay,
    blockedRowCells,
    groups,
    groupOfBlock,
    exclusivePartners,
    placements: new Map(),
    forbidden: options.forbidden instanceof Map ? options.forbidden : buildForbidden(options.conditions || [], blockIds),
    broadcastStarts: new Map(),
    groupStarts: new Map(),
    dayBlocks: new Map(),
    commandNames: options.commandNames instanceof Map ? options.commandNames : new Map(),
  };
}

/** その行・コマが使用可能か（× を除く） */
export function isRowCellUsable(ctx, row, day, slot) {
  const enabled = ctx.enabledByDay.get(Number(day));
  if (!enabled || !enabled.has(Number(slot))) return false;
  return !ctx.blockedRowCells.has(`${row}|${day}|${slot}`);
}

/** ブロックが所属するグループの制約集合 */
function constraintsFor(ctx, block) {
  const list = ctx.groupOfBlock.get(String(block.id)) || [];
  const merged = { ...(block.constraints || {}) };
  for (const g of list) {
    if (g.constraints.first_slot_required) merged.first_slot_required = true;
    if (g.constraints.last_day_required) merged.last_day_required = true;
    if (g.constraints.slot_exclusive) merged.slot_exclusive = true;
    if (g.constraints.day_purity_forbid) merged.day_purity_forbid = true;
    if (g.kind === 'ALL_STUDENTS') merged.scope_all = true;
    if (g.kind === 'SCIENCE') merged.stream_kind = 'SCIENCE';
    if (g.kind === 'ARTS') merged.stream_kind = 'ARTS';
    if (g.kind === 'BROADCAST') merged.slot_exclusive = true;
  }
  return merged;
}


/**
 * コマ組みを (day, startSlot) に配置可能か（HARD 判定）
 */
export function canPlaceBlockShape(ctx, block, day, startSlot) {
  const cells = block.cells || [];
  const span = Math.max(1, Number(block.span) || 1);
  const con = constraintsFor(ctx, block);

  if (startSlot + span - 1 > ctx.slots) return false;
  if (con.fixed_start_slot && startSlot !== Number(con.fixed_start_slot)) return false;
  if (Array.isArray(con.start_slots) && con.start_slots.length && !con.start_slots.map(Number).includes(startSlot)) return false;

  const forbidden = ctx.forbidden.get(String(block.id)) || new Set();

  for (const c of cells) {
    const row = rowKey(c);
    const target = startSlot + (Number(c.offset) || 0);
    const perDay = ctx.grid.get(row);
    if (!perDay) return false;
    if (perDay[day][target]) return false;
    if (!isRowCellUsable(ctx, row, day, target)) return false;
    if (forbidden.has(`${row}|${day}|${target}`)) return false;
    // 1限目は全員受験コマ組みのみ（H1）
    if (ctx.rules.first_period_all && target === 1 && con.scope_all !== true) return false;
  }

  // 放送設備の同時使用不可：同一グループ内は同日で開始コマが重複できない（H5）
  if (con.slot_exclusive) {
    const used = ctx.broadcastStarts.get(day) || new Set();
    if (used.has(startSlot)) return false;
  }

  // グループ排他（H4: exclusive_with）: 排他グループが同じ開始コマに配置されている位置は使えない
  const blockGroups = ctx.groupOfBlock.get(String(block.id)) || [];
  if (blockGroups.length && ctx.exclusivePartners?.size) {
    const occupied = ctx.groupStarts.get(`${day}|${startSlot}`);
    if (occupied && occupied.size) {
      for (const g of blockGroups) {
        const partners = ctx.exclusivePartners.get(g.id);
        if (!partners) continue;
        for (const p of occupied) {
          if (partners.has(p)) return false;
        }
      }
    }
  }

  // 最終日は全員受験コマ組みのみで埋める（H2）
  if (ctx.rules.last_day_all && day === ctx.days && con.last_day_required && con.scope_all !== true) return false;

  return true;
}

export function placeBlockShape(ctx, block, day, startSlot) {
  const con = constraintsFor(ctx, block);
  for (const c of block.cells || []) {
    const row = rowKey(c);
    const target = startSlot + (Number(c.offset) || 0);
    const perDay = ctx.grid.get(row);
    if (perDay) perDay[day][target] = String(block.id);
  }
  ctx.placements.set(String(block.id), { block_id: String(block.id), day, slot: startSlot, span: Math.max(1, Number(block.span) || 1) });
  if (con.slot_exclusive) {
    if (!ctx.broadcastStarts.has(day)) ctx.broadcastStarts.set(day, new Set());
    ctx.broadcastStarts.get(day).add(startSlot);
  }
  const key = `${day}|${startSlot}`;
  if (!ctx.groupStarts.has(key)) ctx.groupStarts.set(key, new Set());
  for (const g of ctx.groupOfBlock.get(String(block.id)) || []) ctx.groupStarts.get(key).add(g.id);
  if (!ctx.dayBlocks.has(day)) ctx.dayBlocks.set(day, []);
  ctx.dayBlocks.get(day).push(String(block.id));
}

export function unplaceBlockShape(ctx, block, day, startSlot) {
  const con = constraintsFor(ctx, block);
  for (const c of block.cells || []) {
    const row = rowKey(c);
    const target = startSlot + (Number(c.offset) || 0);
    const perDay = ctx.grid.get(row);
    if (perDay && perDay[day][target] === String(block.id)) perDay[day][target] = null;
  }
  ctx.placements.delete(String(block.id));
  const used = ctx.broadcastStarts.get(day);
  if (used && con.slot_exclusive) used.delete(startSlot);
  const gset = ctx.groupStarts.get(`${day}|${startSlot}`);
  if (gset) {
    for (const g of ctx.groupOfBlock.get(String(block.id)) || []) gset.delete(g.id);
    if (!gset.size) ctx.groupStarts.delete(`${day}|${startSlot}`);
  }
  const list = ctx.dayBlocks.get(day) || [];
  const i = list.indexOf(String(block.id));
  if (i >= 0) list.splice(i, 1);
}

/** 正規化位置（0=最初, 1=最後） */
function normalizedPosition(day, slot, days, slots, daySlots) {
  const ordered = daySlots.map((d) => d.day);
  const dIdx = ordered.indexOf(Number(day));
  const idx = (dIdx < 0 ? 0 : dIdx) * slots + (Number(slot) - 1);
  return idx / Math.max(1, days * slots - 1);
}

/** 軟制約ペナルティ（小さいほど良い） */
export function blockSoftPenalty(ctx, blocks, meta) {
  let penalty = 0;

  // 同日を理系のみ／文系のみで埋めることの禁止（軟化）
  const purityGroups = ctx.groups.filter((g) => g.constraints.day_purity_forbid || g.kind === 'SCIENCE' || g.kind === 'ARTS');
  if (ctx.rules.day_stream_mix) {
    for (const g of purityGroups) {
      for (const [, list] of ctx.dayBlocks.entries()) {
        if (list.length < 2) continue;
        const inGroup = list.filter((b) => g.members.has(b));
        if (inGroup.length === list.length) penalty += ctx.rules.weights?.stream_mix ?? 120;
      }
    }
  }

  // 同一コマの前半・後半偏り（S1）
  const positions = new Map();
  for (const b of blocks) {
    const p = ctx.placements.get(String(b.id));
    if (!p) continue;
    const pos = normalizedPosition(p.day, p.slot, ctx.days, ctx.slots, ctx.daySlots);
    for (const c of b.cells || []) {
      const cmd = String(c.command_id);
      if (!positions.has(cmd)) positions.set(cmd, []);
      positions.get(cmd).push(pos);
    }
  }
  if (ctx.rules.balance_even) {
    const all = [...positions.values()].flat();
    const globalMean = all.length ? all.reduce((s, x) => s + x, 0) / all.length : 0;
    for (const list of positions.values()) {
      const mean = list.reduce((s, x) => s + x, 0) / list.length;
      penalty += Math.abs(mean - globalMean) * (ctx.rules.weights?.balance ?? 45);
    }
  }

  // 過去分布照合（S2）
  if (ctx.rules.history_balance && Array.isArray(meta.history) && meta.history.length) {
    const hist = new Map();
    for (const h of meta.history) {
      const key = String(h.subject_name || h.subjectName || '').trim();
      const pos = normalizedPosition(
        Number(h.day_number) || h.dayNumber,
        Number(h.slot_number) || h.slotNumber,
        ctx.days,
        ctx.slots,
        ctx.daySlots
      );
      if (!hist.has(key)) hist.set(key, []);
      hist.get(key).push(pos);
    }
    for (const b of blocks) {
      const p = ctx.placements.get(String(b.id));
      if (!p) continue;
      const pos = normalizedPosition(p.day, p.slot, ctx.days, ctx.slots, ctx.daySlots);
      for (const c of b.cells || []) {
        const name = ctx.commandNames?.get(String(c.command_id)) || String(c.command_name || '');
        const hlist = hist.get(name);
        if (!hlist || !hlist.length) continue;
        const prev = hlist.reduce((s, x) => s + x, 0) / hlist.length;
        penalty += Math.abs(pos - prev) * (ctx.rules.weights?.history ?? 30);
      }
    }
  }

  return Math.round(penalty * 100) / 100;
}

export const DEFAULT_TIMETABLE_RULES_BLOCK = {
  first_period_all: true,
  last_day_all: true,
  day_stream_mix: true,
  balance_even: true,
  history_balance: true,
  weights: { stream_mix: 120, balance: 45, history: 30 },
};


/** 入力からソルバーオプションを組み立てる */
export function buildBlockOptions(input, blocks) {
  const blockIds = new Set(blocks.map((b) => String(b.id)));
  const conditions = Array.isArray(input.conditions) ? input.conditions : [];
  return {
    groups: input.groups || [],
    forbidden:
      input.forbidden instanceof Map
        ? input.forbidden
        : buildForbidden(conditions, blockIds),
    blockedRowCells: input.blockedRowCells instanceof Set ? input.blockedRowCells : new Set(input.blockedRowCells || []),
  };
}

/** 使用可能マスの総数（行 × 実施日 × 時限） */
function usableRowCells(ctx, rows, daySlots) {
  let total = 0;
  for (const r of rows) {
    for (const d of daySlots) {
      for (const s of d.enabled_slots) {
        if (!ctx.blockedRowCells.has(`${rowKey(r)}|${d.day}|${s}`)) total += 1;
      }
    }
  }
  return total;
}


/** 1限目（全実施日）と最終日の coverage 確認（H1/H2） */
function coverageOK(ctx, blocks) {
  const byId = new Map(blocks.map((b) => [String(b.id), b]));
  const allAtSlot1 = (day) => {
    for (const r of ctx.rows) {
      const usable = !ctx.blockedRowCells.has(`${rowKey(r)}|${day}|1`) && (ctx.enabledByDay.get(day)?.has(1) ?? false);
      if (!usable) continue;
      const id = ctx.grid.get(rowKey(r))?.[day]?.[1];
      if (!id) return false;
      const b = byId.get(id);
      if (!b || constraintsFor(ctx, b).scope_all !== true) return false;
    }
    return true;
  };

  if (ctx.rules.first_period_all) {
    for (const d of ctx.daySlots) {
      if (!allAtSlot1(d.day)) return false;
    }
  }

  if (ctx.rules.last_day_all) {
    const lastDay = ctx.daySlots[ctx.daySlots.length - 1]?.day;
    if (lastDay == null) return true;
    for (const r of ctx.rows) {
      for (const s of ctx.enabledByDay.get(lastDay) || []) {
        if (ctx.blockedRowCells.has(`${rowKey(r)}|${lastDay}|${s}`)) continue;
        const id = ctx.grid.get(rowKey(r))?.[lastDay]?.[s];
        if (!id) return false;
        const b = byId.get(id);
        if (!b || constraintsFor(ctx, b).scope_all !== true) return false;
      }
    }
  }
  return true;
}

/** 試行位置（1限目の制約は canPlaceBlockShape で強制） */
function candidatePositions(ctx, block) {
  const positions = [];
  for (const d of ctx.daySlots) {
    for (const s of ctx.enabledByDay.get(d.day) || []) {
      if (canPlaceBlockShape(ctx, block, d.day, s)) positions.push({ d: d.day, s });
    }
  }
  const con = constraintsFor(ctx, block);
  if (ctx.rules.last_day_all && con.scope_all === true) {
    const lastDay = ctx.daySlots[ctx.daySlots.length - 1]?.day;
    positions.sort((a, b) => (b.d === lastDay) - (a.d === lastDay) || a.d - b.d || a.s - b.s);
  }
  return positions;
}

/** MRV 順序付け + 深さ優先探索 */
export function searchBlockPlacements(blocks, ctx, nodeLimit = 120000) {
  let nodes = 0;
  const dfs = (remaining) => {
    if (remaining.length === 0) return coverageOK(ctx, blocks);

    let bestIdx = 0;
    let bestPositions = candidatePositions(ctx, remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const pos = candidatePositions(ctx, remaining[i]);
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
    const next = remaining.filter((_, i) => i !== bestIdx);
    for (const { d, s } of bestPositions) {
      if (nodes++ > nodeLimit) return false;
      placeBlockShape(ctx, block, d, s);
      if (dfs(next)) return true;
      unplaceBlockShape(ctx, block, d, s);
    }
    return false;
  };

  const ok = dfs(blocks.slice());
  return ok ? ctx.placements : null;
}

/** 軟制約ペナルティを下げる局所交換 */
export function localImproveBlocks(blocks, ctx, meta, maxPasses = 8) {
  for (let pass = 0; pass < maxPasses; pass++) {
    let improved = false;
    for (const block of blocks) {
      const cur = ctx.placements.get(String(block.id));
      if (!cur) continue;
      unplaceBlockShape(ctx, block, cur.day, cur.slot);
      const before = coverageOK(ctx, blocks) ? blockSoftPenalty(ctx, blocks, meta) : Infinity;
      let best = { day: cur.day, slot: cur.slot, score: before };
      for (const d of ctx.daySlots) {
        for (const s of ctx.enabledByDay.get(d.day) || []) {
          if (!canPlaceBlockShape(ctx, block, d.day, s)) continue;
          placeBlockShape(ctx, block, d.day, s);
          const ok = coverageOK(ctx, blocks);
          const score = ok ? blockSoftPenalty(ctx, blocks, meta) : Infinity;
          unplaceBlockShape(ctx, block, d.day, s);
          if (score < best.score) best = { day: d.day, slot: s, score };
        }
      }
      placeBlockShape(ctx, block, best.day, best.slot);
      if (best.day !== cur.day || best.slot !== cur.slot) improved = true;
    }
    if (!improved) break;
  }
}

/**
 * コマ組み配置の検証（教務の手動配置でも自動配置でも同じ検証を通す）
 * @param {{daySlots, slots, rows, blocks, commands, groups, conditions, rules, history, blockedRowCells, placements}} input
 * @returns {{hard:Array, soft:Array, stats:object}}
 */
export function validateBlockPlacements(input) {
  const slots = Number(input.slots) || 0;
  const daySlots = input.daySlots || [];
  const rows = (input.rows || []).map((r) => ({ id: rowKey(r), grade: Number(r.grade) || 0, name: r.name }));
  const commands = input.commands || [];
  const rules = { ...DEFAULT_TIMETABLE_RULES_BLOCK, ...(input.rules || {}) };
  rules.weights = { ...DEFAULT_TIMETABLE_RULES_BLOCK.weights, ...(rules.weights || {}) };
  const blocks = (input.blocks || []).map((b) => ({
    ...b,
    id: String(b.id),
    span: Math.max(1, Number(b.span) || 1),
    constraints: b.constraints || {},
    cells: (b.cells || []).map((c) => ({ class_course_id: rowKey(c), offset: Number(c.offset) || 0, command_id: String(c.command_id) })),
  }));

  const commandNames = input.commandNames instanceof Map ? input.commandNames : new Map(commands.map((c) => [String(c.id), c.name]));
  const options = buildBlockOptions(input, blocks);
  const ctx = createBlockContext(blocks, rows, daySlots, slots, rules, { ...options, commandNames });

  for (const p of input.placements || []) {
    const pid = String(p.block_id ?? p.id ?? p.shapeId ?? '');
    const b = blocks.find((x) => String(x.id) === pid);
    if (b) placeBlockShape(ctx, b, Number(p.day), Number(p.slot));
  }

  const hard = [];
  const soft = [];
  const cellCount = new Map();

  for (const b of blocks) {
    const p = ctx.placements.get(String(b.id));
    if (!p) {
      hard.push({ type: 'UNPLACED', message: `コマ組み「${b.name}」が時間割に配置されていません。` });
      continue;
    }
    if (p.slot + b.span - 1 > slots) {
      hard.push({ type: 'OVERFLOW', message: `コマ組み「${b.name}」(${b.span}コマ) が ${slots}限を超えて配置されています。` });
    }
    const con = constraintsFor(ctx, b);
    if (con.fixed_start_slot && p.slot !== Number(con.fixed_start_slot)) {
      hard.push({ type: 'FIXED_SLOT', message: `コマ組み「${b.name}」は固定開始コマ（${con.fixed_start_slot}限目）以外に配置されています。` });
    }
    for (const c of b.cells || []) {
      const row = rowKey(c);
      const target = p.slot + (Number(c.offset) || 0);
      if (!isRowCellUsable(ctx, row, p.day, target)) {
        hard.push({ type: 'BLOCKED_CELL', message: `コマ組み「${b.name}」は ×（使用不能コマ）を含む位置（${p.day}日目 ${target}限 ${row}）に配置されています。` });
      }
      const forbidden = ctx.forbidden.get(String(b.id)) || new Set();
      if (forbidden.has(`${row}|${p.day}|${target}`)) {
        hard.push({ type: 'CONDITION_FORBIDDEN', message: `コマ組み「${b.name}」は入れ条件で禁止されたマス（${p.day}日目 ${target}限 ${row}）を含みます。` });
      }
      const key = `${row}|${p.day}|${target}`;
      cellCount.set(key, (cellCount.get(key) || 0) + 1);
    }
  }

  for (const [key, n] of cellCount.entries()) {
    if (n > 1) {
      const [row, day, slot] = key.split('|');
      hard.push({ type: 'OVERLAP', message: `マス ${row} の ${day}日目 ${slot}限 が複数のコマ組みで使われています。` });
    }
  }

  // 放送設備の同時使用（H5: slot_exclusive）
  for (const g of ctx.groups.filter((x) => x.constraints.slot_exclusive || x.kind === 'BROADCAST')) {
    const seen = new Map();
    for (const [day, list] of ctx.dayBlocks.entries()) {
      for (const bId of list) {
        if (!g.members.has(bId)) continue;
        const p = ctx.placements.get(bId);
        if (!p) continue;
        const key = `${day}:${p.slot}`;
        if (seen.has(key)) {
          hard.push({ type: 'BROADCAST_CONFLICT', message: `放送を使うコマ組みが ${day}日目 ${p.slot}限 で重複しています（${commandNames.get(bId) || bId}）。` });
        }
        seen.set(key, bId);
      }
    }
  }

  // グループ排他（H4: exclusive_with）: 排他グループが同じ開始コマに同時配置されていないか
  if (ctx.exclusivePartners?.size) {
    const exclPairs = new Set();
    for (const g of ctx.groups) {
      for (const other of (g.constraints.exclusive_with || []).map(String)) {
        exclPairs.add([g.id, other].sort().join('|'));
      }
    }
    for (const [key, gset] of ctx.groupStarts.entries()) {
      if (gset.size < 2) continue;
      for (const pair of exclPairs) {
        const [ga, gb] = pair.split('|');
        if (gset.has(ga) && gset.has(gb)) {
          const [day, slot] = key.split('|');
          hard.push({ type: 'GROUP_EXCLUSIVE', message: `${day}日目 ${slot}限 に排他グループ（${ga} / ${gb}）が同時に配置されています。` });
        }
      }
    }
  }

  // 同日を理系のみ／文系のみで埋めない（H6: day_purity_forbid）
  const purityGroups = ctx.groups.filter((g) => g.constraints.day_purity_forbid || g.kind === 'SCIENCE' || g.kind === 'ARTS');
  for (const [day, list] of ctx.dayBlocks.entries()) {
    if (list.length < 2) continue;
    for (const g of purityGroups) {
      const inGroup = list.filter((bId) => g.members.has(bId));
      if (inGroup.length === list.length && g.constraints.day_purity_forbid) {
        hard.push({ type: 'DAY_PURITY', message: `${day}日目は ${g.kind === 'SCIENCE' ? '理系' : '文系'}コマ組みだけで埋められています。` });
      }
    }
  }

  const usableCells = usableRowCells(ctx, rows, daySlots);
  const filled = [...cellCount.values()].reduce((s, v) => s + v, 0);
  const penalty = blockSoftPenalty(ctx, blocks, { history: input.history || [] });

  return {
    hard,
    soft,
    stats: {
      totalCells: usableCells,
      filledCells: filled,
      fillRate: usableCells ? Math.round((filled / usableCells) * 100) : 0,
      unplacedBlocks: blocks.filter((b) => !ctx.placements.get(String(b.id))).length,
      penalty,
    },
  };
}

/**
 * 時間割自動作成（コマ組みベース）
 * @param {{daySlots, slots, rows, commands, blocks, groups, conditions, rules, history, blockedRowCells}} input
 */
export function solveBlockTimetable(input) {
  const slots = Number(input.slots) || 0;
  const daySlots = input.daySlots || [];
  const rows = (input.rows || []).map((r) => ({ id: rowKey(r), grade: Number(r.grade) || 0, name: r.name }));
  const commands = input.commands || [];

  const rules = { ...DEFAULT_TIMETABLE_RULES_BLOCK, ...(input.rules || {}) };
  rules.weights = { ...DEFAULT_TIMETABLE_RULES_BLOCK.weights, ...(rules.weights || {}) };

  const blocks = (input.blocks && input.blocks.length ? input.blocks : autoBlockShapes(commands, rows)).map((b) => ({
    ...b,
    id: String(b.id),
    span: Math.max(1, Number(b.span) || 1),
    constraints: b.constraints || {},
    cells: (b.cells || []).map((c) => ({ class_course_id: rowKey(c), offset: Number(c.offset) || 0, command_id: String(c.command_id) })),
  }));

  const commandNames = new Map(commands.map((c) => [String(c.id), c.name]));
  const options = buildBlockOptions(input, blocks);
  const meta = { history: input.history || [] };

  let ctx = createBlockContext(blocks, rows, daySlots, slots, rules, { ...options, commandNames });
  let placements = searchBlockPlacements(blocks, ctx);
  const relaxed = !placements;

  // 厳しすぎるハード条件（1限目全員・最終日全員）を緩めて再試行する
  if (!placements) {
    const relaxedRules = { ...rules, first_period_all: false, last_day_all: false };
    ctx = createBlockContext(blocks, rows, daySlots, slots, relaxedRules, { ...options, commandNames });
    placements = searchBlockPlacements(blocks, ctx);
  }

  if (!placements) {
    const diag = {
      hard: [{ type: 'INFEASIBLE', message: '設定されたコマ組み・入れ条件・グループ制約では時間割を組めません。コマ組みの形・入れ条件・考査期間を見直してください。' }],
      soft: [],
      stats: { totalCells: usableRowCells(ctx, rows, daySlots), filledCells: 0, fillRate: 0, unplacedBlocks: blocks.length, penalty: 0 },
    };
    return { feasible: false, relaxed: true, placements: [], diagnostics: diag, stats: diag.stats, penalty: 0 };
  }

  localImproveBlocks(blocks, ctx, meta);

  const out = [];
  for (const b of blocks) {
    const p = ctx.placements.get(String(b.id));
    if (!p) continue;
    out.push({
      block_id: b.id,
      name: b.name,
      day: p.day,
      slot: p.slot,
      span: p.span,
      cells: b.cells.map((c) => ({ ...c, command_name: commandNames.get(c.command_id) || null })),
    });
  }

  const diagnostics = validateBlockPlacements({
    daySlots,
    slots,
    rows,
    blocks,
    commands,
    groups: input.groups || [],
    conditions: input.conditions || [],
    rules,
    history: input.history || [],
    blockedRowCells: options.blockedRowCells,
    commandNames,
    placements: out,
  });

  return {
    feasible: diagnostics.hard.length === 0,
    relaxed,
    placements: out,
    diagnostics,
    stats: diagnostics.stats,
    penalty: diagnostics.stats.penalty,
  };
}

export default solveBlockTimetable;


