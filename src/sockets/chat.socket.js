/**
 * ISSystem Realtime Chat Socket Handlers
 * チャットメッセージリアルタイム配信・タイピング中通知・既読状態 & 未読バッジカウント同期
 */

import chatService from '../services/chat.service.js';
import chatModel from '../models/chat.model.js';
import { sanitizeSocketString } from '../middlewares/socket.middleware.js';

/**
 * チャンネルメンバー全員（送信者除く）へトースト通知を送信
 * @param {import('socket.io').Server} io
 * @param {Object} payload
 */
export async function broadcastChatToast(io, { channelId, channelName, createdMessage, senderUser }) {
  try {
    const members = await chatModel.getMembers(channelId);
    const preview = String(createdMessage.message_text || createdMessage.text || '').slice(0, 40);

    const targetIds = members
      .map((m) => m.user_id)
      .filter((id) => id && String(id) !== String(senderUser.id));

    targetIds.forEach((memberId) => {
      io.to(`user:${memberId}`).emit('chat:toast', {
        channelId,
        channelName: channelName || 'チャット',
        senderId: senderUser.id,
        senderName: senderUser.name || '教員',
        messageId: createdMessage.id,
        preview,
        timestamp: createdMessage.created_at || new Date().toISOString(),
      });
    });
  } catch (err) {
    console.warn('[Socket.io Chat Toast Warning]', err.message);
  }
}

/**
 * 接続時に参加チャンネルルームを自動参加（チャット画面以外でも通知が届くようにする）
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 * @param {Object} user
 */
export async function autoJoinUserChannelRooms(io, socket, user) {
  try {
    const channels = await chatModel.listChannelsForUser(user.id);
    channels.forEach((c) => {
      socket.join(`chat:channel:${c.id}`);
    });
    socket.emit('chat:channels_synced', {
      channels: channels.map((c) => ({ id: c.id, name: c.name, type: c.type })),
    });
  } catch (err) {
    console.warn('[Socket.io Chat AutoJoin Warning]', err.message);
  }
}

