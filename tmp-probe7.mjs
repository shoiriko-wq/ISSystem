import { examService } from './src/services/exam.service.js';
import { solveProctor } from './src/utils/exam-proctor-solver.js';
import { pool } from './config/database.js';
const KYOMU = { id: 'et-kyomu', role: 'KYOMU' };
const built = await examService.buildProctorInput('e2e-exam', KYOMU);
const res = solveProctor(built.input);
const pg = {}; for (const r of res.plan) pg[r.grade] = (pg[r.grade]||0)+1;
const ug = {}; for (const c of res.unassigned) { const k = c.grade; ug[k]=(ug[k]||0)+1; }
console.log('PLAN', res.plan.length, JSON.stringify(pg));
console.log('UNASSIGNED', res.unassigned.length, JSON.stringify(ug));
console.log(JSON.stringify(res.unassigned.slice(0,5)));
console.log(JSON.stringify(res.diagnostics.filter(d=>d.level==='HARD').slice(0,3)));
await pool.end();
