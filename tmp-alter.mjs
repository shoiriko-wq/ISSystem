import { Client } from 'pg';
import config from './config/default.js';
const c = new Client(config.db);
await c.connect();
try {
  await c.query('ALTER TABLE exam_proctor_assignments ADD COLUMN patrol_teacher_id BIGINT');
  console.log('ADDED patrol_teacher_id');
} catch (e) { console.log('ERR:', e.message); }
await c.query('CREATE INDEX IF NOT EXISTS idx_proctor_patrol ON exam_proctor_assignments (exam_master_id, patrol_teacher_id)');
console.log('INDEX OK');
await c.end();
