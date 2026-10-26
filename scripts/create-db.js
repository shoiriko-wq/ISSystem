/**
 * データベースそのものの作成 (CREATE DATABASE)
 * .env の DB_NAME を対象に、テンプレート DB (postgres) へ接続して作成する
 */

import { Pool } from 'pg';
import config from '../config/default.js';

const { host, port, user, password, database } = config.db;

const admin = new Pool({
  host,
  port,
  user,
  password,
  database: 'postgres',
  connectionTimeoutMillis: 5000,
});

try {
  const exists = await admin.query('SELECT datname FROM pg_database WHERE datname = $1', [database]);

  if (exists.rows.length > 0) {
    console.log(`✅ データベース "${database}" は既に存在します。`);
  } else {
    // CREATE DATABASE はパラメータバインド不可のため識別子を安全に検証する
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(database)) {
      throw new Error(`安全でないデータベース名: ${database}`);
    }
    await admin.query(`CREATE DATABASE "${database}"`);
    console.log(`🎉 データベース "${database}" を作成しました。`);
  }
} catch (err) {
  console.error('❌ データベース作成エラー:', err.message);
  process.exitCode = 1;
} finally {
  await admin.end();
}
