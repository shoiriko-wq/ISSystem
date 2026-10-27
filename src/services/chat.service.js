/**
 * ISSystem Realtime Chat & Workflow Integration Service
 * チャットチャンネル管理・リアルタイムメッセージ送受信・決裁ワークフロー専用チャット自動生成
 */

import chatModel from '../models/chat.model.js';
import userModel from '../models/user.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';
import { onlineUserIds } from '../utils/presence.js';

export const chatService = {
  /**
   * ログイン教員が参加しているチャットチャンネル一覧の取得
   * @param {string} userId
   */
  async getUserChannels(userId) {
    const channels = await chatModel.listChannelsForUser(userId);

    // 各チャンネルの最新メッセージ・未読件数・メンバー数を付加
    const enrichedChannels = await Promise.all(
      channels.map(async (ch) => {
        const messages = await chatModel.getMessages(ch.id, 1);
        const lastMessage = messages.length > 0 ? messages[0] : null;
        const unread = await chatModel.countUnreadForUser(ch.id, userId);
        return {
          ...ch,
          lastMessage,
          unread,
        };
      })
    );

    return enrichedChannels;
  },

  /**
   * 特定チャンネルのメッセージ履歴取得
   * @param {string} channelId
   * @param {string} userId
   * @param {number} limit
   */
  async getChannelMessages(channelId, userId, limit = 50) {
    const channel = await chatModel.findChannelById(channelId);
    if (!channel) {
      throw new ApiError(404, '指定されたチャットチャンネルが見つかりません。');
    }

    const members = await chatModel.getMembers(channelId);
    const isMember = members.some((m) => m.user_id === userId);

    if (!isMember && channel.type !== 'PUBLIC') {
      throw new ApiError(403, 'このチャットチャンネルの閲覧権限がありません。');
    }

    const messages = await chatModel.getMessages(channelId, limit);

    // 既読ログに基づき、各メッセージの「未読者」名簿を付与（未読0名のメッセージは全員既読）
    const reads = await chatModel.getChannelReads(channelId);
    const readSet = new Set(
      reads.map((r) => `${r.message_id}::${r.user_id}`)
    );

    const decorated = messages.map((m) => {
      const unreaders = members
        .filter((mem) => {
          const memId = mem.user_id;
          if (!memId) return false;
          if (String(memId) === String(m.sender_id)) return false; // 送信者は自身の未読対象外
          return !readSet.has(`${m.id}::${memId}`);
        })
        .map((mem) => mem.user_name || mem.user_id);

      return {
        ...m,
        unreaders,
        readers: members
          .filter((mem) => readSet.has(`${m.id}::${mem.user_id}`))
          .map((mem) => mem.user_name || mem.user_id),
      };
    });

    return {
      channel,
      messages: decorated,
    };
  },

  /**
   * メッセージの送信
   * @param {Object} messageData - { channelId, messageText, attachments }
   * @param {Object} senderUser - { id, name }
   */
  async sendMessage(messageData, senderUser) {
    const { channelId, messageText, attachments } = messageData;

    if (!channelId || (!messageText && (!attachments || attachments.length === 0))) {
      throw new ApiError(400, 'チャンネルIDおよびメッセージ本文（または添付ファイル）は必須です。');
    }

    const channel = await chatModel.findChannelById(channelId);
    if (!channel) {
      throw new ApiError(404, '対象のチャットチャンネルが存在しません。');
    }

    const senderId = senderUser?.id || senderUser?.staff_code || messageData.sender_id || 'kyomu01';

    // セキュリティ配慮：非公開（GROUP/WORKFLOW等）チャンネルの場合、送信者がメンバーに含まれているか検証
    if (channel.type !== 'PUBLIC' && senderId !== 'SYSTEM') {
      const members = await chatModel.getMembers(channelId);
      const isMember = members.some((m) => m.user_id === senderId);
      if (!isMember) {
        throw new ApiError(403, 'このプライベートチャットグループのメンバーではないため、メッセージを送信できません。');
      }
    }

    let senderName = senderUser?.name;

    if (!senderName || senderName === '教員' || senderName === '教務 主任') {
      try {
        let dbUser = await userModel.findById(senderId);
        if (!dbUser) {
          dbUser = await userModel.findByStaffCode(senderId);
        }
        if (dbUser && dbUser.name) {
          senderName = dbUser.name;
        }
      } catch (e) {
        console.warn('[ChatService] user lookup failed:', e.message);
      }
    }

    senderName = senderName || senderUser?.name || '教員';

    const sentMessage = await chatModel.sendMessage({
      channel_id: channelId,
      sender_id: senderId,
      sender_name: senderName,
      message_text: messageText ? messageText.trim() : '',
      attachments_json: attachments || null,
    });

    // 監査ログ記録 (チャット送信ログ)
    try {
      await auditModel.logAction({
        userId: senderId,
        action: 'SEND_CHAT_MESSAGE',
        targetEntity: 'CHAT_CHANNEL',
        targetId: channelId,
      });
    } catch (err) {}

    return sentMessage;
  },

  /**
   * 一般チャットチャンネル（学年・分掌・任意グループ）の新規作成
   * @param {Object} channelData - { name, type, memberIds }
   * @param {Object} creatorUser - { id, name }
   */
  async createChannel(channelData, creatorUser) {
    if (!channelData.name) {
      throw new ApiError(400, 'チャンネル名は必須です。');
    }

    const initialMembers = new Set(channelData.memberIds || []);
    initialMembers.add(creatorUser.id);

    const newChannel = await chatModel.createChannel({
      name: channelData.name.trim(),
      type: channelData.type || 'PRIVATE',
      memberIds: Array.from(initialMembers),
    });

    await auditModel.logAction({
      userId: creatorUser.id,
      action: 'CREATE_CHAT_CHANNEL',
      targetEntity: 'CHAT_CHANNEL',
      targetId: newChannel.id,
      changesJson: JSON.stringify({ name: newChannel.name, type: newChannel.type }),
    });

    return newChannel;
  },

  /**
   * 決裁ワークフロー（物品購入リクエスト・出張申請等）連携専用チャットチャンネルの自動構築
   * @param {Object} approvalData - { id, title, applicant_id, applicant_name, approver_id }
   * @returns {Promise<Object>} 作成されたチャットチャンネル
   */
  async createWorkflowChannel(approvalData) {
    const channelName = `【決裁協議】${approvalData.title}`;
    const initialMemberIds = [approvalData.applicant_id];

    if (approvalData.approver_id) {
      initialMemberIds.push(approvalData.approver_id);
    } else {
      // 承認者未指定の場合、全教務主任・管理者を自動招待
      const allUsers = await userModel.listAll();
      const kyomuUsers = allUsers.filter(u => u.is_kyomu === true || u.role === 'ADMIN' || u.role === 'KYOMU');
      kyomuUsers.forEach(u => initialMemberIds.push(u.id));
    }

    const workflowChannel = await chatModel.createChannel({
      name: channelName,
      type: 'WORKFLOW',
      memberIds: Array.from(new Set(initialMemberIds)),
    });

    // 初期システム案内の自動投稿
    await chatModel.sendMessage({
      channel_id: workflowChannel.id,
      sender_id: 'SYSTEM',
      sender_name: 'システム自動通知',
      message_text: `決裁申請「${approvalData.title}」の協議・問い合わせ専用チャットが自動開設されました。\n申請者: ${approvalData.applicant_name}`,
    });

    return workflowChannel;
  },

  /**
   * 既存チャンネルへのメンバー追加
   * @param {string} channelId
   * @param {string} targetUserId
   * @param {Object} operatorUser
   */
  async addMemberToChannel(channelId, targetUserId, operatorUser) {
    const channel = await chatModel.findChannelById(channelId);
    if (!channel) {
      throw new ApiError(404, '対象のチャンネルが見つかりません。');
    }

    const targetUser = await userModel.findById(targetUserId);
    if (!targetUser) {
      throw new ApiError(404, '追加対象のユーザーが見つかりません。');
    }

    const addedMember = await chatModel.addMember(channelId, targetUserId);

    // 招待通知メッセージのシステム自動投稿
    await chatModel.sendMessage({
      channel_id: channelId,
      sender_id: 'SYSTEM',
      sender_name: 'システム自動通知',
      message_text: `${operatorUser.name} 先生が ${targetUser.name} 先生をチャンネルに追加しました。`,
    });

    return addedMember;
  },

  /**
   * チャンネルメンバー一覧とオンライン状態の取得
   * @param {string} channelId
   */
  async getChannelMembers(channelId) {
    const members = await chatModel.getMembers(channelId);
    return members.map(m => ({
      ...m,
      isOnline: onlineUserIds.has(m.user_id || m.id)
    }));
  },

  /**
   * チャンネルの削除（公開チャンネルは削除不可、参加者・管理者のみ）
   * @param {string} channelId
   * @param {Object} user - { id, name, role, is_kyomu }
   */
  async deleteChannel(channelId, user) {
    const targetId = chatModel.normalizeChannelId(channelId);
    const channel = await chatModel.findChannelById(targetId);
    const channelType = (channel && channel.type) || 'PRIVATE';

    if (targetId === 'general' || channelType === 'PUBLIC') {
      throw new ApiError(400, '公開チャンネルは削除できません。');
    }

    const members = await chatModel.getMembers(targetId);
    const isMember = members.some((m) => (m.user_id || m.id) === user.id);
    const privileged = user.role === 'ADMIN' || user.is_kyomu === true || user.is_kyomu === 1;

    if (!isMember && !privileged) {
      throw new ApiError(403, 'このチャンネルを削除する権限がありません。');
    }

    const deleted = await chatModel.deleteChannel(targetId);
    if (!deleted) {
      throw new ApiError(404, '削除対象のチャンネルが見つかりません。');
    }

    try {
      await auditModel.logAction({
        userId: user.id,
        action: 'DELETE_CHAT_CHANNEL',
        targetEntity: 'CHAT_CHANNEL',
        targetId,
        changesJson: JSON.stringify({ name: channel?.name }),
      });
    } catch (err) {}

    return { channelId: targetId, channel: channel || { id: targetId } };
  },

  /**
   * チャンネルの非表示 / 表示切り替え
   * @param {string} channelId
   * @param {string} userId
   * @param {boolean} isHidden
   */
  async toggleHideChannel(channelId, userId, isHidden) {
    await chatModel.toggleHideChannel(channelId, userId, isHidden);
    return { success: true, isHidden };
  },

  /**
   * チャンネルの既読位置更新（閲覧した範囲を既読ログとして記録する）
   * @param {string} channelId
   * @param {string} userId
   * @param {string|null} lastReadMessageId
   */
  async updateLastRead(channelId, userId, lastReadMessageId = null) {
    const recorded = await chatModel.markChannelRead(channelId, userId, lastReadMessageId);
    const remainingUnread = await chatModel.countUnreadForUser(channelId, userId);

    try {
      await auditModel.logAction({
        userId: userId,
        action: 'READ_CHAT_CHANNEL',
        targetEntity: 'CHAT_CHANNEL',
        targetId: channelId,
        changesJson: JSON.stringify({ recorded, remainingUnread, lastReadMessageId }),
      });
    } catch (err) {}

    return { success: true, channelId, userId, recorded, unreadCount: remainingUnread };
  },

  /**
   * メッセージの取り消し（送信者本人のみ削除可能）
   * @param {string} messageId
   * @param {Object} user - { id, name }
   */
  async cancelMessage(messageId, user) {
    const msg = await chatModel.findMessageById(messageId);
    if (!msg) {
      throw new ApiError(404, '取り消すメッセージが見つかりません。');
    }

    const requesterId = user?.id || user?.staff_code;
    const senderId = msg.sender_id || msg.senderId;
    const isStaffCodeMatch = user?.staff_code && String(user.staff_code) === String(senderId);

    if (String(requesterId) !== String(senderId) && !isStaffCodeMatch) {
      throw new ApiError(403, '自分が送信したメッセージのみ取り消すことができます。');
    }

    const deleted = await chatModel.deleteMessage(messageId);
    if (!deleted) {
      throw new ApiError(400, 'メッセージの取り消しに失敗しました。');
    }

    try {
      await auditModel.logAction({
        userId: requesterId || 'kyomu01',
        action: 'CANCEL_CHAT_MESSAGE',
        targetEntity: 'CHAT_MESSAGE',
        targetId: messageId,
        changesJson: JSON.stringify({ channelId: msg.channel_id }),
      });
    } catch (err) {}

    // 既読・未読の整合性を保つため、削除後の未読件数を再計算して返す
    const channelId = msg.channel_id;
    const members = await chatModel.getMembers(channelId);
    const affected = [];
    for (const mem of members) {
      if (!mem.user_id || String(mem.user_id) === String(senderId)) continue;
      affected.push({
        userId: mem.user_id,
        unreadCount: await chatModel.countUnreadForUser(channelId, mem.user_id),
      });
    }

    return { success: true, messageId, channelId, affectedUnreads: affected };
  },
};

export default chatService;