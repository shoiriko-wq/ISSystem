/**
 * 教科マスタ初期設定移行スクリプト
 * 初期設定（国語・地歴公民・数学・理科・保健体育・芸術・外国語・家庭・情報）以外の
 * 教科を削除し、教員の担当教科 (users.subjects) から該当名称を除去する。
 * 初期設定で欠けている教科は補完する。
 */
import { query } from '../config/database.js';

// src/services/subject.service.js の DEFAULT_SUBJECT_NAMES と同名の初期設定
const KEEP = ['国語', '地歴公民', '数学', '理科', '保健体育', '芸術', '外国語', '家庭', '情報'];
const keepLower = new Set(KEEP.map((n) => String(n).toLowerCase()));

const subjects = (await query('SELECT id, name FROM subjects')).rows;
const removeIds = subjects.filter((s) => !keepLower.has(String(s.name).toLowerCase())).map((s) => s.id);
for (const id of removeIds) {
  await query('DELETE FROM subjects WHERE id = ?', [id]);
}

const users = (await query("SELECT id, subjects FROM users WHERE subjects IS NOT NULL AND subjects <> '[]'")).rows;
let cleanedUsers = 0;
for (const u of users) {
  try {
    const arr = JSON.parse(u.subjects);
    const kept = arr.filter((n) => keepLower.has(String(n).toLowerCase()));
    if (kept.length !== arr.length) {
      await query('UPDATE users SET subjects = ? WHERE id = ?', [JSON.stringify(kept), u.id]);
      cleanedUsers += 1;
    }
  } catch (e) {
    console.warn(`users.subjects parse failed for ${u.id}: ${e.message}`);
  }
}

const present = new Set((await query('SELECT name FROM subjects')).rows.map((s) => String(s.name).toLowerCase()));
for (let i = 0; i < KEEP.length; i++) {
  const key = KEEP[i].toLowerCase();
  if (!present.has(key)) {
    await query("INSERT INTO subjects (id, name, sort_order, color_key) VALUES (?, ?, ?, 'SLATE')", [
      `subj_${i + 1}`,
      KEEP[i],
      i + 1,
    ]);
  }
}

const after = (await query('SELECT id, name, sort_order FROM subjects ORDER BY sort_order ASC, name ASC')).rows;
console.log('deleted subjects:', subjects.filter((s) => removeIds.includes(s.id)).map((s) => s.name));
console.log('cleaned users:', cleanedUsers);
console.log('subjects now:', after.map((s) => s.name));
process.exit(0);
