/**
 * ISSystem 教職員 CSV 一括登録 Service
 *
 * 2026-11-15 追加:
 *  - CSV をアップロードして教職員アカウントを一括登録する。
 *    `POST /api/users/import/preview` (プレビュー + 検証) → `POST /api/users/import/commit` (確定) の2段階。
 *  - 一括登録で設定した初期パスワードは必ず自分で変更させる (`users.must_change_password = 1`)。
 *    フラグが 1 の間はアプリ系 API が 403 で止まる (`app.js` の `requirePasswordSet`)。
 *  - 検証は実 DB との突合で行う。PostgreSQL の FK / UNIQUE は文レベルで即検出されるため、
 *    DB に無いテストデータ (架空のユーザー id 等) では検出できない (AGENTS.md 第10条)。
 *    commit は単一トランザクションで users を INSERT し seating_status の座席セルを UPSERT する。
 *    1件でも CONSTRAINT violation が出たら ROLLBACK して 409 を返す (部分作成なし)。
 *  - プレビューの bcrypt ハッシュはメモリ内 staging にだけ置く。API レスポンスには一切出さない。
 *  - 権限: 教務部 KYOMU/ADMIN のみ (`requireKyomuRole`)。ADMIN は role を指定できるが、
 *    KYOMU が作成できる role は TEACHER 固定 (ADMIN/KYOMU への権限昇格抑止)。
 *  - プレビュー ID はランダム128bit・有効期限15分・1発行者あたり最大5件・消費済みは再利用不可。
 *  - 監査ログ `USER_IMPORT` (作成件数・発行者) を記録する。
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import config from '../../config/default.js';
import userModel from '../models/user.model.js';
import auditModel from '../models/audit.model.js';
import subjectModel from '../models/subject.model.js';
import { getDb, pool } from '../../config/database.js';
import { parseCsv } from '../../scripts/seed-data.js';
import { ApiError } from '../middlewares/error.middleware.js';

const BCRYPT_ROUNDS = 10;

/** CSV の必須列 (氏名・教職員番号・初期パスワード・ロール) */
export const REQUIRED_COLUMNS = ['staff_code', 'name', 'password', 'role'];

/** 許可 role (追加の権限は作らない — ADMIN / KYOMU / TEACHER の3つだけ) */
export const ALLOWED_ROLES = ['TEACHER', 'KYOMU', 'ADMIN'];

/** プレビューの有効期限 (分), 1発行者の同時保持数, 1回の登録の行数上限 */
export const PREVIEW_TTL_MINUTES = 15;
export const PREVIEW_MAX_PER_ISSUER = 5;
export const IMPORT_MAX_ROWS = 100;

// プレビュー staging (bcrypt ハッシュはこのメモリ内にのみ置く。レスポンスには出さない)
const previews = new Map();

function sweepPreviews() {
  const now = Date.now();
  for (const [id, p] of previews) {
    if (p.expiresAt.getTime() < now) previews.delete(id);
  }
}

/** ロール文字列をホワイトリストへ正規化 (大文字化 + 日本語略称の受容) */
function normalizeRole(raw) {
  const s = String(raw ?? '').trim();
  const up = s.toUpperCase();
  if (up === 'TEACHER' || s === '教員') return 'TEACHER';
  if (up === 'KYOMU' || s === '教務') return 'KYOMU';
  if (up === 'ADMIN' || s === '管理者') return 'ADMIN';
  return null;
}

/** 初期パスワードの検証 (8文字以上・72文字以下 = bcrypt の上限) */
function validatePassword(raw) {
  const pw = String(raw ?? '');
  if (pw.length < 8) return '初期パスワードは8文字以上です。';
  if (pw.length > 72) return '初期パスワードは72文字以下です。';
  return null;
}

/** メール形式 (任意項目。書かれていれば検証) */
function validateEmail(raw) {
  const email = String(raw ?? '').trim();
  if (!email) return null;
  if (email.length > 120) return 'email が長すぎます。';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'email の形式が不正です。';
  return null;
}

/**
 * CSV テキストを行オブジェクト集合へ変換する (前処理)。
 * 列名は trim + 小文字へ正規化し、`#` で始まる行と空行は無視する (seed と同一規則)。
 * @param {string} text
 * @param {string[]} expectedColumns
 * @returns {Array<Object>}
 */
