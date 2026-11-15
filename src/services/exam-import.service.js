/**
 * ISSystem 考査基本情報の CSV 一括登録サービス
 * public/js/modules/exam/exam-import.ui.js と REST 連携する
 *
 * セクション（クラス・コース / 科目 / 教室 / 実施科目の決定）ごとの CSV を
 * 1. preview : パース・検証して staging に一時保存し、編集ロックを取得する
 * 2. commit  : staging のハッシュを照合し、検証済み行のみ既存サービス経由で DB に書き込む
 * 3. cancel  : staging を削除し、取得した編集ロックを解除する
 *
 * 書き込みは basicinfoService.createItem / updateItem と examService.addDecisionRow / saveDecisionRow
 * を呼ぶだけで生 SQL は使わない。監査ログ・cache invalidate・socket 通知は各サービス内部で実行される。
 * 教科マスタ(subject_groups)は書込 API が存在しないため対象外（UI の subjectGroups.js も未実装）。
 */
import crypto from 'node:crypto';
import { parseCsv } from '../../scripts/seed-data.js';
import { basicinfoModel } from '../models/basicinfo.model.js';
import { examModel } from '../models/exam.model.js';
import { basicinfoService } from './basicinfo.service.js';
import { examService } from './exam.service.js';

/** 教務部権限の判定（basicinfo.service.js と同じ規則） */
function isKyomuUser(user) {
  const role = String(user?.role || '').toUpperCase();
  return user?.is_kyomu === true || role === 'KYOMU' || role === 'ADMIN';
}

const PREVIEW_TTL_MS = 30 * 60 * 1000; // preview 有効期限（30分）
const MAX_CSV_BYTES = 2 * 1024 * 1024; // 2MB上限
const MAX_PREVIEW_ROWS = 5000;

// セクション = UI の tab id と一致。kind は basicinfo のセクションロック名（decision は行単位書き込み）
const SECTIONS = {
  class: { kind: 'class', label: 'クラス・コース', key: ['grade', 'name'] },
  subject: { kind: 'subject', label: '科目', key: ['name'] },
  room: { kind: 'room', label: '教室', key: ['name'] },
  decision: { kind: null, label: '実施科目の決定', key: ['subject_name', 'grade'] },
};

// CSV ヘッダー（テンプレートと同じ必須列。列名は実テーブルの列名に合わせる）
const CSV_HEADERS = {
  class: ['grade', 'name', 'short_name', 'is_active'],
  subject: ['name', 'subject_id', 'grade', 'sort_order', 'notes'],
  room: ['name', 'seats', 'notes', 'is_active'],
  decision: [
    'subject_name',
    'subject_short',
    'subject_id',
    'grade',
    'stream',
    'scope',
    'setter_teacher_id',
    'patrol_teacher_id',
    'duration_slots',
    'duration_minutes',
    'room_name',
    'notes',
  ],
};

const STREAMS = ['SCIENCE', 'ARTS', 'OTHER'];
const SCOPES = ['ALL', 'GRADE', 'STREAM'];

const SAMPLE_ROW = {
  class: '1,1X,1X,TRUE',
  subject: '国語,国語,1,1,第一教科',
  room: 'A101,40,南校舎3階,TRUE',
  decision: '国語,国,国語,1,OTHER,ALL,田中 太郎,,1,60,A101,',
};

function sectionOf(section) {
  return SECTIONS[String(section || '').trim()] || null;
}

function normalizeName(name) {
  return String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[\s\u3000\uff00-\uffef]+/g, '');
}

function parseYesNo(text, dflt = true) {
  const t = String(text || '')
    .trim()
    .toUpperCase();
  if (t === 'TRUE' || t === '1' || t === 'YES' || t === 'はい') return true;
  if (t === 'FALSE' || t === '0' || t === 'NO' || t === 'いいえ') return false;
  return dflt;
}

function parseIntIn(text, min, max, dflt = null) {
  const t = String(text || '').trim();
  if (t === '') return dflt;
  const n = Number(t);
  if (!Number.isInteger(n) || n < min || n > max) return null;
  return n;
}

function csvNameOf(section) {
  const map = { class: 'classes', subject: 'curriculum_subjects', room: 'basic_rooms', decision: 'exam_subject_decisions' };
  return map[section] || section;
}

