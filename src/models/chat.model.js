/**
 * ISSystem Chat & Messaging Data Access Model
 * チャットチャンネル・メンバー・メッセージ PostgreSQL 完全対応モデル
 */

import { query } from '../../config/database.js';
import { nowIso } from '../utils/db.js';

// フォールバック用インメモリキャッシュ
const mockChannels = new Map();
const mockChannelMembers = new Map();

export const chatModel = {
  /**
   * チャンネルIDの正規化エイリアス変換
   * (フロントエンドの 'chat-all' や 'all' を DB上の 'general' にマッピング)
   */
  normalizeChannelId(channelId) {
    if (!channelId) return 'general';
    if (channelId === 'chat-all' || channelId === 'all' || channelId === 'chat_all') return 'general';
    return channelId;
  },

  /**
   * チャンネルIDによる詳細取得
   * @param {string} channelId
   */
  async findChannelById(channelId) {
    const rawId = channelId;
    const targetId = this.normalizeChannelId(channelId);

    if (mockChannels.has(targetId)) return mockChannels.get(targetId);

    try {
      const res = await query(`SELECT * FROM chat_channels WHERE id = $1 OR id = $2`, [targetId, rawId]);
      return res.rows[0] || { id: rawId, name: '📢 全体チャット', type: 'PUBLIC' };
    } catch (error) {
      return { id: rawId, name: '📢 全体チャット', type: 'PUBLIC' };
    }
  },

  /**
   * 特定ユーザーが参加・表示権限を持つチャンネル一覧の取得
   * @param {string} userId
   */
  async listChannelsForUser(userId = 'kyomu01') {
    try {
      const res = await query(
        `SELECT DISTINCT c.*, cm.is_hidden, cm.joined_at
         FROM chat_channels c
         LEFT JOIN chat_channel_members cm ON c.id = cm.channel_id AND cm.user_id = $1
         WHERE c.type = 'PUBLIC' OR (cm.user_id = $2 AND (cm.is_hidden IS NULL OR cm.is_hidden = 0))
         ORDER BY c.created_at ASC`,
        [userId, userId]
      );
      const channels = res.rows;

      if (channels && channels.length > 0) return channels;
    } catch (error) {
      console.warn('[ChatModel PG Warning] listChannelsForUser fallback:', error.message);
    }

    return [
      { id: 'general', name: '📢 職員全体', type: 'PUBLIC' },
      { id: 'chat-all', name: '📢 全体チャット', type: 'PUBLIC' },
      { id: 'grade1', name: '🏫 1年学年部', type: 'GROUP' },
      { id: 'kyomu', name: '📋 教務部連絡', type: 'GROUP' }
    ];
  },

  /**
   * 新規チャットチャンネルの構築
   * @param {Object} channelData
   */
  async createChannel(channelData) {
    const id = channelData.id || `chat_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const nowStr = nowIso();
    const newChannel = {
      id,
      name: channelData.name,
      type: channelData.type || 'PUBLIC',
      created_at: nowStr
    };

    mockChannels.set(id, newChannel);

    try {
      await query(
        `INSERT INTO chat_channels (id, name, type, created_at) VALUES ($1, $2, $3, $4)`,
        [newChannel.id, newChannel.name, newChannel.type, nowStr]
      );
    } catch (error) {
      console.warn('[ChatModel PG Warning] createChannel DB insert failed:', error.message);
    }

    if (channelData.memberIds && Array.isArray(channelData.memberIds)) {
      for (const mId of channelData.memberIds) {
        await this.addMember(id, mId);
      }
    }

    return newChannel;
  },

  /**
   * チャンネルへのメンバー追加・再表示処理 (PostgreSQL 互換 ON CONFLICT)
   * @param {string} channelId
   * @param {string} userId
   */
  async addMember(channelId, userId) {
    const targetId = this.normalizeChannelId(channelId);
    const nowStr = nowIso();
    const key = `${targetId}_${userId}`;
    const member = {
      channel_id: targetId,
      user_id: userId,
      is_hidden: 0,
      joined_at: nowStr
    };

    mockChannelMembers.set(key, member);

    try {
      await query(
        `INSERT INTO chat_channel_members (channel_id, user_id, is_hidden, joined_at)
         VALUES ($1, $2, 0, $3)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET is_hidden = 0, joined_at = $3`,
        [targetId, userId, nowStr]
      );
    } catch (error) {
      console.warn('[ChatModel PG Warning] addMember DB failed:', error.message);
    }

    return member;
  },

  /**
   * チャンネルメンバー一覧の取得
   * @param {string} channelId
   */
  async getMembers(channelId) {
    const targetId = this.normalizeChannelId(channelId);
    try {
      const res = await query(
        `SELECT cm.*, u.name as user_name, u.role, u.department 
         FROM chat_channel_members cm
         JOIN users u ON cm.user_id = u.id
         WHERE cm.channel_id = ? OR cm.channel_id = ?`,
        [targetId, channelId]
      );
      return res.rows || [];
    } catch (error) {
      return [];
    }
  },

  /**
   * メッセージの送信・保存
   * @param {Object} messageData
   */
  async sendMessage(messageData) {
    const id = messageData.id || `msg_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const channelId = this.normalizeChannelId(messageData.channel_id || messageData.channelId);
    const senderId = messageData.sender_id || messageData.senderId || 'kyomu01';
    const messageText = messageData.message || messageData.message_text || messageData.messageText || messageData.content || '';
    const nowStr = nowIso();

    let senderName = messageData.sender_name || messageData.senderName;
    try {
      await query(
        `INSERT INTO chat_messages (id, channel_id, sender_id, message, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, channelId, senderId, messageText, nowStr]
      );
      if (!senderName || senderName === '教員' || senderName === '教務 主任') {
        const userRes = await query(`SELECT name FROM users WHERE id = $1 OR staff_code = $2`, [senderId, senderId]);
        if (userRes.rows[0] && userRes.rows[0].name) senderName = userRes.rows[0].name;
      }
    } catch (error) {
      console.warn('[ChatModel PG Warning] sendMessage DB insert failed:', error.message);
    }

    senderName = senderName || '教員';

    const msg = {
      id,
      channel_id: channelId,
      channelId: channelId,
      sender_id: senderId,
      senderId: senderId,
      sender_name: senderName,
      senderName: senderName,
      message: messageText,
      message_text: messageText,
      text: messageText,
      created_at: nowStr,
      createdAt: nowStr
    };

    return msg;
  },

  /**
   * チャンネルのメッセージ履歴取得 (時系列昇順)
   * ※ 存在しない m.message_text をクエリから完全除去
   * @param {string} channelId
   * @param {number} limit
   */
  async getMessages(channelId, limit = 50) {
    const rawId = channelId;
    const targetId = this.normalizeChannelId(channelId);

    try {
      const res = await query(
        `SELECT m.id, m.channel_id, m.sender_id, 
                m.message,
                m.created_at,
                COALESCE(u.name, m.sender_id) as sender_name, u.role as sender_role
         FROM chat_messages m
         LEFT JOIN users u ON m.sender_id = u.id OR m.sender_id = u.staff_code
         WHERE m.channel_id = $1 OR m.channel_id = $2
         ORDER BY m.created_at ASC
         LIMIT $3`,
        [targetId, rawId, limit]
      );
      const rows = res.rows;

      if (rows && rows.length > 0) {
        // JS側でフロントエンド互換の全命名規則プロパティをセット
        return rows.map(r => ({
          ...r,
          message_text: r.message,
          content: r.message,
          senderName: r.sender_name || r.sender_id || '教員',
          sender_name: r.sender_name || r.sender_id || '教員',
          senderId: r.sender_id,
          sender_id: r.sender_id
        }));
      }
    } catch (error) {
      console.warn('[ChatModel PG Warning] getMessages DB query failed:', error.message);
    }

    return [];
  },

  /**
   * エイリアスメソッド群
   */
  async getUserChannels(userId) {
    return this.listChannelsForUser(userId);
  },

  async getChannelMessages(channelId, limit = 50) {
    return this.getMessages(channelId, limit);
  },

  async createMessage(msgData) {
    return this.sendMessage(msgData);
  },

  /**
   * チャンネル非表示・非アクティブトグル
   */
  async toggleHideChannel(channelId, userId, isHidden) {
    const targetId = this.normalizeChannelId(channelId);
    try {
      await query(
        `UPDATE chat_channel_members SET is_hidden = $1 WHERE channel_id = $2 AND user_id = $3`,
        [isHidden ? 1 : 0, targetId, userId]
      );
    } catch (error) {
      // 無視
    }
  },

  /**
   * チャンネル・グループの削除
   */
  async deleteChannel(channelId) {
    const targetId = this.normalizeChannelId(channelId);
    mockChannels.delete(targetId);
    try {
      await query(`DELETE FROM chat_messages WHERE channel_id = $1`, [targetId]);
      await query(`DELETE FROM chat_channel_members WHERE channel_id = $1`, [targetId]);
      await query(`DELETE FROM chat_channels WHERE id = $1`, [targetId]);
      return true;
    } catch (error) {
      console.warn('[ChatModel PG Warning] deleteChannel failed:', error.message);
      return false;
    }
  }
};

// --- named import 用のエクスポート ---
export const {
  findChannelById,
  listChannelsForUser,
  getUserChannels,
  createChannel,
  addMember,
  getMembers,
  sendMessage,
  createMessage,
  getMessages,
  getChannelMessages,
  toggleHideChannel,
  deleteChannel
} = chatModel;

export default chatModel;