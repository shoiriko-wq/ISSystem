/**
 * ISSystem Subject Catalog Controller (教科マスタAPI)
 * 一覧は全教職員、追加・改名・削除は教務部 (KYOMU) のみ (ルーティングで requireKyomuOnlyRole)
 * 教員の担当教科設定: 自分自身は全教職員、他教員は教務部のみ
 */

import subjectService from '../services/subject.service.js';

export const subjectController = {
  /**
   * 教科マスタ一覧 (担当教科選択UI・使用件数付き)
   * GET /api/subjects
   */
  async listSubjects(req, res, next) {
    try {
      const { subjects } = await subjectService.listSubjects();
      return res.status(200).json({
        success: true,
        count: subjects.length,
        subjects,
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || '教科マスタの取得に失敗しました。',
      });
    }
  },

  /**
   * 教科の追加 (教務部 KYOMU のみ)
   * POST /api/subjects
   */
  async createSubject(req, res, next) {
    try {
      const { name, color_key, sort_order } = req.body;
      const subject = await subjectService.createSubject(name, req.user, { color_key, sort_order });

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('subjects:changed', { action: 'create', subject, userId: req.user?.id, userName: req.user?.name });
      }

      return res.status(201).json({
        success: true,
        message: `教科「${subject.name}」を追加しました。`,
        subject,
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || '教科の追加に失敗しました。',
      });
    }
  },

  /**
   * 教科の改名・色・表示順変更 (教務部 KYOMU のみ)
   * PUT /api/subjects/:id
   */
  async updateSubject(req, res, next) {
    try {
      const { id } = req.params;
      const updated = await subjectService.updateSubject(id, req.body, req.user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('subjects:changed', { action: 'update', subject: updated, userId: req.user?.id, userName: req.user?.name });
      }

      return res.status(200).json({
        success: true,
        message: `教科「${updated.name}」を更新しました。`,
        subject: updated,
        cascaded: updated.cascaded,
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || '教科の更新に失敗しました。',
      });
    }
  },

  /**
   * 教科の削除 (教務部 KYOMU のみ・考査計画で使用中は削除不可)
   * DELETE /api/subjects/:id
   */
  async deleteSubject(req, res, next) {
    try {
      const { id } = req.params;
      const removed = await subjectService.deleteSubject(id, req.user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('subjects:changed', { action: 'delete', id, userId: req.user?.id, userName: req.user?.name });
      }

      return res.status(200).json({
        success: true,
        message: `教科「${removed.name}」を削除しました。`,
        removed_from_users: removed.removed_from_users,
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || '教科の削除に失敗しました。',
      });
    }
  },

  /**
   * 教員の担当教科設定 (自分自身は全教職員、他教員は教務部のみ)
   * PUT /api/users/:id/subjects
   */
  async setUserSubjects(req, res, next) {
    try {
      const targetUserId = req.params.id;
      const subjects = req.body.subjects !== undefined ? req.body.subjects : req.body;
      const updated = await subjectService.setUserSubjects(req.user, targetUserId, subjects);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('subjects:user_changed', { user_id: targetUserId, subjects: updated.subjects, userId: req.user?.id });
      }

      return res.status(200).json({
        success: true,
        message: `担当教科を${String(targetUserId) === String(req.user.id) ? '自分' : '対象教員'}へ設定しました。`,
        user: { id: updated.id, name: updated.name, subjects: updated.subjects },
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || '担当教科の設定に失敗しました。',
      });
    }
  },
};

export default subjectController;
