/**
 * ISSystem 基本情報マスタ 初期データ CSV ローダー (scripts/seed-data.js)
 *
 * 初期データはコード（サーバー側のホワイトリスト）に固定せず、`data/seed/*.csv` で保持する。
 * 対象テーブルが **空のときだけ** CSV を投入する（運用で作り替えたマスタへは触らない）。
 * 投入順序: 教科 (subjects) → クラス (classes) → 教室 (basic_rooms) → 科目 (curriculum_subjects)
 * 科目の offerings が空の行は、offer_grades の学年に属する全クラス + room_id の教室で自動生成する。
 *
 * CSV 仕様: BOM・CRLF・引用符（"" で内側の引用符をエスケープ）に対応。
 *          `#` で始まる行と空行は無視する。id が空の行は自動採番 (cls001 / subj001 / room001 / csub001)。
 *          Excel で編集して上書き保存できる（UTF-8・カンマ区切り）。
 *
 * 実行: npm run db:seed:csv  （`--force` で空チェックを無視して投入）
 *      node scripts/seed-data.js [--force]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query, closeDatabase } from '../config/database.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const SEED_DIR = path.resolve(__dirname, '..', 'data', 'seed');

/** CSV を行オブジェクトへパースする（引用符・"" エスケープ・CRLF・BOM 対応） */
export function parseCsv(text) {
  const src = String(text ?? '').replace(/\uFEFF/g, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    if (field) pushField();
    if (row.length) rows.push(row);
    row = [];
  };

  while (i < src.length) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === ',') {
      pushField();
      i += 1;
      continue;
    }
    if (ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '\n') {
      pushRow();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  pushRow();

  const dataRows = rows.filter((r) => r.length > 1 && !String(r[0] ?? '').trimStart().startsWith('#'));
  if (dataRows.length < 2) return [];
  const header = dataRows[0].map((h) => String(h).trim().toLowerCase());
  return dataRows.slice(1).map((r) => {
    const obj = {};
    header.forEach((key, idx) => {
      obj[key] = r[idx] ?? '';
    });
    return obj;
  });
}

/** 文字列を JSON 配列テキストへ正規化する（空・'' は '[]'） */
function toJsonArray(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '[]';
  try {
    const parsed = JSON.parse(s);
    return JSON.stringify(Array.isArray(parsed) ? parsed : [parsed]);
  } catch {
    return '[]';
  }
}

function toNumber(raw, fallback = 0) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) ? n : fallback;
}

function toBool(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return true;
  return s === 'true' || s === '1' || s === 'yes' || s === 'はい';
}

/** 投入するマスタの定義（投入順序が外部キーの順序になる） */
export const SEED_SPECS = [
  { table: 'subjects', file: 'subject_groups.csv', idPrefix: 'subj', required: ['name'], numeric: ['sort_order'] },
  { table: 'classes', file: 'classes.csv', idPrefix: 'cls', required: ['grade', 'name'], numeric: ['grade', 'class_num'] },
  { table: 'basic_rooms', file: 'basic_rooms.csv', idPrefix: 'room', required: ['name'], numeric: ['seats'], json: ['grades'] },
  {
    table: 'curriculum_subjects',
    file: 'curriculum_subjects.csv',
    idPrefix: 'csub',
    required: ['name'],
    numeric: ['grade', 'default_duration', 'sort_order'],
    json: ['offerings'],
    // offerings が空の行は offer_grades（実施学年）+ default_room_id から自動生成する
    derive: (ctx, raw, out) => {
      if (String(out.offerings ?? '') === '[]') {
        const grades = String(raw.offer_grades ?? raw.grade ?? '')
          .split(/[/、,，\s]+/)
          .map((g) => Number(g))
          .filter((g) => Number.isInteger(g) && g > 0);
        const roomId = out.default_room_id ?? null;
        const built = [];
        for (const g of grades) {
          for (const c of ctx.classes) {
            if (Number(c.grade) === g) {
              built.push({ grade: g, class_course_id: String(c.id), room_id: roomId ? String(roomId) : null });
            }
          }
        }
        built.sort((a, b) => a.grade - b.grade || String(a.class_course_id).localeCompare(String(b.class_course_id), 'ja'));
        out.offerings = JSON.stringify(built);
      }
    },
  },
];

const columnCache = new Map();

