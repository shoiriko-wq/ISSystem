import { examService } from './src/services/exam.service.js';
import { query, pool } from './config/database.js';
const KYOMU = { id: 'et-kyomu', role: 'KYOMU' };
const board = await examService.getProctorBoard('e2e-exam', KYOMU);
const byGrade = {};
for (const c of board.cells) { byGrade[c.grade] = (byGrade[c.grade]||0)+1; }
console.log('CELLS', board.cells.length, JSON.stringify(byGrade));
console.log('E2E CELLS', board.cells.filter(c=>String(c.class_id||'').startsWith('e2e-cls-')).length);
const p = await query(`SELECT grade, subject_name, class_ids, duration_slots FROM exam_subject_plan WHERE exam_master_id='e2e-exam' AND subject_name='国語'`, []);
console.log('PLAN class_ids', JSON.stringify(p.rows));
const cl = await query(`SELECT id, grade, name FROM classes WHERE grade IN (1,2,3) AND (id LIKE 'e2e-cls-%' OR id='cls201') ORDER BY id`, []);
console.log('CLASSES g2 sample', JSON.stringify(cl.rows));
await pool.end();
