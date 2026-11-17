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
import caRoutes from './routes/ca.routes.js';
import { errorHandler, notFoundHandler } from './middlewares/error.middleware.js';
import { parseCorsOrigin, originMatches } from './utils/origins.js';
import { createAccessLogStream } from './utils/access-log.js';
import config from '../config/default.js';
import jwt from 'jsonwebtoken';

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
// 2026/11/7 監査対策: wildcard ('*') を既定にせず、明示 Origin リストのみ許可する。
app.use(
  cors({
    origin: (origin, callback) => {
      // 2026/11/17: ブラウザは既定ポート 443 を Origin に書かない（https://<IP>:443 → https://<IP>）。
      // 許可リスト側と要求側を normalizeOrigin で揃えて照合する（wildcard '*' は明示設定時のみ許可）。
      const allowed = parseCorsOrigin(process.env.CORS_ORIGIN || process.env.CLIENT_ORIGIN, config.cors.allowedOrigins);
      if (!origin) return callback(null, true);
      return callback(null, originMatches(origin, allowed));
    },
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
  // 4b. v3.0.8: ファイル出力 (data/logs/access-YYYY-MM-DD.log、dir 700 / file 600、日次ローテーション、cron が AUDIT_RETENTION_DAYS で保持)
  app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev', { stream: createAccessLogStream() }));
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

// 6. プライベートCAダウンロードページ / 証明書配布 (/ca)
app.use('/ca', caRoutes);

// 6b. v3.1.15 初期パスワード変更ゲート (CSV 一括登録): must_change_password=1 のアカウントは
// パスワード変更完了までアプリ系 API を 403 で遮断する (§5)。
// ログイン・招待登録・パスワード変更・CA配布・監査ログ閲覧はゲートの対象外（変更手続きに必要）。
const PASSWORD_GATE_EXEMPT = new Set(['auth', 'ca', 'audit', 'health']);
const gateJwtSecret = config.auth?.jwtSecret || 'dev-secret-key-change-in-production';

app.use('/api', (req, res, next) => {
  const firstSegment = String(req.path || '').split('/').filter(Boolean)[0] || '';
  if (PASSWORD_GATE_EXEMPT.has(firstSegment)) return next();

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return next(); // 未認証は authenticateToken が 401 を返す

  let payload = null;
  try {
    payload = jwt.verify(token, gateJwtSecret);
  } catch {
    return next(); // 不正トークンは authenticateToken が 401 で止める
  }

  if (payload && payload.pwd === 1) {
    console.warn('[UserImportGate] 初期パスワード未変更のアカウントをアプリ系 API 要求から遮断しました。', {
      id: payload.id,
      staff_code: payload.staff_code
    });
    return res.status(403).json({
      success: false,
      message: '初期パスワードの変更が完了するまでアプリは利用できません。パスワードを変更してください。',
      code: 'PASSWORD_CHANGE_REQUIRED'
    });
  }

  return next();
});

// 7. マスター API ルーティング登録 (/api)
app.use('/api', routes);

// 8. 静的ファイル（public/ ディレクトリ配下の index.html, css, js）配信設定
app.use(express.static(path.join(__dirname, '../public')));

// 9. SPA/UIフォールバック処理 (Express v5対応ワイルドカード構文)
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