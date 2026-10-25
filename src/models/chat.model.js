/**
 * ISSystem Chat & Messaging Data Access Model
 * チャットチャンネル・メンバー・メッセージ PostgreSQL 完全対応モデル
 */

import { openDb } from '../utils/db.js';

async function getDb() {
  return openDb();
}

// フォールバック用インメモリキャッシュ
const mockChannels = new Map();
const mockChannelMembers = new Map();

/**
 * sender_id の FOREIGN KEY 解決
 * users テーブルに存在しない送信者 (SYSTEM 自動通知など) は 'system' ユーザーへ寄せ、
 * chat_messages_sender_id_fkey 制約を満たす
 */
async function resolveSenderId(senderId) {
  if (!senderId) return senderId;
  try {
    const res = await query(
      `SELECT id FROM users WHERE id = $1 OR staff_code = $1 LIMIT 1`,
      [senderId]
    );
    if (res.rows[0]) return res.rows[0].id;
    const sys = await query(`SELECT id FROM users WHERE id = 'system' LIMIT 1`, []);
    return sys.rows[0] ? sys.rows[0].id : senderId;
  } catch (error) {
    console.warn('[ChatModel PG Warning] resolveSenderId fallback:', error.message);
    return senderId;
  }
}


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
      const db = await getDb();
      await db.query(
        `INSERT INTO chat_channel_members (channel_id, user_id, is_hidden, joined_at)
         VALUES ($1, $2, 0, $3)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET is_hidden = 0, joined_at = EXCLUDED.joined_at`,
        [targetId, userId, nowStr]
      );
    } catch (error) {
      console.warn('[ChatModel PG Warning] addMember DB failed:', error.message);
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
         WHERE cm.channel_id = $1 OR cm.channel_id = $2`,
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
    const rawSenderId = messageData.sender_id || messageData.senderId || 'kyomu01';
    const senderId = await resolveSenderId(rawSenderId);
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
   * メッセージの削除（送信者による取り消し）
   * @param {string} messageId
   */
  async deleteMessage(messageId) {
    try {
      const db = await getDb();
      await db.run(`DELETE FROM chat_message_reads WHERE message_id = ?`, [messageId]);
      await db.run(`DELETE FROM chat_messages WHERE id = ?`, [messageId]);
      await db.close();
      return true;
    } catch (error) {
      console.warn('[ChatModel] deleteMessage failed:', error.message);
      return false;
    }
  },

  /**
   * チャンネル内の既読ログ取得（誰がどのメッセージを読んだか）
   * @param {string} channelId
   */
  async getChannelReads(channelId) {
    const targetId = this.normalizeChannelId(channelId);
    try {
      const db = await getDb();
      const rows = await db.all(
        `SELECT message_id, user_id, read_at FROM chat_message_reads WHERE channel_id = ?`,
        [targetId]
      );
      await db.close();
      return rows || [];
    } catch (error) {
      console.warn('[ChatModel] getChannelReads fallback:', error.message);
      return [];
    }
  },

  /**
   * メッセージ既読の記録（チャンネル閲覧時、指定メッセージまでを既読扱いにする）
   * @param {string} channelId
   * @param {string} userId
   * @param {string|null} uptoMessageId 既読位置となるメッセージID (省略時はチャンネル内全メッセージ)
   */
  async markChannelRead(channelId, userId, uptoMessageId = null) {
    const targetId = this.normalizeChannelId(channelId);
    if (!userId) return false;

    try {
      const db = await getDb();
      let uptoDate = null;
      if (uptoMessageId) {
        const ref = await db.get(`SELECT created_at FROM chat_messages WHERE id = ?`, [uptoMessageId]);
        uptoDate = ref ? ref.created_at : null;
      }

      // 自分の送信メッセージは既読扱いの対象外（未読者リストに自分を含めない）
      const messages = await db.all(
        `SELECT id, created_at FROM chat_messages
         WHERE (channel_id = ? OR channel_id = ?) AND sender_id <> ?
         ORDER BY created_at ASC`,
        [targetId, channelId, userId]
      );

      const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
      let recorded = 0;
      for (const m of messages) {
        if (uptoDate && m.created_at > uptoDate) continue;
        await db.run(
          `INSERT INTO chat_message_reads (channel_id, message_id, user_id, read_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (channel_id, message_id, user_id) DO NOTHING`,
          [targetId, m.id, userId, nowStr]
        );
        recorded += 1;
      }
      await db.close();
      return recorded;
    } catch (error) {
      console.warn('[ChatModel] markChannelRead failed:', error.message);
      return 0;
    }
  },

  /**
   * 特定ユーザーの未読メッセージ件数（未読バッジ用）
   * @param {string} channelId
   * @param {string} userId
   */
  async countUnreadForUser(channelId, userId) {
    const targetId = this.normalizeChannelId(channelId);
    if (!userId) return 0;
    try {
      const db = await getDb();
      const row = await db.get(
        `SELECT COUNT(m.id) AS cnt
         FROM chat_messages m
         WHERE (m.channel_id = ? OR m.channel_id = ?)
           AND m.sender_id <> ?
           AND NOT EXISTS (
             SELECT 1 FROM chat_message_reads r
             WHERE r.channel_id = ? AND r.message_id = m.id AND r.user_id = ?
           )`,
        [targetId, channelId, userId, targetId, userId]
      );
      await db.close();
      return row ? parseInt(row.cnt, 10) : 0;
    } catch (error) {
      console.warn('[ChatModel] countUnreadForUser fallback:', error.message);
      return 0;
    }
  },

  /**
   * メッセージ詳細取得（取り消し時の所有者検証用）
   * @param {string} messageId
   */
  async findMessageById(messageId) {
    try {
      const db = await getDb();
      const row = await db.get(
        `SELECT m.*, COALESCE(u.name, m.sender_id) AS sender_name
         FROM chat_messages m
         LEFT JOIN users u ON m.sender_id = u.id OR m.sender_id = u.staff_code
         WHERE m.id = ?`,
        [messageId]
      );
      await db.close();
      return row || null;
    } catch (error) {
      console.warn('[ChatModel] findMessageById fallback:', error.message);
      return null;
    }
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
  deleteMessage,
  findMessageById,
  getChannelReads,
  markChannelRead,
  countUnreadForUser
} = chatModel;

export default chatModel;