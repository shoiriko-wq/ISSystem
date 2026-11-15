import { examModel } from './src/models/exam.model.js';
import { pool } from './config/database.js';
const rows = await examModel.listProctorAssignments('e2e-exam');
console.log('TOTAL', rows.length, 'noPatrol', rows.filter(r=>!r.patrol_teacher_id).length);
console.log(JSON.stringify(rows.slice(0,3).map(r=>[r.grade,r.class_id,r.day_number,r.slot_number,r.subject_name,r.proctor_teacher_id,r.patrol_teacher_id,r.room_name,r.room_type])));
const slots = await examModel.listSlots('e2e-exam');
console.log('SCI', JSON.stringify(slots.filter(s=>s.subject_name==='科学').map(s=>[s.grade,s.day_number,s.slot_number,s.duration_slots])));
await pool.end();
