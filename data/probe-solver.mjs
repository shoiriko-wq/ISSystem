// 一時計測スクリプト（削除予定）: ソルバの時間と入力量を測る
import { examService } from '../src/services/exam.service.js';

const kyomu = { id: 'kyomu01', role: 'KYOMU', grade: 0 };

const master = await examService.createMaster(
  { title: 'PROBE3 2099', start_date: '2099-11-01', end_date: '2099-11-03', days_count: 3, daily_slots: 8, grades: [1, 2, 3] },
  kyomu
);
const id = master.id;
await examService.startSubjectSurvey(id, kyomu);

const t0 = Date.now();
const ctx = await examService.buildBlockSolverInput(id);
console.log('input ms', Date.now() - t0, 'rows', ctx.rows.length, 'commands', ctx.commands.length, 'blocks', ctx.blocks.length, 'groups', ctx.groups.length, 'conditions', ctx.conditions.length, 'history', ctx.history.length, 'blocked', ctx.blockedRowCells ? ctx.blockedRowCells.size ?? ctx.blockedRowCells.length : 0);

const t1 = Date.now();
const result = await examService.solveTimetable(id, kyomu);
console.log('solve ms', Date.now() - t1, 'feasible', result.feasible, 'assignments', result.assignments ? result.assignments.length : -1, 'unassigned', result.unassigned ? result.unassigned.length : -1, 'saved', result.saved);

// クリーンアップ: この試験マスターを消す
const { query } = await import('../config/database.js');
await query('DELETE FROM exam_slots WHERE exam_master_id = ?', [id]);
await query('DELETE FROM exam_subject_plan WHERE exam_master_id = ?', [id]);
await query('DELETE FROM exam_masters WHERE id = ?', [id]);
console.log('cleaned', id);
process.exit(0);