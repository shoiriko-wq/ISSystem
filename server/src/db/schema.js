// src/db/schema.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// data ディレクトリのパスを指定
const dataDir = path.join(__dirname, '../../data');

// data ディレクトリが存在しない場合は自動作成
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// server/data/database.db に保存するように設定
const dbPath = path.join(dataDir, 'database.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');

function initDatabase() {
  // 1. 教室マスターテーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS classrooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      capacity INTEGER DEFAULT 0,
      note TEXT
    );
  `);

  // 2. 教室予約テーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS classroom_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      classroom_id INTEGER NOT NULL,
      title TEXT NOT NULL,         -- 目的・行事名など
      teacher_name TEXT NOT NULL,  -- 予約者名
      start_time TEXT NOT NULL,    -- ISO8601形式 (例: '2026-10-01T09:00:00')
      end_time TEXT NOT NULL,
      equipment TEXT,              -- 使用備品・メモ
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (classroom_id) REFERENCES classrooms (id) ON DELETE CASCADE
    );
  `);

  // 3. 体育館使用団体テーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS gym_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category TEXT DEFAULT '部活動',
      contact_person TEXT DEFAULT '',
      note TEXT DEFAULT '',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 4. 体育館予約テーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS gym_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,            -- 使用団体ID（部活など）
      area TEXT NOT NULL,          -- '全面', 'A面', 'B面', 'ステージ側', '入口側' など
      purpose TEXT NOT NULL,       -- 利用目的
      teacher_name TEXT,           -- 予約者・担当者名
      start_time TEXT NOT NULL,    -- ISO8601形式
      end_time TEXT NOT NULL,
      note TEXT,                   -- 備考・使用機材
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES gym_groups (id) ON DELETE SET NULL
    );
  `);

  // 5. 学級・座席設定テーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS seating_layouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_name TEXT NOT NULL UNIQUE, -- 授業名（例: '1年 情報Ⅰ'）
      row_config TEXT NOT NULL,         -- 配置パターン（例: '677776'）
      alignment TEXT DEFAULT 'back',    -- 'back' または 'front'
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 6. 生徒情報テーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class_name TEXT NOT NULL,
      student_number INTEGER NOT NULL, -- 出席番号
      name TEXT NOT NULL,             -- 氏名
      kana TEXT,                      -- ふりがな
      gender TEXT,                    -- 性別
      seat_number INTEGER,            -- 現在の席番号（1〜）
      note TEXT                       -- 配慮事項など（前方希望等）
    );
  `);

  console.log('Database tables initialized successfully.');
}

module.exports = { db, initDatabase };