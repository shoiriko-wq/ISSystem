/**
 * ISSystem Insecure (HTTP) Application
 *
 * 非安全ポート (HTTP) は「CAダウンロードページ」と証明書の配布専用に限定する。
 * - アプリ画面（SPA）は配信しない → 常にCAページを表示
 * - API アクセスは 426 Upgrade Required で拒否
 * - WebSocket (socket.io) は存在しない（wss のみ提供）
 */

import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { caController } from './controllers/ca.controller.js';
import { CA_FILE_NAME } from './services/ca.service.js';

const insecureApp = express();

// セキュリティヘッダー（ページはインラインスタイルのみ、スクリプトは使用しない）
insecureApp.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        'default-src': ["'self'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'script-src': ["'none'"],
        'img-src': ["'self'"],
        'connect-src': ["'self'"],
        'frame-ancestors': ["'none'"],
        'base-uri': ["'self'"],
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

if (process.env.NODE_ENV !== 'test') {
  insecureApp.use(morgan('dev'));
}

// 1. ルートCA証明書のダウンロード（証明書は公開情報 = HTTPでも配布）
insecureApp.get(`/ca/${CA_FILE_NAME}`, caController.downloadCa);
insecureApp.get(`/${CA_FILE_NAME}`, caController.downloadCa);

// 2. CA設定ページ
insecureApp.get('/ca', caController.showCaPage);

// 3. API は非安全トランスポートでは提供しない (426 Upgrade Required)
insecureApp.use('/api', caController.insecureTransport);

// 4. その他の全リクエストの振り分け
//    ブラウザGET → CAダウンロードページ / API的パス・JSON期望 → 426 / 非GETメソッド → 405
insecureApp.use(caController.insecureRequest);

export default insecureApp;