export function csvToRows(text, expectedColumns = REQUIRED_COLUMNS) {
  const raw = parseCsv(text);
  if (raw.length === 0) throw new ApiError(400, 'CSV にデータ行がありません。');
  const normalized = raw.map((row) => {
    const out = {};
    for (const key of Object.keys(row)) out[key.trim().toLowerCase()] = row[key];
    return out;
  });
  const headerKeys = new Set(Object.keys(normalized[0]).map((k) => k.trim().toLowerCase()));
  const missing = expectedColumns.filter((c) => !headerKeys.has(c));
  if (missing.length > 0) {
    throw new ApiError(
      400,
      `CSV の必須列がありません: ${missing.join(', ')} (氏名・教職員番号・初期パスワード・ロール)`
    );
  }
  return normalized;
}

/**
 * CSV の行集合を検証し、登録可能行とエラー行へ分離する (実 DB と突合)。
 * @param {Array<Object>} rows csvToRows の結果
 * @param {Object} issuer 発行者 { role, is_kyomu }
 * @returns {Promise<Array<Object>>} [{row_no, staff_code, name, role, grade, department, email,
           extension_number, desk_number, group_zone, status_note, subjects, valid, errors}]
 */
export async function validateRows(rows, issuer) {
  const listAll = typeof userModel.listAll === 'function' ? await userModel.listAll() : [];
  const existingStaff = new Set(listAll.map((u) => String(u.staff_code || '').trim().toLowerCase()));
  const existingEmail = new Set(
    listAll.map((u) => String(u.email || '').trim().toLowerCase()).filter((e) => e)
  );

  const master = typeof subjectModel.listSubjects === 'function' ? await subjectModel.listSubjects() : [];
  const subjectNames = new Set(master.map((s) => String(s.name).trim().toLowerCase()));

  const canPrivileged = issuer.role === 'ADMIN';
  const seenStaff = new Map();

  const out = [];
  rows.forEach((raw, idx) => {
    const errors = [];
    const rowNo = Number(raw.row_no) || idx + 1;
    const staffCode = String(raw.staff_code || '').trim();
    const name = String(raw.name || '').trim();
    const role = normalizeRole(raw.role);
    const pwErr = validatePassword(raw.password);
    const email = String(raw.email || '').trim();

    if (!staffCode) errors.push('教職員番号が空です。');
    else if (staffCode.length > 40) errors.push('教職員番号が長すぎます (40文字以下)。');
    else if (!/^[A-Za-z0-9._-]+$/.test(staffCode)) errors.push('教職員番号は半角英数字と . _ - のみ使用できます。');
    if (!name) errors.push('氏名が空です。');
    else if (name.length > 60) errors.push('氏名が長すぎます (60文字以下)。');
    if (pwErr) errors.push(pwErr);
    if (!role) errors.push('role がホワイトリスト外です (TEACHER / KYOMU / ADMIN のみ)。');

    const key = staffCode.toLowerCase();
    if (staffCode) {
      if (seenStaff.has(key)) errors.push(`同一CSV内で教職員番号 ${staffCode} が重複しています (行 ${seenStaff.get(key)})。`);
      else seenStaff.set(key, rowNo);
      if (existingStaff.has(key)) errors.push('この教職員番号は DB に既に存在します。');
    }

    const emailErr = validateEmail(raw.email);
    if (emailErr) errors.push(emailErr);
    if (email && existingEmail.has(email.toLowerCase())) errors.push('この email は DB に既に存在します。');

    const subjects = String(raw.subjects || '')
      .split(/[,、，\s]+/)
      .map((s) => s.trim())
      .filter((s) => s);
    for (const sub of subjects) {
      if (!subjectNames.has(sub.toLowerCase())) errors.push(`担当教科 ${sub} が教科マスタに存在しません。`);
    }

    // 権限昇格抑止: ADMIN は role を指定できる。KYOMU は TEACHER だけ作成できる
    if (role && role !== 'TEACHER' && !canPrivileged) {
      errors.push('KYOMU は role TEACHER のアカウントのみ作成できます (ADMIN/KYOMU への昇格不可)。');
    }

    const grade = String(raw.grade || '').trim();
    if (grade && !/^[0-9]{1,2}$/.test(grade)) errors.push('grade は数字1〜2桁です。');
    const extension = String(raw.extension_number || '').trim();
    if (extension && !/^[0-9-]{1,16}$/.test(extension)) errors.push('内線番号は数字と - です。');
    const desk = String(raw.desk_number || '').trim();
    if (desk.length > 20) errors.push('desk_number が長すぎます (20文字以下)。');

    out.push({
      row_no: rowNo,
      staff_code: staffCode,
      name,
      role: role || null,
      grade: grade || null,
      department: String(raw.department || '').trim() || null,
      email: email || null,
      extension_number: extension || null,
      desk_number: desk || null,
      group_zone: String(raw.group_zone || '').trim() || 'staff',
      status_note: String(raw.status_note || '').trim() || '',
      subjects,
      raw_password: String(raw.password || ''),
      valid: errors.length === 0,
      errors
    });
  });

  return out;
}

