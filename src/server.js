/**
 * ISSystem Secure Server Entrypoint (HTTPS/WSS + CA配布HTTPサーバ)
 * データベース接続初期化・TLS(HTTPS/WSS)サーバー起動・非HTTP CAページ起動・Cron起動 & グレースフルシャットダウン
 */

import http from 'http';
import https from 'https';
import { Server as SocketIOServer } from 'socket.io';
import config from '../config/default.js';
import app from './app.js';
import insecureApp from './app.insecure.js';
import { initializeDatabase, closeDatabase } from '../config/database.js';
import { seedInitialData } from '../scripts/seed-data.js';
import { initializeSockets } from './sockets/socket.index.js';
import { initializeCronJobs } from './utils/cron.jobs.js';
import { loadTlsOptions, getCaInfo } from './services/ca.service.js';
import { isSocketOriginAllowed } from './middlewares/socket.middleware.js';

const SSL_PORT = config.ssl.httpsPort; // HTTPS / WSS（アプリ本体）
const SSL_HOST = config.ssl.host; // 安全サーバーの監視ホスト
const INSECURE_PORT = config.ssl.insecurePort; // CAダウンロードページ専用
const INSECURE_HOST = config.server.host; // CA配布サーバーの監視ホスト

/** リスニングエラー（EADDRINUSE 等）の共通ハンドラー */
const attachListenErrorHandler = (server, port, label) => {
  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ ポート ${port} (${label}) は既に使用されています（EADDRINUSE）。`);
      console.error('   確認: ss -ltnp | grep :' + port);
      console.error('   既存インスタンスの停止: pkill -f "node src/server.js" （nodemon 側も停止してください）');
      process.exit(1);
    }
    console.error(`❌ ${label} のリスニング中にエラーが発生しました:`, error);
    process.exit(1);
  });
};

async function startServer() {
  try {
    console.log('----------------------------------------------------');
    console.log('ISSystem (職員室情報共有システム) バックエンドを起動中...');
    console.log('----------------------------------------------------');

    // 1. データベース接続の初期化およびテーブル/インデックス構築
    await initializeDatabase();
    console.log('[Database] データベースの初期化と接続が完了しました。');

    // 1b. 基本情報マスタ（クラス・教科・教室・科目）の初期データは data/seed/*.csv から投入する
    //     サーバー側のコードに初期名を固定しない。対象テーブルが空のときだけ投入し、運用で作り替えたマスタには触らない。
    try {
      const seedResults = await seedInitialData();
      const total = seedResults.reduce((sum, r) => sum + r.inserted, 0);
      if (total > 0) {
        console.log(`[Seed CSV] 初期マスタデータを投入: ${seedResults.map((r) => `${r.table}=${r.inserted}件`).join(' / ')} 合計 ${total}件`);
      }
    } catch (seedErr) {
      console.warn('[Seed CSV] 初期マスタデータの投入をスキップしました:', seedErr.message);
    }

    const servers = [];

    // 2. プライベートCA・サーバー証明書の読み込み
    const tls = loadTlsOptions();
    const caInfo = getCaInfo();

    if (tls && caInfo.exists) {
      // 3. HTTPS サーバー（アプリ本体）の作成
      const secureServer = https.createServer(tls, app);

      // 4. Socket.io WebSocket サーバー（wss）の初期化
      // 2026/11/7 監査 Critical #1 対策: cors origin を '*' 既定にしない。
      // 接続ハンドシェイクの Origin は socket.middleware.js の許可リストで照合する（単一実装）。
      const io = new SocketIOServer(secureServer, {
        cors: {
          origin: (origin, callback) => {
            if (isSocketOriginAllowed(origin)) callback(null, true);
            else {
              console.warn(`[Socket.io CORS] 拒否: 許可されていない Origin (${origin})`);
              callback(new Error('CORS origin not allowed'));
            }
          },
          methods: ['GET', 'POST'],
          credentials: true,
        },
        pingTimeout: 60000,
        pingInterval: 25000,
      });

      // 5. Socket.io イベントハンドラーと認証ミドルウェアの登録
      initializeSockets(io);
      app.set('io', io);
      console.log('[Socket.io] WSS リアルタイム通信レイヤーを初期化しました。');

      // 6. 定期バックグラウンドタスク (Cron) の登録
      initializeCronJobs(io);

      attachListenErrorHandler(secureServer, SSL_PORT, 'HTTPS/WSS');
      secureServer.listen(SSL_PORT, SSL_HOST, () => {
        console.log('====================================================');
        console.log('🔒 安全接続サーバー (HTTPS / WSS)');
        console.log(`   - 監視ホスト:   ${SSL_HOST}`);
        console.log(`   - HTTPS URL:  https://localhost:${SSL_PORT}/`);
        console.log(`   - WSS URL:    wss://localhost:${SSL_PORT}`);
        console.log(`   - ルートCA指紋: ${caInfo.fingerprint}`);
        console.log(`   - 実行環境:    ${process.env.NODE_ENV || 'development'}`);
        console.log('====================================================');
      });
      servers.push(secureServer);
    } else {
      console.error('❌ プライベートCA / サーバー証明書が見つかりません。');
      console.error('   生成: npm run cert:gen  (scripts/create-ca.mjs)');
      console.error('   証明書が存在する間はアプリ（画面・API）は安全接続でのみ提供されます。');
    }

    // 7. 非HTTPサーバー（CAダウンロードページ専用）の起動
    const insecureServer = http.createServer(insecureApp);
    attachListenErrorHandler(insecureServer, INSECURE_PORT, 'HTTP(CA配布)');
    insecureServer.listen(INSECURE_PORT, INSECURE_HOST, () => {
      console.log('----------------------------------------------------');
      console.log('📄 非安全ポート (HTTP) はCA証明書の配布専用です。');
      console.log(`   - 監視ホスト: ${INSECURE_HOST}`);
      console.log(`   - CAページ: http://localhost:${INSECURE_PORT}/ca`);
      console.log('   - APIアクセスは 426 Upgrade Required で拒否されます。');
      console.log('----------------------------------------------------');
    });
    servers.push(insecureServer);

    // 8. SIGINT / SIGTERM シグナルによるグレースフルシャットダウン
    const gracefulShutdown = (signal) => {
      console.log(`\n[Server Shutdown] シグナル ${signal} を受信しました。サーバーを終了します...`);

      let remaining = servers.length;
      const finish = async () => {
        console.log('[Server Shutdown] HTTP/HTTPS・WebSocket サーバーを停止しました。');
        await closeDatabase();
        process.exit(0);
      };

      if (remaining === 0) {
        return finish();
      }
      servers.forEach((s) =>
        s.close(() => {
          remaining -= 1;
          if (remaining === 0) finish();
        })
      );

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
