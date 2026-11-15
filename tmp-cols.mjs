import { Client } from 'pg';
import config from './config/default.js';
const c = new Client(config.db);
await c.connect();
for (const t of ['exam_masters','exam_slots','exam_subject_plan','exam_proctor_assignments','exam_rules','exam_rooms','users']) {
  const cols = await c.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_name=$1 ORDER BY ordinal_position`, [t]);
  console.log(t, ':', cols.rows.map(r=>r.column_name).join(','));
}
await c.end();
