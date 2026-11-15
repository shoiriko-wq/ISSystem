import { Client } from 'pg';
import config from './config/default.js';
const c = new Client(config.db);
await c.connect();
const t = await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE 'exam%' ORDER BY table_name");
console.log(t.rows.map(r=>r.table_name).join(' '));
for (const name of t.rows.map(r=>r.table_name)) {
  const cols = await c.query(`SELECT column_name FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [name]);
  console.log(name+': '+cols.rows.map(r=>r.column_name).join(','));
}
const cnt = await c.query("SELECT exam_master_id, COUNT(*)::int AS n FROM exam_slots GROUP BY exam_master_id");
console.log('SLOTS:', JSON.stringify(cnt.rows));
await c.end();