// ===== テンプレート（UTF-8 BOM + CRLF。UI の downloadCsv と同じ形式） =====
function templateCsv(section) {
  const s = sectionOf(section);
  if (!s) throw new Error('unknown section');
  return '\uFEFF' + CSV_HEADERS[section].join(',') + '\r\n' + SAMPLE_ROW[section] + '\r\n';
}

// ===== 行ビルダー（CSV列 → 正規化行 + 表示文字列） =====
function buildRows(csv, section) {
  const raw = parseCsv(csv);
  const get = (r, k) => String(r[k] ?? '').trim();
  const rows = [];
  for (const r of raw) {
    if (section === 'class') {
      const name = get(r, 'name');
      const row = {
        grade: parseIntIn(get(r, 'grade'), 1, 6),
        name,
        short_name: get(r, 'short_name') || name,
        is_active: parseYesNo(get(r, 'is_active'), true),
        display: `${name}（${get(r, 'grade')}年 / ${parseYesNo(get(r, 'is_active'), true) ? '有効' : '無効'}）`,
      };
      rows.push(row);
      continue;
    }
    if (section === 'subject') {
      const name = get(r, 'name');
      const group = get(r, 'subject_id');
      const row = {
        name,
        subject_id: group, // 教科マスタ名
        grade: parseIntIn(get(r, 'grade'), 1, 6),
        sort_order: parseIntIn(get(r, 'sort_order'), 0, 500, 0),
        notes: get(r, 'notes') || null,
        display: `${name}（${get(r, 'grade')}年 / 教科: ${group || '（未設定）'}）`,
      };
      rows.push(row);
      continue;
    }
    if (section === 'room') {
      const name = get(r, 'name');
      const seats = parseIntIn(get(r, 'seats'), 0, 200, 40);
      const row = {
        name,
        seats,
        notes: get(r, 'notes') || null,
        is_active: parseYesNo(get(r, 'is_active'), true),
        display: `${name}（座席 ${seats} / ${parseYesNo(get(r, 'is_active'), true) ? '有効' : '無効'}）`,
      };
      rows.push(row);
      continue;
    }
    // decision
    const subjectName = get(r, 'subject_name');
    const grade = parseIntIn(get(r, 'grade'), 1, 6);
    const row = {
      subject_name: subjectName,
      subject_short: get(r, 'subject_short') || subjectName,
      subject_id: get(r, 'subject_id'), // 教科マスタ名（curriculum_subjects.subject_id）
      grade,
      stream: (get(r, 'stream') || 'OTHER').toUpperCase(),
      scope: (get(r, 'scope') || 'ALL').toUpperCase(),
      setter_name: get(r, 'setter_teacher_id'),
      patrol_name: get(r, 'patrol_teacher_id'),
      duration_slots: parseIntIn(get(r, 'duration_slots'), 1, 8, 1),
      duration_minutes: parseIntIn(get(r, 'duration_minutes'), 5, 240, 60),
      room_name: get(r, 'room_name'),
      notes: get(r, 'notes') || null,
      display: `${subjectName}（${get(r, 'grade')}年 / 出題: ${get(r, 'setter_teacher_id') || '未設定'} / ${get(r, 'duration_slots')}時限×${get(r, 'duration_minutes')}分 / 教室: ${get(r, 'room_name') || '未設定'}）`,
    };
    rows.push(row);
  }
  return rows;
}

// ===== 参照データ（検証・名前→ID解決用） =====
async function loadCtx(examId, section, user) {
  const ctx = { classes: [], subjects: [], groups: [], rooms: [], staff: [], decisions: [], phases: null };
  if (section === 'class') ctx.classes = await basicinfoModel.listClasses();
  if (section === 'subject') {
    ctx.subjects = await basicinfoModel.listSubjects();
    ctx.groups = await basicinfoModel.listSubjectGroups();
  }
  if (section === 'room') ctx.rooms = await basicinfoModel.listRooms();
  if (section === 'decision') {
    const board = await examService.listSubjectDecisions(examId, user);
    ctx.decisions = board.decisions || [];
    ctx.phases = board.phases || null;
    ctx.subjects = await basicinfoModel.listSubjects();
    ctx.groups = await basicinfoModel.listSubjectGroups();
    ctx.rooms = await basicinfoModel.listRooms();
    ctx.staff = await examModel.fetchStaffPool();
  }
  return ctx;
}

