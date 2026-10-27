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
const poolConfig = dbConfig.pool || {};

const pool = new Pool({
  host: dbConfig.host,
  port: dbConfig.port,
  user: dbConfig.user,
  password: dbConfig.password,
  // config.db.name 相当 (DB_NAME) を pg の接続先として使用する
  database: dbConfig.database || dbConfig.name,
  max: poolConfig.max ?? dbConfig.maxConnections ?? 20,
  min: poolConfig.min ?? 0,
  idleTimeoutMillis: poolConfig.idleTimeoutMillis ?? 30000,
  connectionTimeoutMillis: poolConfig.connectionTimeoutMillis ?? 10000,
  application_name: 'issystem',
  ssl: dbConfig.ssl ? { rejectUnauthorized: false } : undefined,
});

pool.on('error', (err) => {
  console.error('❌ 共有プール内の未処理クライアントエラー:', err.message);
});

/**
 * SQLite スタイルの ? プレースホルダを PostgreSQL の $n に変換する
 * ※ 文字列リテラル内の ? は変換しない。既に $n 形式の SQL はそのまま通過させる
 * @param {string} sql
 */
function normalizePlaceholders(sql) {
  const str = String(sql);
  let out = '';
  let paramIndex = 0;
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];

    if (inSingle) {
      out += ch;
      if (ch === "'") inSingle = false;
      continue;
    }
    if (inDouble) {
      out += ch;
      if (ch === '"') inDouble = false;
      continue;
    }
    if (ch === "'") {
      inSingle = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inDouble = true;
      out += ch;
      continue;
    }
    if (ch === '$') {
      // 既存の $n を追跡し、次採番は $max+1 から行う (? と $n の混在は採番崩れを防ぐ)
      const match = str.slice(i).match(/^\$(\d+)/);
      if (match) paramIndex = Math.max(paramIndex, parseInt(match[1], 10));
      out += ch;
      continue;
    }
    if (ch === '?') {
      paramIndex += 1;
      out += `$${paramIndex}`;
      continue;
    }

    out += ch;
  }

  return out;
}

/**
 * クエリヘルパー (PostgreSQL $1, $2.. プレースホルダ。 ? 表記も許容)
 */
const query = (text, params) => pool.query(normalizePlaceholders(text), params);

/**
 * 排他処理用のクライアント取得 (トランザクション)
 */
const getClient = () => pool.connect();

/**
 * モデル層用の SQLite 互換アダプタ (get / all / run / query / exec / close)
 * 共有プール上で SQLite と同じ API を提供し、close() は no-op とする
 * @param {import('pg').Pool | import('pg').Client} client
 */
function createDbAdapter(client = pool) {
  const runQuery = (sql, params = []) => client.query(normalizePlaceholders(sql), params);

  return {
    async get(sql, params = []) {
      const res = await runQuery(sql, params);
      return res.rows[0] || null;
    },

    async all(sql, params = []) {
      const res = await runQuery(sql, params);
      return res.rows;
    },

    async run(sql, params = []) {
      const res = await runQuery(sql, params);
      return { changes: res.rowCount, rowCount: res.rowCount, rows: res.rows };
    },

    async query(sql, params = []) {
      return runQuery(sql, params);
    },

    async exec(sql) {
      await client.query(sql);
    },

    async transaction(handler) {
      return withTransaction(handler);
    },

    // 共有プールを借用するのみ → 実.Close は行わない (no-op)
    async close() {
      return null;
    },

    pool,
  };
}

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
 * モデル層用接続アダプタ (共有プールを借用)。close() は no-op
 * ※ 冪等スキーマ (db/schema.sql) を初回アクセス時に適用する
 */
async function getDb() {
  if (dbConfig.autoInitSchema && !schemaApplied) {
    await ensureSchema();
  }
  return createDbAdapter(pool);
}

/**
 * サーバー終了時のプールクローズ (複数回呼び出し-safe)
 */
let poolClosingPromise = null;

async function closeDatabase() {
  if (!poolClosingPromise) poolClosingPromise = pool.end();
  await poolClosingPromise;
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

export {
  pool,
  query,
  getClient,
  withTransaction,
  ensureSchema,
  initializeDatabase,
  getDb,
  createDbAdapter,
  closeDatabase,
  normalizePlaceholders,
};
export default pool;
