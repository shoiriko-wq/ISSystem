/**
 * ISSystem Bulletin & Circular Controller
 * 掲示板・要承認回覧板・ワンクリックデジタル承認・未確認者督促API (SQLite・フロントエンド構造完全互換版)
 */

import bulletinService from '../services/bulletin.service.js';
import bulletinModel from '../models/bulletin.model.js';
import { parseMultipart, extractFormParts, saveFileEntries } from '../services/upload.service.js';

/**
 * 日ごと表示のキー ('today' / 'yesterday' / 'YYYY-MM-DD') を 'YYYY-MM-DD' (JST) に正規化する
 * @param {string} raw
 */
function normalizePostedDay(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const lower = str.toLowerCase();
  const JST = 'Asia/Tokyo';

  if (lower === 'today' || str === '本日' || str === '今日') {
    return new Date().toLocaleDateString('sv-SE', { timeZone: JST });
  }
  if (lower === 'yesterday' || str === '昨日') {
    const today = new Date(new Date().toLocaleDateString('sv-SE', { timeZone: JST }) + 'T12:00:00+09:00');
    today.setDate(today.getDate() - 1);
    return today.toLocaleDateString('sv-SE', { timeZone: JST });
  }

  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? str.substring(0, 10) : null;
}

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
        pinned: pinned === 'true',
        // 投稿日（日ごと表示切替）— 'today' などの別名は JST の日付キーへ変換
        postedDay: normalizePostedDay(req.query.postedDay || req.query.posted_date || req.query.day),
        // 期間絞り込み (WEEK 表示モードなど)
        startDate: req.query.startDate || req.query.start_date || req.query.start,
        endDate: req.query.endDate || req.query.end_date || req.query.end
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
   * ファイル添付付きの新規掲示投稿 (multipart/form-data)
   * POST /api/bulletins/upload
   */
  async createBulletinWithUpload(req, res, next) {
    try {
      const authorUser = req.user || { id: 'kyomu01', name: '教務 主任' };
      const created = await bulletinService.createBulletinWithUpload(req, authorUser);

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
        message: `掲示を投稿しました（添付 ${created.attachments.length} 件）`,
        data: created,
        bulletin: created,
      });
    } catch (error) {
      const status = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 400;
      console.warn('[BulletinController Upload Warning]', error.message);
      return res.status(status).json({
        success: false,
        message: error.message || '添付付きの投稿に失敗しました。'
      });
    }
  },

  /**
   * 既存掲示への添付ファイル追加 (multipart/form-data)
   * POST /api/bulletins/:id/attachments
   */
  async addAttachmentsToBulletin(req, res, next) {
    try {
      const { id } = req.params;
      const authorUser = req.user || { id: 'kyomu01', name: '教務 主任' };

      const post = await bulletinService.getBulletinDetail(id, authorUser.id || 'kyomu01');
      const role = String(authorUser.role || '').toUpperCase();
      const isPrivileged = role === 'KYOMU' || role === 'KYOUMU' || role === 'ADMIN';
      const isAuthor = String(post.authorId || post.author_id) === String(authorUser.id);

      if (!isPrivileged && !isAuthor) {
        return res.status(403).json({
          success: false,
          message: '添付ファイルを追加できるのは投稿者本人・教務・管理者のみです。'
        });
      }

      const form = await parseMultipart(req);
      const { files } = extractFormParts(form);

      const savedMeta = await saveFileEntries(files, authorUser, bulletinModel, id);

      return res.status(201).json({
        success: true,
        message: `添付ファイルを追加しました (${savedMeta.length} 件)`,
        data: savedMeta,
        attachments: savedMeta,
      });
    } catch (error) {
      const status = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 400;
      console.warn('[BulletinController Attachment Warning]', error.message);
      return res.status(status).json({
        success: false,
        message: error.message || '添付ファイルの追加に失敗しました。'
      });
    }
  },

  /**
   * 添付ファイルのダウンロード (実体配信)
   * GET /api/bulletins/attachments/:attachmentId
   */
  async downloadBulletinAttachment(req, res, next) {
    try {
      const { attachmentId } = req.params;
      const userId = req.user ? req.user.id : 'kyomu01';

      const { meta, stream } = await bulletinService.getAttachmentForDownload(attachmentId, userId);

      const encodedName = encodeURIComponent(meta.name);
      res.setHeader('Content-Type', meta.mime || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${meta.name}"; filename*=UTF-8''${encodedName}`);
      res.setHeader('Content-Length', String(meta.size));
      res.setHeader('X-Attachment-Id', meta.id);

      stream.on('error', (err) => {
        console.error('[BulletinController Attachment Stream Error]', err.message);
        if (!res.headersSent) {
          return res.status(404).json({ success: false, message: '添付ファイルの実体を読み取れません。' });
        }
        res.end();
      });

      return stream.pipe(res);
    } catch (error) {
      const status = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 404;
      return res.status(status).json({
        success: false,
        message: error.message || '添付ファイルをダウンロードできません。'
      });
    }
  },

  /**
   * 添付ファイルの削除
   * DELETE /api/bulletins/attachments/:attachmentId
   */
  async deleteBulletinAttachment(req, res, next) {
    try {
      const { attachmentId } = req.params;
      const user = req.user || { id: 'kyomu01', name: '教務 主任' };

      const result = await bulletinService.deleteAttachment(attachmentId, user);

      return res.status(200).json({
        success: true,
        message: `添付ファイル「${result.name}」を削除しました。`,
        data: result,
      });
    } catch (error) {
      const status = error.statusCode >= 400 && error.statusCode < 600 ? error.statusCode : 400;
      return res.status(status).json({
        success: false,
        message: error.message || '添付ファイルの削除に失敗しました。'
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
  createBulletinWithUpload,
  addAttachmentsToBulletin,
  downloadBulletinAttachment,
  deleteBulletinAttachment,
  acknowledgeBulletin,
  remindUnacknowledgedUsers,
  addComment,
  deleteBulletin,
  digitallyApprove,
  markAsRead,
  remindUnapprovedMembers,
} = bulletinController;

export default bulletinController;