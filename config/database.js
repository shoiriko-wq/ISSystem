/**
 * ISSystem Database Connection (PostgreSQL / node-pg)
 * config/default.js の設定を唯一の接続定義とする単一構成 (SQLite 依存は完全撤廃)
 */

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './default.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dbConfig = config.db;

const pool = new Pool({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  database: dbConfig.database,
  max: dbConfig.pool.max,
  min: dbConfig.pool.min,
  idleTimeoutMillis: dbConfig.pool.idleTimeoutMillis,
  connectionTimeoutMillis: dbConfig.pool.connectionTimeoutMillis,
  ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  console.error('❌ 共有プール内の未処理クライアントエラー:', err.message);
});

/**
 * クエリヘルパー (PostgreSQL $1, $2.. プレースホルダ)
 */
const query = (text, params) => pool.query(text, params);

/**
 * 排他処理用のクライアント取得 (トランザクション)
 */
const getClient = () => pool.connect();

/**
 * トランザクションヘルパー
 * @param {(client: import('pg').Client) => Promise<any>} handler
 */
async function withTransaction(handler) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// --- 冪等スキーマ自動適用 (db/schema.sql) ---
let schemaApplied = false;
let schemaPromise = null;

/**
 * ';' 区切りでステートメント単位に分割 (コメントのみのチャンクは除去)
 * ※ 複数ステートメントを 1 クエリで送ると Postgres 内部カタログ (pg_type) が競合するため単位実行する
 */
function splitStatements(sqlScript) {
  return sqlScript
    .split(';')
    .map((chunk) => chunk.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
    .filter((chunk) => chunk.length > 0);
}

async function ensureSchema() {
  if (schemaApplied) return true;
  // 同時実行 (import 時自動適用 + 明示的 initialize/seed) は 1 回の適用に共有する
  if (schemaPromise) return schemaPromise;

  schemaPromise = (async () => {
    const schemaPath = path.resolve(__dirname, '..', dbConfig.schemaPath);
    if (!fs.existsSync(schemaPath)) {
      console.warn(`⚠️ schema.sql が見つかりません: ${schemaPath}`);
      return false;
    }

    const statements = splitStatements(fs.readFileSync(schemaPath, 'utf-8'));
    const failures = [];

    for (const stmt of statements) {
      try {
        await pool.query(stmt);
      } catch (err) {
        failures.push(`${stmt.substring(0, 48)}... => ${err.message}`);
      }
    }

    if (failures.length > 0) {
      console.warn(`⚠️ スキーマ適用に ${failures.length} 件の問題:`);
      failures.forEach((f) => console.warn(`  - ${f}`));
      return false;
    }

    schemaApplied = true;
    console.log(`🧱 PostgreSQL スキーマを適用しました (${statements.length} ステートメント / ${schemaPath})`);
    return true;
  })().finally(() => {
    schemaPromise = null;
  });

  return schemaPromise;
}

if (dbConfig.autoInitSchema) {
  ensureSchema().then((applied) => {
    if (!applied) {
      console.log('[Database] データベースに接続できません。npm run db:init を実行してください。');
    }
  });
}

/**
 * サーバー起動時のデータベース初期化 (スキーマ適用 + 接続確認)
 */
async function initializeDatabase() {
  const applied = await ensureSchema();
  const client = await pool.connect();
  const info = await client.query('SELECT current_database() AS db, version() AS v');
  client.release();
  console.log(`🔗 データベース接続確認: ${info.rows[0].db} (${info.rows[0].v.split(' ')[1]})`);
  return applied;
}

export { pool, query, getClient, withTransaction, ensureSchema, initializeDatabase };
export default pool;
