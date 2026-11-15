import { examModel } from './src/models/exam.model.js';
import { pool } from './config/database.js';
const rows = await examModel.listProctorAssignments('e2e-exam');
const room2 = { 1: '技術家庭理論', 2: '技術家庭理論', 3: '科学' };
console.log(JSON.stringify(rows.filter(r=>r.subject_name===room2[r.grade]).map(r=>[r.grade,r.day_number,r.slot_number,r.subject_name,r.room_name,r.room_type])));
await pool.end();