/**
 * チャット関連WebSocketイベントハンドラーのバインド
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export function registerChatSocketHandlers(io, socket) {
  const user = socket.user;

  /**
   * チャンネルアクセス権検証
   * ★ 職員全体チャット撤廃（2026/11/9 v3.1.2）: 全チャンネルが個人作成グループ。
   *   メンバーでないユーザーは閲覧・送信・既読更新いずれも不可。
   * @param {string} channelId
   * @returns {Promise<boolean>}
   */
  async function canAccessChannel(channelId) {
    const channel = await chatModel.findChannelById(channelId);
    if (!channel) return false;
    const members = await chatModel.getMembers(channelId);
    return members.some((m) => String(m.user_id) === String(user.id));
  }

  // ★ チャット画面以外でも新着通知が届くよう、参加中チャンネルルームを自動参加
  autoJoinUserChannelRooms(io, socket, user);

  /**
   * 特定チャットチャンネルルームへの参加
   * event: 'chat:join_channel'
   */
  socket.on('chat:join_channel', async (data) => {
    const channelId = sanitizeSocketString(data && typeof data === 'object' ? data.channelId : data, 64);
    if (!channelId) return;

    try {
      // ★ 職員全体チャット撤廃: 個人作成グループのメンバーのみルーム参加を許す
      const channel = await chatModel.findChannelById(channelId);
      if (!channel) {
        console.warn(`[Socket.io Chat Security] 存在しないチャンネル ${channelId} への参加要求`);
        return;
      }
      const members = await chatModel.getMembers(channelId);
      const isMember = members.some((m) => m.user_id === user.id);
      if (!isMember) {
        console.warn(`[Socket.io Chat Security] Unauthorized join attempt: User ${user.name} (${user.id}) tried to join non-member channel ${channelId}`);
        return;
      }

      const roomName = `chat:channel:${channelId}`;
      socket.join(roomName);
      console.log(`[Socket.io Chat] User ${user.name} (${user.id}) joined ${roomName}`);
    } catch (err) {
      console.error('[Socket.io Chat Join Error]:', err);
    }
  });

  /**
   * チャットチャンネルルームからの離脱
   * event: 'chat:leave_channel'
   */
  socket.on('chat:leave_channel', (rawChannelId) => {
    const channelId = sanitizeSocketString(rawChannelId, 64);
    if (!channelId) return;
    const roomName = `chat:channel:${channelId}`;
    socket.leave(roomName);
    console.log(`[Socket.io Chat] User ${user.name} (${user.id}) left ${roomName}`);
  });

  /**
   * リアルタイムメッセージの送信 & ルーム内一斉配信
   * event: 'chat:send_message'
   */
  socket.on('chat:send_message', async (data, callback) => {
    try {
      const channelId = sanitizeSocketString(data?.channelId, 64);
      const messageText = typeof data?.messageText === 'string' ? data.messageText.trim() : '';
      const attachments = Array.isArray(data?.attachments) ? data.attachments : undefined;

      if (!channelId || !messageText) {
        if (callback) callback({ success: false, error: 'チャンネルIDと本文は必須です。' });
        return;
      }

      // ★ ロール/メンバーシップ gate: 非メンバーのチャンネルへの送信は拒否
      if (!(await canAccessChannel(channelId))) {
        console.warn(`[Socket.io Chat Security] ${user.name} (${user.id}) が非メンバーチャンネル ${channelId} へ送信を試みました`);
        if (callback) callback({ success: false, error: 'このチャンネルへの送信権限がありません。' });
        return;
      }

      // サービス層を通してメッセージを永続化保存
      const createdMessage = await chatService.sendMessage(
        { channelId, messageText, attachments },
        user
      );

      let channelName = 'チャット';
      try {
        const channelObj = await chatModel.findChannelById(channelId);
        if (channelObj && channelObj.name) {
          channelName = channelObj.name;
        }
      } catch (err) {}

      const roomName = `chat:channel:${channelId}`;

      // 該当チャンネルに参加中の全クライアントへ新着メッセージを即時一斉配信
      io.to(roomName).emit('chat:message', {
        channelId,
        channelName,
        message: createdMessage,
      });

      // ★ トースト通知（送信者以外・チャット画面外も含む）
      await broadcastChatToast(io, { channelId, channelName, createdMessage, senderUser: user });

      // チャンネルメンバー宛てに未読バッジ更新イベントを個別通知
      const members = await chatModel.getMembers(channelId);
      if (Array.isArray(members)) {
        members.forEach((member) => {
          if (member.user_id !== user.id) {
            io.to(`user:${member.user_id}`).emit('chat:unread_count_updated', {
              channelId,
              increment: 1,
            });
          }
        });
      }

      if (callback) callback({ success: true, message: createdMessage });
    } catch (error) {
      console.error('[Socket.io Chat Send Error]:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * タイピング中（入力中…）ステータスのブロードキャスト
   * event: 'chat:typing_start'
   */
  socket.on('chat:typing_start', async (channelId) => {
    const safeChannelId = sanitizeSocketString(channelId, 64);
    if (!safeChannelId) return;
    if (!(await canAccessChannel(safeChannelId))) return;
    socket.to(`chat:channel:${safeChannelId}`).emit('chat:user_typing', {
      channelId: safeChannelId,
      user: { id: user.id, name: user.name },
      isTyping: true,
    });
  });

  /**
   * タイピング終了ステータスのブロードキャスト
   * event: 'chat:typing_stop'
   */
  socket.on('chat:typing_stop', async (channelId) => {
    const safeChannelId = sanitizeSocketString(channelId, 64);
    if (!safeChannelId) return;
    if (!(await canAccessChannel(safeChannelId))) return;
    socket.to(`chat:channel:${safeChannelId}`).emit('chat:user_typing', {
      channelId: safeChannelId,
      user: { id: user.id, name: user.name },
      isTyping: false,
    });
  });

  /**
   * メッセージ既読位置の即時同期 & 未読バッジクリア通知
   * event: 'chat:mark_as_read'
   */
  socket.on('chat:mark_as_read', async (data) => {
    try {
      const channelId = sanitizeSocketString(data?.channelId, 64);
      const lastReadMessageId = sanitizeSocketString(data?.lastReadMessageId, 64);
      if (!channelId) return;

      // 非メンバーのチャンネルの既読記録は書かせない
      if (!(await canAccessChannel(channelId))) {
        console.warn(`[Socket.io Chat Security] ${user.name} (${user.id}) が非メンバーチャンネル ${channelId} の既読更新を試みました`);
        return;
      }

      const result = await chatService.updateLastRead(channelId, user.id, lastReadMessageId);

      // 該当ユーザー本人の未読バッジ件数を同期
      socket.emit('chat:unread_count_updated', {
        channelId,
        unreadCount: result?.unreadCount || 0,
      });

      // チャンネル参加者へ既読完了イベントを通知
      socket.to(`chat:channel:${channelId}`).emit('chat:read_receipt', {
        channelId,
        userId: user.id,
        userName: result?.reader?.name || user.name,
        userAvatar: result?.reader?.avatar_url || null,
        lastReadMessageId,
      });
    } catch (error) {
      console.error('[Socket.io Chat Read Error]:', error);
    }
  });

  /**
   * コメント取り消し（送信者本人のみ取り消し可）
   * event: 'chat:cancel_message'
   * ※ 取り消した本文はクライアントとの通信に載せない。状態変更のみを通知する。
   */
  socket.on('chat:cancel_message', async (data, callback) => {
    try {
      const messageId = sanitizeSocketString(data?.messageId || data?.id, 64);
      if (!messageId) {
        if (callback) callback({ success: false, message: 'メッセージIDが必要です。' });
        return;
      }

      const result = await chatService.cancelMessage(messageId, user);

      // チャンネル参加者へ取り消しを通知（本文は含めず、取り消し表示へ差し替える）
      socket.to(`chat:channel:${result.channelId}`).emit('chat:message_cancelled', {
        channelId: result.channelId,
        messageId,
        cancelledBy: user.id,
        cancelledByName: user.name,
      });

      // 影響を受けたメンバーの未読バッジを再計算して同期
      (result.affectedUnreads || []).forEach((entry) => {
        io.to(`user:${entry.userId}`).emit('chat:unread_count_updated', {
          channelId: result.channelId,
          unreadCount: entry.unreadCount,
        });
      });

      if (callback) callback({ success: true, message: 'コメントを取り消しました。', messageId });
    } catch (error) {
      if (callback) callback({ success: false, message: error.message });
    }
  });
}

export default registerChatSocketHandlers;