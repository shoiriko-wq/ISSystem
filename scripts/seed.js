/**
 * ISSystem ダミーデータ一括挿入スクリプト (scripts/seed.js)
 * 仕様書 v2.1.0 完全連動版
 */

import bcrypt from 'bcrypt';
import { pool } from '../config/database.js';
import path from 'path';
import { fileURLToPath } from 'url';
// crypto/config は bcrypt 化に伴い不要


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// PostgreSQL 準拠のため database.sqlite は使用しない

async function hashPassword(password) {
  // bcrypt ハッシュ (Salt rounds = 10) を使用

  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

const BCRYPT_ROUNDS = 10;
/**
 * PostgreSQL 準拠アップサートヘルパー
 * SQLite の INSERT OR REPLACE 相当を $n プレースホルダ + ON CONFLICT (id) で実装
 */
async function upsert(client, table, columns, values) {
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
  const updates = columns.map((c) => `${c} = EXCLUDED.${c}`).join(', ');
  const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders}) ON CONFLICT (id) DO UPDATE SET ${updates}`;
  return client.query(sql, values);
}


const defaultPasswordHash = await hashPassword('password123');

// 1. 教職員ユーザー
const dummyUsers = [
  { id: 'kyomu01', staff_code: 'T2026001', name: '教務 主任', email: 'kyomu@school.ed.jp', password_hash: defaultPasswordHash, role: 'KYOMU', department: '教務部', extension_number: '101' },
  { id: 't-tanaka', staff_code: 'T2026002', name: '田中 先生', email: 'tanaka@school.ed.jp', password_hash: defaultPasswordHash, role: 'TEACHER', department: '生徒指導部', extension_number: '102' },
  { id: 't-sato', staff_code: 'T2026003', name: '佐藤 先生', email: 'sato@school.ed.jp', password_hash: defaultPasswordHash, role: 'TEACHER', department: 'キャリアガイダンス部', extension_number: '103' },
  { id: 't-suzuki', staff_code: 'T2026004', name: '鈴木 先生', email: 'suzuki@school.ed.jp', password_hash: defaultPasswordHash, role: 'TEACHER', department: '特色推進部', extension_number: '104' },
  { id: 't-takahashi', staff_code: 'T2026005', name: '高橋 先生', email: 'takahashi@school.ed.jp', password_hash: defaultPasswordHash, role: 'TEACHER', department: '１学年', extension_number: '105' }
];

// 2. 掲示板投稿
const dummyPosts = [
  { id: 'post_1', title: '【教務部】中間考査採点票の提出期限について', content: '中間考査の全科目採点票の最終締め切りは明後日17時です。未提出の教科・学年はお早めに教務部へご提出ください。', post_type: 'CIRCULAR', priority: 'URGENT', author_id: 'kyomu01', created_at: '2026-10-15 08:30:00' },
  { id: 'post_2', title: '避難訓練の実施要項および各クラスの避難経路確認', content: '来週火曜日の6限に全校避難訓練を実施します。各担任の先生は事前に生徒へ非常口および避難経路の周知を行ってください。', post_type: 'NOTICE', priority: 'NORMAL', author_id: 't-tanaka', created_at: '2026-10-14 15:10:00' },
  { id: 'post_3', title: '【進路指導部】第2回進路希望調査集計報告', content: '2学年の第2回進路希望調査の集計が完了いたしました。共有フォルダ「進路資料」内をご確認ください。', post_type: 'NEWS', priority: 'NORMAL', author_id: 't-sato', created_at: '2026-10-13 11:00:00' }
];

// 3. 承認ログ
const dummyAcknowledgements = [
  { id: 'ack_1', post_id: 'post_1', user_id: 't-tanaka', status: 'APPROVED', comment: '英語科採点完了し提出済み', acknowledged_at: '2026-10-15 09:12:00' },
  { id: 'ack_2', post_id: 'post_1', user_id: 't-sato', status: 'READ', comment: null, acknowledged_at: '2026-10-15 10:00:00' },
  { id: 'ack_3', post_id: 'post_1', user_id: 't-suzuki', status: 'UNREAD', comment: null, acknowledged_at: null }
];

// 4. チャットチャンネル
const dummyChannels = [
  { id: 'general', name: '📢 職員全体', type: 'PUBLIC' },
  { id: 'grade1', name: '🏫 1年学年部', type: 'GROUP' },
  { id: 'kyomu', name: '📋 教務部連絡', type: 'GROUP' }
];

// 5. チャットメッセージ
const dummyMessages = [
  { id: 'msg_1', channel_id: 'general', sender_id: 'kyomu01', message: '先生方、お疲れ様です。本日の定例打ち合わせは16:30から第一会議室にて行います。', created_at: '2026-10-15 08:15:00' },
  { id: 'msg_2', channel_id: 'general', sender_id: 't-tanaka', message: '了解いたしました。生徒指導部からの配付資料を持参いたします。', created_at: '2026-10-15 08:20:00' },
  { id: 'msg_3', channel_id: 'grade1', sender_id: 't-tanaka', message: '明日の1学年集会の移動経路について、体育館前廊下が混雑しないよう確認お願いします。', created_at: '2026-10-15 09:00:00' }
];

// 6. 座席状態
const dummySeating = [
  { id: 'seat_1', user_id: 'kyomu01', desk_number: 'A-01', group_zone: 'admin', current_status: 'PRESENT', status_note: '' },
  { id: 'seat_2', user_id: 't-tanaka', desk_number: 'A-02', group_zone: 'g1', current_status: 'CLASS', status_note: '2-A 英語' },
  { id: 'seat_3', user_id: 't-sato', desk_number: 'A-03', group_zone: 'g2', current_status: 'PRESENT', status_note: '第一会議室' },
  { id: 'seat_4', user_id: 't-suzuki', desk_number: 'B-01', group_zone: 'g3', current_status: 'TRIP', status_note: '県庁出張' },
  { id: 'seat_5', user_id: 't-takahashi', desk_number: 'B-02', group_zone: 'g1', current_status: 'LEAVE', status_note: '年休' }
];

// 7. 施設・備品マスター
const dummyResources = [
  { id: '1', name: '第一会議室', category: 'ROOM' },
  { id: '2', name: '第二会議室', category: 'ROOM' },
  { id: '3', name: '体育館', category: 'ROOM' },
  { id: '4', name: 'プロジェクターA', category: 'EQUIPMENT' },
  { id: '5', name: '校外研修用マイクロバス', category: 'EQUIPMENT' }
];

// 8. 施設予約 (新スキーマ構造: facility_id, target_date, user_name 等に対応)
const dummyReservations = [
  { id: 'resv_1', facility_id: '1', resource_id: '1', user_id: 'kyomu01', user_name: '教務 主任', title: '教務部定例会議', target_date: '2026-10-15', start_time: '2026-10-15 16:30:00', end_time: '2026-10-15 17:30:00', is_cancelled: false },
  { id: 'resv_2', facility_id: '4', resource_id: '4', user_id: 't-sato', user_name: '佐藤 先生', title: '進路説明会プレゼン', target_date: '2026-10-16', start_time: '2026-10-16 13:00:00', end_time: '2026-10-16 15:00:00', is_cancelled: false }
];

// 9. 校内スケジュール・年間行事 (新規追加)
const dummySchedules = [
  { id: 'sch_101', title: '中間考査（第1日）', description: '全学年対象 9:00開始', event_date: '2026-10-15', category: 'EXAM', target_grade: null, created_by_user_id: 'kyomu01' },
  { id: 'sch_102', title: '職員定例会議', description: '第一会議室 15:30〜', event_date: '2026-10-15', category: 'MEETING', target_grade: null, created_by_user_id: 'kyomu01' },
  { id: 'sch_103', title: '避難訓練', description: 'グラウンド避難', event_date: '2026-10-20', category: 'SCHOOL', target_grade: null, created_by_user_id: 'kyomu01' }
];

async function seedDatabase() {
  console.log('🌱 ダミーデータの一括投入を開始します...');

  const client = await pool.connect();
  await client.query('BEGIN');

  try {
    for (const u of dummyUsers) {
      await upsert(client, 'users', ['id', 'staff_code', 'name', 'email', 'password_hash', 'role', 'department', 'extension_number'], [u.id, u.staff_code, u.name, u.email, u.password_hash, u.role, u.department, u.extension_number]);
    }

    for (const p of dummyPosts) {
      await upsert(client, 'posts', ['id', 'title', 'content', 'post_type', 'priority', 'author_id', 'created_at'], [p.id, p.title, p.content, p.post_type, p.priority, p.author_id, p.created_at]);
    }

    for (const a of dummyAcknowledgements) {
      await upsert(client, 'post_acknowledgements', ['id', 'post_id', 'user_id', 'status', 'comment', 'acknowledged_at'], [a.id, a.post_id, a.user_id, a.status, a.comment, a.acknowledged_at]);
    }

    for (const c of dummyChannels) {
      await upsert(client, 'chat_channels', ['id', 'name', 'type'], [c.id, c.name, c.type]);
    }

    for (const m of dummyMessages) {
      await upsert(client, 'chat_messages', ['id', 'channel_id', 'sender_id', 'message', 'created_at'], [m.id, m.channel_id, m.sender_id, m.message, m.created_at]);
    }

    for (const s of dummySeating) {
      await upsert(client, 'seating_status', ['id', 'user_id', 'desk_number', 'group_zone', 'current_status', 'status_note'], [s.id, s.user_id, s.desk_number, s.group_zone, s.current_status, s.status_note]);
    }

    for (const r of dummyResources) {
      await upsert(client, 'resources', ['id', 'name', 'category'], [r.id, r.name, r.category]);
    }

    for (const rv of dummyReservations) {
      await upsert(client, 'reservations', ['id', 'facility_id', 'resource_id', 'user_id', 'user_name', 'title', 'target_date', 'start_time', 'end_time', 'is_cancelled'], [rv.id, rv.facility_id, rv.resource_id, rv.user_id, rv.user_name, rv.title, rv.target_date, rv.start_time, rv.end_time, rv.is_cancelled]);
    }

    for (const sch of dummySchedules) {
      await upsert(client, 'school_schedules', ['id', 'title', 'description', 'event_date', 'category', 'target_grade', 'created_by_user_id'], [sch.id, sch.title, sch.description, sch.event_date, sch.category, sch.target_grade, sch.created_by_user_id]);
    }

    await client.query('COMMIT;');
    console.log('🎉 全テーブルへの最新ダミーデータ投入が完了しました！');

  } catch (err) {
    await client.query('ROLLBACK;');
    console.error('❌ シードデータ投入エラー:', err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

seedDatabase();