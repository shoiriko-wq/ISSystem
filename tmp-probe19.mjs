import { examModel } from './src/models/exam.model.js';
import { examService } from './src/services/exam.service.js';
import { pool } from './config/database.js';
const KYOMU = { id: 'et-kyomu', role: 'KYOMU' };
const plan = await examModel.listSubjectPlan('e2e-exam');
const planByKey = new Map(plan.map(p => [`${p.grade}|${p.subject_name}`, p]));
const slots = await examModel.listSlots('e2e-exam');
const busy = new Map();
for (const s of slots) {
  const pp = planByKey.get(`${s.grade}|${s.subject_name}`);
  if (!pp) continue;
  const span = Number(s.duration_slots || 1);
  for (let k = 0; k < span; k++) {
    const slot = Number(s.slot_number) + k;
    busy.set(`${pp.setter_teacher_id}|${s.day_number}|${slot}`, 'creator');
    busy.set(`${pp.patrol_teacher_id}|${s.day_number}|${slot}`, 'patrol');
  }
}
const rows = await examModel.listProctorAssignments('e2e-exam');
const clash = rows.filter((x) => busy.has(`${x.proctor_teacher_id}|${x.day_number}|${x.slot_number}`));
console.log('BUSYCLASH', JSON.stringify(clash.map((x) => [x.grade, x.class_id, x.day_number, x.slot_number, x.subject_name, x.proctor_teacher_id, x.setter_teacher_id, x.patrol_teacher_id])));
const setterClash = rows.filter((x) => x.proctor_teacher_id === x.setter_teacher_id);
console.log('SETTER', JSON.stringify(setterClash.map((x) => [x.grade, x.class_id, x.day_number, x.slot_number, x.subject_name, x.proctor_teacher_id])));
const built = await examService.buildProctorInput('e2e-exam', KYOMU);
console.log('SPECIAL', JSON.stringify(built.input.room_cells.map((c) => [c.unit_id, c.room_type, c.day, c.slot])));
await pool.end();