function findExisting(section, row, ctx) {
  if (section === 'class') {
    return ctx.classes.find((c) => Number(c.grade) === row.grade && normalizeName(c.name) === normalizeName(row.name)) || null;
  }
  if (section === 'subject') {
    return ctx.subjects.find((s) => normalizeName(s.name) === normalizeName(row.name)) || null;
  }
  if (section === 'room') {
    return ctx.rooms.find((r) => normalizeName(r.name) === normalizeName(row.name)) || null;
  }
  return ctx.decisions.find((d) => normalizeName(d.subject_name) === normalizeName(row.subject_name) && Number(d.grade) === row.grade) || null;
}

function resolveStaffId(name, ctx) {
  const n = normalizeName(name);
  const hit = ctx.staff.find((s) => normalizeName(s.name) === n);
  return hit ? String(hit.id) : null;
}

function resolveRoomId(name, ctx) {
  const n = normalizeName(name);
  const hit = ctx.rooms.find((r) => normalizeName(r.name) === n);
  return hit ? String(hit.id) : null;
}

function resolveSubjectId(name, ctx) {
  const n = normalizeName(name);
  const hit = ctx.subjects.find((s) => normalizeName(s.name) === n);
  return hit ? String(hit.id) : null;
}

function resolveGroupId(name, ctx) {
  const n = normalizeName(name);
  const hit = ctx.groups.find((g) => normalizeName(g.name) === n);
  return hit ? String(hit.id) : null;
}


// ===== 検証 =====
function validateRow(section, row, ctx, user) {
  const errors = [];
  const warn = [];
  if (section === 'class') {
    if (row.grade === null) errors.push('grade が不正');
    if (row.name.length < 2) errors.push('name が不正');
    if (row.short_name && row.short_name.length > 32) errors.push('short_name が長すぎ');
    const dupShort = ctx.classes.find((c) => Number(c.grade) === row.grade && normalizeName(c.short_name) === normalizeName(row.short_name) && normalizeName(c.name) !== normalizeName(row.name));
    if (dupShort) warn.push(`short_name ${row.short_name} は ${row.grade}年の ${dupShort.name} と重複`);
    return { ok: errors.length === 0, errors, warn };
  }
  if (section === 'subject') {
    if (row.name.length < 2) errors.push('name が不正');
    if (row.grade === null) errors.push('grade が不正');
    if (!row.subject_id) errors.push('教科名(subject_id) 必須');
    else if (!ctx.groups.find((g) => normalizeName(g.name) === normalizeName(row.subject_id))) errors.push(`教科名(subject_id) ${row.subject_id} が存在しない`);
    const dup = ctx.subjects.find((s) => normalizeName(s.name) === normalizeName(row.name));
    if (dup && Number(dup.grade) !== row.grade) warn.push(`科目名 ${row.name} は ${dup.grade}年に登録済み`);
    return { ok: errors.length === 0, errors, warn };
  }
  if (section === 'room') {
    if (row.name.length < 2) errors.push('name が不正');
    if (row.seats === null) errors.push('seats が不正');
    if (row.seats < 10) warn.push('座席数が10未満');
    return { ok: errors.length === 0, errors, warn };
  }
  // decision
  if (row.subject_name.length < 2) errors.push('subject_name が不正');
  if (row.grade === null) errors.push('grade が不正');
  if (!STREAMS.includes(row.stream)) errors.push(`stream が不正（${STREAMS.join('/')} のいずれか）`);
  if (!SCOPES.includes(row.scope)) errors.push(`scope が不正（${SCOPES.join('/')} のいずれか）`);
  if (row.duration_slots === null) errors.push('duration_slots が不正');
  if (row.duration_minutes === null) errors.push('duration_minutes が不正');
  if (row.subject_id) {
    const groupHit = ctx.groups.find((g) => normalizeName(g.name) === normalizeName(row.subject_id));
    const subjHit = ctx.subjects.find((s) => normalizeName(s.name) === normalizeName(row.subject_id));
    if (!groupHit && !subjHit) errors.push(`subject_id ${row.subject_id} が存在しない`);
  }
  if (row.setter_name && !resolveStaffId(row.setter_name, ctx)) errors.push(`出題者 ${row.setter_name} が教員一覧に存在しない`);
  if (row.patrol_name && !resolveStaffId(row.patrol_name, ctx)) errors.push(`巡回者 ${row.patrol_name} が教員一覧に存在しない`);
  if (row.room_name && !resolveRoomId(row.room_name, ctx)) errors.push(`教室名 ${row.room_name} が教室マスタに存在しない`);
  const kyomu = isKyomuUser(user);
  const phases = ctx.phases;
  if (!kyomu && phases && phases.decision_phase === 'ENDED') errors.push('決定調査終了中は決定行を編集できない');
  return { ok: errors.length === 0, errors, warn };
}

