/**
 * ISSystem HTTP & Socket.io Server Entrypoint
 * データベース接続初期化・HTTP/WebSocket サーバー起動・Cronタスク起動 & グレースフルシャットダウン
 */

import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import app from './app.js';
import { initializeDatabase } from '../config/database.js';
import { initializeSockets } from './sockets/socket.index.js';
import { initializeCronJobs } from './utils/cron.jobs.js';

const PORT = process.env.PORT || 3000;

async function startServer() {
  try {
    console.log('----------------------------------------------------');
    console.log('ISSystem (職員室情報共有システム) バックエンドを起動中...');
    console.log('----------------------------------------------------');

    // 1. データベース接続の初期化およびテーブル/インデックス構築
    await initializeDatabase();
    console.log('[Database] データベースの初期化と接続が完了しました。');

    // 2. HTTP サーバーの作成
    const server = http.createServer(app);

    // 3. Socket.io WebSocket サーバーの初期化
    const io = new SocketIOServer(server, {
      cors: {
        origin: process.env.CLIENT_ORIGIN || '*',
        methods: ['GET', 'POST'],
        credentials: true,
      },
      pingTimeout: 60000,
      pingInterval: 25000,
    });

    // 4. Socket.io イベントハンドラーと認証ミドルウェアの登録
    initializeSockets(io);
    app.set('io', io);
    console.log('[Socket.io] WebSocket リアルタイム通信レイヤーを初期化しました。');

    // 5. 定期バックグラウンドタスク (Cron) の登録
    initializeCronJobs(io);

    // 6. HTTP & WebSocket サーバーのリスニング開始
    server.listen(PORT, () => {
      console.log('====================================================');
      console.log(`🚀 ISSystem サーバーが正常に起動しました！`);
      console.log(`   - HTTP API URL:   http://localhost:${PORT}/api`);
      console.log(`   - WebSocket URL:  ws://localhost:${PORT}`);
      console.log(`   - 実行環境:        ${process.env.NODE_ENV || 'development'}`);
      console.log('====================================================');
    });

    // 7. SIGINT / SIGTERM シグナルによるグレースフルシャットダウン
    const gracefulShutdown = (signal) => {
      console.log(`\n[Server Shutdown] シグナル ${signal} を受信しました。サーバーを終了します...`);

      server.close(() => {
        console.log('[Server Shutdown] HTTP/WebSocket サーバーを停止しました。');
        process.exit(0);
      });

      // 10秒以内に終了しない場合は強制終了
      setTimeout(() => {
        console.error('[Server Shutdown] 強制終了します。');
        process.exit(1);
      }, 10000);
    };

    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  } catch (error) {
    console.error('❌ サーバー起動中に深刻なエラーが発生しました:', error);
    process.exit(1);
  }
}

startServer();