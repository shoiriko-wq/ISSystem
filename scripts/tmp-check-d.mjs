/**
 * ISSystem ダミーデータ一括挿入スクリプト (scripts/seed.js) — PostgreSQL 版
 * 仕様書 v2.1.0 完全連動版
 */

import { Client } from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';
import bcrypt from 'bcrypt';
import config from '../config/default.js';
import { seedInitialData } from './seed-data.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbCfg = config.db;

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);
const SEED_PASSWORD = 'password123';

// 1. 教職員ユーザー
const dummyUsers = [
  { id: 'kyomu01', staff_code: 'T2026001', name: '教務 主任', email: 'kyomu@school.ed.jp', role: 'KYOMU', grade: 'NONE', department: '教務部', extension_number: '101' },
  { id: 't-tanaka', staff_code: 'T2026002', name: '田中 先生', email: 'tanaka@school.ed.jp', role: 'TEACHER', grade: '1', department: '生徒指導部', extension_number: '102' },
  { id: 't-sato', staff_code: 'T2026003', name: '佐藤 先生', email: 'sato@school.ed.jp', role: 'TEACHER', grade: '2', department: 'キャリアガイダンス部', extension_number: '103' },
  { id: 't-suzuki', staff_code: 'T2026004', name: '鈴木 先生', email: 'suzuki@school.ed.jp', role: 'TEACHER', grade: '3', department: '特色推進部', extension_number: '104' },
  { id: 't-takahashi', staff_code: 'T2026005', name: '高橋 先生', email: 'takahashi@school.ed.jp', role: 'TEACHER', grade: '1', department: '１学年', extension_number: '105' },
  { id: 'sys-admin', staff_code: 'T2026000', name: 'システム 管理者', email: 'admin@school.ed.jp', role: 'ADMIN', grade: 'NONE', department: 'システム管理', extension_number: '100' }
];

