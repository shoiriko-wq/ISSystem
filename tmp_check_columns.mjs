import { query, closeDatabase } from './config/database.js';

const res = await query(
  `SELECT table_name, column_name, data_type, column_default
   FROM information_schema.columns
   WHERE table_name IN ('exam_masters','exam_slots')
     AND column_name IN ('schedule_cells','is_blocked','notes')
   ORDER BY table_name, column_name`
);
for (const r of res.rows) console.log(`${r.table_name}.${r.column_name} ${r.data_type} default=${r.column_default}`);
await closeDatabase();
