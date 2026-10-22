/**
 * ISSystem Bulletin & Circular Service
 * 掲示板・要承認回覧板の作成・ワンクリックデジタル承認・確認率動的計算・未確認教員一括督促通知 (完全安全ガード版)
 */

import bulletinModel from '../models/bulletin.model.js';
import userModel from '../models/user.model.js';
import auditModel from '../models/audit.model.js';
import chatModel from '../models/chat.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

export const bulletinService = {
  /**
   * 掲示・回覧板の一覧取得（閲覧教員の承認済みステータス付与）
   * @param {Object} filters - { type, category, targetGrade, targetDepartment, searchKey, isUrgent }
   * @param {string} userId - 閲覧教員のID
   */
  async getBulletins(filters = {}, userId = 'kyomu01') {
    const rawFilter = {
      ...filters,
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
    return list.map(item => {
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

    return {
      ...bulletin,
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

    return {
      ...normalizedPost,
      ...created,
      createdAt: created.createdAt || created.created_at || new Date().toISOString()
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