/** プレビュー発行 (検証結果と staging をメモリへ保持し、ハッシュはレスポンスに出さない) */
export async function createPreview(csvText, issuer, fileName = '') {
  const rows = csvToRows(csvText);
  if (rows.length > IMPORT_MAX_ROWS) {
    throw new ApiError(400, `CSV は1回 ${IMPORT_MAX_ROWS}行までです (${rows.length}行)。`);
  }
  const validated = await validateRows(rows, issuer);

  const staging = [];
  for (const v of validated) {
    const entry = { ...v };
    delete entry.raw_password;
    if (v.valid) entry.password_hash = await bcrypt.hash(v.raw_password, BCRYPT_ROUNDS);
    staging.push(entry);
  }

  sweepPreviews();
  const mine = Array.from(previews.values()).filter((p) => p.issuerId === issuer.id && !p.consumed);
  if (mine.length >= PREVIEW_MAX_PER_ISSUER) {
    throw new ApiError(429, `未消費のプレビューが ${PREVIEW_MAX_PER_ISSUER}件あります。先に確定してください。`);
  }

  const previewId = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + PREVIEW_TTL_MINUTES * 60 * 1000);
  previews.set(previewId, {
    id: previewId,
    issuerId: issuer.id,
    issuerRole: issuer.role,
    fileName,
    rows: staging,
    createdAt: new Date(),
    expiresAt,
    consumed: false
  });

  return {
    preview_id: previewId,
    fileName,
    total_rows: staging.length,
    valid_rows: staging.filter((r) => r.valid).length,
    invalid_rows: staging.filter((r) => !r.valid).length,
    rows: staging.map(({ raw_password: _pw, password_hash: _hash, ...rest }) => rest),
    expiresAt: expiresAt.toISOString()
  };
}

/** commit 対象行の bcrypt ハッシュ付き staging を取り出す (消費済み・期限切れ・未発見・不正行は 400) */
function takeStaging(previewId, rowNos, issuer) {
  sweepPreviews();
  const p = previews.get(previewId);
  if (!p) throw new ApiError(400, 'プレビューが見つかりません。CSV をアップロードし直してください。');
  if (p.issuerId !== issuer.id) throw new ApiError(403, 'このプレビューを発行した教務アカウントで確定してください。');
  if (p.consumed) throw new ApiError(400, 'このプレビューは既に確定済みです。CSV をアップロードし直してください。');
  if (p.expiresAt.getTime() < Date.now()) {
    previews.delete(previewId);
    throw new ApiError(400, 'プレビューの有効期限 (15分) が切れました。CSV をアップロードし直してください。');
  }
  const wanted = new Set(rowNos.map((n) => Number(n)));
  const picked = p.rows.filter((r) => wanted.has(r.row_no));
  if (picked.length !== wanted.size) throw new ApiError(400, 'commit 対象行がプレビューと一致しません。');
  const invalid = picked.filter((r) => !r.valid);
  if (invalid.length > 0) {
    throw new ApiError(
      400,
      `登録できない行を含められています: 行 ${invalid.map((r) => r.row_no).join(', ')} (検証結果を確認してください)`
    );
  }
  p.consumed = true;
  return picked;
}

/** 監査ログ USER_IMPORT (作成件数・発行者)。失敗は登録を止めない */
async function recordImportAudit(issuer, createdCount, fileName) {
  try {
    await auditModel.logAction({
      userId: issuer.id,
      action: 'USER_IMPORT',
      targetEntity: 'USER',
      targetId: `import:${fileName}`,
      ipAddress: '',
      changesJson: JSON.stringify({ created_count: createdCount, issuer_role: issuer.role, fileName })
    });
  } catch (auditErr) {
    console.warn('[Audit Log Warning]', auditErr.message);
  }
}

