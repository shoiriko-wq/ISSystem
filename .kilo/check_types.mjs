// ライブDB のカラム型を information_schema から一覧化して UTF-8 ファイルに書き出す検証支援スクリプト
import fs from 'node:fs';
import { query, closeDatabase } from '../config/database.js';

const tables = [
  'posts',
  'post_acknowledgements',
  'post_comments',
  'reservations',
  'resources',
  'chat_messages',
  'chat_channels',
  'exam_slots',
  'exam_proctor_assignments',
  'exam_teacher_exemptions',
  'exam_phases',
  'exam_commands',
  'exam_command_groups',
  'exam_block_groups',
  'exam_block_rules',
  'exam_room_assignments',
  'exam_trips',
  'exam_masters',
  'exam_subject_rows',
  'exam_commands',
  'users',
  'invitation_codes',
  'audit_logs',
  'school_schedules',
  'seating_status',
  'facility_cells',
  'approvals',
  'absences',
  'absence_records',
  'subject_masters',
  'class_masters',
];

const out = [];
for (const t of tables) {
  const res = await query(
    `SELECT table_name, column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1
     ORDER BY ordinal_position`,
    [t]
  );
  if (res.rows.length === 0) {
    out.push(`TABLE ${t}: (not present)`);
    continue;
  }
  out.push(`TABLE ${t}`);
  for (const r of res.rows) {
    out.push(`  ${r.column_name} : ${r.data_type} null=${r.is_nullable} default=${r.column_default ?? ''}`);
  }
}

const present = await query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`
);
out.push(`ALL_TABLES: ${present.rows.map((r) => r.table_name).join(', ')}`);

fs.writeFileSync('tmp_db_types.txt', out.join('\n'), 'utf8');
await closeDatabase();
console.log('written', out.length, 'lines');