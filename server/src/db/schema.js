const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '../../data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'database.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

function ensureColumnExists(tableName, columnName, columnDefinition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  const exists = columns.some(col => col.name === columnName);
  if (!exists) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}

function initDatabase() {
  // 1. 教室マスター
  db.exec(`
    CREATE TABLE IF NOT EXISTS classrooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      capacity INTEGER DEFAULT 0,
      note TEXT
    );
  `);

  // 2. 教室予約
  db.exec(`
    CREATE TABLE IF NOT EXISTS classroom_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      classroom_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      teacher_name TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      equipment TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (classroom_id) REFERENCES classrooms (id) ON DELETE CASCADE
    );
  `);

  // 3. 体育館使用団体
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

  // 4. 体育館予約
  db.exec(`
    CREATE TABLE IF NOT EXISTS gym_reservations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER,
      area TEXT NOT NULL,
      purpose TEXT NOT NULL,
      teacher_name TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (group_id) REFERENCES gym_groups (id) ON DELETE SET NULL
    );
  `);

  // 5. クラス（講座）マスター
  db.exec(`
    CREATE TABLE IF NOT EXISTS classes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
  `);

  // 6. 座席レイアウト設定（alignment を追加）
  db.exec(`
    CREATE TABLE IF NOT EXISTS seating_layouts (
      class_id INTEGER PRIMARY KEY,
      layout_type TEXT DEFAULT 'custom_columns',
      column_counts TEXT DEFAULT '[6,7,7,7,7,6]', -- 各列の席数
      max_rows INTEGER DEFAULT 7,                  -- 最大行数（グリッド高さ）
      alignment TEXT DEFAULT 'back',               -- 'back'(後ろ詰め) または 'front'(前詰め)
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE CASCADE
    );
  `);

  // 7. 生徒マスタ（ID、氏名、ふりがな、性別、部活動、選択科目のみ）
  db.exec(`
    CREATE TABLE IF NOT EXISTS students (
      id TEXT PRIMARY KEY,          -- 生徒ID
      name TEXT NOT NULL,          -- 氏名
      kana TEXT DEFAULT '',        -- ふりがな
      gender TEXT DEFAULT '未設定', -- 性別
      club TEXT DEFAULT '',        -- 部活動名
      subject_option TEXT DEFAULT ''-- 選択科目
    );
  `);

  // 8. クラス・生徒所属テーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS class_students (
      class_id INTEGER NOT NULL,
      student_id TEXT NOT NULL,
      PRIMARY KEY (class_id, student_id),
      FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
    );
  `);

  // 9. 座席配置割り当てテーブル
  db.exec(`
    CREATE TABLE IF NOT EXISTS seat_assignments (
      class_id INTEGER NOT NULL,
      seat_id TEXT NOT NULL,       -- 例: 'r1_c1'
      student_id TEXT NOT NULL,
      PRIMARY KEY (class_id, seat_id),
      FOREIGN KEY (class_id) REFERENCES classes (id) ON DELETE CASCADE,
      FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE CASCADE
    );
  `);

  // 既存DBに後から追加されたカラムの保証（安全性確保）
  ensureColumnExists('seating_layouts', 'alignment', "TEXT DEFAULT 'back'");
  ensureColumnExists('seating_layouts', 'max_rows', "INTEGER DEFAULT 7");
  ensureColumnExists('students', 'club', "TEXT DEFAULT ''");
  ensureColumnExists('students', 'subject_option', "TEXT DEFAULT ''");

  console.log('Database tables initialized successfully.');
}

module.exports = { db, initDatabase };