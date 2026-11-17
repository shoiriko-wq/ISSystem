import { query, pool } from './config/database.js';
const r = await query("SELECT staff_code, name, subjects FROM users WHERE subjects IS NOT NULL AND subjects <> '[]' ORDER BY staff_code ASC");
for (const row of r.rows) console.log(`${row.staff_code} :: ${row.subjects}`);
const c = await query('SELECT count(*)::int c FROM classes');
console.log('classes:', c.rows[0].c);
await pool.end();
