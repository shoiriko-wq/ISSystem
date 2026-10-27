/**
 * ISSystem 定期考査デモデータ投入スクリプト (scripts/seed-exam.js)
 * 考査マスタ・試験教室・非常勤教員・教員プール・出張等・配慮事項を生成する
 */

import { Client } from 'pg';
import bcrypt from 'bcrypt';
import config from '../config/default.js';

const dbCfg = config.db;
const client = new Client({
  host: dbCfg.host,
  port: dbCfg.port,
  database: dbCfg.name,
  user: dbCfg.user,
  password: dbCfg.password,
});
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_SALT_ROUNDS || '10', 10);
const SEED_PASSWORD = 'password123';

const EXAM_ID = process.env.EXAM_ID || 'exam_2026_2';
const DAYS = 5;
const SLOTS = 8;
const GRADES = [1, 2, 3];

const teachers = [];
for (const g of GRADES) {
  for (let i = 1; i <= 8; i++) {
    teachers.push({
      id: `t-${g}0${i}`,
      staff_code: `T2026${g}0${i}`,
      name: `${g}年 教員${i}`,
      email: `t${g}0${i}@school.ed.jp`,
      role: 'TEACHER',
      grade: String(g),
      department: '教科教育部',
      is_parttime: false,
    });
  }
}
for (let i = 1; i <= 5; i++) {
  teachers.push({
    id: `pt-0${i}`,
    staff_code: `P202600${i}`,
    name: `非常勤 教員${i}`,
    email: `pt0${i}@school.ed.jp`,
    role: 'TEACHER',
    grade: 'NONE',
    department: '非常勤',
    is_parttime: true,
  });
}

const rooms = [];
for (const g of GRADES) {
  for (let i = 1; i <= 5; i++) {
    rooms.push({ name: `${g}年${'ABCDE'[i - 1]}教室`, capacity: 60, room_type: 'CLASS', grades: [g] });
  }
}
for (let i = 1; i <= 5; i++) {
  rooms.push({ name: `予備室${i}`, capacity: 60, room_type: 'CLASS', grades: [1, 2, 3], is_alternate: true });
}
rooms.push({ name: '特別教室A', capacity: 60, room_type: 'SP1', grades: [1, 2, 3] });
rooms.push({ name: '特別教室B', capacity: 60, room_type: 'SP2', grades: [1, 2, 3] });
rooms.push({ name: '特別教室C', capacity: 60, room_type: 'SP2', grades: [1, 2, 3] });
rooms.push({ name: '準備室', capacity: 20, room_type: 'PREP1', grades: [] });

// 実施科目プラン（1科目 × 1学年 = 実施単位）
// scope ALL = その学年の生徒全員が受験（1限・最終日ルール対象）
const SUBJECTS = [
  { name: '国語総合', stream: 'ARTS', duration: 1, scope: 'ALL' },
  { name: '数学Ⅰ', stream: 'SCIENCE', duration: 1, scope: 'ALL' },
  { name: '数学Ⅱ', stream: 'SCIENCE', duration: 1, scope: 'ALL' },
  { name: '数学Ⅲ', stream: 'SCIENCE', duration: 2, fixed_slot: 2, scope: 'ALL' },
  { name: '英語コミュニケーションⅠ', stream: 'ARTS', duration: 1, scope: 'ALL', broadcast: true },
  { name: '英語表現Ⅰ', stream: 'ARTS', duration: 1, scope: 'ALL' },
  { name: '日本史探究', stream: 'ARTS', duration: 1, scope: 'ALL' },
  { name: '現代数学', stream: 'SCIENCE', duration: 1, scope: 'ALL', shared: true },
  { name: '発展化学', stream: 'SCIENCE', duration: 1, scope: 'ALL', solo: true },
  { name: '物理基礎', stream: 'SCIENCE', duration: 1, scope: 'ALL' },
  { name: '生物基礎', stream: 'SCIENCE', duration: 1, scope: 'ALL' },
  { name: '家庭基礎', stream: 'OTHER', duration: 1, scope: 'ALL' },
  { name: '情報基礎', stream: 'OTHER', duration: 1, scope: 'ALL' },
  { name: '体育理論', stream: 'OTHER', duration: 1, scope: 'GRADE', broadcast: true },
  { name: '進路指導', stream: 'OTHER', duration: 1, scope: 'GRADE', solo: true },
];

