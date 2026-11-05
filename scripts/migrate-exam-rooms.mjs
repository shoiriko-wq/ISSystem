import { query, ensureSchema } from '../config/database.js';

const DEFAULT_EXAM_ROOM_NAMES = [
  '1-1', '1-2', '1-3', '1-4', '1-5', '1-6', '1-7',
  '2-1', '2-2', '2-3', '2-4', '2-5', '2-6', '2-7',
  '3-1', '3-2', '3-3', '3-4', '3-5', '3-6', '3-7', '3-8',
  '227', '212', '312', '405', '多目的',
];

function roomRow(mid, name) {
  const m = /^([123])-(\d)$/.exec(name);
  const id = m ? `eroom_${m[1]}_${m[2]}` : /^\d+$/.test(name) ? `eroom_${name}` : 'eroom_multi';
  return { id, mid, name, room_type: m ? 'CLASS' : 'SPECIAL', capacity: m ? 40 : null, grades: m ? `[${m[1]}]` : '[]' };
}

await ensureSchema();

const masters = (await query('SELECT id FROM exam_masters ORDER BY id')).rows.map((r) => r.id);
for (const mid of masters) {
  const existing = (await query('SELECT id, name FROM exam_rooms WHERE exam_master_id = ?', [mid])).rows;
  const stale = existing.filter((r) => !DEFAULT_EXAM_ROOM_NAMES.includes(r.name));
  const staleNames = new Set(stale.map((r) => r.name));

  for (const r of stale) {
    const a = await query('DELETE FROM exam_room_assignments WHERE exam_master_id = ? AND (room_id = ? OR room_name = ?)', [mid, r.id, r.name]);
    const c1 = await query('UPDATE exam_room_config SET standard_room = NULL WHERE exam_master_id = ? AND standard_room = ?', [mid, r.name]);
    await query('DELETE FROM exam_rooms WHERE id = ?', [r.id]);
    console.log(`removed: ${r.name} (${r.id}) cascaded assignments=${a.rowCount} standard_config=${c1.rowCount}`);
  }

  const cfgs = (await query('SELECT id, alt_rooms FROM exam_room_config WHERE exam_master_id = ?', [mid])).rows;
  for (const c of cfgs) {
    let arr = [];
    try { arr = JSON.parse(c.alt_rooms || '[]'); } catch { arr = []; }
    const next = arr.filter((n) => !staleNames.has(String(n)));
    if (next.length !== arr.length) {
      await query('UPDATE exam_room_config SET alt_rooms = ? WHERE id = ?', [JSON.stringify(next), c.id]);
    }
  }

  for (const name of DEFAULT_EXAM_ROOM_NAMES) {
    const d = roomRow(mid, name);
    await query(
      `INSERT INTO exam_rooms (id, exam_master_id, name, room_type, capacity, grades)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (exam_master_id, name) DO NOTHING`,
      [d.id, d.mid, d.name, d.room_type, d.capacity, d.grades]
    );
  }

  const names = (await query('SELECT name FROM exam_rooms WHERE exam_master_id = ? ORDER BY name', [mid])).rows.map((r) => r.name);
  console.log(`exam_master ${mid}: rooms(${names.length}) = ${names.join(',')}`);
}
process.exit(0);
