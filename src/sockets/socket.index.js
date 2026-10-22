/**
 * ISSystem Socket.io Gateway & Connection Handler
 * WebSocket認証ミドルウェア・接続イベントルーティング管理
 */

import jwt from 'jsonwebtoken';
import config from '../../config/default.js';
import registerChatSocketHandlers from './chat.socket.js';
import registerSeatingSocketHandlers from './seating.socket.js';
import registerLockSocketHandlers from './lock.socket.js';
import { onlineUserIds } from '../utils/presence.js';

/**
 * Socket.io サーバーの初期化およびハンドラー登録
 * @param {import('socket.io').Server} io
 */
export function initializeSockets(io) {
  // Socket.io 接続認証ミドルウェア (JWT検証)
  io.use((socket, next) => {
    const rawToken = socket.handshake.auth?.token || socket.handshake.headers?.authorization;

    if (!rawToken) {
      return next(new Error('Authentication error: Token missing'));
    }

    // "Bearer <token>" の形式にも対応できるよう抽出
    const token = rawToken.startsWith('Bearer ') ? rawToken.split(' ')[1] : rawToken;

    // ★ 1. デモモード用トークンの個別許容
    if (token && token.startsWith('demo-jwt-token-')) {
      socket.user = {
        id: 'demo-teacher',
        name: 'デモ教員',
        role: 'TEACHER'
      };
      return next();
    }

    // ★ 2. 通常の JWT 検証
    const jwtSecret = config.jwtSecret || process.env.JWT_SECRET || 'your-secret-key';

    jwt.verify(token, jwtSecret, (err, decoded) => {
      if (err) {
        // 開発環境 (NODE_ENV !== 'production') の場合はエラーで弾かず柔軟にフォールバック
        if (process.env.NODE_ENV !== 'production') {
          console.warn(`[Socket.io Auth] トークン検証警告 (${err.message}) - 開発環境用フォールバックユーザーで接続を許可します。`);
          socket.user = {
            id: 'dev-user',
            name: '開発教員',
            role: 'TEACHER'
          };
          return next();
        }

        return next(new Error('Authentication error: Invalid token'));
      }

      socket.user = decoded;
      next();
    });
  });

  // クライアント接続時のイベントリスナー
  io.on('connection', (socket) => {
    const userId = socket.user?.id;
    if (userId) {
      onlineUserIds.add(userId);
      io.emit('user:presence', { userId, isOnline: true });
    }
    console.log(`[Socket.io] クライアント接続: User ID ${userId} (${socket.user.name || '教員'}) - Socket ID: ${socket.id}`);

    // 各ドメインごとのリアルタイムハンドラーをバインド
    registerChatSocketHandlers(io, socket);
    registerSeatingSocketHandlers(io, socket);
    registerLockSocketHandlers(io, socket);

    // 切断時のログ出力
    socket.on('disconnect', (reason) => {
      if (userId) {
        // 同じユーザーの他のアクティブソケットがなければオフラインに
        // ここではシンプルに削除してブロードキャスト
        onlineUserIds.delete(userId);
        io.emit('user:presence', { userId, isOnline: false });
      }
      console.log(`[Socket.io] クライアント切断: User ID ${userId} - Reason: ${reason}`);
    });
  });
}

export default initializeSockets;