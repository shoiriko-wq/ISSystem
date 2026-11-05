import { query, ensureSchema } from '../config/database.js';

const DEFAULT_FACILITY_ROWS = [
  ['fac_1', '学文館会議室', 'ROOM'],
  ['fac_2', '西会議室', 'ROOM'],
  ['fac_3', '東会議室', 'ROOM'],
  ['fac_4', '応接室', 'ROOM'],
  ['fac_5', '図書室', 'ROOM'],
  ['fac_6', '食堂', 'ROOM'],
  ['fac_7', '多目的教室', 'ROOM'],
  ['fac_8', '４０５教室（西社会科教室）', 'SPECIAL'],
  ['fac_9', '４０９教室（東社会科教室）', 'SPECIAL'],
  ['fac_10', '２１２教室', 'SPECIAL'],
  ['fac_11', '３１２教室', 'SPECIAL'],
  ['fac_12', '２２７教室', 'SPECIAL'],
  ['fac_13', '２２８教室（ＤＸルーム）', 'SPECIAL'],
  ['fac_14', '視聴覚教室', 'SPECIAL'],
  ['fac_15', '化学教室', 'SPECIAL'],
  ['fac_16', '生物教室', 'SPECIAL'],
  ['fac_17', '地学教室', 'SPECIAL'],
];

const DEFAULT_NAMES = new Set(DEFAULT_FACILITY_ROWS.map((r) => r[1]));

await ensureSchema();

const existing = (await query('SELECT id, name, category FROM resources ORDER BY id')).rows;

// 1) 初期設定以外の施設を削除（FK制約を満たすため予約・編集ロック・セル値を先に除去）
for (const r of existing) {
  if (DEFAULT_NAMES.has(r.name)) continue;
  const resv = await query('DELETE FROM reservations WHERE COALESCE(resource_id, facility_id) = ? RETURNING id', [r.id]);
  const locks = await query('DELETE FROM editing_locks WHERE resource_id = ? RETURNING resource_id', [r.id]);
  const cells = await query('DELETE FROM facility_cells WHERE cell_id = ? RETURNING cell_key', [r.id]);
  await query('DELETE FROM resources WHERE id = ?', [r.id]);
  console.log(`removed: ${r.name} (${r.id}) cascaded reservations=${resv.rowCount} locks=${locks.rowCount} cells=${cells.rowCount}`);
}

// 2) 初期設定施設を投入（名前・ID 両方の重複を避ける）
const after = (await query('SELECT id, name FROM resources')).rows;
const byName = new Set(after.map((r) => r.name));
const byId = new Set(after.map((r) => r.id));
for (const [id, name, category] of DEFAULT_FACILITY_ROWS) {
  if (byName.has(name) || byId.has(id)) continue;
  await query('INSERT INTO resources (id, name, category) VALUES (?, ?, ?)', [id, name, category]);
}

const names = (await query('SELECT id, name, category FROM resources ORDER BY id')).rows;
console.log(`resources(${names.length}) = ${names.map((r) => r.name).join(',')}`);
process.exit(0);
