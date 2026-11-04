// 対象カラムの実際の型・デフォルト・データ分布を確認するスクリプト
import { Client } from 'pg';
import config from '../config/default.js';

const dbCfg = config.db;
const client = new Client({
  user: dbCfg.user,
  password: dbCfg.password,
  host: dbCfg.host,
  port: dbCfg.port,
  database: dbCfg.database || dbCfg.name,
  application_name: 'issystem-probe-types',
});

await client.connect();

const probes = [
  { table: 'posts', column: 'is_deleted' },
  { table: 'reservations', column: 'is_cancelled' },
  { table: 'chat_messages', column: 'is_cancelled' },
];

for (const p of probes) {
  const typeInfo = await client.query(
    `SELECT data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema='public' AND table_name=$1 AND column_name=$2`,
    [p.table, p.column]
  );
  const rows = await client.query(
    `SELECT ${p.column} AS val, pg_typeof(${p.column}) AS t, count(*) AS n
     FROM ${p.table} GROUP BY 1, 2 ORDER BY 1`
  );
  console.log(`PROBE ${p.table}.${p.column} type=${typeInfo.rows[0]?.data_type} null=${typeInfo.rows[0]?.is_nullable} default=${typeInfo.rows[0]?.column_default ?? ''}`);
  for (const r of rows.rows) {
    console.log(`  data val=${r.val} pgtype=${r.t} count=${r.n}`);
  }
}

// COALESCE(boolean,0) が実際に失敗するか検証
try {
  const r = await client.query('SELECT COALESCE(is_deleted, 0) = 0 AS ok FROM posts LIMIT 1');
  console.log(`COALESCE posts.is_deleted ok=${r.rows[0]?.ok}`);
} catch (err) {
  console.log(`COALESCE posts.is_deleted FAIL => ${err.message}`);
}
try {
  const r = await client.query('SELECT COALESCE(is_cancelled, 0) = 0 AS ok FROM reservations LIMIT 1');
  console.log(`COALESCE reservations.is_cancelled ok=${r.rows[0]?.ok}`);
} catch (err) {
  console.log(`COALESCE reservations.is_cancelled FAIL => ${err.message}`);
}

await client.end();