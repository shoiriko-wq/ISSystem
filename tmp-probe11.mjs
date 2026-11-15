import { examModel } from './src/models/exam.model.js';
import { pool } from './config/database.js';
const rows = await examModel.listProctorAssignments('e2e-exam');
console.log('TOTAL', rows.length);
console.log(JSON.stringify(rows.map(r=>[r.grade,r.class_id,r.day_number,r.slot_number,r.subject_name,r.room_name,r.proctor_teacher_id,r.patrol_teacher_id])));
await pool.end();
