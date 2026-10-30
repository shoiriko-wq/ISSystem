/**
 * ISSystem Periodic Exam Controller
 * 定期考査（実施科目調査・時間割・教室・出張・試験監督）API
 */

import examService from '../services/exam.service.js';

const ok = (res, data, message = null) =>
  res.status(200).json({ success: true, message, data });

const wrap = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (error) {
    next(error);
  }
};

export const examController = {
  // ===== マスタ =====
  listMasters: wrap(async (req, res) => {
    ok(res, await examService.listMasters(req.user));
  }),

  createMaster: wrap(async (req, res) => {
    ok(res, await examService.createMaster(req.body, req.user), '考査を登録しました。');
  }),

  updateMaster: wrap(async (req, res) => {
    ok(res, await examService.updateMaster(req.params.id, req.body, req.user), '考査情報を更新しました。');
  }),

  deactivateMaster: wrap(async (req, res) => {
    ok(res, await examService.deactivateMaster(req.params.id, req.user), '考査手続を終了しました。');
  }),

  getBoard: wrap(async (req, res) => {
    ok(res, await examService.getBoard(req.params.id, req.user));
  }),

  getActiveExam: wrap(async (req, res) => {
    const master = await examService.findActiveMaster();
    if (!master) return res.status(404).json({ success: false, message: '進行中の考査がありません。' });
    ok(res, await examService.getBoard(master.id, req.user));
  }),

  setPhase: wrap(async (req, res) => {
    const { phase_key, phase_value } = req.body;
    ok(res, await examService.setPhase(req.params.id, phase_key, phase_value, req.user), 'フェーズを更新しました。');
  }),

  // ===== 実施科目・出題者 =====
  startSubjectSurvey: wrap(async (req, res) => {
    ok(res, await examService.startSubjectSurvey(req.params.id, req.user), '実施科目調査を開始しました。');
  }),

  saveSubjectRow: wrap(async (req, res) => {
    ok(res, await examService.saveSubjectRow(req.params.id, req.body, req.user), '実施科目を登録しました。');
  }),

  submitSubjectRow: wrap(async (req, res) => {
    ok(res, await examService.submitSubjectRow(req.params.id, req.params.rowId, req.user), '提出を完了しました。');
  }),

  deleteSubjectRow: wrap(async (req, res) => {
    ok(res, await examService.deleteSubjectRow(req.params.id, req.params.rowId, req.user), '実施科目を削除しました。');
  }),

  endSubjectSurvey: wrap(async (req, res) => {
    ok(res, await examService.endSubjectSurvey(req.params.id, req.user), '実施科目調査を終了しました。');
  }),

  getSubjects: wrap(async (req, res) => {
    ok(res, await examService.getSubjects(req.params.id, req.user));
  }),

  // ===== 試験時間割 =====
  saveTimetableRules: wrap(async (req, res) => {
    ok(res, await examService.saveTimetableRules(req.params.id, req.body, req.user), '時間割ルールを保存しました。');
  }),

  solveTimetable: wrap(async (req, res) => {
    ok(res, await examService.solveTimetable(req.params.id, req.user), '試験時間割を作成しました。');
  }),

  saveTimetableSlots: wrap(async (req, res) => {
    ok(res, await examService.saveTimetableSlots(req.params.id, req.body, req.user), '時間割コマを保存しました。');
  }),

  publishTimetable: wrap(async (req, res) => {
    ok(res, await examService.publishTimetable(req.params.id, req.user), '試験時間割を公表しました。');
  }),

  getSlots: wrap(async (req, res) => {
    ok(res, await examService.getSlots(req.params.id, req.user));
  }),

  // ===== ×（使用不能コマ） =====

  getScheduleCells: wrap(async (req, res) => {
    ok(res, await examService.getScheduleCells(req.params.id, req.user));
  }),

  saveScheduleCells: wrap(async (req, res) => {
    ok(res, await examService.saveScheduleCells(req.params.id, req.body, req.user), '全学年共通 × を保存しました。');
  }),

  saveGradeBlocked: wrap(async (req, res) => {
    ok(res, await examService.saveGradeBlocked(req.params.id, req.body, req.user), '学年固有 × を保存しました。');
  }),

  validateTimetableRows: wrap(async (req, res) => {
    ok(res, await examService.validateTimetableRows(req.params.id, req.body, req.user));
  }),

  // ===== 試験教室 =====
  getRooms: wrap(async (req, res) => {
    ok(res, await examService.getRooms(req.params.id, req.user));
  }),

  getRoomRules: wrap(async (req, res) => {
    ok(res, await examService.getRoomRules(req.params.id, req.user));
  }),

  saveRoomRules: wrap(async (req, res) => {
    ok(res, await examService.saveRoomRules(req.params.id, req.body, req.user), '学年別特別教室ルールを保存しました。');
  }),

  getRoomConfig: wrap(async (req, res) => {
    ok(res, await examService.getRoomConfig(req.params.id, req.user));
  }),

  saveRooms: wrap(async (req, res) => {
    ok(res, await examService.saveRooms(req.params.id, req.body, req.user), '試験教室マスターを保存しました。');
  }),

  saveRoomConfig: wrap(async (req, res) => {
    ok(res, await examService.saveRoomConfig(req.params.id, req.body, req.user), '教室構成ルールを保存しました。');
  }),

  solveRoomAssignments: wrap(async (req, res) => {
    ok(res, await examService.solveRoomAssignments(req.params.id, req.user), '試験教室割当を作成しました。');
  }),

  saveRoomAssignments: wrap(async (req, res) => {
    ok(res, await examService.saveRoomAssignments(req.params.id, req.body, req.user), '教室割当を保存しました。');
  }),

  publishRoomAssignments: wrap(async (req, res) => {
    ok(res, await examService.publishRoomAssignments(req.params.id, req.user), '試験教室割当を公表しました。');
  }),

  endRoomPhase: wrap(async (req, res) => {
    ok(res, await examService.endRoomPhase(req.params.id, req.user), '教室割当フェーズを終了しました。');
  }),

  // ===== 出張等 =====

  startTripSurvey: wrap(async (req, res) => {
    ok(res, await examService.startTripSurvey(req.params.id, req.user), '出張等の登録を開始しました。');
  }),

  publishTrips: wrap(async (req, res) => {
    ok(res, await examService.publishTrips(req.params.id, req.user), '出張等を公表しました。');
  }),

  previewTrips: wrap(async (req, res) => {
    ok(res, await examService.previewTrips(req.params.id, req.user));
  }),

  getTrips: wrap(async (req, res) => {
    ok(res, await examService.getTrips(req.params.id, req.user));
  }),

  saveTrips: wrap(async (req, res) => {
    ok(res, await examService.saveTrips(req.params.id, req.body, req.user), '出張等を登録しました。');
  }),

  deleteTrip: wrap(async (req, res) => {
    ok(res, await examService.deleteTrip(req.params.id, req.params.tripId, req.user), '出張等を削除しました。');
  }),

  endTripPhase: wrap(async (req, res) => {
    ok(res, await examService.endTripPhase(req.params.id, req.user), '出張等登録フェーズを終了しました。');
  }),

  // ===== 公表ビュー =====

  // ===== 試験監督 =====
  getStaffPool: wrap(async (req, res) => {
    ok(res, await examService.getStaffPool(req.user));
  }),

  getProctorBoard: wrap(async (req, res) => {
    ok(res, await examService.getProctorBoard(req.params.id, req.user));
  }),

  validateProctorRows: wrap(async (req, res) => {
    ok(res, await examService.validateProctorRows(req.params.id, req.body.rows || req.body, req.user));
  }),

  saveProctorRules: wrap(async (req, res) => {
    ok(res, await examService.saveProctorRules(req.params.id, req.body, req.user), '監督ルールを保存しました。');
  }),

  saveParttimeStaff: wrap(async (req, res) => {
    ok(res, await examService.saveParttimeStaff(req.params.id, req.body, req.user), '非常勤教員条件を保存しました。');
  }),

  deleteParttimeStaff: wrap(async (req, res) => {
    ok(res, await examService.deleteParttimeStaff(req.params.id, req.params.staffRowId, req.user), '非常勤教員条件を削除しました。');
  }),

  setParttimeAvailability: wrap(async (req, res) => {
    ok(res, await examService.setParttimeAvailability(req.params.id, req.body, req.user), '非常勤出勤可能コマを保存しました。');
  }),

  saveTeacherConstraint: wrap(async (req, res) => {
    ok(res, await examService.saveTeacherConstraint(req.params.id, req.body, req.user), '教員個別条件を保存しました。');
  }),

  addExemption: wrap(async (req, res) => {
    ok(res, await examService.addExemption(req.params.id, req.body, req.user), '監督免除教員を登録しました。');
  }),

  removeExemption: wrap(async (req, res) => {
    ok(res, await examService.removeExemption(req.params.id, req.params.teacherId, req.user), '監督免除を解除しました。');
  }),

  solveProctors: wrap(async (req, res) => {
    const result = await examService.solveProctorBoard(req.params.id, req.user);
    ok(res, result, `試験監督割当を作成しました（割当 ${result.stats.assigned} / ${result.stats.cells}）。`);
  }),

  saveProctors: wrap(async (req, res) => {
    ok(res, await examService.saveProctorAssignments(req.params.id, req.body, req.user), '監督割当を保存しました。');
  }),

  publishProctors: wrap(async (req, res) => {
    ok(res, await examService.publishProctor(req.params.id, req.user), '試験監督割当を公表しました。');
  }),

  endProctorPhase: wrap(async (req, res) => {
    ok(res, await examService.endProctor(req.params.id, req.user), '監督割当フェーズを終了しました。');
  }),

  // ===== 公表ビュー =====
  getPublishedView: wrap(async (req, res) => {
    ok(res, await examService.getPublishedView(req.params.id, req.user));
  }),

  getPublishedTimetable: wrap(async (req, res) => {
    ok(res, await examService.getPublishedTimetable(req.params.id, req.user));
  }),

  getPublishedRooms: wrap(async (req, res) => {
    ok(res, await examService.getPublishedRooms(req.params.id, req.user));
  }),

  getPublishedProctors: wrap(async (req, res) => {
    ok(res, await examService.getPublishedProctors(req.params.id, req.user));
  }),

  getPublishedTrips: wrap(async (req, res) => {
    ok(res, await examService.getPublishedTrips(req.params.id, req.user));
  }),
};

export default examController;