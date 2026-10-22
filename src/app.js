/**
 * ISSystem Express Application Setup
 * ミドルウェア登録・CORS・JSONパーサー・マスター API ルーティング統合 & 静的ファイル配信 & 共通エラーハンドラー設定
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'path';
import { fileURLToPath } from 'url';
import routes from './routes/index.js';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// 1. セキュリティヘッダー設定 (Helmet) - 開発時のクロスオリジン・静的リソース制限を緩和
app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    contentSecurityPolicy: false, // インラインスクリプトやSocket.io CDN等の動的実行を許可
  })
);

// 2. CORS (Cross-Origin Resource Sharing) 設定
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || true, // 開発時はあらゆるOriginを動的に許可
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
    credentials: true,
  })
);

// 3. HTTPリクエストボディパーサー
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 4. HTTPアクセスログ出力 (開発環境: dev, 本番: combined)
if (process.env.NODE_ENV !== 'test') {
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
}

// 5. ヘルスチェック用軽量エンドポイント (ルートから /api/health へ移動)
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ONLINE',
    system: 'ISSystem Staff Room Information Sharing Backend API',
    version: '2.5.0',
    timestamp: new Date().toISOString(),
  });
});

// 6. マスター API ルーティング登録 (/api)
app.use('/api', routes);

// 7. 静的ファイル（public/ ディレクトリ配下の index.html, css, js）配信設定
app.use(express.static(path.join(__dirname, '../public')));

// 8. SPA/UIフォールバック処理 (Express v5対応ワイルドカード構文)
app.get('{*path}', (req, res, next) => {
  // /api/ から始まる未定義リクエストは 404 ハンドラーへ流す
  if (req.path.startsWith('/api')) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// 9. 未定義 API ルーティング (404 Not Found) ハンドラー
app.use(notFoundHandler);

// 10. 全体共通エラーハンドリングミドルウェア
app.use(errorHandler);

export default app;