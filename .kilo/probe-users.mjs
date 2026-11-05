import { query, ensureSchema } from '../config/database.js';
await ensureSchema();
const t = (await query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE 'user%' OR table_name LIKE 'staff%') ORDER BY table_name")).rows.map((r) => r.table_name);
console.log('tables:', t.join(','));
const cols = (await query("SELECT column_name FROM information_schema.columns WHERE table_name='users' ORDER BY ordinal_position")).rows.map((r) => r.column_name);
console.log('users cols:', cols.join(','));
const rows = (await query('SELECT * FROM users ORDER BY role DESC LIMIT 8')).rows.map((r) => ({ staff_code: r.staff_code ?? r.id, role: r.role, name: r.name, is_kyomu: r.is_kyomu, grade: r.grade }));
console.log(JSON.stringify(rows, null, 1));
process.exit(0);
