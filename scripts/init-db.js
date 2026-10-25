/**
 * データベース初期化スクリプト (scripts/init-db.js) — PostgreSQL 版
 * db/schema.sql を読み込み、常に最新構造へクリーンリビルドします
 */

import { Client } from 'pg';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import config from '../config/default.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// パス定義 (PostgreSQL クラスタ内の issystem DB および db/schema.sql)
const schemaPath = path.resolve(__dirname, '../db/schema.sql');
const dbCfg = config.db;

// SQL 識別子を安全にダブルクォートでエスケープする
function quoteIdent(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

async function ensureDatabaseExists() {
  const admin = new Client({
    user: dbCfg.user,
    password: dbCfg.password,
    host: dbCfg.host,
    port: dbCfg.port,
    database: 'postgres',
    application_name: 'issystem-init-db',
  });

  await admin.connect();
  try {
    const found = await admin.query('SELECT 1 AS ok FROM pg_database WHERE datname = $1', [dbCfg.name]);
    if (found.rowCount === 0) {
      // データベース名は識別子なので quoteIdent で埋め込む
      await admin.query(`CREATE DATABASE ${quoteIdent(dbCfg.name)} TEMPLATE template0 ENCODING 'UTF8'`);
      console.log(`🧱 PostgreSQL データベース "${dbCfg.name}" を新規作成しました。`);
    } else {
      console.log(`✅ 既存の PostgreSQL データベース "${dbCfg.name}" を利用します。`);
    }

    // タイムゾーン設定（日本標準時）
    await admin.query(`ALTER DATABASE ${quoteIdent(dbCfg.name)} SET TIME ZONE 'Asia/Tokyo'`);
  } finally {
    await admin.end();
  }
}

async function setupDatabase() {
  console.log('🔄 データベースの一括セットアップを開始します...');
  console.log(`📦 接続先: postgresql://${dbCfg.host}:${dbCfg.port}/${dbCfg.name}`);
  console.log(`📜 スキーマ: ${schemaPath}`);

  const client = new Client({
    user: dbCfg.user,
    password: dbCfg.password,
    host: dbCfg.host,
    port: dbCfg.port,
    database: dbCfg.name,
    application_name: 'issystem-init-db',
  });

  try {
    // 1. schema.sql の存在確認と読み込み
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`schema.sql が見つかりません: ${schemaPath}`);
    }
    const sqlScript = fs.readFileSync(schemaPath, 'utf-8');

    // 2. データベース自体が存在しなければ作成
    await ensureDatabaseExists();

    // 3. 対象データベースへ接続
    await client.connect();
    await client.query("SET TIME ZONE 'Asia/Tokyo'");

    // 4. 最新スキーマの一括実行（外部キー制約は PostgreSQL では常に有効）
    await client.query(sqlScript);

    const tableCount = await client.query(
      `SELECT count(*) AS cnt FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    );
    console.log(`🎉 データベースの初期化＆データ投入が正常に完了しました！（public スキーマのテーブル数: ${tableCount.rows[0].cnt}）`);

  } catch (err) {
    console.error('❌ データベース初期化エラー:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

setupDatabase();
