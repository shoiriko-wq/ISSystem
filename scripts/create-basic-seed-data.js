/**
 * ISSystem 基本情報マスタ 初期データ CSV 生成スクリプト (scripts/create-basic-seed-data.js)
 *
 * data/seed/*.csv を仕様のcounts（クラス30・教科9・科目98・教室14）で書き出す。
 * 科目名は コ_101 … 美術_305 の採番（教科コード + 学年 + 連番）で、ソート順の最後が 美術_305 になる。
 * クラス名は 1A … 3J の短名（チップが学年1行に収まる幅）。教室は A101 … + 体育館・音楽室。
 *
 * 実行: node scripts/create-basic-seed-data.js   （CSV を書き出すだけ。投入は npm run db:seed）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'seed');

// 1. 教科マスタ（9件）
const GROUPS = [
  { code: 'コ', name: 'コ' },
  { code: 'サ', name: 'サ' },
  { code: 'ス', name: 'ス' },
  { code: 'ミ', name: 'ミ' },
  { code: '保', name: '保' },
  { code: '英', name: '英' },
  { code: '体', name: '体' },
  { code: '音楽', name: '音楽' },
  { code: '美術', name: '美術' },
];

// 2. クラスマスタ（30件: 学年1〜3 × 10クラス、名前 1A … 3J）
const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];

// 3. 教室マスタ（14件: A101 … + 体育館・音楽室）
const ROOMS = [
  { id: 'room001', name: 'A101', room_type: 'CLASS', seats: 40, grades: [1], notes: '1年A' },
  { id: 'room002', name: 'A102', room_type: 'CLASS', seats: 40, grades: [1], notes: '1年B' },
  { id: 'room003', name: 'A103', room_type: 'CLASS', seats: 40, grades: [1], notes: '1年C' },
  { id: 'room004', name: 'A104', room_type: 'CLASS', seats: 40, grades: [1], notes: '1年D' },
  { id: 'room005', name: 'A105', room_type: 'CLASS', seats: 40, grades: [1], notes: '1年E' },
  { id: 'room006', name: 'A106', room_type: 'CLASS', seats: 40, grades: [1], notes: '1年F' },
  { id: 'room007', name: 'B101', room_type: 'CLASS', seats: 40, grades: [2], notes: '2年A' },
  { id: 'room008', name: 'B102', room_type: 'CLASS', seats: 40, grades: [2], notes: '2年B' },
  { id: 'room009', name: 'B103', room_type: 'CLASS', seats: 40, grades: [2], notes: '2年C' },
  { id: 'room010', name: 'B104', room_type: 'CLASS', seats: 40, grades: [2], notes: '2年D' },
  { id: 'room011', name: 'C101', room_type: 'CLASS', seats: 40, grades: [3], notes: '3年A' },
  { id: 'room012', name: 'C102', room_type: 'CLASS', seats: 40, grades: [3], notes: '3年B' },
  { id: 'room013', name: '体育館', room_type: 'GYM', seats: 200, grades: [1, 2, 3], notes: '全学年' },
  { id: 'room014', name: '音楽室', room_type: 'SPECIAL', seats: 40, grades: [1, 2, 3], notes: '器楽・合唱' },
];

// 4. 科目マスタ（98件: 教科コード_学年+連番。ソート順の最後は 美術_305）
//    教科ごとの実施学年内訳（grade1/grade2/grade3 の件数）で 98件を作る
const SUBJECT_PLAN = [
  { code: 'コ', room: 'room001', per: [3, 4, 3] },   // コ_101 … → 10件（合計98件の調整）
  { code: 'サ', room: 'room001', per: [4, 4, 3] },
  { code: 'ス', room: 'room002', per: [4, 4, 3] },
  { code: 'ミ', room: 'room002', per: [4, 4, 3] },
  { code: '保', room: 'room013', per: [3, 3, 4] },
  { code: '英', room: 'room003', per: [4, 4, 3] },
  { code: '体', room: 'room013', per: [3, 3, 4] },
  { code: '音楽', room: 'room014', per: [3, 4, 3] },
  { code: '美術', room: 'room014', per: [5, 4, 5] },
];

/** CSVセルの引用（カンマ・引用符・改行を含む値は "..." でくるむ） */
const cell = (v) => {
  const s = String(v ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header, rows) => [header.join(','), ...rows.map((r) => r.map(cell).join(','))].join('\n') + '\n';

const subjects = GROUPS.map((g, i) => [`subj0${i + 1}`, g.name, String(i + 1)]);

const classes = [];
for (const grade of [1, 2, 3]) {
  LETTERS.forEach((L, i) => {
    classes.push([`cls${grade}${String(i + 1).padStart(2, '0')}`, grade, i + 1, `${grade}${L}`]);
  });
}

const rooms = ROOMS.map((r) => [
  r.id, r.name, r.room_type, r.seats, JSON.stringify(r.grades), true, r.notes,
]);

const curriculum = [];
let seq = 0;
for (const p of SUBJECT_PLAN) {
  const groupIdx = GROUPS.findIndex((g) => g.code === p.code) + 1;
  p.per.forEach((n, gi) => {
    const grade = gi + 1;
    for (let s = 1; s <= n; s += 1) {
      seq += 1;
      curriculum.push([
        `csub${String(seq).padStart(3, '0')}`,
        `${p.code}_${grade}${String(s).padStart(2, '0')}`,
        `${p.code}${grade}${String(s).padStart(2, '0')}`,
        `subj0${groupIdx}`,
        grade, 50, seq, true, String(grade), p.room,
      ]);
    }
  });
}

const HEADER_SUBJECTS = ['id', 'name', 'sort_order'];
const HEADER_CLASSES = ['id', 'grade', 'class_num', 'name'];
const HEADER_ROOMS = ['id', 'name', 'room_type', 'seats', 'grades', 'is_active', 'notes'];
const HEADER_CURRICULUM = ['id', 'name', 'short_name', 'subject_id', 'grade', 'default_duration', 'sort_order', 'is_active', 'offer_grades', 'default_room_id'];

const files = [
  ['subject_groups.csv', csv(HEADER_SUBJECTS, subjects)],
  ['classes.csv', csv(HEADER_CLASSES, classes)],
  ['basic_rooms.csv', csv(HEADER_ROOMS, rooms)],
  ['curriculum_subjects.csv', csv(HEADER_CURRICULUM, curriculum)],
];

for (const [name, text] of files) {
  fs.writeFileSync(path.join(SEED_DIR, name), text, 'utf8');
}

console.log(`[basic-seed] クラス${classes.length}・教科${subjects.length}・科目${curriculum.length}・教室${rooms.length} を data/seed/ へ書き出した`);
console.log(`[basic-seed] 科目の先頭=${curriculum[0][1]} 最後=${curriculum[curriculum.length - 1][1]}`);