/**
 * プレビュー staging の行を 1 トランザクションで DB へ確定する (部分作成なし)。
 * - users INSERT (must_change_password = 1: 初期パスワードは必ず自分で変更させる)
 * - desk_number が書かれた行は seating_status の座席セルを UPSERT (現在の状態=在室)
 * - PostgreSQL の FK / UNIQUE 違反は ROLLBACK して 409 (テストデータでは検出できない)
 */
export async function commitImport(previewId, rowNos, issuer) {
  const picked = takeStaging(previewId, rowNos, issuer);

  // users.subjects は教科マスタの id を格納する。CSV の教科名 → id へ変換してから INSERT する (§5)
  const master = typeof subjectModel.listSubjects === 'function' ? await subjectModel.listSubjects() : [];
  const nameToId = new Map(master.map((s) => [String(s.name).trim().toLowerCase(), String(s.id)]));
  for (const row of picked) {
    // users.id は座席 (seating_status) との FK キー。教職員番号を id に使う (created の id と一致させる)
    row.id = row.staff_code;
    row.subjects = (row.subjects || []).map((n) => nameToId.get(String(n).trim().toLowerCase())).filter(Boolean);
  }

  const client = await pool.connect();
  let created = [];
  try {
    await client.query('BEGIN');
    // FK 検査を COMMIT 直前へ繰延べる (users → seating_status の追加順で FK が先行できるようにする)
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    await userModel.bulkCreate(picked, client);
    created = picked.map((row) => ({
      id: row.staff_code,
      staff_code: row.staff_code,
      name: row.name,
      role: row.role,
      grade: row.grade,
      department: row.department,
      desk_number: row.desk_number,
      must_change_password: true
    }));

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.warn('[UserImport] CONSTRAINT 違反で ROLLBACK:', err.message);
    const e = new ApiError(409, 'データベース制約に抵触したため登録をロールバックしました (作成0件)。');
    e.details = { cause: err.message, code: err.code || null };
    throw e;
  } finally {
    client.release();
  }

  await recordImportAudit(issuer, created.length, previews.get(previewId)?.fileName || '');
  previews.delete(previewId);

  return {
    success: true,
    created_count: created.length,
    created,
    must_change_password: true
  };
}

/**
 * テンプレート CSV (UTF-8 BOM 付き) を生成する (v3.1.15 §5)。
 * 列順は README §5 と同一: staff_code / name / role / grade / department / email /
 * password / extension_number / desk_number / group_zone / status_note / subjects。
 * (検証は列順に依存しない。必須4列 staff_code / name / role / password は REQUIRED_COLUMNS)
 * @returns {{headers: string[], sample: string[], csvText: string}}
 */
export function buildTemplateCsv() {
  const columns = [
    'staff_code',
    'name',
    'role',
    'grade',
    'department',
    'email',
    'password',
    'extension_number',
    'desk_number',
    'group_zone',
    'status_note',
    'subjects'
  ];
  const sample = [
    'T2026100',
    'サンプル 太郎',
    'TEACHER',
    '1',
    '１学年',
    'sample@example.com',
    'Init2026!8',
    '221',
    'A-12',
    'staff',
    '着任初日',
    '数学,国語'
  ];
  const escapeCell = (v) => (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csvText = `\uFEFF${columns.join(',')}\n${sample.map(escapeCell).join(',')}\n`;
  return { headers: columns, sample, csvText };
}

/** テスト・検証用: staging の状態 (ハッシュは返さない) */
export function previewStats() {
  sweepPreviews();
  return {
    count: previews.size,
    ttlMinutes: PREVIEW_TTL_MINUTES,
    maxPerIssuer: PREVIEW_MAX_PER_ISSUER,
    maxRows: IMPORT_MAX_ROWS
  };
}

export const userImportService = {
  createPreview,
  commitImport,
  csvToRows,
  validateRows,
  buildTemplateCsv,
  previewStats,
  REQUIRED_COLUMNS,
  ALLOWED_ROLES,
  PREVIEW_TTL_MINUTES,
  PREVIEW_MAX_PER_ISSUER,
  IMPORT_MAX_ROWS
};
export default userImportService;
