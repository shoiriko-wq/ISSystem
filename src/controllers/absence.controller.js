/**
 * ISSystem 年休等・出張 欠席登録コントローラー
 * GET /api/absences, POST /api/absences, DELETE /api/absences/:id
 * 操作後は Socket.io で 'absence:updated' をブロードキャストし全ダッシュボードを即時更新
 */

import { absenceService, ABSENCE_TYPE_LABELS } from '../services/absence.service.js';

/**
 * 全クライアントへ登録変更を通知 (Socket.io 未起動時はスキップ)
 */
function broadcastAbsence(req, payload) {
  const io = req.app ? req.app.get('io') : null;
  if (!io) return;
  io.emit('absence:updated', payload);
}

/**
 * バリデーション・権限エラー (4xx) をフロントエンドのトーストへ届く形 (messageフィールド) で返す
 * ※ 401/403 は APIクライアントがセッション切れとみなすため、権限拒否は 422 を使用する
 * @returns {boolean} エラーを処理した場合は true
 */
function handleAbsenceError(res, error, fallbackMessage) {
  const statusCode = error.statusCode || 500;
  if (statusCode >= 400 && statusCode < 500) {
    res.status(statusCode).json({
      success: false,
      message: error.message || fallbackMessage,
    });
    return true;
  }
  return false;
}

export const absenceController = {
  /**
   * ダッシュボード用サマリー取得
   * GET /api/absences?date=YYYY-MM-DD
   */
  async getSummary(req, res, next) {
    try {
      const user = req.user;
      const summary = await absenceService.getSummary(req.query.date, user);

      return res.status(200).json({
        success: true,
        counts: summary.counts,
        labels: summary.labels,
        records: summary.records,
        can_record: summary.can_record,
        date: summary.date,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 登録フォーム用の教員一覧 (選択可否フラグ付き)
   * GET /api/absences/teachers
   */
  async getTeachers(req, res, next) {
    try {
      const teachers = await absenceService.getSelectableTeachers(req.user);
      return res.status(200).json({ success: true, teachers });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 年休等・出張 の手動登録
   * POST /api/absences
   * Body: { user_id, record_type: 'LEAVE'|'TRIP', record_date, reason }
   */
  async recordAbsence(req, res, next) {
    try {
      const user = req.user;
      const saved = await absenceService.recordAbsence(req.body, user);

      broadcastAbsence(req, {
        action: saved ? 'record' : 'update',
        date: saved.record_date,
        record_type: saved.record_type,
        record_type_label: ABSENCE_TYPE_LABELS[saved.record_type],
        user_id: saved.user_id,
        userName: saved.user_name,
        operatorId: user.id || user._id,
        operatorName: user.name,
      });

      return res.status(201).json({
        success: true,
        message: `「${ABSENCE_TYPE_LABELS[saved.record_type]}」${saved.user_name} 教員を登録しました。`,
        record: saved,
      });
    } catch (error) {
      if (!handleAbsenceError(res, error, '年休等・出張の登録に失敗しました。')) {
        next(error);
      }
    }
  },

  /**
   * 登録の取消 (削除)
   * DELETE /api/absences/:id
   */
  async deleteAbsence(req, res, next) {
    try {
      const user = req.user;
      const deleted = await absenceService.removeAbsence(req.params.id, user);

      broadcastAbsence(req, {
        action: 'remove',
        date: deleted.record_date,
        record_type: deleted.record_type,
        record_type_label: ABSENCE_TYPE_LABELS[deleted.record_type],
        user_id: deleted.user_id,
        userName: deleted.user_name,
        operatorId: user.id || user._id,
        operatorName: user.name,
      });

      return res.status(200).json({
        success: true,
        message: `${deleted.user_name} 教員の「${ABSENCE_TYPE_LABELS[deleted.record_type]}」登録を取消しました。`,
        record: deleted,
      });
    } catch (error) {
      if (!handleAbsenceError(res, error, '年休等・出張登録の取消に失敗しました。')) {
        next(error);
      }
    }
  },
};

export default absenceController;