const subjectPlan = [];
for (const g of GRADES) {
  SUBJECTS.forEach((s, i) => {
    subjectPlan.push({
      id: `plan-${EXAM_ID}-${g}-${s.name}`,
      exam_master_id: EXAM_ID,
      subject_name: s.name,
      subject_id: `sub-${g}-${i + 1}`,
      grade: g,
      stream: s.stream,
      scope: s.scope,
      setter_teacher_id: `t-${g}0${(i % 8) + 1}`,
      duration_slots: s.duration,
      fixed_slot: s.fixed_slot ?? null,
      shared_slot: !!s.shared,
      broadcast_slot: !!s.broadcast,
      solo_subject: !!s.solo,
      submit_status: 'SUBMITTED',
    });
  });
}

// 科目別標準教室設定（標準教室＋予備教室の順序）
const roomConfigRows = [];
for (const g of GRADES) {
  for (const s of SUBJECTS) {
    roomConfigRows.push({
      id: `rcfg-${EXAM_ID}-${g}-${s.name}`,
      exam_master_id: EXAM_ID,
      subject_name: s.name,
      grade: g,
      standard_room: `${g}年A教室`,
      alt_rooms: [`予備室1`, `予備室2`, `予備室3`],
      notes: null,
    });
  }
}


async function main() {
  await client.connect();
  const hash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);

  for (const t of teachers) {
    await client.query(
      `INSERT INTO users (id, staff_code, name, email, password_hash, role, grade, department, is_parttime)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (id) DO UPDATE SET
         staff_code = EXCLUDED.staff_code,
         name = EXCLUDED.name,
         grade = EXCLUDED.grade,
         department = EXCLUDED.department,
         is_parttime = EXCLUDED.is_parttime`,
      [t.id, t.staff_code, t.name, t.email, hash, t.role, t.grade, t.department, t.is_parttime]
    );
  }

  await client.query(
    `INSERT INTO exam_masters (id, title, start_date, end_date, days_count, daily_slots, grades, period_times, is_active, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9)
     ON CONFLICT (id) DO UPDATE SET
       title = EXCLUDED.title,
       start_date = EXCLUDED.start_date,
       end_date = EXCLUDED.end_date,
       days_count = EXCLUDED.days_count,
       daily_slots = EXCLUDED.daily_slots,
       grades = EXCLUDED.grades,
       period_times = EXCLUDED.period_times,
       is_active = true`,
    [
      EXAM_ID,
      '2026年度 2学期期末考査',
      '2026-11-17',
      '2026-11-21',
      DAYS,
      SLOTS,
      JSON.stringify(GRADES),
      JSON.stringify(Array.from({ length: SLOTS }, (_, i) => `${i + 1}限`)),
      'kyomu01',
    ]
  );

  await client.query(`DELETE FROM exam_rooms WHERE exam_master_id = $1`, [EXAM_ID]);
  for (const r of rooms) {
    await client.query(
      `INSERT INTO exam_rooms (id, exam_master_id, name, room_type, capacity, grades, is_alternate, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'kyomu01',CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, name) DO UPDATE SET
         room_type = EXCLUDED.room_type,
         capacity = EXCLUDED.capacity,
         grades = EXCLUDED.grades,
         is_alternate = EXCLUDED.is_alternate`,
      [`room-${EXAM_ID}-${r.name}`, EXAM_ID, r.name, r.room_type, r.capacity, JSON.stringify(r.grades), !!r.is_alternate]
    );
  }

  // 実施科目プラン（出題者調査データ）
  await client.query(`DELETE FROM exam_subject_plan WHERE exam_master_id = $1`, [EXAM_ID]);
  for (const p of subjectPlan) {
    await client.query(
      `INSERT INTO exam_subject_plan (id, exam_master_id, subject_name, subject_id, grade, stream, scope,
        setter_teacher_id, duration_slots, fixed_slot, shared_slot, broadcast_slot, solo_subject,
        notes, submit_status, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,null,$14,'kyomu01',CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, subject_name, grade) DO UPDATE SET
         subject_id = EXCLUDED.subject_id,
         stream = EXCLUDED.stream,
         scope = EXCLUDED.scope,
         setter_teacher_id = EXCLUDED.setter_teacher_id,
         duration_slots = EXCLUDED.duration_slots,
         fixed_slot = EXCLUDED.fixed_slot,
         shared_slot = EXCLUDED.shared_slot,
         broadcast_slot = EXCLUDED.broadcast_slot,
         solo_subject = EXCLUDED.solo_subject,
         submit_status = EXCLUDED.submit_status`,
      [
        p.id, p.exam_master_id, p.subject_name, p.subject_id, p.grade, p.stream, p.scope,
        p.setter_teacher_id, p.duration_slots, p.fixed_slot, p.shared_slot, p.broadcast_slot,
        p.solo_subject, p.submit_status,
      ]
    );
  }

  // 科目別標準教室設定
  await client.query(`DELETE FROM exam_room_config WHERE exam_master_id = $1`, [EXAM_ID]);
  for (const c of roomConfigRows) {
    await client.query(
      `INSERT INTO exam_room_config (id, exam_master_id, subject_name, grade, standard_room, alt_rooms, notes, updated_by, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,null,'kyomu01',CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, subject_name, grade) DO UPDATE SET
         standard_room = EXCLUDED.standard_room,
         alt_rooms = EXCLUDED.alt_rooms`,
      [c.id, c.exam_master_id, c.subject_name, c.grade, c.standard_room, JSON.stringify(c.alt_rooms)]
    );
  }

  const parttime = teachers.filter((t) => t.is_parttime);
  for (const p of parttime) {
    await client.query(
      `INSERT INTO exam_parttime_staff (exam_master_id, teacher_id, daily_limit, max_consecutive, consecutive_rule, notes, updated_by, updated_at)
       VALUES ($1,$2,3,1,'MAX1','デモ非常勤','kyomu01',CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, teacher_id) DO UPDATE SET
         daily_limit = EXCLUDED.daily_limit,
         max_consecutive = EXCLUDED.max_consecutive,
         consecutive_rule = EXCLUDED.consecutive_rule,
         notes = EXCLUDED.notes`,
      [EXAM_ID, p.id]
    );
    for (let d = 1; d <= DAYS; d++) {
      for (let s = 1; s <= SLOTS; s++) {
        const canWork = !(d % 2 === 0 && s >= 6); // 偶数日の6〜8コマは出勤不可
        await client.query(
          `INSERT INTO exam_parttime_availability (exam_master_id, teacher_id, day_number, slot_number, can_work, updated_by, updated_at)
           VALUES ($1,$2,$3,$4,$5,'kyomu01',CURRENT_TIMESTAMP)
           ON CONFLICT (exam_master_id, teacher_id, day_number, slot_number) DO UPDATE SET
             can_work = EXCLUDED.can_work`,
          [EXAM_ID, p.id, d, s, canWork]
        );
      }
    }
  }

  await client.query(
    `INSERT INTO exam_teacher_exemptions (exam_master_id, teacher_id, reason)
     VALUES ($1,$2,$3)
     ON CONFLICT (exam_master_id, teacher_id) DO UPDATE SET
       reason = EXCLUDED.reason`,
    [EXAM_ID, 't-308', '通院治療による全期間免除']
  );

  await client.query(
    `INSERT INTO exam_teacher_constraints (id, exam_master_id, teacher_id, constraint_type, notes, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,'kyomu01',CURRENT_TIMESTAMP)
     ON CONFLICT (exam_master_id, teacher_id) DO UPDATE SET
       constraint_type = EXCLUDED.constraint_type,
       notes = EXCLUDED.notes`,
    [`tc-${EXAM_ID}-t-108`, EXAM_ID, 't-108', JSON.stringify({ max_slots_per_day: 2, max_consecutive_slots: 1 }), '午後連続監督不可']
  );

  await client.query(`DELETE FROM exam_trips WHERE exam_master_id = $1`, [EXAM_ID]);
  const trips = [
    { teacher_id: 't-101', day_number: 1, slot_number: 4, reason: '部活動引率' },
    { teacher_id: 't-205', day_number: 2, slot_number: 2, reason: '県教育委員会研修' },
    { teacher_id: 'pt-01', day_number: 3, slot_number: 5, reason: '校外会議' },
  ];
  for (const t of trips) {
    await client.query(
      `INSERT INTO exam_trips (id, exam_master_id, teacher_id, day_number, slot_number, reason, from_absence, recorded_by, recorded_by_name, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,false,'kyomu01','教務 主任',CURRENT_TIMESTAMP)`,
      [`trip-${EXAM_ID}-${t.teacher_id}-${t.day_number}-${t.slot_number}`, EXAM_ID, t.teacher_id, t.day_number, t.slot_number, t.reason]
    );
  }
  console.log(`🌱 考査 ${EXAM_ID} のデモデータ（教員 ${teachers.length}名 / 教室 ${rooms.length}室 / 科目 ${subjectPlan.length}単位 / 非常勤 ${parttime.length}名）を投入しました。`);
  await client.end();
}

main().catch((err) => {
  console.error('❌ 考査デモデータ投入失敗:', err);
  process.exit(1);
});