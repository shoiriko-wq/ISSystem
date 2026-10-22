/**
 * ISSystem Bulletin & Circular Controller
 * 掲示板・要承認回覧板・ワンクリックデジタル承認・未確認者督促API (SQLite・フロントエンド構造完全互換版)
 */

import bulletinService from '../services/bulletin.service.js';

export const bulletinController = {
  /**
   * 掲示・回覧板一覧の取得
   * GET /api/bulletins
   */
  async getBulletins(req, res, next) {
    try {
      const { type, category, targetGrade, targetDepartment, searchKey, isUrgent, limit, pinned, post_type } = req.query;
      const userId = req.user ? req.user.id : 'kyomu01';

      const filterParams = {
        type: type || post_type,
        category,
        targetGrade,
        targetDepartment,
        searchKey: searchKey || req.query.search || req.query.q,
        isUrgent: isUrgent === 'true' || pinned === 'true',
        limit: limit ? parseInt(limit, 10) : null,
        pinned: pinned === 'true'
      };

      let bulletins = [];
      try {
        bulletins = await bulletinService.getBulletins(filterParams, userId);
      } catch (serviceErr) {
        console.warn('[BulletinController] Service call warning, fallback to empty array:', serviceErr.message);
        bulletins = [];
      }

      const resultList = Array.isArray(bulletins) ? bulletins : [];

      // フロントエンドの互換性を考慮し、`data` と `bulletins` の両プロパティで返却
      return res.status(200).json({
        success: true,
        count: resultList.length,
        data: resultList,
        bulletins: resultList
      });
    } catch (error) {
      console.error('[BulletinController Fatal Error]', error.message);
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
        bulletins: []
      });
    }
  },

  /**
   * 掲示・回覧詳細の取得 (承認者一覧・未確認教員リスト・コメント含む)
   * GET /api/bulletins/:id
   */
  async getBulletinDetail(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user ? req.user.id : 'kyomu01';

      const detail = await bulletinService.getBulletinDetail(id, userId);

      return res.status(200).json({
        success: true,
        data: detail,
        bulletin: detail,
      });
    } catch (error) {
      return res.status(404).json({
        success: false,
        message: '指定された掲示・回覧が見つかりません。'
      });
    }
  },

  /**
   * 新規掲示・回覧板の投稿作成
   * POST /api/bulletins
   */
  async createBulletin(req, res, next) {
    try {
      const postData = req.body;
      const authorUser = req.user || { id: 'kyomu01', name: '教務 主任' };

      const created = await bulletinService.createBulletin(postData, authorUser);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('bulletin:posted', {
          bulletin: created,
          userId: authorUser.id || authorUser._id,
          userName: authorUser.name || '教員'
        });
      }

      return res.status(201).json({
        success: true,
        message: '掲示・回覧を新規投稿しました。',
        data: created,
        bulletin: created,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || '投稿の作成に失敗しました。'
      });
    }
  },

  /**
   * 要承認回覧板のワンクリックデジタル承認（既読確認）
   * POST /api/bulletins/:id/acknowledge / PUT /api/bulletins/:id/approve
   */
  async acknowledgeBulletin(req, res, next) {
    try {
      const { id } = req.params;
      const userId = req.user ? req.user.id : 'kyomu01';

      const result = await bulletinService.acknowledgeBulletin(id, userId);

      return res.status(200).json({
        success: true,
        message: '回覧内容を確認・承認しました。',
        acknowledgedAt: result ? result.acknowledgedAt : new Date().toISOString(),
        ackCount: result ? result.ackCount : 1,
        ackPercentage: result ? result.ackPercentage : 100,
        data: result
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || '承認処理に失敗しました。'
      });
    }
  },

  /**
   * 未確認教員への一括督促リマインド通知送信
   * POST /api/bulletins/:id/remind
   */
  async remindUnacknowledgedUsers(req, res, next) {
    try {
      const { id } = req.params;
      const currentUser = req.user || { id: 'kyomu01', name: '教務 主任' };

      const result = await bulletinService.remindUnacknowledgedUsers(id, currentUser);

      return res.status(200).json({
        success: true,
        message: result ? result.message : 'リマインド通知を送信しました。',
        remindedCount: result ? result.remindedCount : 0,
        unacknowledgedUsers: result ? result.unacknowledgedUsers : [],
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || '督促通知の送信に失敗しました。'
      });
    }
  },

  /**
   * 回覧板スレッドへのコメント追加
   * POST /api/bulletins/:id/comments
   */
  async addComment(req, res, next) {
    try {
      const { id } = req.params;
      const { commentText, comment } = req.body;
      const user = req.user || { id: 'kyomu01', name: '教務 主任' };

      const saved = await bulletinService.addComment(id, commentText || comment, user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('bulletin:commented', {
          comment: saved,
          bulletinId: id,
          userId: user.id || user._id,
          userName: user.name || '教員'
        });
      }

      return res.status(201).json({
        success: true,
        message: 'コメントを投稿しました。',
        data: saved,
        comment: saved,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || 'コメントの追加に失敗しました。'
      });
    }
  },

  /**
   * 掲示・回覧投稿の削除
   * DELETE /api/bulletins/:id
   */
  async deleteBulletin(req, res, next) {
    try {
      const { id } = req.params;
      const user = req.user || { id: 'kyomu01', name: '教務 主任' };

      const result = await bulletinService.deleteBulletin(id, user);

      return res.status(200).json({
        success: true,
        message: result ? result.message : '削除しました。',
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || '削除に失敗しました。'
      });
    }
  },
};

// --- ルーティング側 (src/routes/index.js) との別名エイリアス定義 ---
bulletinController.digitallyApprove = bulletinController.acknowledgeBulletin;
bulletinController.markAsRead = bulletinController.acknowledgeBulletin;
bulletinController.remindUnapprovedMembers = bulletinController.remindUnacknowledgedUsers;

// 個別インポート (named import) 用の展開エクスポート
export const {
  getBulletins,
  getBulletinDetail,
  createBulletin,
  acknowledgeBulletin,
  remindUnacknowledgedUsers,
  addComment,
  deleteBulletin,
  digitallyApprove,
  markAsRead,
  remindUnapprovedMembers,
} = bulletinController;

export default bulletinController;