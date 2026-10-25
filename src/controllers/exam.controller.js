/**
 * ISSystem Periodic Exam & Proctor Auto-Optimization Controller
 * 定期考査時間割・自教科監督回避・矛盾診断エンジン・監督自動最適化ソルバー連携API
 */

import examService from '../services/exam.service.js';

export const examController = {
  /**
   * 全考査マスター一覧の取得
   * GET /api/exams
   */
  async getExamMasters(req, res, next) {
    try {
      const masters = await examService.getExamMasters();

      return res.status(200).json({
        success: true,
        count: masters.length,
        masters,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 考査マトリクス統合データ（時間割 + 監督割当 + 矛盾診断ステータス）の取得
   * GET /api/exams/:id/matrix
   */
  async getExamMatrixWithValidation(req, res, next) {
    try {
      const { id } = req.params;

      const result = await examService.getExamMatrixWithValidation(id);

      return res.status(200).json({
        success: true,
        master: result.master,
        matrix: result.matrix,
        hasConflicts: result.hasConflicts,
        hasWarnings: result.hasWarnings,
        conflicts: result.conflicts,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 考査時間割および監督割り当ての矛盾診断のみを実行
   * GET /api/exams/:id/diagnose
   */
  async diagnoseConflicts(req, res, next) {
    try {
      const { id } = req.params;

      const conflicts = await examService.diagnoseConflicts(id);

      return res.status(200).json({
        success: true,
        hasConflicts: conflicts.errors.length > 0,
        hasWarnings: conflicts.warnings.length > 0,
        conflicts,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 制約解決・監督自動最適化ソルバーの実行
   * POST /api/exams/:id/auto-assign
   */
  async autoAssignProctors(req, res, next) {
    try {
      const { id } = req.params;
      const operatorUser = req.user;

      const result = await examService.autoAssignProctors(id, operatorUser);

      return res.status(200).json({
        success: true,
        message: result.message,
        assignedSlotsCount: result.assignedSlotsCount,
        conflicts: result.conflicts,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 単一コマの監督手動変更（即時矛盾再診断結果を返却）
   * PUT /api/exams/:id/proctor
   */
  async updateProctorAssignment(req, res, next) {
    try {
      const { id } = req.params;
      const { dayNumber, slotNumber, classId, teacherId } = req.body;
      const user = req.user;

      const result = await examService.updateProctorAssignment(
        id,
        { dayNumber, slotNumber, classId, teacherId },
        user
      );

      return res.status(200).json({
        success: true,
        message: result.message,
        conflicts: result.conflicts,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 考査コマ・科目時間割スロットの一括保存
   * PUT /api/exams/:id/slots
   */
  async saveExamSlots(req, res, next) {
    try {
      const { id } = req.params;
      const { slots } = req.body;
      const user = req.user;

      const savedSlots = await examService.saveExamSlots(id, slots, user);

      return res.status(200).json({
        success: true,
        message: '考査時間割スロットを保存しました。',
        slotsCount: savedSlots.length,
        slots: savedSlots,
      });
    } catch (error) {
      next(error);
    }
  },
};

export default examController;