import { query, closeDatabase } from './config/database.js';

const cons = await query(
  `SELECT conname, contype, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid IN ('exam_slots'::regclass) ORDER BY conname`
);
for (const r of cons.rows) console.log(`CONSTRAINT ${r.conname} [${r.contype}] ${r.def}`);

const idx = await query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'exam_slots'`);
for (const r of idx.rows) console.log(`INDEX ${r.indexname} ${r.indexdef}`);
await closeDatabase();