/** テーブルに存在する列名を調べる（CSV の運用専用列・DB に無い列は安全に無視する） */
async function availableColumns(table, runQuery) {
  if (columnCache.has(table)) return columnCache.get(table);
  const res = await runQuery(`SELECT column_name FROM information_schema.columns WHERE table_name = $1`, [table]);
  const set = new Set(res.rows.map((r) => String(r.column_name).toLowerCase()));
  columnCache.set(table, set);
  return set;
}

async function tableRowCount(table, runQuery) {
  const res = await runQuery(`SELECT count(*) AS n FROM ${table}`);
  return Number(res.rows?.[0]?.n) || 0;
}

/**
 * 空のテーブルへ CSV の初期データを投入する
 * @param {{ runQuery?: Function, force?: boolean }} options
 * @returns {Promise<Array<{ table: string, file: string, inserted: number }>>}
 */
export async function seedInitialData(options = {}) {
  const runQuery = options.runQuery ?? query;
  const force = options.force === true;
  const results = [];
  const ctx = { classes: [] };

  for (const spec of SEED_SPECS) {
    const filePath = path.join(SEED_DIR, spec.file);
    if (!fs.existsSync(filePath)) {
      console.warn(`[Seed CSV] ${spec.file} が見つかりません（${spec.table} はスキップ）。`);
      continue;
    }
    if (!force && (await tableRowCount(spec.table, runQuery)) > 0) {
      results.push({ table: spec.table, file: spec.file, inserted: 0 });
      continue;
    }

    const rows = parseCsv(fs.readFileSync(filePath, 'utf8'));
    const columns = await availableColumns(spec.table, runQuery);
    if (spec.table === 'curriculum_subjects') ctx.classes = await loadClasses(runQuery);

    let inserted = 0;
    for (let idx = 0; idx < rows.length; idx += 1) {
      const raw = rows[idx];
      const out = {};
      let missing = false;

      for (const key of spec.required) {
        if (!String(raw[key] ?? '').trim()) missing = true;
      }
      if (missing) {
        console.warn(`[Seed CSV] ${spec.file} ${idx + 1}行目は必須項目が空のためスキップします。`);
        continue;
      }

      for (const key of Object.keys(raw)) {
        if (!columns.has(key)) continue;   // CSV の運用専用列 (offer_grades など) は DB へ書かない
        const rawVal = raw[key];
        if (spec.numeric?.includes(key)) out[key] = toNumber(rawVal);
        else if (key === 'is_active') out[key] = toBool(rawVal);
        else if (spec.json?.includes(key)) out[key] = toJsonArray(rawVal);
        else {
          const trimmed = String(rawVal ?? '').trim();
          out[key] = trimmed === '' ? null : trimmed;
        }
      }

      if (!out.id) out.id = `${spec.idPrefix}${String(idx + 1).padStart(3, '0')}`;
      if (spec.derive) spec.derive(ctx, raw, out);

      const keys = Object.keys(out);
      const cols = keys.join(', ');
      const placeholders = keys.map((_, k) => `$${k + 1}`).join(', ');
      await runQuery(
        `INSERT INTO ${spec.table} (${cols}) VALUES (${placeholders}) ON CONFLICT (id) DO NOTHING`,
        keys.map((k) => out[k])
      );
      inserted += 1;
    }

    results.push({ table: spec.table, file: spec.file, inserted });
  }

  return results;
}

/** CLI (node scripts/seed-data.js [--force]) */
const isCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isCli) {
  const force = process.argv.includes('--force');
  try {
    const results = await seedInitialData({ force });
    const total = results.reduce((sum, r) => sum + r.inserted, 0);
    console.log(`[Seed CSV] 初期マスタデータ投入: ${results.map((r) => `${r.table}=${r.inserted}件`).join(' / ')} 合計 ${total}件`);
    if (!total) console.log('[Seed CSV] 対象テーブルが空ではなかったため、CSVからの投入は行いませんでした。');
  } catch (err) {
    console.error('❌ [Seed CSV] 投入に失敗しました:', err.message);
    process.exitCode = 1;
  } finally {
    await closeDatabase();
  }
}

export default seedInitialData;


/** クラス一覧 (科目の offerings 自動生成用) */
async function loadClasses(runQuery) {
  const res = await runQuery(`SELECT id, grade FROM classes ORDER BY grade ASC, id ASC`);
  return res.rows.map((c) => ({ id: String(c.id), grade: Number(c.grade) || 0 }));
}