// ===== 1行コミット（既存サービス経由。監査ログ・cache invalidate・socket通知はサービス内部） =====
async function commitRow(section, row, ctx, user, examId) {
  const existing = findExisting(section, row, ctx);
  const action = existing ? 'update' : 'create';
  if (section === 'class') {
    const payload = { grade: row.grade, name: row.name, short_name: row.short_name, is_active: row.is_active };
    const saved = existing ? await basicinfoService.updateItem('class', existing.id, payload, user) : await basicinfoService.createItem('class', payload, user);
    return { action, id: saved?.id ? String(saved.id) : null, name: row.name };
  }
  if (section === 'subject') {
    const payload = { name: row.name, subject_id: row.subject_id, grade: row.grade, sort_order: row.sort_order, notes: row.notes };
    const saved = existing ? await basicinfoService.updateItem('subject', existing.id, payload, user) : await basicinfoService.createItem('subject', payload, user);
    return { action, id: saved?.id ? String(saved.id) : null, name: row.name };
  }
  if (section === 'room') {
    const payload = { name: row.name, seats: row.seats, notes: row.notes, is_active: row.is_active };
    const saved = existing ? await basicinfoService.updateItem('room', existing.id, payload, user) : await basicinfoService.createItem('room', payload, user);
    return { action, id: saved?.id ? String(saved.id) : null, name: row.name };
  }
  // decision — 名前をIDへ解決してから examService 経由で書く
  const payload = {
    exam_master_id: examId,
    subject_name: row.subject_name,
    subject_short: row.subject_short,
    subject_id: row.subject_id ? (resolveSubjectId(row.subject_id, ctx) || resolveGroupId(row.subject_id, ctx)) : null,
    grade: row.grade,
    stream: row.stream,
    scope: row.scope,
    setter_teacher_id: row.setter_name ? resolveStaffId(row.setter_name, ctx) : null,
    patrol_teacher_id: row.patrol_name ? resolveStaffId(row.patrol_name, ctx) : null,
    duration_slots: row.duration_slots,
    duration_minutes: row.duration_minutes,
    room_id: row.room_name ? resolveRoomId(row.room_name, ctx) : null,
    room_name: row.room_name || null,
    notes: row.notes,
  };
  if (existing) {
    const saved = await examService.saveDecisionRow({ ...payload, id: existing.id }, user);
    return { action: 'update', id: existing.id, name: row.subject_name, summary: saved };
  }
  await examService.addDecisionRow(payload, user);
  const created = findExisting(section, row, await loadCtx(examId, section, user));
  return { action: 'create', id: created ? created.id : null, name: row.subject_name };
}


// ===== 編集ロック（basicinfo の exam_basic ロック。decision は行単位書き込みなのでロックなし） =====
async function acquireLock(section, user) {
  const kind = SECTIONS[section].kind;
  if (!kind) return null;
  return await basicinfoService.lockSection(kind, user);
}

async function releaseLock(section, user) {
  const kind = SECTIONS[section].kind;
  if (!kind) return null;
  return await basicinfoService.unlockSection(kind, user);
}

async function isUnlockedByIssuer(section, userId) {
  const kind = SECTIONS[section].kind;
  if (!kind) return true;
  const locks = await basicinfoService.sectionLocks();
  const lock = locks[kind];
  if (!lock) return true;
  return String(lock.user_id) === String(userId);
}

