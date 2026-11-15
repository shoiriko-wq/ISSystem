/**
 * ISSystem 定期考査 基本情報 CSV 一括登録 UI (仕様書 §5・§7)
 * 基本情報タブ（クラス・科目・教室）と 実施科目の決定 のデータを CSV で一括登録する教務部カード。
 * - セクションを選ぶとテンプレート CSV (UTF-8 BOM) をダウンロードできる
 * - CSV を選ぶと preview API へ送り、実データと突合して行の合否を表で示す（DB 書き込みなし）
 * - preview は basicinfo のセクション編集ロックを取得する（決定セクションは行単位書き込みなのでロックなし）
 * - 確定ボタンは検証済み全行を CSV 行順に登録する（行単位の書き込みなので先行行は残る＝部分作成あり）
 * 教務部 (KYOMU/ADMIN) のみ表示。exam.basic.ui.js の基本情報タブ末尾にカードを追加して使う。
 */

import { saveBlobAsFile } from '../../api.js';
import { escapeHTML, refreshLucideIcons, showToast } from '../../ui-helpers.js';
import { examApi, examStore, isKyomuUser, sectionCard } from './exam.shared.js';

const SECTIONS = [
  { key: 'class', label: 'クラス・コース' },
  { key: 'subject', label: '科目' },
  { key: 'room', label: '教室・座席数' },
  { key: 'decision', label: '実施科目の決定' },
];

const CSV_NAMES = {
  class: 'classes',
  subject: 'curriculum_subjects',
  room: 'basic_rooms',
  decision: 'exam_subject_decisions',
};

/** 直近のプレビュー（section / preview_id / csvBase64 / 行の合否） */
let current = null;

/** CSV ファイルを base64 へ変換（preview API は csvBase64 を受け取る） */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
    reader.onerror = () => reject(new Error('CSV ファイルを読み込めませんでした。'));
    reader.readAsDataURL(file);
  });
}

/** CSV テキストのデータ行数（ヘッダーを除く） */
function countDataRows(text) {
  const lines = String(text || '').split(/\r\n|\n|\r/).filter((l) => l.trim() !== '');
  return Math.max(0, lines.length - 1);
}

/** テンプレート CSV をダウンロード（サーバー生成の UTF-8 BOM 付き） */
async function downloadTemplate(sectionKey) {
  const r = await examApi.get(`/exam/import/template/${sectionKey}`);
  const csvText = r?.csvText;
  if (!csvText) throw new Error('テンプレートが取得できませんでした。');
  const blob = new Blob([csvText], { type: 'text/csv;charset=utf-8' });
  saveBlobAsFile(blob, `${CSV_NAMES[sectionKey] || sectionKey}-import-template.csv`);
}

/** プレビュー表（行番号・種別・内容・合否） */
function previewTableHtml(rows) {
  if (!rows.length) return '<p class="text-slate-500 text-[12px]">CSV にデータ行がありません。</p>';
  const trs = rows
    .map((r) => {
      const act = r.action === 'create' ? '新規' : r.action === 'update' ? '更新' : 'スキップ';
      const actCls = r.action === 'create' ? 'text-emerald-700' : r.action === 'update' ? 'text-blue-700' : 'text-slate-400';
      const msg = r.ok ? (r.warn.length ? `⚠ ${r.warn.join(' / ')}` : '') : r.errors.join(' / ');
      const okCls = r.ok ? 'text-slate-600' : 'text-red-700 font-bold';
      return `<tr class="border-b border-slate-100">
        <td class="px-2 py-1 text-[11px] text-slate-500">${r.row}</td>
        <td class="px-2 py-1 text-[11px] font-bold ${actCls}">${act}</td>
        <td class="px-2 py-1 text-[11px] text-slate-700">${escapeHTML(r.display)}</td>
        <td class="px-2 py-1 text-[11px] ${okCls}">${escapeHTML(msg)}</td>
      </tr>`;
    })
    .join('');
  return `<table class="w-full border-collapse text-[11px]">
    <thead>
      <tr class="bg-slate-50 text-slate-500">
        <th class="px-2 py-1 text-left">行</th>
        <th class="px-2 py-1 text-left">種別</th>
        <th class="px-2 py-1 text-left">内容</th>
        <th class="px-2 py-1 text-left">合否</th>
      </tr>
    </thead>
    <tbody>${trs}</tbody>
  </table>`;
}

