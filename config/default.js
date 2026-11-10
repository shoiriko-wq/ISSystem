/**
 * ISSystem Application Configuration
 * PostgreSQL 一本化 (ISSystem仕様書 §9) - .env の環境変数から設定を構築
 */

import dotenv from 'dotenv';
import path from 'path';
// 既存の OS 環境変数 (DB_NAME=is_system 等) より .env を優先して上書きする
dotenv.config({ override: true, quiet: true });

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

// メール暗号化モードの許可値 (none = 暗号化なし, starttls, tls = TLS 直結)
const MAIL_TLS_MODES = ['none', 'starttls', 'tls'];

/** .env の暗号化モード値を許可値へ正規化する（不正値は fallback（既定 'none'）） */
function normalizeTlsMode(value, fallback = 'none') {
  const v = String(value ?? '').trim().toLowerCase();
  return MAIL_TLS_MODES.includes(v) ? v : fallback;
}

// 2026/11/8 監査 Critical 対策: 既知の既定値 secret を起動時に拒否（fail-fast）。
// JWT_SECRET / MAIL_ENC_SECRET は 32文字以上のランダム値（openssl rand -hex 32）必須。
const KNOWN_INSECURE_SECRETS = new Set([
  'is_system_secret_key_2026_default_jwt',
  'dev-secret-key-change-in-production',
  'changeme',
  'secret',
  'jwt-secret',
]);

function enforceSecret(name, value) {
  const str = String(value || '');
  if (str.length < 32 || KNOWN_INSECURE_SECRETS.has(str)) {
    throw new Error(
      `[Config] ${name} が安全ではありません。32文字以上のランダム値が必要です（生成: openssl rand -hex 32）。` +
      ' 既知の既定値・短値・未設定での起動は禁止されています。'
    );
  }
  return str;
}

const jwtSecret = enforceSecret('JWT_SECRET', process.env.JWT_SECRET);
const mailEncSecret = enforceSecret('MAIL_ENC_SECRET', process.env.MAIL_ENC_SECRET);
if (mailEncSecret === jwtSecret) {
  throw new Error('[Config] MAIL_ENC_SECRET は JWT_SECRET と必ず別値にしてください（キー系統の分離）。');
}


