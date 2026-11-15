import { examModel } from './src/models/exam.model.js';
import { pool } from './config/database.js';
const rows = await examModel.listProctorAssignments('e2e-exam');
console.log('TOTAL', rows.length);
const g = {}; for (const r of rows) g[r.grade] = (g[r.grade]||0)+1;
console.log('BY GRADE', JSON.stringify(g));
console.log('E2E', JSON.stringify(rows.filter(r=>String(r.class_id).startsWith('e2e-cls-')).map(r=>[r.grade,r.class_id,r.day_number,r.slot_number,r.proctor_teacher_id,r.patrol_teacher_id])));
await pool.end();