/** カード本体（セクション選択・テンプレート・CSV選択・プレビュー表・確定/取り消し） */
export function importCardHtml(kyomu = isKyomuUser()) {
  if (!kyomu) return '';
  const options = SECTIONS.map((s) => `<option value="${s.key}">${s.label}</option>`).join('');
  return sectionCard(
    'upload',
    'CSV 一括登録',
    'テンプレートをダウンロードして記入し、CSV を選ぶと行の合否を表示します。検証済み行のみ登録されます（教務部のみ）。',
    `
    <div class="ui-exam-import-inner" data-staged="0">
      <div class="flex flex-wrap items-center gap-2">
        <select class="ui-exam-import-section border border-slate-300 rounded px-2 py-1 text-[12px] bg-white">${options}</select>
        <button class="ui-exam-import-template inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50">
          <i data-lucide="download" class="w-3.5 h-3.5"></i> テンプレート
        </button>
        <label class="inline-flex items-center gap-1 rounded border border-slate-300 px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50 cursor-pointer">
          <i data-lucide="file-up" class="w-3.5 h-3.5"></i> CSV を選ぶ
          <input type="file" accept=".csv,text/csv" class="ui-exam-import-file hidden" />
        </label>
      </div>
      <div class="ui-exam-import-summary mt-2 text-[11px] text-slate-600"></div>
      <div class="ui-exam-import-preview mt-2 overflow-x-auto"></div>
      <div class="ui-exam-import-actions mt-2 flex flex-wrap gap-2">
        <button class="ui-exam-import-commit rounded border border-emerald-300 bg-emerald-50 px-2 py-1 text-[11px] font-bold text-emerald-700 hover:bg-emerald-100">
          <i data-lucide="check-circle" class="w-3.5 h-3.5"></i> 検証済み行を登録
        </button>
        <button class="ui-exam-import-cancel rounded border border-slate-300 px-2 py-1 text-[11px] font-bold text-slate-600 hover:bg-slate-50">
          <i data-lucide="x-circle" class="w-3.5 h-3.5"></i> 取り消し
        </button>
      </div>
    </div>`,
  );
}

