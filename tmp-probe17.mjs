import { examModel } from './src/models/exam.model.js';
import { pool } from './config/database.js';
const dec = await examModel.listSubjectDecisions('e2e-exam');
console.log('DEC', dec.length, JSON.stringify(dec.slice(0,3).map(d=>[d.grade,d.subject_name,d.setter_teacher_id,d.patrol_teacher_id,d.source_plan_id])));
await pool.end();
