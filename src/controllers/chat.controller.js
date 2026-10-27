/**
 * ISSystem Realtime Chat Controller
 * チャットチャンネル一覧・メッセージ履歴・送信・チャンネル作成・メンバー追加API (フロントエンド構造・WebSocket完全連動版)
 */

import chatService from '../services/chat.service.js';
import chatModel from '../models/chat.model.js';
import { broadcastChatToast } from '../sockets/chat.socket.js';

export const chatController = {
  /**
   * 参加チャットチャンネル一覧の取得
   * GET /api/chat/channels
   */
  async getUserChannels(req, res, next) {
    try {
      const userId = req.user ? req.user.id : 'kyomu01';
      const channels = await chatService.getUserChannels(userId);

      const list = Array.isArray(channels) ? channels : [];

      return res.status(200).json({
        success: true,
        count: list.length,
        data: list,
        channels: list,
      });
    } catch (error) {
      console.error('[ChatController getUserChannels Error]', error.message);
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
        channels: [],
      });
    }
  },

  /**
   * 指定チャンネルのメッセージ履歴取得
   * GET /api/chat/channels/:channelId/messages
   */
  async getChannelMessages(req, res, next) {
    try {
      const { channelId } = req.params;
      const { limit } = req.query;
      const userId = req.user ? req.user.id : 'kyomu01';

      let result = await chatService.getChannelMessages(
        channelId,
        userId,
        limit ? parseInt(limit, 10) : 50
      );

      // 配列形式で直接返ってきた場合とオブジェクト型で返ってきた場合の両方を吸収
      const messagesList = Array.isArray(result) 
        ? result 
        : (result && result.messages ? result.messages : []);

      const channelObj = (result && result.channel) ? result.channel : { id: channelId, name: 'チャット' };

      return res.status(200).json({
        success: true,
        count: messagesList.length,
        data: messagesList,
        messages: messagesList,
        channel: channelObj,
      });
    } catch (error) {
      console.error('[ChatController getChannelMessages Error]', error.message);
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
        messages: [],
      });
    }
  },

  /**
   * メッセージの送信 (キーの全受容 & リアルタイムSocket配信)
   * POST /api/chat/channels/:channelId/messages
   */
  async sendMessage(req, res, next) {
    try {
      const { channelId } = req.params;
      // message, messageText, content のいずれのキーで送信されても受け取れるように補捕
      const { messageText, message, content, attachments, senderId, senderName } = req.body;
      const text = messageText || message || content;

      const userId = (req.user && req.user.id) || senderId || 'kyomu01';
      let userName = (req.user && req.user.name) || senderName;

      const senderUser = {
        id: userId,
        name: userName || '教員',
        role: (req.user && req.user.role) || 'TEACHER'
      };

      if (!text || !text.trim()) {
        return res.status(400).json({
          success: false,
          message: 'メッセージ本文を入力してください。',
        });
      }

      const sentMessage = await chatService.sendMessage(
        { channelId, channel_id: channelId, messageText: text.trim(), message: text.trim(), attachments },
        senderUser
      );

      let channelName = 'チャット';
      try {
        const channel = await chatModel.findChannelById(channelId);
        if (channel && channel.name) {
          channelName = channel.name;
        }
      } catch (err) {}

      // WebSocket (Socket.io) リアルタイム配信用インスタンスの取得・配信
      try {
        const io = req.app ? req.app.get('io') : null;
        if (io) {
          const roomName = `chat:channel:${channelId}`;
          io.to(roomName).emit('chat:message', {
            channelId,
            channelName,
            message: sentMessage,
          });

          // ★ チャット画面外にいるメンバーへもトースト通知を配信
          await broadcastChatToast(io, { channelId, channelName, createdMessage: sentMessage, senderUser });
        }
      } catch (wsErr) {
        console.warn('[Socket Broadcast Warning]', wsErr.message);
      }

      return res.status(201).json({
        success: true,
        message: 'メッセージを送信しました。',
        data: sentMessage,
        messageData: sentMessage,
        chatMessage: sentMessage,
      });
    } catch (error) {
      console.error('[ChatController sendMessage Error]', error.message);
      return res.status(400).json({
        success: false,
        message: error.message || 'メッセージの送信に失敗しました。',
      });
    }
  },

  /**
   * チャットチャンネルの新規作成
   * POST /api/chat/channels
   */
  async createChannel(req, res, next) {
    try {
      const { name, type, memberIds } = req.body;
      const creatorUser = req.user || { id: 'kyomu01', name: '教務 主任' };

      const newChannel = await chatService.createChannel(
        { name, type, memberIds },
        creatorUser
      );

      try {
        const io = req.app ? req.app.get('io') : null;
        if (io) {
          const initialMembers = new Set(memberIds || []);
          initialMembers.add(creatorUser.id);
          initialMembers.forEach((memberId) => {
            io.to(`user:${memberId}`).emit('chat:channel_created', {
              channel: newChannel,
              creator: creatorUser
            });
          });
        }
      } catch (wsErr) {
        console.warn('[Socket Broadcast Warning]', wsErr.message);
      }

      return res.status(201).json({
        success: true,
        message: 'チャットチャンネルを作成しました。',
        data: newChannel,
        channel: newChannel,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || 'チャンネル作成に失敗しました。',
      });
    }
  },

  /**
   * 既存チャンネルへのメンバー追加
   * POST /api/chat/channels/:channelId/members
   */
  async addMember(req, res, next) {
    try {
      const { channelId } = req.params;
      const { targetUserId } = req.body;
      const operatorUser = req.user || { id: 'kyomu01', name: '教務 主任' };

      if (!targetUserId) {
        return res.status(400).json({
          success: false,
          message: '追加対象のユーザーIDを指定してください。',
        });
      }

      const member = await chatService.addMemberToChannel(
        channelId,
        targetUserId,
        operatorUser
      );

      return res.status(200).json({
        success: true,
        message: 'メンバーをチャンネルに追加しました。',
        data: member,
        member,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || 'メンバー追加に失敗しました。',
      });
    }
  },

  /**
   * チャンネルの非表示/表示切り替え
   * PUT /api/chat/channels/:channelId/hide
   */
  async toggleHideChannel(req, res, next) {
    try {
      const { channelId } = req.params;
      const { isHidden } = req.body;
      const userId = req.user ? req.user.id : 'kyomu01';

      const result = await chatService.toggleHideChannel(
        channelId,
        userId,
        isHidden === true
      );

      return res.status(200).json({
        success: true,
        message: isHidden ? 'チャンネルを非表示にしました。' : 'チャンネルを表示状態にしました。',
        data: result,
        result,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || '操作に失敗しました。',
      });
    }
  },

  /**
   * チャンネルのメンバー一覧取得
   * GET /api/chat/channels/:channelId/members
   */
  async getChannelMembers(req, res, next) {
    try {
      const { channelId } = req.params;
      const members = await chatService.getChannelMembers(channelId);
      return res.status(200).json({
        success: true,
        count: members.length,
        data: members,
        members,
      });
    } catch (error) {
      console.error('[ChatController getChannelMembers Error]', error.message);
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
        members: [],
      });
    }
  },

  /**
   * メッセージの取り消し（送信者本人のみ）
   * DELETE /api/chat/messages/:messageId
   */
  async cancelMessage(req, res, next) {
    try {
      const { messageId } = req.params;
      const user = req.user || { id: 'kyomu01', name: '教務 主任' };

      const result = await chatService.cancelMessage(messageId, user);

      // 全チャンネル参加者へ「取り消された」ことをリアルタイム通知
      try {
        const io = req.app ? req.app.get('io') : null;
        if (io) {
          io.to(`chat:channel:${result.channelId}`).emit('chat:message_deleted', {
            channelId: result.channelId,
            messageId,
            deletedBy: user.id,
            deletedByName: user.name,
          });

          // 各メンバーの未読バッジを再計算して同期
          (result.affectedUnreads || []).forEach((entry) => {
            io.to(`user:${entry.userId}`).emit('chat:unread_count_updated', {
              channelId: result.channelId,
              unreadCount: entry.unreadCount,
            });
          });
        }
      } catch (wsErr) {
        console.warn('[Socket Broadcast Warning]', wsErr.message);
      }

      return res.status(200).json({
        success: true,
        message: 'メッセージを取り消しました。',
        data: { messageId, channelId: result.channelId },
        messageId,
        channelId: result.channelId,
      });
    } catch (error) {
      console.error('[ChatController cancelMessage Error]', error.message);
      return res.status(error.status || 400).json({
        success: false,
        message: error.message || 'メッセージの取り消しに失敗しました。',
      });
    }
  },

  /**
   * チャンネルの削除
   * DELETE /api/chat/channels/:channelId
   */
  async deleteChannel(req, res, next) {
    try {
      const { channelId } = req.params;
      const user = req.user || { id: 'kyomu01', name: '教務 主任' };

      const result = await chatService.deleteChannel(channelId, user);

      // チャンネル参加者へ削除をリアルタイム通知
      try {
        const io = req.app ? req.app.get('io') : null;
        if (io) {
          io.to(`chat:channel:${result.channelId}`).emit('chat:channel_deleted', {
            channelId: result.channelId,
            deletedBy: user.id,
            deletedByName: user.name,
          });
        }
      } catch (wsErr) {
        console.warn('[Socket Broadcast Warning]', wsErr.message);
      }

      return res.status(200).json({
        success: true,
        message: 'チャンネルを削除しました。',
        data: result.channel,
        channelId: result.channelId,
      });
    } catch (error) {
      const statusCode = error?.statusCode || 400;
      console.error('[ChatController deleteChannel Error]', error.message);
      return res.status(statusCode).json({
        success: false,
        message: error.message || 'チャンネル削除に失敗しました。',
      });
    }
  },

  /**
   * 最終既読日時の更新（閲覧位置ログ＝既読メッセージの記録）
   * PUT /api/chat/channels/:channelId/read
   */
  async updateLastRead(req, res, next) {
    try {
      const { channelId } = req.params;
      const userId = req.user ? req.user.id : 'kyomu01';
      const lastReadMessageId = req.body ? (req.body.lastReadMessageId || req.body.last_read_message_id || null) : null;

      let result = { success: true, unreadCount: 0 };
      if (chatService && typeof chatService.updateLastRead === 'function') {
        result = await chatService.updateLastRead(channelId, userId, lastReadMessageId);
      }

      // 自分の未読バッジを同期し、チャンネル参加者へ既読を通知する
      try {
        const io = req.app ? req.app.get('io') : null;
        if (io) {
          io.to(`user:${userId}`).emit('chat:unread_count_updated', {
            channelId,
            unreadCount: result.unreadCount || 0,
          });
          io.to(`chat:channel:${channelId}`).emit('chat:read_receipt', {
            channelId,
            userId,
            userName: req.user ? req.user.name : '教員',
            lastReadMessageId,
          });
        }
      } catch (wsErr) {
        console.warn('[Socket Broadcast Warning]', wsErr.message);
      }

      return res.status(200).json({
        success: true,
        message: '既読状態を更新しました。',
        data: result,
        unreadCount: result.unreadCount || 0,
      });
    } catch (error) {
      console.error('[ChatController updateLastRead Error]', error.message);
      return res.status(200).json({
        success: true,
        message: '既読更新スキップ',
        unreadCount: 0,
      });
    }
  },
};

// --- ルーティング側 (src/routes/index.js) との別名エイリアス定義 ---
chatController.getChannels = chatController.getUserChannels;
chatController.getMessages = chatController.getChannelMessages;

// 個別インポート (named import) 用の展開エクスポート
export const {
  getUserChannels,
  getChannelMessages,
  sendMessage,
  createChannel,
  addMember,
  deleteChannel,
  toggleHideChannel,
  updateLastRead,
  getChannels,
  getMessages,
  getChannelMembers,
  cancelMessage,
} = chatController;

export default chatController;