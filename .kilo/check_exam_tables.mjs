import { pool } from '../config/database.js';

const names = await pool.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'exam%'"
);
console.log('tables:', names.rows.map((r) => r.table_name).join(' '));

const counts = await pool.query('SELECT count(*)::int c FROM exam_cell_exclusions').catch((e) => ({ rows: [{ c: 'ERR ' + e.message }] }));
console.log('exam_cell_exclusions rows:', counts.rows[0].c);
await pool.end();