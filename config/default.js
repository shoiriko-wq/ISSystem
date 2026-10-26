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

  // データベース接続設定 (PostgreSQL のみ)
  db: {
    type: 'postgres',
    host: process.env.DB_HOST || 'localhost',
    port: toInt(process.env.DB_PORT, 5432),
    database: process.env.DB_NAME || 'issystem',
    user: process.env.PG_USER || process.env.DB_USER || 'postgres',
    password: process.env.PG_PASSWORD || process.env.DB_PASSWORD || 'postgres',
    ssl: process.env.PG_SSL === 'require' || process.env.DB_SSL === 'true',
    pool: {
      max: toInt(process.env.DB_POOL_SIZE, 10),
      min: toInt(process.env.DB_POOL_MIN, 2),
      idleTimeoutMillis: toInt(process.env.DB_IDLE_TIMEOUT_MS, 30000),
      connectionTimeoutMillis: toInt(process.env.DB_CONNECTION_TIMEOUT_MS, 5000),
    },
    schemaPath: process.env.DB_SCHEMA_PATH || 'db/schema.sql',
    autoInitSchema: process.env.DB_AUTO_INIT !== 'false',
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

export default config;
export { config };
