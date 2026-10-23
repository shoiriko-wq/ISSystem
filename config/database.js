/**
 * ISSystem Database Configuration & Initialization
 * PostgreSQL 接続プール (pg) を全モデル・スクリプトで共有
 */

import pg from 'pg';
import 'dotenv/config';

const { Pool } = pg;

// 環境変数からの接続設定 (.env 対応)
const DB_PASSWORD = process.env.DB_PASSWORD;
if (!DB_PASSWORD) {
  throw new Error(
    '[Database] DB_PASSWORD が設定されていません。' +
    ' プロジェクトの .env ファイルに有効なパスワードを設定してください。' +
    ' 例: DB_PASSWORD=your_password'
  );
}

const PG_CONFIG = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'is_system',
  user: process.env.DB_USER || 'postgres',
  password: DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

// 単一インスタンスの接続プールを全プロセス内で共有
const pool = new Pool(PG_CONFIG);

/**
 * モデル層から使用される共通 SQL クエリ実行ヘルパー
 * pg の Result (res.rows / res.rowCount) をそのまま返す
 */
export async function query(sqlText, params = []) {
  const result = await pool.query(sqlText, params || []);
  return result;
}

/**
 * サーバー起動時の接続検証
 */
export async function initializeDatabase() {
  const client = await pool.connect();
  try {
    const res = await client.query('SELECT NOW() AS now');
    console.log(`[Database] PostgreSQL 接続完了: ${PG_CONFIG.host}:${PG_CONFIG.port}/${PG_CONFIG.database} (server now=${res.rows[0].now})`);
  } finally {
    client.release();
  }
  return pool;
}

export { pool };

export default {
  pool,
  query,
  initializeDatabase,
  PG_CONFIG,
};
