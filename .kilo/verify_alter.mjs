// 型統一マイグレーション (boolean → integer) を pg.Client で直接実行し、エラーと結果型を検証するスクリプト
import { Client } from 'pg';
import config from '../config/default.js';

const dbCfg = config.db;
const client = new Client({
  user: dbCfg.user,
  password: dbCfg.password,
  host: dbCfg.host,
  port: dbCfg.port,
  database: dbCfg.database || dbCfg.name,
  application_name: 'issystem-verify-alter',
});

const statements = [
  'DROP INDEX IF EXISTS idx_posts_deleted',
  'ALTER TABLE posts ALTER COLUMN is_deleted DROP DEFAULT',
  'ALTER TABLE posts ALTER COLUMN is_deleted TYPE integer USING (CASE WHEN is_deleted::text = \'true\' THEN 1 ELSE 0 END)',
  'ALTER TABLE posts ALTER COLUMN is_deleted SET DEFAULT 0',
  'CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts(is_deleted)',
  'DROP INDEX IF EXISTS idx_res_cancelled',
  'ALTER TABLE reservations ALTER COLUMN is_cancelled DROP DEFAULT',
  'ALTER TABLE reservations ALTER COLUMN is_cancelled TYPE integer USING (CASE WHEN is_cancelled::text = \'true\' THEN 1 WHEN is_cancelled::text = \'false\' THEN 0 WHEN is_cancelled::text = \'1\' THEN 1 WHEN is_cancelled::text = \'0\' THEN 0 ELSE NULL END)',
  'ALTER TABLE reservations ALTER COLUMN is_cancelled SET DEFAULT 0',
  'CREATE INDEX IF NOT EXISTS idx_res_cancelled ON reservations(is_cancelled)',
];

await client.connect();
for (const stmt of statements) {
  try {
    await client.query(stmt);
    console.log(`OK   ${stmt}`);
  } catch (err) {
    console.log(`FAIL ${stmt} => ${err.message}`);
  }
}

const types = await client.query(
  `SELECT table_name, column_name, data_type, is_nullable, column_default
   FROM information_schema.columns
   WHERE table_schema = 'public' AND column_name IN ('is_deleted','is_cancelled')
   ORDER BY table_name, column_name`
);
for (const r of types.rows) {
  console.log(`TYPE ${r.table_name}.${r.column_name} = ${r.data_type} null=${r.is_nullable} default=${r.column_default ?? ''}`);
}

const idx = await client.query(
  `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('idx_posts_deleted','idx_res_cancelled') ORDER BY indexname`
);
for (const r of idx.rows) {
  console.log(`INDEX ${r.indexname} ${r.indexdef}`);
}

await client.end();