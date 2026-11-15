import { examModel } from './src/models/exam.model.js';
import { pool } from './config/database.js';
const plan = await examModel.listSubjectPlan('e2e-exam');
console.log('PLAN', JSON.stringify(plan.map(p=>[p.grade,p.subject_name,p.patrol_teacher_id,p.patrol_teacher_name])));
await pool.end();