/** イベント購読（reload は再描画関数、sig は AbortController.signal） */
export function bindImportCard(container, reload, sig) {
  const inner = container.querySelector('.ui-exam-import-inner');
  if (!inner) return;
  const sel = inner.querySelector('.ui-exam-import-section');
  const tmplBtn = inner.querySelector('.ui-exam-import-template');
  const fileInput = inner.querySelector('.ui-exam-import-file');
  const summary = inner.querySelector('.ui-exam-import-summary');
  const preview = inner.querySelector('.ui-exam-import-preview');
  const commitBtn = inner.querySelector('.ui-exam-import-commit');
  const cancelBtn = inner.querySelector('.ui-exam-import-cancel');

  const clear = () => {
    current = null;
    inner.dataset.staged = '0';
    summary.textContent = '';
    preview.innerHTML = '';
    if (fileInput) fileInput.value = '';
  };

  sel.addEventListener('change', () => clear(), { signal: sig });

  tmplBtn.addEventListener(
    'click',
    async () => {
      try {
        await downloadTemplate(sel.value);
        showToast('テンプレートをダウンロードしました。', 'success');
      } catch (e) {
        showToast(String(e?.message || 'テンプレート取得に失敗しました。'), 'error');
      }
    },
    { signal: sig },
  );

  fileInput.addEventListener(
    'change',
    async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      summary.innerHTML = '<span class="text-slate-500">CSV を検証しています…</span>';
      preview.innerHTML = '';
      try {
        const csvBase64 = await readFileAsBase64(file);
        const res = await examApi.post('/exam/import/preview', {
          section: sel.value,
          exam_master_id: examStore.examId,
          csvBase64,
          fileName: file.name,
        });
        current = { section: sel.value, csvBase64, previewId: res.preview_id, rows: res.rows || [] };
        inner.dataset.staged = '1';
        const lockNote = res.locked
          ? '（このセクションの編集ロックを取得しました）'
          : res.locks?.length
            ? `（編集ロック: ${res.locks.map((l) => l.user_name || l.name).join('・')}）`
            : '';
        summary.innerHTML =
          `<span class="font-bold text-slate-700">CSV: ${escapeHTML(res.fileName)}・全 ${res.total_rows} 行</span>` +
          `<span class="ml-2 font-bold text-emerald-700">登録可能 ${res.valid_rows} 行</span>` +
          `<span class="ml-2 font-bold text-red-700">エラー ${res.invalid_rows} 行</span>` +
          `${lockNote ? `<span class="ml-2 text-slate-500">${escapeHTML(lockNote)}</span>` : ''}`;
        preview.innerHTML = previewTableHtml(res.rows || []);
        refreshLucideIcons(preview);
        if (!res.valid_rows) showToast('登録可能な行がありません。エラーを修正してください。', 'error');
      } catch (e) {
        current = null;
        inner.dataset.staged = '0';
        summary.innerHTML = '';
        preview.innerHTML = `<p class="text-[11px] text-red-700 font-bold">${escapeHTML(String(e?.message || 'CSV の検証に失敗しました。'))}</p>`;
        showToast(String(e?.message || 'CSV の検証に失敗しました。'), 'error');
      }
    },
    { signal: sig },
  );

  commitBtn.addEventListener(
    'click',
    async () => {
      if (!current?.rows?.length) {
        showToast('先に CSV を選んで検証してください。', 'error');
        return;
      }
      const rows = current.rows.filter((r) => r.ok).map((r) => r.row);
      if (!rows.length) {
        showToast('登録可能な行がありません。', 'error');
        return;
      }
      const label = { class: 'クラス', subject: '科目', room: '教室', decision: '実施科目' }[current.section] || 'データ';
      commitBtn.disabled = true;
      commitBtn.innerHTML = '<i data-lucide="loader-2" class="w-3.5 h-3.5 animate-spin"></i> 登録中…';
      refreshLucideIcons(commitBtn);
      try {
        const res = await examApi.post('/exam/import/commit', {
          section: current.section,
          exam_master_id: examStore.examId,
          csvBase64: current.csvBase64,
          rows,
        });
        clear();
        const registered = Number(res.registered_count || 0);
        const updated = (res.results || []).filter((r) => r.action === 'update').length;
        const msg = registered
          ? `${registered} 行の${label}を登録しました${updated ? `（そのうち更新 ${updated} 行）` : ''}。`
          : '検証済み行が登録されませんでした。';
        await reload();
        showToast(msg, registered ? 'success' : 'info');
      } catch (e) {
        showToast(String(e?.message || 'CSV 一括登録に失敗しました。'), 'error');
      } finally {
        commitBtn.disabled = false;
        commitBtn.innerHTML = '<i data-lucide="check-circle" class="w-3.5 h-3.5"></i> 検証済み行を登録';
        refreshLucideIcons(commitBtn);
      }
    },
    { signal: sig },
  );

  cancelBtn.addEventListener(
    'click',
    async () => {
      if (!current) {
        showToast('取り消すプレビューがありません。', 'info');
        return;
      }
      try {
        await examApi.post('/exam/import/cancel', {
          section: current.section,
          exam_master_id: examStore.examId,
          csvBase64: current.csvBase64,
        });
        clear();
        showToast('プレビューを取り消しました（編集ロックは解除済み）。', 'info');
        await reload();
      } catch (e) {
        showToast(String(e?.message || '取り消しに失敗しました。'), 'error');
      }
    },
    { signal: sig },
  );

  refreshLucideIcons(inner);
}

export default importCardHtml;