// ===== Staging プレビュー =====
const stagingPreviews = new Map();

function sha1Hex(text) {
  return crypto.createHash('sha1').update(String(text), 'utf-8').digest('hex');
}

function previewIdOf(examId, csv) {
  return sha1Hex(`${examId}:${csv}`);
}

function normalizeRowsCsv(csv) {
  return String(csv)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\uFEFF/g, '')
    .trim();
}

function normalizeJson(str) {
  try {
    return JSON.stringify(JSON.parse(str));
  } catch {
    return String(str || '');
  }
}

function isHashMatch(a, b) {
  return normalizeJson(a) === normalizeJson(b);
}

function normalizeRowsPayload(rows) {
  const arr = Array.isArray(rows) ? rows : [rows];
  const out = arr.map((r) => Number(r)).filter((n) => Number.isInteger(n) && n >= 1);
  return out.sort((a, b) => a - b);
}

async function listStagedIds() {
  return Array.from(stagingPreviews.keys());
}

function pruneExpired() {
  const now = Date.now();
  for (const [id, entry] of stagingPreviews.entries()) {
    if (entry.expiresAt < now) stagingPreviews.delete(id);
  }
}


// ===== API =====
/** CSV preview（パース + 検証 + staging + 編集ロック取得） */
async function previewCsv({ section, examId, csvBase64, fileName = 'import.csv' }, user) {
  const s = sectionOf(section);
  if (!s) {
    const err = new Error('セクションが不正です。');
    err.statusCode = 400;
    throw err;
  }
  if (!isKyomuUser(user)) {
    const err = new Error('CSV 一括登録は教務部 (KYOMU) の権限が必要です。');
    err.statusCode = 403;
    throw err;
  }
  const raw = Buffer.from(String(csvBase64 || ''), 'base64').toString('utf-8');
  if (Buffer.byteLength(raw, 'utf-8') > MAX_CSV_BYTES) {
    const err = new Error('CSV が大きすぎます（2MB上限）');
    err.statusCode = 413;
    throw err;
  }
  const csv = normalizeRowsCsv(raw);
  const rows = buildRows(csv, section);
  if (rows.length > MAX_PREVIEW_ROWS) {
    const err = new Error(`CSV の行数が多すぎます（上限 ${MAX_PREVIEW_ROWS}）`);
    err.statusCode = 413;
    throw err;
  }
  const ctx = await loadCtx(examId, section, user);
  const keySet = new Set();
  const previewRows = [];
  let valid = 0;
  let invalid = 0;
  rows.forEach((row, idx) => {
    const lineNo = idx + 2;
    const key = SECTIONS[section].key.map((k) => row[k]).join('|');
    const keyN = normalizeName(key);
    const dup = keySet.has(keyN);
    keySet.add(keyN);
    const check = validateRow(section, row, ctx, user);
    const existing = findExisting(section, row, ctx);
    const action = dup ? 'skip' : existing ? 'update' : 'create';
    const ok = check.ok && !dup;
    if (ok) valid += 1;
    else invalid += 1;
    previewRows.push({
      row: lineNo,
      key,
      action,
      ok,
      errors: dup ? ['CSV 内でキー重複'] : check.errors,
      warn: check.warn,
      display: row.display,
      row_data: row,
    });
  });
  const previewId = previewIdOf(examId, csv);
  stagingPreviews.set(previewId, {
    section,
    examId,
    fileName,
    csv,
    rows: previewRows,
    issuer: user.id,
    expiresAt: Date.now() + PREVIEW_TTL_MS,
    hash: sha1Hex(csv),
  });
  const locks = [];
  if (s.kind) {
    const lock = await acquireLock(section, user);
    if (lock && lock.user_id) locks.push({ kind: s.kind, user_id: lock.user_id, user_name: lock.user_name });
  }
  return {
    section,
    examId,
    preview_id: previewId,
    fileName,
    total_rows: previewRows.length,
    valid_rows: valid,
    invalid_rows: invalid,
    locked: !!s.kind,
    locks,
    rows: previewRows.map((r) => ({ row: r.row, key: r.key, action: r.action, ok: r.ok, errors: r.errors, warn: r.warn, display: r.display })),
  };
}


