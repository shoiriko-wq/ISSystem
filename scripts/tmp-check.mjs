import { query, pool } from '../config/database.js';
const r = await query("SELECT id, staff_code, name, role FROM users WHERE staff_code LIKE 'T99%' ORDER BY created_at");
console.log(JSON.stringify(r.rows, null, 1));
await pool.end();