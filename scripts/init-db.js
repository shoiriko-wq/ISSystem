/**
 * データベース初期化スクリプト (scripts/init-db.js)
 * db/schema.sql を読み込み、PostgreSQL (config/database.js 準拠) へ最新構造を適用します
 */

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { pool } from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// パス定義 (接続設定は config/database.js の .env 準拠 / PostgreSQL)
const schemaPath = path.resolve(__dirname, '../db/schema.sql');

async function setupDatabase() {
  console.log('🔄 データベースの一括セットアップを開始します...');
  const target = `${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'is_system'}`;
  console.log(`📁 出力DB: ${target}`);
  console.log(`📜 スキーマ: ${schemaPath}`);

  try {
    // 1. schema.sql の存在確認と読み込み
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`schema.sql が見つかりません: ${schemaPath}`);
    }
    const sqlScript = fs.readFileSync(schemaPath, 'utf-8');

    // 2. 接続検証 (config/database.js の共有プールを使用)
    const client = await pool.connect();
    const connInfo = await client.query('SELECT current_database() AS db, version() AS v');
    console.log(`🔗 接続先: ${connInfo.rows[0].db} (${connInfo.rows[0].v.split(' ')[1]})`);
    client.release();

    // 3. 最新スキーマの一括適用 (CREATE TABLE IF NOT EXISTS 準拠のため既存データは保持)
    await pool.query(sqlScript);

    // 4. 適用結果の検証
    const tablesRes = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' ORDER BY table_name`
    );
    const names = tablesRes.rows.map((r) => r.table_name);
    console.log(`🧱 適用テーブル (${names.length}): ${names.join(', ')}`);

    if (!names.includes('users')) {
      throw new Error('users テーブルが存在しません。schema.sql を確認してください。');
    }

    console.log('🎉 データベースの初期化（PostgreSQL スキーマ適用）が正常に完了しました！');

  } catch (err) {
    console.error('❌ データベース初期化エラー:', err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

setupDatabase();