import { examModel } from './src/models/exam.model.js';
import { pool } from './config/database.js';
const plan = await examModel.listSubjectPlan('e2e-exam');
const slots = await examModel.listSlots('e2e-exam');
console.log('PLAN_IDS', JSON.stringify(plan.map(p=>[p.id,p.grade,p.subject_name])));
console.log('SLOT_IDS', JSON.stringify(slots.map(s=>[s.unit_id,s.grade,s.subject_name,s.day_number,s.slot_number])));
await pool.end();
