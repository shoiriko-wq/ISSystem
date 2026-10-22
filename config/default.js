/**
 * ISSystem Configuration Module
 * システムデフォルト設定および環境変数の統合ロード
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  // 1. サーバー基本設定
  server: {
    env: process.env.NODE_ENV || 'development',
    port: parseInt(process.env.PORT || '3000', 10),
    host: process.env.HOST || '0.0.0.0',
    corsOrigin: process.env.CORS_ORIGIN || '*',
  },

  // 2. 認証・セキュリティ設定
  auth: {
    jwtSecret: process.env.JWT_SECRET || 'is_system_secret_key_2026_default_jwt',
    jwtExpiresIn: process.env.JWT_EXPIRES_IN || '24h',
    bcryptSaltRounds: parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10),
    invitationCodeExpiryHours: 24,
  },

  // 3. データベース接続設定 (PostgreSQL / SQLite / MongoDB 柔軟対応)
  db: {
    type: process.env.DB_TYPE || 'sqlite', // 'postgres' | 'mongodb' | 'sqlite'
    uri: process.env.DATABASE_URL || 'file:./data/is_system.db',
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    name: process.env.DB_NAME || 'issystem',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 'password',
    maxConnections: parseInt(process.env.DB_MAX_CONN || '20', 10),
  },

  // 4. リアルタイム通信 & 排他制御設定
  realtime: {
    lockTimeoutMs: parseInt(process.env.LOCK_TIMEOUT_MS || '180000', 10), // 3分間無操作で自動解放
    pingIntervalMs: 25000,
    pingTimeoutMs: 20000,
  },

  // 5. バックグラウンドタスク & 定期考査最適化設定
  optimizer: {
    maxTimeMs: parseInt(process.env.OPTIMIZER_MAX_TIME_MS || '10000', 10), // 最適化計算最大時間 (10秒)
    workerThreads: parseInt(process.env.WORKER_THREADS || '2', 10),
  },

  // 6. ストレージ & ファイルアップロード設定
  storage: {
    uploadDir: process.env.UPLOAD_DIR || path.join(__dirname, '../../data/uploads'),
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB
  },

  // 7. ログ設定
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    auditLogRetentionDays: 90,
  }
};

export default config;