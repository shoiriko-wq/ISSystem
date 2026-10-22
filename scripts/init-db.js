/**
 * データベース初期化スクリプト (scripts/init-db.js)
 * db/schema.sql を読み込み、常に最新構造へクリーンリビルドします
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// パス定義 (プロジェクト直下の database.sqlite および db/schema.sql)
const dbPath = path.resolve(__dirname, '../database.sqlite');
const schemaPath = path.resolve(__dirname, '../db/schema.sql');

async function setupDatabase() {
  console.log('🔄 データベースの一括セットアップを開始します...');
  console.log(`📁 出力DB: ${dbPath}`);
  console.log(`📜 スキーマ: ${schemaPath}`);

  try {
    // 1. schema.sql の存在確認と読み込み
    if (!fs.existsSync(schemaPath)) {
      throw new Error(`schema.sql が見つかりません: ${schemaPath}`);
    }
    const sqlScript = fs.readFileSync(schemaPath, 'utf-8');

    // 2. 既存の古くなった DB ファイルがあれば削除してクリーン化
    if (fs.existsSync(dbPath)) {
      fs.unlinkSync(dbPath);
      console.log('🧹 既存の旧データベースファイルを削除・リフレッシュしました。');
    }

    // 3. データベース新規接続 & スキーマ適用
    const db = await open({
      filename: dbPath,
      driver: sqlite3.Database
    });

    await db.run('PRAGMA foreign_keys = ON;');

    // 4. 最新スキーマの一括実行
    await db.exec(sqlScript);

    console.log('🎉 データベースの初期化＆データ投入が正常に完了しました！');
    await db.close();

  } catch (err) {
    console.error('❌ データベース初期化エラー:', err.message);
    process.exit(1);
  }
}

setupDatabase();