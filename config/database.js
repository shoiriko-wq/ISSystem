/**
 * ISSystem Database Configuration & Initialization
 * 仕様書準拠: 単一 SQLite ファイル (database.sqlite) を全モデルで共有
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const DB_PATH = path.resolve(__dirname, '../database.sqlite');
const SCHEMA_PATH = path.resolve(__dirname, '../db/schema.sql');

let db = null;

export async function getDb() {
  if (!db) {
    db = await open({
      filename: DB_PATH,
      driver: sqlite3.Database,
    });
    await db.exec('PRAGMA journal_mode = WAL;');
    await db.exec('PRAGMA foreign_keys = ON;');
  }
  return db;
}

/**
 * モデル層から使用される共通 SQL クエリ実行ヘルパー
 * PostgreSQL 風の $1,$2 プレースホルダは SQLite の ? に変換する
 */
export async function query(sqlText, params = []) {
  const database = await getDb();
  const sqliteSql = String(sqlText).replace(/\$(\d+)/g, '?');
  const trimmedSql = sqliteSql.trim().toUpperCase();

  if (trimmedSql.startsWith('SELECT') || trimmedSql.startsWith('PRAGMA')) {
    const rows = await database.all(sqliteSql, params);
    return { rows };
  }

  const result = await database.run(sqliteSql, params);
  return {
    rows: [],
    rowCount: result.changes || 0,
    lastID: result.lastID,
    changes: result.changes || 0,
  };
}

export async function initializeDatabase() {
  const database = await getDb();

  if (fs.existsSync(SCHEMA_PATH)) {
    const sqlScript = fs.readFileSync(SCHEMA_PATH, 'utf-8');
    await database.exec(sqlScript);
  }

  console.log('[Database] database.sqlite のスキーマ検証が完了しました。');
  return database;
}

export default {
  getDb,
  query,
  initializeDatabase,
  DB_PATH,
};
