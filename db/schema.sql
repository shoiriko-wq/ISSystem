-- -------------------------------------------------------------
-- ISSystem データベース定義スキーマ (仕様書 v2.1.0 完全対応版)
-- -------------------------------------------------------------

PRAGMA foreign_keys = ON;

-- 1. 教職員アカウント (users)
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  staff_code TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'TEACHER',
  grade TEXT,
  department TEXT,
  extension_number TEXT,
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_users_role ON users(role);
CREATE INDEX IF NOT EXISTS idx_users_department ON users(department);

-- 2. 掲示板・回覧板投稿 (posts)
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  post_type TEXT NOT NULL DEFAULT 'NOTICE',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  author_id TEXT NOT NULL,
  target_scope TEXT DEFAULT '{"grade":"ALL","department":"ALL"}',
  attachments TEXT DEFAULT '[]',
  is_deleted INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_posts_type ON posts(post_type);
CREATE INDEX IF NOT EXISTS idx_posts_priority ON posts(priority);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id);
CREATE INDEX IF NOT EXISTS idx_posts_deleted ON posts(is_deleted);

-- 3. 回覧板承認・既読ログ (post_acknowledgements)
CREATE TABLE IF NOT EXISTS post_acknowledgements (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'UNREAD',
  comment TEXT,
  acknowledged_at DATETIME,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (post_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_ack_post_user ON post_acknowledgements(post_id, user_id);
CREATE INDEX IF NOT EXISTS idx_ack_user_status ON post_acknowledgements(user_id, status);

-- 4. 職員チャットチャンネル (chat_channels)
CREATE TABLE IF NOT EXISTS chat_channels (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'PUBLIC',
  members TEXT DEFAULT '[]',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_channels_type ON chat_channels(type);

-- 4b. チャンネル参加者 (実装互換用)
CREATE TABLE IF NOT EXISTS chat_channel_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  is_hidden INTEGER DEFAULT 0,
  joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (channel_id, user_id),
  FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 5. チャットメッセージ (chat_messages)
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  message TEXT NOT NULL,
  meta_data TEXT DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (channel_id) REFERENCES chat_channels(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_chat_channel_time ON chat_messages(channel_id, created_at DESC);

-- 6. 職員室リアルタイム座席・在席状態 (seating_status)
CREATE TABLE IF NOT EXISTS seating_status (
  id TEXT PRIMARY KEY,
  user_id TEXT UNIQUE NOT NULL,
  desk_number TEXT NOT NULL,
  group_zone TEXT NOT NULL DEFAULT 'staff',
  current_status TEXT NOT NULL DEFAULT 'PRESENT',
  status_note TEXT DEFAULT '',
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_seating_zone ON seating_status(group_zone);
CREATE INDEX IF NOT EXISTS idx_seating_status ON seating_status(current_status);

-- 7. 施設・備品マスター (resources)
CREATE TABLE IF NOT EXISTS resources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'ROOM'
);

-- 8. 施設・備品予約記録 (reservations)
CREATE TABLE IF NOT EXISTS reservations (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL,
  facility_id TEXT,
  user_id TEXT,
  user_name TEXT DEFAULT '教員',
  title TEXT NOT NULL,
  target_date TEXT,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  is_cancelled INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (resource_id) REFERENCES resources(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_res_target_date ON reservations(target_date);
CREATE INDEX IF NOT EXISTS idx_res_resource ON reservations(resource_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_res_cancelled ON reservations(is_cancelled);

-- 9. 校内スケジュール・年間行事
CREATE TABLE IF NOT EXISTS school_schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  event_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  category TEXT DEFAULT 'SCHOOL',
  target_grade INTEGER,
  created_by_user_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_schedule_event_date ON school_schedules(event_date);

-- 10. 簡易決裁・承認申請
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT DEFAULT 'PURCHASE',
  description TEXT,
  content TEXT,
  amount INTEGER DEFAULT 0,
  applicant_id TEXT,
  approver_id TEXT,
  status TEXT DEFAULT 'PENDING',
  comment TEXT,
  linked_chat_channel_id TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  approved_at DATETIME
);

-- 11. 招待コード
CREATE TABLE IF NOT EXISTS invitation_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  created_by_user_id TEXT,
  used_by_user_id TEXT,
  is_used INTEGER DEFAULT 0,
  expires_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 12. 排他編集ロック
CREATE TABLE IF NOT EXISTS editing_locks (
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (resource_type, resource_id)
);

-- 13. 監査ログ
CREATE TABLE IF NOT EXISTS system_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT,
  details TEXT,
  ip_address TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- -------------------------------------------------------------
-- 初期デモデータ (パスワードは bcrypt salt=10 / password123)
-- -------------------------------------------------------------
INSERT OR IGNORE INTO users (id, staff_code, name, email, password_hash, role, grade, department, extension_number)
VALUES
  ('kyomu01', 'T2026001', '教務 主任', 'kyomu@school.ed.jp', '$2b$10$UaPLuLuZtQ.5DG3P33kdl.iM0Rl140Ky9Gv8JWXomI8LiRUxA8SCC', 'KYOMU', 'NONE', '教務部', '101'),
  ('t-tanaka', 'T2026002', '田中 先生', 'tanaka@school.ed.jp', '$2b$10$UaPLuLuZtQ.5DG3P33kdl.iM0Rl140Ky9Gv8JWXomI8LiRUxA8SCC', 'TEACHER', '1', '生徒指導部', '102'),
  ('t-sato', 'T2026003', '佐藤 先生', 'sato@school.ed.jp', '$2b$10$UaPLuLuZtQ.5DG3P33kdl.iM0Rl140Ky9Gv8JWXomI8LiRUxA8SCC', 'TEACHER', '2', '進路指導部', '103');

INSERT OR IGNORE INTO chat_channels (id, name, type, members)
VALUES
  ('general', '📢 職員全体', 'PUBLIC', '["kyomu01","t-tanaka","t-sato"]'),
  ('grade1', '🏫 1年学年部', 'GROUP', '["t-tanaka"]'),
  ('kyomu', '📋 教務部連絡', 'GROUP', '["kyomu01"]');

INSERT OR IGNORE INTO chat_channel_members (channel_id, user_id, is_hidden)
VALUES
  ('general', 'kyomu01', 0),
  ('general', 't-tanaka', 0),
  ('general', 't-sato', 0),
  ('grade1', 't-tanaka', 0),
  ('kyomu', 'kyomu01', 0);

INSERT OR IGNORE INTO posts (id, title, content, post_type, priority, author_id, target_scope)
VALUES
  ('post_1', '【教務部】中間考査採点票の提出期限について', '中間考査の全科目採点票の最終締め切りは明後日17時です。未提出の教科はお早めにご提出ください。', 'CIRCULAR', 'URGENT', 'kyomu01', '{"grade":"ALL","department":"ALL"}'),
  ('post_2', '避難訓練の実施要項および各クラスの避難経路確認', '来週火曜日の6限に全校避難訓練を実施します。各担任の先生は事前に生徒へ非常口の周知を行ってください。', 'NOTICE', 'NORMAL', 't-tanaka', '{"grade":"ALL","department":"生徒指導部"}');

INSERT OR IGNORE INTO resources (id, name, category)
VALUES
  ('1', '第一会議室', 'ROOM'),
  ('2', '第二会議室', 'ROOM'),
  ('3', '体育館', 'ROOM'),
  ('4', 'プロジェクターA', 'EQUIPMENT'),
  ('5', '校外研修用マイクロバス', 'EQUIPMENT');

INSERT OR IGNORE INTO seating_status (id, user_id, desk_number, group_zone, current_status, status_note)
VALUES
  ('seat_1', 'kyomu01', 'A-01', 'admin', 'PRESENT', ''),
  ('seat_2', 't-tanaka', 'A-02', 'g1', 'CLASS', '2-A 英語'),
  ('seat_3', 't-sato', 'A-03', 'g2', 'PRESENT', '');

INSERT OR IGNORE INTO school_schedules (id, title, description, event_date, start_time, end_time, category, created_by_user_id)
VALUES
  ('sch_101', '中間考査（第1日）', '全学年対象 9:00開始', '2026-10-15', '09:00', '15:30', 'EXAM', 'kyomu01'),
  ('sch_102', '職員定例会議', '第一会議室 15:30〜', '2026-10-15', '15:30', '17:00', 'MEETING', 'kyomu01'),
  ('sch_103', '避難訓練', 'グラウンド避難', '2026-10-20', '14:25', '15:15', 'SCHOOL', 'kyomu01');
