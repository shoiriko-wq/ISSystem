/**
 * ISSystem Socket.io Gateway & Connection Handler
 * WebSocket認証ミドルウェア・接続イベントルーティング管理
 */

import registerChatSocketHandlers from './chat.socket.js';
import registerSeatingSocketHandlers from './seating.socket.js';
import registerLockSocketHandlers from './lock.socket.js';
import registerMailSocketHandlers from './mail.socket.js';
import mailService from '../services/mail.service.js';
import { onlineUserIds } from '../utils/presence.js';
import {
  isSocketOriginAllowed,
  verifySocketToken,
} from '../middlewares/socket.middleware.js';

/**
 * Socket.io サーバーの初期化およびハンドラー登録
 * @param {import('socket.io').Server} io
 */
export function initializeSockets(io) {
  // Socket.io 接続認証ミドルウェア（Origin 許可リスト + JWT 厳格検証）
  // 2026/11/7 監査 Critical #1 対策: demo トークン無条件通過と dev フォールバックを廃止。
  // 検証失敗は NODE_ENV に関係なく常に接続を拒否する。
  io.use((socket, next) => {
    const origin = socket.handshake.headers?.origin;
    if (!isSocketOriginAllowed(origin)) {
      console.warn(`[Socket.io Auth] 拒否: 許可されていない Origin (${origin})`);
      return next(new Error('Authentication error: Origin not allowed'));
    }

    const rawToken = socket.handshake.auth?.token || socket.handshake.headers?.authorization;

    let user;
    try {
      user = verifySocketToken(rawToken);
    } catch (err) {
      console.warn(`[Socket.io Auth] 拒否: ${err.message} (Origin: ${origin || 'none'})`);
      return next(new Error(`Authentication error: ${err.message}`));
    }

    socket.user = user;
    next();
  });

  // クライアント接続時のイベントリスナー
  io.on('connection', (socket) => {
    const userId = socket.user?.id;
    if (userId) {
      onlineUserIds.add(userId);
      // 個人宛の通知 (chat:toast / 未読バッジ更新 など) を受けるためのパーソナルルームに参加
      socket.join(`user:${userId}`);
      io.emit('user:presence', { userId, isOnline: true });
    }
    console.log(`[Socket.io] クライアント接続: User ID ${userId} (${socket.user.name} / ${socket.user.role}) - Socket ID: ${socket.id}`);

    // 各ドメインごとのリアルタイムハンドラーをバインド
    registerChatSocketHandlers(io, socket);
    registerSeatingSocketHandlers(io, socket);
    registerLockSocketHandlers(io, socket);
    registerMailSocketHandlers(io, socket);

    // このユーザのメールアカウントの常時接続 (IMAP IDLE) 監視を開始する
    if (userId) {
      mailService.ensureActiveWatchForUser(userId, io);
    }

    // 切断時のログ出力
    socket.on('disconnect', (reason) => {
      if (userId) {
        // 同じユーザーの他のアクティブソケットがなければオフラインに
        // ここではシンプルに削除してブロードキャスト
        onlineUserIds.delete(userId);
        io.emit('user:presence', { userId, isOnline: false });
        // このユーザの常時接続セッションを全て閉じる (2〜3秒で不要)
        mailService.dropWatchForUser(userId);
      }
      console.log(`[Socket.io] クライアント切断: User ID ${userId} - Reason: ${reason}`);
    });
  });
}

export default initializeSockets;