-- -------------------------------------------------------------
-- ISSystem データベース定義スキーマ (仕様書 v2.1.0 完全対応版)
-- PostgreSQL 15+ 準拠 (scripts/init-db.js 経由で適用)
-- -------------------------------------------------------------

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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
  acknowledged_at TIMESTAMP,
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_channels_type ON chat_channels(type);

-- 4b. チャンネル参加者 (実装互換用)
CREATE TABLE IF NOT EXISTS chat_channel_members (
  channel_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  is_hidden INTEGER DEFAULT 0,
  joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
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
  is_cancelled BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (resource_id) REFERENCES resources(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_res_target_date ON reservations(target_date);
CREATE INDEX IF NOT EXISTS idx_res_resource ON reservations(resource_id, start_time, end_time);
CREATE INDEX IF NOT EXISTS idx_res_cancelled ON reservations(is_cancelled);

-- 9. 校内行事・スケジュール (school_schedules)
CREATE TABLE IF NOT EXISTS school_schedules (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  event_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  category TEXT NOT NULL DEFAULT 'EVENT',
  target_grade INTEGER,
  created_by_user_id TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_schedules_date ON school_schedules(event_date);
CREATE INDEX IF NOT EXISTS idx_schedules_grade ON school_schedules(target_grade);

