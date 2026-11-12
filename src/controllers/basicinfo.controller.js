/**
 * ISSystem 定期考査 基本情報マスタ Controller
 * 一覧は全教職員、登録・改名・削除は教務部 (KYOMU) のみ。
 * 変更時は socket で basicinfo:changed を通知し、考査計画画面へ反映する。
 */

import basicinfoService from '../services/basicinfo.service.js';
import { ApiError } from '../middlewares/error.middleware.js';

const KINDS = ['class', 'subject', 'room'];

const SECTION_LABELS = { class: 'クラス・コース', group: '教科', subject: '科目', room: '教室' };

/** /api/exam/basic-lock/:kind の kind を検証（4セクションのみ） */
function resolveSectionKind(req) {
  const kind = String(req.params?.kind || '').trim();
  if (!SECTION_LABELS[kind]) {
    throw new ApiError(400, '不明なセクション種別です（class / group / subject / room のいずれか）。');
  }
  return kind;
}

/** ロック状態変化を socket で通知（座席表の lock:status_changed と同一イベント） */
function emitSectionLock(req, payload) {
  const io = req.app ? req.app.get('io') : null;
  if (!io) return;
  io.emit('lock:status_changed', {
    resourceType: 'exam_basic',
    resourceId: `exam_basic_${payload.kind}`,
    kind: payload.kind,
    isLocked: payload.isLocked,
    user_id: payload.user_id,
    user_name: payload.user_name,
  });
}

function emitChange(req, payload) {
  const io = req.app ? req.app.get('io') : null;
  if (io) {
    io.emit('basicinfo:changed', { ...payload, userId: req.user?.id, userName: req.user?.name });
  }
}

function resolveKind(req) {
  const kind = String(req.params.kind || '').toLowerCase();
  if (!KINDS.includes(kind)) {
    const err = new Error('マスタ種別が不正です。');
    err.statusCode = 400;
    throw err;
  }
  return kind;
}

export const basicinfoController = {
  /**
   * 基本情報マスタ一覧 (クラス・コース・教科・科目・教室)
   * GET /api/basic-info?grade=1
   */
  async listBasicInfo(req, res, next) {
    try {
      const grade = req.query.grade ? Number(req.query.grade) : null;
      const data = await basicinfoService.getBasicInfo(grade, req.user);
      return res.status(200).json({ success: true, data });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || '基本情報の取得に失敗しました。',
      });
    }
  },

  /**
   * マスタの使用中件数 (削除可否表示用)
   * GET /api/basic-info/usage/:kind/:id
   */
  async getUsage(req, res, next) {
    try {
      const kind = resolveKind(req);
      const usage = await basicinfoService.getUsage(kind, req.params.id, req.user);
      return res.status(200).json({ success: true, data: { kind, id: req.params.id, usage } });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || '使用件数の取得に失敗しました。',
      });
    }
  },

  /**
   * マスタの登録 (教務部 KYOMU のみ)
   * POST /api/basic-info/:kind
   */
  async createItem(req, res, next) {
    try {
      const kind = resolveKind(req);
      const created = await basicinfoService.createItem(kind, req.body || {}, req.user);
      emitChange(req, { action: 'create', kind, item: created });
      return res.status(201).json({ success: true, message: `${kind} を登録しました。`, data: created });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || '登録に失敗しました。',
      });
    }
  },

  /**
   * マスタの改名・更新 (教務部 KYOMU のみ、考査計画へ CASCADE)
   * PUT /api/basic-info/:kind/:id
   */
  async updateItem(req, res, next) {
    try {
      const kind = resolveKind(req);
      const updated = await basicinfoService.updateItem(kind, req.params.id, req.body || {}, req.user);
      emitChange(req, { action: 'update', kind, item: updated });
      return res.status(200).json({
        success: true,
        message: `変更を反映しました${updated?.cascaded ? '（考査計画・時間割・教室割・監督割へ cascade）' : ''}`,
        data: updated,
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || '更新に失敗しました。',
      });
    }
  },

  /**
   * マスタの削除 (教務部 KYOMU のみ、使用中は 409)
   * DELETE /api/basic-info/:kind/:id
   */
  async deleteItem(req, res, next) {
    try {
      const kind = resolveKind(req);
      const removed = await basicinfoService.deleteItem(kind, req.params.id, req.user);
      emitChange(req, { action: 'delete', kind, id: removed.id });
      return res.status(200).json({ success: true, message: '削除しました。', data: removed });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || '削除に失敗しました。',
      });
    }
  },
  // ===== セクション編集ロック（座席表の編集排他ロックと同一の editing_locks） =====
  /** POST /api/exam/basic-lock/:kind — セクションの編集を開始（ロック取得＝編集可能モード） */
  async acquireSectionLock(req, res, next) {
    try {
      const kind = resolveSectionKind(req);
      const lock = await basicinfoService.lockSection(kind, req.user);
      emitSectionLock(req, { kind, isLocked: true, user_id: req.user.id, user_name: req.user.name });
      return res.status(200).json({
        success: true,
        message: `${SECTION_LABELS[kind]}を編集可能モードにしました。`,
        data: lock,
      });
    } catch (error) {
      next(error);
    }
  },

  /** DELETE /api/exam/basic-lock/:kind — セクションの編集を終了（ロック解除＝読み取り専用モード） */
  async releaseSectionLock(req, res, next) {
    try {
      const kind = resolveSectionKind(req);
      const data = await basicinfoService.unlockSection(kind, req.user);
      emitSectionLock(req, { kind, isLocked: false, user_id: req.user.id, user_name: req.user.name });
      return res.status(200).json({
        success: true,
        message: `${SECTION_LABELS[kind]}を編集ロック（読み取り専用）へ戻しました。`,
        data,
      });
    } catch (error) {
      next(error);
    }
  },
};

export default basicinfoController;
