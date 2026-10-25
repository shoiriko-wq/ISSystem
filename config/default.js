/**
 * ISSystem Application Configuration
 * PostgreSQL 一本化 (仕様書 v2.1.0) - .env の環境変数から設定を構築
 */

import dotenv from 'dotenv';
// 既存の OS 環境変数 (DB_NAME=is_system 等) より .env を優先して上書きする
dotenv.config({ override: true, quiet: true });

const toInt = (value, fallback) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const config = {
  env: process.env.NODE_ENV || 'development',

  server: {
    port: toInt(process.env.PORT, 3000),
  },

  // 2. 認証・セキュリティ設定
  auth: {
    jwtSecret: process.env.JWT_SECRET || 'is_system_secret_key_2026_default_jwt',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10),
    invitationCodeExpiryHours: 24,
  },

  // 3. データベース接続設定 (PostgreSQL 18.6 / pg ライブラリ)
  db: {
    type: process.env.DB_TYPE || 'postgres', // 'postgres'
    uri: process.env.DATABASE_URL || 'postgresql://postgres:password@localhost:5432/issystem',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'issystem',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    maxConnections: parseInt(process.env.DB_MAX_CONN || '20', 10),
    timezone: process.env.DB_TIMEZONE || 'Asia/Tokyo',
  },

  // 4. リアルタイム通信 & 排他制御設定
  realtime: {
    lockTimeoutMs: parseInt(process.env.LOCK_TIMEOUT_MS || '180000', 10), // 3分間無操作で自動解放
    pingIntervalMs: 25000,
    pingTimeoutMs: 20000,
  },

  // JWT 認証設定 (auth.middleware.js / auth.service.js は config.auth.jwtSecret を参照する)
  auth: {
    jwtSecret: process.env.JWT_SECRET || 'dev-secret-key-change-in-production',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    bcryptSaltRounds: toInt(process.env.BCRYPT_SALT_ROUNDS, 10),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-secret-key-change-in-production',
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
};

// モデル層は config/database.js の共有 pg プール（PostgreSQL）を使用する
if (config.db.type !== 'postgres') {
  console.warn(
    `[Config Warning] DB_TYPE='${config.db.type}' は PostgreSQL 以外の指定です。` +
    '全モデルは config/database.js 経由で PostgreSQL に接続します。DB_TYPE=postgres を設定してください。'
  );
}

export default config;
export { config };