// 2. 掲示板投稿
// 2. 掲示投稿（JST 基準の現在日に寄せる。ミニカレンダーの打点・未読検証が当日基準で動く）
function seedDay(offset = 0) {
  const d = new Date(Date.now() + 9 * 3600000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split('T')[0];
}

const dummyPosts = [
  { id: 'post_1', title: '【教務部】中間考査採点票の提出期限について', content: '中間考査の全科目採点票の最終締め切りは明後日17時です。未提出の教科・学年はお早めに教務部へご提出ください。', author_id: 'kyomu01', created_at: `${seedDay(0)} 08:30:00`, display_start_date: seedDay(0), display_end_date: seedDay(16) },
  { id: 'post_2', title: '避難訓練の実施要項および各クラスの避難経路確認', content: '来週火曜日の6限に全校避難訓練を実施します。各担任の先生は事前に生徒へ非常口および避難経路の周知を行ってください。', author_id: 't-tanaka', created_at: `${seedDay(0)} 15:10:00`, display_start_date: seedDay(0), display_end_date: null },
  { id: 'post_3', title: '【進路指導部】第2回進路希望調査集計報告', content: '2学年の第2回進路希望調査の集計が完了いたしました。共有フォルダ「進路資料」内をご確認ください。', author_id: 't-sato', created_at: `${seedDay(0)} 11:00:00`, display_start_date: seedDay(0), display_end_date: seedDay(6) }
];

// 3. 承認ログ
const dummyAcknowledgements = [
  { id: 'ack_1', post_id: 'post_1', user_id: 't-tanaka', status: 'APPROVED', comment: '英語科採点完了し提出済み', acknowledged_at: `${seedDay(0)} 09:12:00` },
  { id: 'ack_2', post_id: 'post_1', user_id: 't-sato', status: 'READ', comment: null, acknowledged_at: `${seedDay(0)} 10:00:00` },
  { id: 'ack_3', post_id: 'post_1', user_id: 't-suzuki', status: 'UNREAD', comment: null, acknowledged_at: null },
  { id: 'ack_4', post_id: 'post_2', user_id: 'kyomu01', status: 'READ', comment: null, acknowledged_at: `${seedDay(0)} 16:05:00` }
];

// 4. チャットチャンネル（★ 職員全体チャット撤廃 2026/11/9 v3.1.2: 個人が作成したグループのみ）
const dummyChannels = [
  { id: 'grade1', name: '🏫 1年学年部', type: 'GROUP', members: ['t-tanaka', 't-takahashi'] },
  { id: 'kyomu', name: '📋 教務部連絡', type: 'GROUP', members: ['kyomu01', 't-tanaka'] },
  { id: 'suisin', name: '🧭 進路指導連絡', type: 'GROUP', members: ['kyomu01', 't-sato'] }
];

// 5. チャットメッセージ
const dummyMessages = [
  { id: 'msg_1', channel_id: 'kyomu', sender_id: 'kyomu01', message: '先生方、お疲れ様です。本日の定例打ち合わせは16:30から第一会議室にて行います。', created_at: '2026-10-15 08:15:00' },
  { id: 'msg_2', channel_id: 'kyomu', sender_id: 't-tanaka', message: '了解いたしました。生徒指導部からの配付資料を持参いたします。', created_at: '2026-10-15 08:20:00' },
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

// 7. 施設・備品マスター（初期設定＝施設予約のデフォルト施設名）
const dummyResources = [
  { id: 'fac_1', name: '学文館会議室', category: 'ROOM' },
  { id: 'fac_2', name: '西会議室', category: 'ROOM' },
  { id: 'fac_3', name: '東会議室', category: 'ROOM' },
  { id: 'fac_4', name: '応接室', category: 'ROOM' },
  { id: 'fac_5', name: '図書室', category: 'ROOM' },
  { id: 'fac_6', name: '食堂', category: 'ROOM' },
  { id: 'fac_7', name: '多目的教室', category: 'ROOM' },
  { id: 'fac_8', name: '４０５教室（西社会科教室）', category: 'SPECIAL' },
  { id: 'fac_9', name: '４０９教室（東社会科教室）', category: 'SPECIAL' },
  { id: 'fac_10', name: '２１２教室', category: 'SPECIAL' },
  { id: 'fac_11', name: '３１２教室', category: 'SPECIAL' },
  { id: 'fac_12', name: '２２７教室', category: 'SPECIAL' },
  { id: 'fac_13', name: '２２８教室（ＤＸルーム）', category: 'SPECIAL' },
  { id: 'fac_14', name: '視聴覚教室', category: 'SPECIAL' },
  { id: 'fac_15', name: '化学教室', category: 'SPECIAL' },
  { id: 'fac_16', name: '生物教室', category: 'SPECIAL' },
  { id: 'fac_17', name: '地学教室', category: 'SPECIAL' }
];

// 8. 施設予約
const dummyReservations = [
  { id: 'resv_1', facility_id: 'fac_1', resource_id: 'fac_1', user_id: 'kyomu01', user_name: '教務 主任', title: '教務部定例会議', target_date: '2026-10-15', start_time: '2026-10-15 16:30:00', end_time: '2026-10-15 17:30:00', is_cancelled: false },
  { id: 'resv_2', facility_id: 'fac_14', resource_id: 'fac_14', user_id: 't-sato', user_name: '佐藤 先生', title: '進路説明会プレゼン', target_date: '2026-10-16', start_time: '2026-10-16 13:00:00', end_time: '2026-10-16 15:00:00', is_cancelled: false }
];

// 8b. 決裁・申請ワークフロー
const dummyApprovals = [
  { id: 'apr_1', title: '職員室用 大型プリンター導入 (10月)', category: 'PURCHASE', description: '印刷コスト削減のためA3対応機を導入。2社相見積。', amount: 248000, applicant_id: 't-sato', approver_id: 'kyomu01', status: 'PENDING', comment: null, linked_chat_channel_id: 'kyomu', approved_at: null, created_at: '2026-10-15 10:00:00' },
  { id: 'apr_2', title: '1年学年集会 体育館使用申請', category: 'FACILITY', description: '10月20日 6限に体育館を使用。', amount: 0, applicant_id: 't-tanaka', approver_id: 'kyomu01', status: 'APPROVED', comment: '承認。使用予定表に登録済み。', linked_chat_channel_id: null, approved_at: '2026-10-14 16:20:00', created_at: '2026-10-13 09:30:00' },
  { id: 'apr_3', title: '校外研修用マイクロバス借用申請', category: 'TRANSPORT', description: '10月22日の県外研修への送迎使用。', amount: 12000, applicant_id: 't-suzuki', approver_id: 'kyomu01', status: 'REJECTED', comment: '同日に県大会送迎と重複するため却下。', linked_chat_channel_id: null, approved_at: '2026-10-12 15:05:00', created_at: '2026-10-11 11:40:00' }
];

// 9. 校内スケジュール・年間行事
const dummySchedules = [
  { id: 'sch_101', title: '中間考査（第1日）', description: '全学年対象 9:00開始', event_date: '2026-10-15', category: 'EXAM', target_grade: null, created_by_user_id: 'kyomu01' },
  { id: 'sch_102', title: '職員定例会議', description: '第一会議室 15:30〜', event_date: '2026-10-15', category: 'MEETING', target_grade: null, created_by_user_id: 'kyomu01' },
  { id: 'sch_103', title: '避難訓練', description: 'グラウンド避難', event_date: '2026-10-20', category: 'SCHOOL', target_grade: null, created_by_user_id: 'kyomu01' }
];

// 9b. スケジュールカテゴリマスタ＝プロフィールの部署名（初期7種・教務部が運用）と行事カテゴリ紐付け（1行事→複数カテゴリ）
const dummyScheduleCategories = [
  { id: 1, name: '教務部', color_key: 'ACCENT', sort_order: 1 },
  { id: 2, name: '生徒指導部', color_key: 'DANGER', sort_order: 2 },
  { id: 3, name: 'キャリアガイダンス部', color_key: 'INFO', sort_order: 3 },
  { id: 4, name: '特色推進部', color_key: 'PURPLE', sort_order: 4 },
  { id: 5, name: '１学年', color_key: 'SUCCESS', sort_order: 5 },
  { id: 6, name: '２学年', color_key: 'SLATE', sort_order: 6 },
  { id: 7, name: '３学年', color_key: 'WARNING', sort_order: 7 }
];

const dummyScheduleCategoryMap = [
  { schedule_id: 'sch_101', category_id: 5 },
  { schedule_id: 'sch_101', category_id: 6 },
  { schedule_id: 'sch_101', category_id: 7 },
  { schedule_id: 'sch_102', category_id: 1 },
  { schedule_id: 'sch_103', category_id: 2 }
];

// 10. クラス・教科・科目・教室マスタの初期データは data/seed/*.csv から投入する (scripts/seed-data.js)
//     サーバー側（コード）に初期名を固定しない。運用で作り替えたマスタをコードへ書き戻さない。

// 11. 考査マスター
const dummyExamMasters = [
  { id: 'exam_2026_1', title: '2026年度 1学期中間考査', start_date: '2026-10-15', end_date: '2026-10-17', days_count: 3, daily_slots: 3, is_active: true }
];

// 12. 科目担当教員マッピング
const subjectTeachers = {
  ko01: 'kyomu01',
  ko02: 't-sato',
  ko03: 't-tanaka',
  ko04: 't-suzuki',
  ko05: 't-takahashi',
  ko06: 't-tanaka',
  ko07: 't-suzuki',
  ko08: 't-takahashi',
  ko09: 't-sato'
};

// 13. 監督除外・配慮教員
const dummyExamExemptions = [
  { exam_master_id: 'exam_2026_1', teacher_id: 't-suzuki', reason: '毎週水曜に県教育委員会出張' },
  { exam_master_id: 'exam_2026_1', teacher_id: 't-takahashi', reason: '通院治療による午後除外' }
];

// 15. 年休等・出張 欠席登録 (当日基準でデモデータを生成)
const todayStr = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const dummyAbsenceRecords = [
  { id: 'abs_1', user_id: 't-takahashi', record_date: todayStr, record_type: 'LEAVE', reason: '年休（通院治療）', recorded_by: 'kyomu01', recorded_by_name: '教務 主任' },
  { id: 'abs_2', user_id: 't-suzuki', record_date: todayStr, record_type: 'TRIP', reason: '県教育委員会 研修（午後）', recorded_by: 'kyomu01', recorded_by_name: '教務 主任' },
  { id: 'abs_3', user_id: 't-sato', record_date: todayStr, record_type: 'TRIP', reason: '進路指導部 校外打ち合わせ', recorded_by: 'kyomu01', recorded_by_name: '教務 主任' }
];

// 14. 考査コマ（科目時間割）と監督割当を決定論的に生成
//     クラス・教科は CSV 投入後の DB 実データから作る（初期データの名前に依存しない）
const teacherPool = ['kyomu01', 't-tanaka', 't-sato', 't-suzuki', 't-takahashi'];
const exemptedTeachers = new Set(dummyExamExemptions.map((e) => e.teacher_id));

/** CSV 投入後のクラス・教科を受けて考査コマと監督割当を生成する */
function buildExamSlots(classes, subjectIds) {
  const slots = [];
  const proctors = [];
  if (!classes.length || !subjectIds.length) return { slots, proctors };

  for (const master of dummyExamMasters) {
    for (let day = 1; day <= master.days_count; day++) {
      for (let slot = 1; slot <= master.daily_slots; slot++) {
        classes.forEach((cls, classIndex) => {
          const subjectId = subjectIds[(day + slot + classIndex) % subjectIds.length];
          const subjectTeacher = subjectTeachers[subjectId] || teacherPool[(day + slot + classIndex) % teacherPool.length];

          slots.push({
            exam_master_id: master.id,
            day_number: day,
            slot_number: slot,
            class_id: cls.id,
            subject_id: subjectId,
            subject_teacher_id: subjectTeacher
          });

          // 自科目担当・除外教員を避けて監督教員を輪番割当
          const eligible = teacherPool.filter((t) => t !== subjectTeacher && !exemptedTeachers.has(t));
          const proctor = eligible[(day * 3 + slot + classIndex) % eligible.length] || teacherPool[0];

          proctors.push({
            exam_master_id: master.id,
            day_number: day,
            slot_number: slot,
            class_id: cls.id,
            proctor_teacher_id: proctor
          });
        });
      }
    }
  }
  return { slots, proctors };
}

async function seedDatabase() {
  console.log('🌱 ダミーデータの一括投入を開始します...');

  const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);

  const client = new Client({
    user: dbCfg.user,
    password: dbCfg.password,
    host: dbCfg.host,
    port: dbCfg.port,
    database: dbCfg.name,
    application_name: 'issystem-seed',
  });

  await client.connect();
  await client.query("SET TIME ZONE 'Asia/Tokyo'");

  // INSERT OR REPLACE 相当：外部キー順序を考慮して関連テーブルを一括クリアする
  const truncateSql = `
    TRUNCATE TABLE
      schedule_category_map,
      schedule_categories,
      system_audit_logs,
      editing_locks,
      invitation_codes,
      school_schedules,
      approvals,
      reservations,
      resources,
      seating_status,
      absence_records,
      chat_messages,
      chat_channel_members,
      chat_channels,
      post_acknowledgements,
      posts,
      exam_teacher_exemptions,
      exam_proctor_assignments,
      exam_slots,
      exam_masters,
      curriculum_subjects,
      basic_rooms,
      classes,
      subjects,
      users
    RESTART IDENTITY CASCADE;
  `;

  await client.query('BEGIN TRANSACTION;');

  try {
    await client.query(truncateSql);

    for (const u of dummyUsers) {
      await client.query(
        `INSERT INTO users (id, staff_code, name, email, password_hash, role, grade, department, extension_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (id) DO UPDATE SET
           staff_code = EXCLUDED.staff_code,
           name = EXCLUDED.name,
           email = EXCLUDED.email,
           password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           grade = EXCLUDED.grade,
           department = EXCLUDED.department,
           extension_number = EXCLUDED.extension_number`,
        [u.id, u.staff_code, u.name, u.email, passwordHash, u.role, u.grade, u.department, u.extension_number]
      );
    }

    for (const p of dummyPosts) {
      await client.query(
        `INSERT INTO posts (id, title, content, author_id, display_start_date, display_end_date, posted_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7)`,
        [p.id, p.title, p.content, p.author_id, p.display_start_date, p.display_end_date, p.created_at]
      );
    }

    for (const a of dummyAcknowledgements) {
      await client.query(
        `INSERT INTO post_acknowledgements (id, post_id, user_id, status, comment, acknowledged_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (post_id, user_id) DO UPDATE SET
           status = EXCLUDED.status,
           comment = EXCLUDED.comment,
           acknowledged_at = EXCLUDED.acknowledged_at`,
        [a.id, a.post_id, a.user_id, a.status, a.comment, a.acknowledged_at]
      );
    }

    for (const c of dummyChannels) {
      await client.query(
        `INSERT INTO chat_channels (id, name, type, members) VALUES ($1, $2, $3, $4)`,
        [c.id, c.name, c.type, JSON.stringify(c.members)]
      );
      for (const m of c.members) {
        await client.query(
          `INSERT INTO chat_channel_members (channel_id, user_id, is_hidden)
           VALUES ($1, $2, 0) ON CONFLICT (channel_id, user_id) DO NOTHING`,
          [c.id, m]
        );
      }
    }

    for (const m of dummyMessages) {
      await client.query(
        `INSERT INTO chat_messages (id, channel_id, sender_id, message, created_at) VALUES ($1, $2, $3, $4, $5)`,
        [m.id, m.channel_id, m.sender_id, m.message, m.created_at]
      );
    }

    for (const s of dummySeating) {
      await client.query(
        `INSERT INTO seating_status (id, user_id, desk_number, group_zone, current_status, status_note)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id) DO UPDATE SET
           desk_number = EXCLUDED.desk_number,
           group_zone = EXCLUDED.group_zone,
           current_status = EXCLUDED.current_status,
           status_note = EXCLUDED.status_note`,
        [s.id, s.user_id, s.desk_number, s.group_zone, s.current_status, s.status_note]
      );
    }

    for (const ab of dummyAbsenceRecords) {
      await client.query(
        `INSERT INTO absence_records (id, user_id, record_date, record_type, reason, recorded_by, recorded_by_name)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (user_id, record_date, record_type) DO UPDATE SET
           reason = EXCLUDED.reason,
           recorded_by = EXCLUDED.recorded_by,
           recorded_by_name = EXCLUDED.recorded_by_name,
           updated_at = CURRENT_TIMESTAMP`,
        [ab.id, ab.user_id, ab.record_date, ab.record_type, ab.reason, ab.recorded_by, ab.recorded_by_name]
      );
    }

    for (const r of dummyResources) {
      await client.query(
        `INSERT INTO resources (id, name, category) VALUES ($1, $2, $3)
         ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category`,
        [r.id, r.name, r.category]
      );
    }

    for (const rv of dummyReservations) {
      await client.query(
        `INSERT INTO reservations (id, facility_id, resource_id, user_id, user_name, title, target_date, start_time, end_time, is_cancelled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [rv.id, rv.facility_id, rv.resource_id, rv.user_id, rv.user_name, rv.title, rv.target_date, rv.start_time, rv.end_time, rv.is_cancelled ? 1 : 0]
      );
    }

    for (const ap of dummyApprovals) {
      await client.query(
        `INSERT INTO approvals (id, title, category, description, amount, applicant_id, approver_id, status, comment, linked_chat_channel_id, approved_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           category = EXCLUDED.category,
           description = EXCLUDED.description,
           amount = EXCLUDED.amount,
           applicant_id = EXCLUDED.applicant_id,
           approver_id = EXCLUDED.approver_id,
           status = EXCLUDED.status,
           comment = EXCLUDED.comment,
           linked_chat_channel_id = EXCLUDED.linked_chat_channel_id,
           approved_at = EXCLUDED.approved_at,
           updated_at = EXCLUDED.updated_at`,
        [ap.id, ap.title, ap.category, ap.description, ap.amount, ap.applicant_id, ap.approver_id, ap.status, ap.comment, ap.linked_chat_channel_id, ap.approved_at, ap.created_at]
      );
    }

    for (const sch of dummySchedules) {
      await client.query(
        `INSERT INTO school_schedules (id, title, description, event_date, category, target_grade, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [sch.id, sch.title, sch.description, sch.event_date, sch.category, sch.target_grade, sch.created_by_user_id]
      );
    }

    // カテゴリマスタ（初期7種）→ 行事カテゴリ紐付けの順で投入 (外部キー順序)
    for (const cat of dummyScheduleCategories) {
      await client.query(
        `INSERT INTO schedule_categories (id, name, color_key, sort_order)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           color_key = EXCLUDED.color_key,
           sort_order = EXCLUDED.sort_order`,
        [cat.id, cat.name, cat.color_key, cat.sort_order]
      );
    }
    await client.query(
      `SELECT setval(pg_get_serial_sequence('schedule_categories', 'id'), (SELECT MAX(id) FROM schedule_categories))`
    );

    for (const link of dummyScheduleCategoryMap) {
      await client.query(
        `INSERT INTO schedule_category_map (schedule_id, category_id)
         VALUES ($1, $2) ON CONFLICT (schedule_id, category_id) DO NOTHING`,
        [link.schedule_id, link.category_id]
      );
    }

    // クラス・教科・教室・科目の初期データは CSV から投入する（コード側に初期名を固定しない）
    // TRUNCATE 済みなので空のテーブルへ data/seed/*.csv を投入する
    const seedResults = await seedInitialData({ runQuery: client.query.bind(client), force: true });
    console.log(`[Seed CSV] ${seedResults.map((r) => `${r.table}=${r.inserted}件`).join(' / ')}`);

    // 考査コマは CSV 投入後の実データ（クラス・教科）から生成する
    const seededClasses = (await client.query('SELECT id, grade FROM classes ORDER BY grade ASC, id ASC')).rows;
    const seededSubjectIds = (await client.query('SELECT id FROM subjects ORDER BY sort_order ASC, id ASC')).rows.map((r) => r.id);

    for (const m of dummyExamMasters) {
      await client.query(
        `INSERT INTO exam_masters (id, title, start_date, end_date, days_count, daily_slots, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         ON CONFLICT (id) DO UPDATE SET
           title = EXCLUDED.title,
           start_date = EXCLUDED.start_date,
           end_date = EXCLUDED.end_date,
           days_count = EXCLUDED.days_count,
           daily_slots = EXCLUDED.daily_slots,
           is_active = true,
           updated_at = CURRENT_TIMESTAMP`,
        [m.id, m.title, m.start_date, m.end_date, m.days_count, m.daily_slots]
      );
    }

    for (const ex of dummyExamExemptions) {
      await client.query(
        `INSERT INTO exam_teacher_exemptions (exam_master_id, teacher_id, reason)
         VALUES ($1, $2, $3)
         ON CONFLICT (exam_master_id, teacher_id) DO UPDATE SET reason = EXCLUDED.reason`,
        [ex.exam_master_id, ex.teacher_id, ex.reason]
      );
    }

    const { slots: dummyExamSlots, proctors: dummyProctorAssignments } = buildExamSlots(seededClasses, seededSubjectIds);

    for (const sl of dummyExamSlots) {
      await client.query(
        `INSERT INTO exam_slots (exam_master_id, day_number, slot_number, class_id, subject_id, subject_teacher_id, is_blocked)
         VALUES ($1, $2, $3, $4, $5, $6, false)
         ON CONFLICT (exam_master_id, day_number, slot_number, class_id, is_blocked)
         DO UPDATE SET
           subject_id = EXCLUDED.subject_id,
           subject_teacher_id = EXCLUDED.subject_teacher_id`,
        [sl.exam_master_id, sl.day_number, sl.slot_number, sl.class_id, sl.subject_id, sl.subject_teacher_id]
      );
    }

    for (const pa of dummyProctorAssignments) {
      await client.query(
        `INSERT INTO exam_proctor_assignments (exam_master_id, day_number, slot_number, class_id, proctor_teacher_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (exam_master_id, day_number, slot_number, class_id)
         DO UPDATE SET proctor_teacher_id = EXCLUDED.proctor_teacher_id`,
        [pa.exam_master_id, pa.day_number, pa.slot_number, pa.class_id, pa.proctor_teacher_id]
      );
    }

    await client.query('COMMIT;');
    console.log('🎉 全テーブルへの最新ダミーデータ投入が完了しました！');

  } catch (err) {
    await client.query('ROLLBACK;');
    console.error('❌ シードデータ投入エラー:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

seedDatabase();