const config = {
  env: process.env.NODE_ENV || 'development',

  server: {
    port: toInt(process.env.PORT, 3000),
    // 非HTTP（CA配布専用）サーバーの監視ホスト
    host: process.env.HOST || '0.0.0.0',
  },

  // 2. 認証・セキュリティ設定 (auth.middleware.js / auth.service.js / socket.index.js が参照)
  auth: {
    jwtSecret, // 2026/11/8: 既定値フォールバック撤去（enforceSecret が起動時に検証）
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    bcryptSaltRounds: toInt(process.env.BCRYPT_SALT_ROUNDS, 10),
    invitationCodeExpiryHours: 24,
  },

  // 3. データベース接続設定 (PostgreSQL 18.6 / pg ライブラリ)
  db: {
    type: process.env.DB_TYPE || 'postgres', // 'postgres'
    uri: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/issystem',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'issystem',
    // pg ライブラリ用の接続先データベース名 (name と同一。config/database.js が参照するキー)
    database: process.env.DB_NAME || 'issystem',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    maxConnections: parseInt(process.env.DB_MAX_CONN || '20', 10),
    timezone: process.env.DB_TIMEZONE || 'Asia/Tokyo',
    // 共有プール設定 (config/database.js が参照するキー)
    pool: {
      max: toInt(process.env.DB_MAX_CONN, 20),
      min: toInt(process.env.DB_MIN_CONN, 0),
      idleTimeoutMillis: toInt(process.env.DB_IDLE_TIMEOUT_MS, 30000),
      connectionTimeoutMillis: toInt(process.env.DB_CONNECT_TIMEOUT_MS, 10000),
    },
    // 冪等スキーマ自動適用 (db/schemaPath 起点はプロジェクトルート)
    schemaPath: process.env.DB_SCHEMA_PATH || 'db/schema.sql',
    autoInitSchema: process.env.DB_AUTO_SCHEMA !== 'false',
    ssl: process.env.DB_SSL === 'true',
  },

  // 4. リアルタイム通信 & 排他制御設定
  realtime: {
    lockTimeoutMs: parseInt(process.env.LOCK_TIMEOUT_MS || '180000', 10), // 3分間無操作で自動解放
    pingIntervalMs: 25000,
    pingTimeoutMs: 20000,
  },

  jwt: {
    secret: jwtSecret, // 2026/11/8: 'dev-secret-key-change-in-production' フォールバック撤去
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },

  cors: {
    allowedOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  logging: {
    level: process.env.LOG_LEVEL || 'info',
    auditRetentionDays: toInt(process.env.AUDIT_RETENTION_DAYS, 90),
    // v3.0.8: アクセスログファイル (access-log.js が日次ローテーション、dir 700 / file 600)
    logDir: process.env.LOG_DIR ? path.join(process.cwd(), process.env.LOG_DIR) : path.join(process.cwd(), 'data', 'logs'),
  },

  security: {
    bcryptSaltRounds: toInt(process.env.BCRYPT_SALT_ROUNDS, 10),
  },

  socket: {
    corsOrigins: (process.env.SOCKET_CORS_ORIGINS || process.env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // 8. メール接続設定の初期値 (IMAP / SMTP)
  //    実値は .env 秘匿情報として保存し GitHub にはコミットしない。
  //    未設定ユーザーのフォームプリフィル、保存時未入力時のフォールバックに使用する。
  mail: {
    // 2026/11/8 監査 Critical 対策: mail_accounts の AES-256-GCM キーは
    // JWT_SECRET から導出せず、専用 MAIL_ENC_SECRET（scrypt 導出）で分離する。
    encSecret: mailEncSecret,
    imapHost: process.env.MAIL_IMAP_HOST || null,
    imapPort: toInt(process.env.MAIL_IMAP_PORT, null),
    smtpHost: process.env.MAIL_SMTP_HOST || null,
    smtpPort: toInt(process.env.MAIL_SMTP_PORT, null),
    // 暗号化モードの初期値 (none = 暗号化なし / starttls / tls = TLS 直結)
    // 既定は 'none'（TLS を使用しない）。実値は .env 秘匿情報で Git にコミットしない。
    imapTls: normalizeTlsMode(process.env.MAIL_IMAP_TLS, 'none'),
    smtpTls: normalizeTlsMode(process.env.MAIL_SMTP_TLS, 'none'),
    // 受信フォルダと送信済みフォルダの初期値 (IMAP フォルダ名)
    inboxFolder: process.env.MAIL_INBOX_FOLDER || 'INBOX',
    sentFolder: process.env.MAIL_SENT_FOLDER || 'Sent',
    // 差出人名の初期値 (SMTP 送信時の表示名)
    displayName: process.env.MAIL_DISPLAY_NAME || '',
    // 接続テスト・送受信のタイムアウト (既定 12 秒)
    timeoutMs: toInt(process.env.MAIL_TIMEOUT_MS, 12000),
  },

  // キャッシュ・運用制限 (仕様書 v2.1.0 準拠)
  cache: {
    newsTtlMs: toInt(process.env.NEWS_CACHE_TTL_MS, 3600000),
    weatherTtlMs: toInt(process.env.WEATHER_CACHE_TTL_MS, 3600000),
  },

  limits: {
    // 3分無操作編集ロックの自動解放閾値
    editingLockTimeoutSeconds: toInt(process.env.EDITING_LOCK_TIMEOUT_SECONDS, 180),
    auditRetentionDays: toInt(process.env.AUDIT_RETENTION_DAYS, 90),
  },

  // 7. ストレージ & ファイルアップロード設定 (upload.service.js が参照: uploadDir / maxFileSize)
  storage: {
    uploadDir: process.env.UPLOAD_DIR || path.join(process.cwd(), 'data', 'uploads'),
    maxFileSize: toInt(process.env.MAX_FILE_SIZE, 10485760), // 10MB
  },

  // 8. 安全通信（プライベートCA / HTTPS・WSS）
  //    - HTTPS/WSS: SSL_PORT（既定 3443）。サーバー証明書はプライベートCAで署名
  //    - 非HTTP(PORT 既定 3000): CAダウンロードページを表示し API は 426 で拒否
  ssl: {
    httpsPort: toInt(process.env.SSL_PORT, 3443),
    insecurePort: toInt(process.env.HTTP_PORT, toInt(process.env.PORT, 3000)),
    // 安全サーバーの監視ホスト（0.0.0.0 = 全インターフェース）
    host: process.env.SSL_HOST || '0.0.0.0',
    // 非HTTPのCAページから「安全接続で開く」ボタンを作るURL基点（未設定なら https://host:port/）
    caPageBase: process.env.SSL_CA_PAGE_BASE || null,
    dir: process.env.SSL_DIR || 'certs',
    key: process.env.SSL_KEY || 'certs/server.key',
    cert: process.env.SSL_CERT || 'certs/server.pem',
    ca: process.env.SSL_CA || 'certs/issystem-ca.crt',
    hosts: (process.env.SSL_HOSTS || 'localhost,issystem.local,issystem,127.0.0.1,::1')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

// モデル層は config/database.js の共有 pg プール（PostgreSQL）を使用する
if (config.db.type !== 'postgres') {
  console.warn(
    `[Config Warning] DB_TYPE='${config.db.type}' は PostgreSQL 以外の指定です。` +
    '全モデルは config/database.js 経由で PostgreSQL に接続します。DB_TYPE=postgres を設定してください。'
  );
}

export default config;
export { config, MAIL_TLS_MODES };
