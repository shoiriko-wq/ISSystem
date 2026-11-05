/**
 * クラス・コース初期設定移行スクリプト
 * 初期設定（1-1〜1-7 / 2-1,2-2,2-3,2-4文,2-4理,2-5,2-6看,2-6文,2-7 /
 * 3-1総,3-1人,3-2,3-3,3-4人,3-4数,3-5,3-6数,3-6環,3-7看,3-7総,3-7人,3-8総,3-8人）
 * 以外のクラス・コースを考査参照をCASCADEして削除し、初期設定を補完する。
 */
import { query, ensureSchema } from '../config/database.js';
import basicinfoModel from '../src/models/basicinfo.model.js';

// スキーマ適用（import時自動適用の非同期完了待ち）を先に済ませ、初期データの差し込み順序を固定する
await ensureSchema();

// src/services/basicinfo.service.js の DEFAULT_CLASS_NAMES に対応する内部ID定義
const DEFAULTS = [
  { id: '1-1', grade: 1, num: 1, name: '1-1' },
  { id: '1-2', grade: 1, num: 2, name: '1-2' },
  { id: '1-3', grade: 1, num: 3, name: '1-3' },
  { id: '1-4', grade: 1, num: 4, name: '1-4' },
  { id: '1-5', grade: 1, num: 5, name: '1-5' },
  { id: '1-6', grade: 1, num: 6, name: '1-6' },
  { id: '1-7', grade: 1, num: 7, name: '1-7' },
  { id: '2-1', grade: 2, num: 1, name: '2-1' },
  { id: '2-2', grade: 2, num: 2, name: '2-2' },
  { id: '2-3', grade: 2, num: 3, name: '2-3' },
  { id: '2-4a', grade: 2, num: 4, name: '2-4文' },
  { id: '2-4r', grade: 2, num: 4, name: '2-4理' },
  { id: '2-5', grade: 2, num: 5, name: '2-5' },
  { id: '2-6k', grade: 2, num: 6, name: '2-6看' },
  { id: '2-6a', grade: 2, num: 6, name: '2-6文' },
  { id: '2-7', grade: 2, num: 7, name: '2-7' },
  { id: '3-1s', grade: 3, num: 1, name: '3-1総' },
  { id: '3-1h', grade: 3, num: 1, name: '3-1人' },
  { id: '3-2', grade: 3, num: 2, name: '3-2' },
  { id: '3-3', grade: 3, num: 3, name: '3-3' },
  { id: '3-4h', grade: 3, num: 4, name: '3-4人' },
  { id: '3-4s', grade: 3, num: 4, name: '3-4数' },
  { id: '3-5', grade: 3, num: 5, name: '3-5' },
  { id: '3-6s', grade: 3, num: 6, name: '3-6数' },
  { id: '3-6w', grade: 3, num: 6, name: '3-6環' },
  { id: '3-7k', grade: 3, num: 7, name: '3-7看' },
  { id: '3-7s', grade: 3, num: 7, name: '3-7総' },
  { id: '3-7h', grade: 3, num: 7, name: '3-7人' },
  { id: '3-8s', grade: 3, num: 8, name: '3-8総' },
  { id: '3-8h', grade: 3, num: 8, name: '3-8人' },
];

const keep = new Set(DEFAULTS.map((d) => d.name));

// 1. 初期設定以外のクラス・コースを削除（考査コマ・監督割・プラン・開講設定をCASCADE）
const rows = (await query('SELECT id, name FROM classes')).rows;
const removed = rows.filter((r) => !keep.has(String(r.name)));
for (const r of removed) {
  const cascaded = await basicinfoModel.deleteClass(r.id);
  await query('DELETE FROM exam_room_assignments WHERE class_id = ?', [r.id]);
  console.log(`removed: ${r.name} (${r.id}) cascaded=${JSON.stringify(cascaded)}`);
}

// 2. 初期設定を補完（既存IDは名称・学年・クラス番号を更新）
for (const d of DEFAULTS) {
  await basicinfoModel.createClass({ id: d.id, grade: d.grade, class_num: d.num, name: d.name, short_name: d.name, updated_by: 'system' });
}

const after = (await query('SELECT id, grade, class_num, name FROM classes ORDER BY grade ASC, class_num ASC, id ASC')).rows;
console.log('classes now:', after.map((r) => r.name).join(','));
process.exit(0);
