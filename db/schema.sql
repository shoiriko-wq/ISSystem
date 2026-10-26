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

-- 1b. 教務フラグと招待コード発行者 (後続マイグレーション対応)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_kyomu INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;

-- 1c. 自主分散招待コード (invitation_codes)
CREATE TABLE IF NOT EXISTS invitation_codes (
  id TEXT PRIMARY KEY,
  code TEXT UNIQUE NOT NULL,
  created_by_user_id TEXT NOT NULL,
  used_by_user_id TEXT,
  is_used INTEGER NOT NULL DEFAULT 0,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (used_by_user_id) REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_invitation_code ON invitation_codes(code);
CREATE INDEX IF NOT EXISTS idx_invitation_expires ON invitation_codes(expires_at);

-- 2. 掲示板・回覧板投稿 (posts)
CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  post_type TEXT NOT NULL DEFAULT 'NOTICE',
  priority TEXT NOT NULL DEFAULT 'NORMAL',
  author_id TEXT NOT NULL,
  target_scope JSONB NOT NULL DEFAULT '{"grade":"ALL","department":"ALL"}'::jsonb,
  attachments JSONB NOT NULL DEFAULT '[]'::jsonb,
  is_deleted BOOLEAN NOT NULL DEFAULT FALSE,
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
  members JSONB NOT NULL DEFAULT '[]'::jsonb,
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
  meta_data JSONB NOT NULL DEFAULT '{}'::jsonb,
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
  CHECK (end_time > start_time),
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

-- 10. 操作・監査ログ (audit_logs) ※ 90日保持 (cron Maintenance)
CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  old_value TEXT,
  new_value TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_audit_resource ON audit_logs(resource_type, resource_id);

-- 11. 編集排他ロック (editing_locks) ※ 1リソースに1ロック (UNIQUE), 3分無操作でcron自動解放
CREATE TABLE IF NOT EXISTS editing_locks (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  acquired_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_accessed TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (resource_type, resource_id)
);
CREATE INDEX IF NOT EXISTS idx_locks_resource ON editing_locks(resource_type, resource_id);

-- 12. 決裁・申請ワークフロー (approvals)
CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'PURCHASE',
  description TEXT,
  amount NUMERIC(12,2) DEFAULT 0,
  applicant_id TEXT,
  approver_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING',
  comment TEXT,
  linked_chat_channel_id TEXT,
  approved_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  FOREIGN KEY (applicant_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (approver_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (linked_chat_channel_id) REFERENCES chat_channels(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_applicant ON approvals(applicant_id);
CREATE INDEX IF NOT EXISTS idx_approvals_approver ON approvals(approver_id);
CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);

-- 12b. フィールドセル値 (facility_cells) ※ 編集ロックと連動
CREATE TABLE IF NOT EXISTS facility_cells (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  cell_id TEXT NOT NULL,
  cell_key TEXT NOT NULL,
  value TEXT,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  UNIQUE (cell_id, cell_key)
);
CREATE INDEX IF NOT EXISTS idx_facility_cells ON facility_cells(cell_id, cell_key);

-- 12c. 掲示・回覧板コメントスレッド (post_comments)
CREATE TABLE IF NOT EXISTS post_comments (
  id TEXT PRIMARY KEY,
  post_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT,
  comment_text TEXT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_post_comments_post ON post_comments(post_id, created_at);

-- 13. クラス・科目マスタ (考査マトリクス参照用)
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  grade SMALLINT NOT NULL,
  class_num SMALLINT NOT NULL
);
CREATE TABLE IF NOT EXISTS subjects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT
);

-- 14. 考査マスター (exam_masters)
CREATE TABLE IF NOT EXISTS exam_masters (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days_count SMALLINT NOT NULL DEFAULT 3,
  daily_slots SMALLINT NOT NULL DEFAULT 3,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 15. 考査コマスロット (exam_slots)
CREATE TABLE IF NOT EXISTS exam_slots (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  exam_master_id TEXT NOT NULL REFERENCES exam_masters(id) ON DELETE CASCADE,
  day_number SMALLINT NOT NULL,
  slot_number SMALLINT NOT NULL,
  class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  subject_id TEXT REFERENCES subjects(id) ON DELETE SET NULL,
  subject_teacher_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (exam_master_id, day_number, slot_number, class_id)
);
CREATE INDEX IF NOT EXISTS idx_exam_slots_master ON exam_slots(exam_master_id, day_number, slot_number);

-- 16. 試験監督割当 (exam_proctor_assignments)
CREATE TABLE IF NOT EXISTS exam_proctor_assignments (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  exam_master_id TEXT NOT NULL REFERENCES exam_masters(id) ON DELETE CASCADE,
  day_number SMALLINT NOT NULL,
  slot_number SMALLINT NOT NULL,
  class_id TEXT REFERENCES classes(id) ON DELETE SET NULL,
  proctor_teacher_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (exam_master_id, day_number, slot_number, class_id)
);
CREATE INDEX IF NOT EXISTS idx_exam_proctors_master ON exam_proctor_assignments(exam_master_id, day_number, slot_number);

-- 17. 監督除外・配慮教員 (exam_teacher_exemptions)
CREATE TABLE IF NOT EXISTS exam_teacher_exemptions (
  id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  exam_master_id TEXT NOT NULL REFERENCES exam_masters(id) ON DELETE CASCADE,
  teacher_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,
  UNIQUE (exam_master_id, teacher_id)
);

