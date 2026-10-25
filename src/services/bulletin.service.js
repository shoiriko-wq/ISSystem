/**
 * ISSystem Bulletin & Circular Service
 * 掲示板・要承認回覧板の作成・ワンクリックデジタル承認・確認率動的計算・未確認教員一括督促通知 (完全安全ガード版)
 */

import bulletinModel from '../models/bulletin.model.js';
import userModel from '../models/user.model.js';
import auditModel from '../models/audit.model.js';
import chatModel from '../models/chat.model.js';
import { mapAttachment, parseMultipart, extractFormParts, saveFileEntries, removeStoredFile, getAttachmentStream } from './upload.service.js';
import { ApiError } from '../middlewares/error.middleware.js';

/**
 * targetScope JSON 文字列の安全パース
 * @param {string} raw
 */
function safeParseScope(raw) {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch (e) {
    return undefined;
  }
}

/**
 * 投稿一覧・詳細へ添付ファイルメタデータ（実体ファイル）を付与する
 * @param {Array<Object>} items
 * @param {import('../models/bulletin.model.js').bulletinModel} model
 */
async function attachAttachments(items, model = bulletinModel) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return list;

  const ids = list.map((i) => String(i.id)).filter(Boolean);
  let rows = [];
  try {
    if (typeof model.listAttachmentsForPosts === 'function') {
      rows = await model.listAttachmentsForPosts(ids);
    }
  } catch (e) {
    console.warn('[BulletinService] 添付一覧取得失敗:', e.message);
    rows = [];
  }

  const byPost = new Map();
  rows.forEach((row) => {
    const key = String(row.post_id);
    if (!byPost.has(key)) byPost.set(key, []);
    byPost.get(key).push(mapAttachment(row));
  });

  return list.map((item) => {
    const dbAttachments = byPost.get(String(item.id)) || [];
    const legacy = Array.isArray(item.attachments) ? item.attachments : [];
    // JSON カラム内の旧添付レコード（オブジェクト/文字列 ID）を正規化し DB 実体と統合
    const normalizedLegacy = legacy
      .map((a) => {
        if (typeof a === 'string') return { id: a, name: a, size: 0, downloadPath: null };
        if (a && a.id) {
          return {
            id: a.id,
            name: a.name || a.originalName || a.original_name || a.id,
            size: Number(a.size || 0),
            mime: a.mime || a.mime_type || '',
            downloadPath: a.downloadPath || (a.id ? `/bulletins/attachments/${a.id}` : null),
          };
        }
        return null;
      })
      .filter(Boolean);

    const merged = [...dbAttachments];
    normalizedLegacy.forEach((legacyItem) => {
      if (!merged.some((m) => String(m.id) === String(legacyItem.id))) merged.push(legacyItem);
    });

    const postedAt = item.postedAt || item.posted_at || item.createdAt || item.created_at;
    const postedDay = String(postedAt).substring(0, 10);

    return {
      ...item,
      postedAt,
      posted_at: postedAt,
      postedDay,
      posted_day: postedDay,
      attachments: merged,
    };
  });
}