/** CSV commit（staging ハッシュ照合 + 検証済み行のみ既存サービス経由で DB へ） */
async function commitRows({ section, examId, csvBase64, rows = [] }, user) {
  const s = sectionOf(section);
  if (!s) {
    const err = new Error('セクションが不正です。');
    err.statusCode = 400;
    throw err;
  }
  if (!isKyomuUser(user)) {
    const err = new Error('CSV 一括登録は教務部 (KYOMU) の権限が必要です。');
    err.statusCode = 403;
    throw err;
  }
  const raw = Buffer.from(String(csvBase64 || ''), 'base64').toString('utf-8');
  const csv = normalizeRowsCsv(raw);
  const previewId = previewIdOf(examId, csv);
  const entry = stagingPreviews.get(previewId);
  if (!entry || entry.expiresAt < Date.now()) {
    const err = new Error('preview 有効期限切れ。再 preview が必要');
    err.statusCode = 400;
    throw err;
  }
  if (entry.issuer !== user.id) {
    const err = new Error('preview を取得したユーザーのみコミットできます。');
    err.statusCode = 403;
    throw err;
  }
  if (!isHashMatch(sha1Hex(csv), entry.hash)) {
    const err = new Error('preview 時の CSV とハッシュが一致しない（race condition）。再 preview が必要');
    err.statusCode = 400;
    throw err;
  }
  const rowSet = normalizeRowsPayload(rows);
  const ctx = await loadCtx(examId, section, user);
  const results = [];
  let registered = 0;
  for (const lineNo of rowSet) {
    const entryRow = entry.rows[lineNo - 2];
    if (!entryRow) {
      const err = new Error(`行番号 ${lineNo} が preview に存在しない`);
      err.statusCode = 400;
      throw err;
    }
    if (!entryRow.ok) {
      const err = new Error(`行 ${lineNo} は登録不可行（preview errors: ${entryRow.errors.join(', ')}）`);
      err.statusCode = 400;
      throw err;
    }
    if (!(await isUnlockedByIssuer(section, user.id))) {
      const err = new Error('編集ロックを他ユーザーが取得した（preview 時に取得したロックを失効）。再 preview が必要');
      err.statusCode = 409;
      throw err;
    }
    const committed = await commitRow(section, entryRow.row_data, ctx, user, examId);
    registered += 1;
    results.push({ row: lineNo, key: entryRow.key, action: committed.action, id: committed.id, name: committed.name });
  }
  stagingPreviews.delete(previewId);
  return { section, examId, registered_count: registered, results };
}

/** CSV cancel（preview を破棄し、取得した編集ロックを解除） */
async function cancelPreview({ section, examId, csvBase64 }, user) {
  const csv = normalizeRowsCsv(Buffer.from(String(csvBase64 || ''), 'base64').toString('utf-8'));
  const previewId = previewIdOf(examId, csv);
  const entry = stagingPreviews.get(previewId);
  if (!entry) return { cancelled: false };
  if (entry.issuer !== user.id) {
    const err = new Error('preview を取得したユーザーのみ取り消しできます。');
    err.statusCode = 403;
    throw err;
  }
  stagingPreviews.delete(previewId);
  if (SECTIONS[section].kind) {
    try {
      await releaseLock(section, user);
    } catch (e) {
      console.warn('[exam-import] cancel release lock failed', e);
    }
  }
  return { cancelled: true };
}

/** 期限切れ preview 一斉 cleanup（ADMIN 専用） */
async function cleanupStagedPreviews() {
  const before = stagingPreviews.size;
  pruneExpired();
  return { removed: before - stagingPreviews.size };
}

async function getTemplate(section) {
  const headers = CSV_HEADERS[section];
  return {
    section,
    headers,
    sample: SAMPLE_ROW[section],
    csvText: templateCsv(section),
    fileName: `${csvNameOf(section)}-import-template.csv`,
    required_columns: headers,
  };
}

export const examImportService = {
  previewCsv,
  commitRows,
  cancelPreview,
  cleanupStagedPreviews,
  getTemplate,
  listStagedIds,
  // 内部状態の snapshot（テスト用）
  _stagingPreviews: stagingPreviews,
};

export default examImportService;