export const bulletinService = {
  /**
   * 掲示・回覧板の一覧取得（閲覧教員の承認済みステータス付与）
   * @param {Object} filters - { type, category, targetGrade, targetDepartment, searchKey, isUrgent }
   * @param {string} userId - 閲覧教員のID
   */
  async getBulletins(filters = {}, userId = 'kyomu01') {
    const rawFilter = {
      ...filters,
      postedDay: filters.postedDay || filters.posted_date || filters.day,
      currentUserId: userId
    };

    let list = [];
    if (typeof bulletinModel.findAll === 'function') {
      list = await bulletinModel.findAll(rawFilter);
    } else if (typeof bulletinModel.findPosts === 'function') {
      list = await bulletinModel.findPosts(rawFilter);
    }

    if (!Array.isArray(list)) list = [];

    // フロントエンド描画に必要な両命名規則 (Camel / Snake) の同時展開
    const normalized = list.map(item => {
      const pType = item.postType || item.post_type || item.type || 'NOTICE';
      const pPriority = item.priority || (item.is_urgent ? 'URGENT' : 'NORMAL');
      const pAuthorName = item.authorName || item.author_name || item.author || '教務 主任';
      const pCreatedAt = item.createdAt || item.created_at || new Date().toISOString();

      return {
        ...item,
        id: item.id,
        title: item.title || '（無題）',
        content: item.content || '',
        postType: pType,
        post_type: pType,
        priority: pPriority,
        authorId: item.authorId || item.author_id || 'kyomu01',
        author_id: item.authorId || item.author_id || 'kyomu01',
        authorName: pAuthorName,
        author_name: pAuthorName,
        createdAt: pCreatedAt,
        created_at: pCreatedAt,
        ackStatus: item.ackStatus || item.ack_status || (item.is_acknowledged ? 'APPROVED' : 'UNREAD'),
        is_acknowledged: item.ackStatus === 'APPROVED' || item.is_acknowledged === true,
        targetScope: item.targetScope || { grade: 'ALL', department: 'ALL' },
        attachments: item.attachments || []
      };
    });

    return await attachAttachments(normalized);
  },

  /**
   * 掲示・回覧投稿の詳細取得（承認一覧・未承認者・確認率の統合）
   * @param {string} id
   * @param {string} userId
   */
  async getBulletinDetail(id, userId = 'kyomu01') {
    const bulletin = await bulletinModel.findById(id);
    if (!bulletin) {
      throw new ApiError(404, '指定された掲示・回覧が見つかりません。');
    }

    // 全アクティブ教員の取得（確認率の分母計算用）
    let allUsers = [];
    try {
      if (userModel && typeof userModel.listAll === 'function') {
        allUsers = await userModel.listAll();
      }
    } catch (e) {
      allUsers = [];
    }

    const targetUsers = allUsers.filter(u => {
      if (bulletin.target_grade && u.grade !== bulletin.target_grade) return false;
      if (bulletin.target_department && u.department !== bulletin.target_department) return false;
      return true;
    });

    const totalTargetCount = targetUsers.length || (allUsers.length > 0 ? allUsers.length : 1);

    // 承認ログ一覧の取得
    let acknowledgements = [];
    try {
      if (typeof bulletinModel.getAcknowledgements === 'function') {
        acknowledgements = await bulletinModel.getAcknowledgements(id);
      }
    } catch (e) {
      acknowledgements = [];
    }

    const ackUserIds = new Set(acknowledgements.map(a => a.user_id || a.userId));

    // 未確認教員のリストアップ
    const unacknowledgedUsers = targetUsers
      .filter(u => !ackUserIds.has(u.id))
      .map(u => ({ id: u.id, name: u.name, grade: u.grade, department: u.department }));

    const ackCount = acknowledgements.length;
    const ackPercentage = totalTargetCount > 0 
      ? Math.round((ackCount / totalTargetCount) * 100) 
      : 0;

    let comments = [];
    try {
      if (typeof bulletinModel.getComments === 'function') {
        comments = await bulletinModel.getComments(id);
      }
    } catch (e) {
      comments = [];
    }

    const pType = bulletin.postType || bulletin.post_type || 'NOTICE';
    const pAuthorName = bulletin.authorName || bulletin.author_name || '教務 主任';

    // 添付ファイル実体メタデータ (テーブルから取得)
    let attachmentMeta = [];
    try {
      if (typeof bulletinModel.listAttachments === 'function') {
        const rows = await bulletinModel.listAttachments(id);
        attachmentMeta = (rows || []).map((row) => mapAttachment(row));
      }
    } catch (attachErr) {
      console.warn('[BulletinService] 添付取得失敗:', attachErr.message);
      attachmentMeta = [];
    }

    const enriched = await attachAttachments([
      {
        ...bulletin,
        attachments: attachmentMeta.length > 0 ? attachmentMeta : bulletin.attachments || [],
      },
    ]);
    const base = enriched[0] || bulletin;

    return {
      ...base,
      postType: pType,
      post_type: pType,
      authorName: pAuthorName,
      author_name: pAuthorName,
      is_acknowledged: ackUserIds.has(userId),
      ack_count: ackCount,
      target_user_count: totalTargetCount,
      ack_percentage: ackPercentage,
      acknowledgements,
      unacknowledged_users: unacknowledgedUsers,
      comments,
    };
  },

  /**
   * 新規掲示・要承認回覧板の作成
   * @param {Object} postData
   * @param {Object} authorUser
   */
  async createBulletin(postData, authorUser = {}) {
    if (!postData.title || !postData.content) {
      throw new ApiError(400, '件名および本文は必須項目です。');
    }

    const userId = authorUser.id || postData.authorId || postData.author_id || 'kyomu01';
    const userName = authorUser.name || postData.authorName || postData.author_name || '教務 主任';

    const normalizedPost = {
      ...postData,
      title: postData.title,
      content: postData.content,
      postType: postData.postType || postData.post_type || postData.type || 'NOTICE',
      post_type: postData.postType || postData.post_type || postData.type || 'NOTICE',
      priority: postData.priority || (postData.is_urgent || postData.isUrgent ? 'URGENT' : 'NORMAL'),
      authorId: userId,
      author_id: userId,
      authorName: userName,
      author_name: userName,
      // 投稿日時（編集日時とは別）と添付ファイル ID 群
      postedAt: postData.postedAt || postData.posted_at || postData.postedAtInput || null,
      posted_at: postData.postedAt || postData.posted_at || postData.postedAtInput || null,
      attachments: (postData.attachments || [])
        .map((a) => (typeof a === 'string' ? a : a && a.id))
        .filter(Boolean),
    };

    const createFn = bulletinModel.create || bulletinModel.createPost;
    const created = await createFn.call(bulletinModel, normalizedPost);

    // 監査ログ記録 (例外で落とさない安全処理)
    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId,
          action: 'CREATE_BULLETIN',
          targetEntity: 'BULLETIN',
          targetId: created.id || 'new_id',
          changesJson: JSON.stringify({ title: created.title, type: created.post_type || created.postType }),
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    const createdAt = created.createdAt || created.created_at || new Date().toISOString();
    const postedAt = created.postedAt || created.posted_at || normalizedPost.postedAt || createdAt;

    let attachmentMeta = [];
    try {
      if (created.id && typeof bulletinModel.listAttachments === 'function') {
        const rows = await bulletinModel.listAttachments(created.id);
        attachmentMeta = (rows || []).map((row) => mapAttachment(row));
      }
    } catch (attachErr) {
      console.warn('[BulletinService] 添付メタ取得失敗:', attachErr.message);
      attachmentMeta = [];
    }

    return {
      ...normalizedPost,
      ...created,
      createdAt,
      created_at: createdAt,
      postedAt,
      posted_at: postedAt,
      postedDay: String(postedAt).substring(0, 10),
      posted_day: String(postedAt).substring(0, 10),
      attachments: attachmentMeta
    };
  },

  /**
   * 要承認回覧板のデジタルワンクリック承認（既読確認）
   * @param {string} postId
   * @param {string} userId
   */
  async acknowledgeBulletin(postId, userId = 'kyomu01') {
    const bulletin = await bulletinModel.findById(postId);
    if (!bulletin) {
      throw new ApiError(404, '対象の回覧板が存在しません。');
    }

    let ack = null;
    if (typeof bulletinModel.updateAcknowledgement === 'function') {
      ack = await bulletinModel.updateAcknowledgement(postId, userId, 'APPROVED');
    } else if (typeof bulletinModel.addAcknowledgement === 'function') {
      ack = await bulletinModel.addAcknowledgement(postId, userId);
    }

    // 監査ログ出力 (ガード付き)
    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId,
          action: 'ACKNOWLEDGE_BULLETIN',
          targetEntity: 'BULLETIN',
          targetId: postId,
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    // 更新後の詳細データを取得
    let updatedDetail = { ack_count: 1, ack_percentage: 100 };
    try {
      updatedDetail = await this.getBulletinDetail(postId, userId);
    } catch (e) {
      // フォールバック
    }

    return {
      success: true,
      acknowledgedAt: ack ? (ack.acknowledged_at || ack.acknowledgedAt) : new Date().toISOString(),
      ackCount: updatedDetail.ack_count || 1,
      ackPercentage: updatedDetail.ack_percentage || 100,
    };
  },

  /**
   * 未確認教員への一括督促通知送信
   * @param {string} postId
   * @param {Object} currentUser
   */
  async remindUnacknowledgedUsers(postId, currentUser = {}) {
    const userId = currentUser.id || 'kyomu01';
    const userName = currentUser.name || '教務 主任';

    let detail = null;
    try {
      detail = await this.getBulletinDetail(postId, userId);
    } catch (e) {
      return { message: '督促対象の取得に失敗しました。', remindedCount: 0 };
    }

    if (!detail.unacknowledged_users || detail.unacknowledged_users.length === 0) {
      return {
        message: 'すべての対象教員が確認・承認済みです。',
        remindedCount: 0,
      };
    }

    const unackNames = detail.unacknowledged_users.map(u => u.name).join('、');
    const reminderMessage = `【回覧板・確認リマインド】\n件名：「${detail.title}」\n未確認の先生方: ${unackNames}\nお手数ですが、ISSystemより内容をご確認の上、承認ボタンの押下をお願いいたします。`;

    // チャットチャンネルへの督促メッセージ投稿
    try {
      if (chatModel && typeof chatModel.listChannelsForUser === 'function') {
        const userChannels = await chatModel.listChannelsForUser(userId);
        const targetChannel = userChannels.length > 0 ? userChannels[0] : { id: 'general' };

        if (chatModel.sendMessage) {
          await chatModel.sendMessage({
            channel_id: targetChannel.id,
            sender_id: userId,
            sender_name: userName,
            message_text: reminderMessage,
          });
        }
      }
    } catch (chatErr) {
      console.warn('[Chat Remind Warning]', chatErr.message);
    }

    // 監査ログ記録
    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId,
          action: 'REMIND_BULLETIN_UNACKNOWLEDGED',
          targetEntity: 'BULLETIN',
          targetId: postId,
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    return {
      message: `${detail.unacknowledged_users.length}名の未確認教員へ督促リマインドを送信しました。`,
      remindedCount: detail.unacknowledged_users.length,
      unacknowledgedUsers: detail.unacknowledged_users,
    };
  },

  /**
   * 回覧板スレッドへのコメント投稿
   * @param {string} postId
   * @param {string} commentText
   * @param {Object} user
   */
  async addComment(postId, commentText, user = {}) {
    if (!commentText || !commentText.trim()) {
      throw new ApiError(400, 'コメント本文を入力してください。');
    }

    const bulletin = await bulletinModel.findById(postId);
    if (!bulletin) {
      throw new ApiError(404, '対象の投稿が存在しません。');
    }

    const commentData = {
      id: `cmt_${Date.now()}`,
      bulletin_id: postId,
      author_id: user.id || 'kyomu01',
      author_name: user.name || '教務 主任',
      comment_text: commentText.trim(),
      created_at: new Date().toISOString()
    };

    if (typeof bulletinModel.addComment === 'function') {
      await bulletinModel.addComment(commentData);
    }

    return commentData;
  },

  /**
   * multipart/form-data による掲示作成（ファイル添付付き）
   * @param {import('express').Request} req
   * @param {Object} authorUser
   */
  async createBulletinWithUpload(req, authorUser = {}) {
    const form = await parseMultipart(req);
    const { fields, files } = extractFormParts(form);

    if (!files || files.length === 0) {
      throw new ApiError(400, '添付ファイルを 1 件以上選択してください。');
    }

    const postData = {
      title: fields.title || fields.subject || '',
      content: fields.content || fields.body || '',
      postType: fields.postType || fields.post_type || fields.type || fields.category,
      priority: fields.priority,
      postedAt: fields.postedAt || fields.posted_at || fields.postedAtInput,
      targetScope: fields.targetScope ? safeParseScope(fields.targetScope) : undefined,
      attachments: [],
    };

    // 本文・件名検証はファイル保存前に行う (失敗時はディスクに残さない)
    if (!postData.title || !postData.content) {
      throw new ApiError(400, '件名および本文は必須項目です。');
    }

    const created = await this.createBulletin(postData, authorUser);

    // 添付をこの投稿へ紐付けて保存
    const savedMeta = await saveFileEntries(files, authorUser, bulletinModel, created.id);

    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId: authorUser.id || 'kyomu01',
          action: 'UPLOAD_BULLETIN_ATTACHMENT',
          targetEntity: 'BULLETIN',
          targetId: created.id,
          changesJson: JSON.stringify({ files: savedMeta.map((m) => ({ id: m.id, name: m.name, size: m.size })) }),
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    return { ...created, attachments: savedMeta };
  },

  /**
   * 添付ファイル 1 件の取得（メタ + 実体ストリーム）
   * @param {string} attachmentId
   * @param {string} userId
   */
  async getAttachmentForDownload(attachmentId, userId = 'kyomu01') {
    const row = await bulletinModel.findAttachment(attachmentId);
    if (!row) {
      throw new ApiError(404, '添付ファイルが見つかりません。');
    }

    if (row.post_id) {
      const post = await bulletinModel.findById(row.post_id);
      if (!post) {
        throw new ApiError(404, '添付元の掲示が存在しないため、ダウンロードできません。');
      }
    }

    return { meta: mapAttachment(row), row, stream: getAttachmentStream(row) };
  },

  /**
   * 添付ファイルの削除（投稿者本人・教務・管理者のみ）
   * @param {string} attachmentId
   * @param {Object} user
   */
  async deleteAttachment(attachmentId, user = {}) {
    const row = await bulletinModel.findAttachment(attachmentId);
    if (!row) {
      throw new ApiError(404, '添付ファイルが見つかりません。');
    }

    const role = String(user.role || '').toUpperCase();
    const isPrivileged = role === 'KYOMU' || role === 'KYOUMU' || role === 'ADMIN';
    const isUploader = row.uploaded_by && String(row.uploaded_by) === String(user.id);

    let isPostAuthor = false;
    if (row.post_id) {
      const post = await bulletinModel.findById(row.post_id);
      isPostAuthor = !!post && String(post.authorId || post.author_id) === String(user.id);
    }

    if (!isPrivileged && !isUploader && !isPostAuthor) {
      throw new ApiError(403, '添付ファイルを削除できるのは投稿者本人・教務・管理者のみです。');
    }

    await bulletinModel.deleteAttachment(row.id);
    await removeStoredFile(row.stored_name);

    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId: user.id || 'kyomu01',
          action: 'DELETE_BULLETIN_ATTACHMENT',
          targetEntity: 'BULLETIN',
          targetId: row.post_id || row.id,
          changesJson: JSON.stringify({ attachmentId: row.id, name: row.original_name }),
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    return { id: row.id, name: row.original_name, deleted: true };
  },

  /**
   * 掲示・回覧投稿の削除
   * @param {string} postId
   * @param {Object} user
   */
  async deleteBulletin(postId, user = {}) {
    const bulletin = await bulletinModel.findById(postId);
    if (!bulletin) {
      throw new ApiError(404, '対象の投稿が見つかりません。');
    }

    if (typeof bulletinModel.delete === 'function') {
      await bulletinModel.delete(postId);
    }

    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId: user.id || 'kyomu01',
          action: 'DELETE_BULLETIN',
          targetEntity: 'BULLETIN',
          targetId: postId,
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    return { message: '掲示・回覧を削除しました。' };
  },
};

export default bulletinService;