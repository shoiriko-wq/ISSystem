/**
 * ISSystem CSV 一括登録モジュール (v3.1.15 / 仕様書 §5)
 * - 教務部 (KYOMU/ADMIN) のユーザー管理モーダル内の CSV 一括登録カード
 * - preview (検証) → 承認行選択 → commit (1 トランザクション INSERT)
 * - 初期パスワード変更モーダル (must_change_password=true のアカウントを強制表示、§5)
 */
import { apiPost, apiPut, saveBlobAsFile } from '../api.js';
import { state, setUserSession } from '../state.js';
import { escapeHTML, refreshLucideIcons, showToast, openModal, closeModal } from '../ui-helpers.js';
import { isKyomuUser } from './subjects.module.js';
import { socketClient } from '../socket.js';

const TEMPLATE_COLUMNS = [
  'staff_code',
  'name',
  'role',
  'password',
  'grade',
  'department',
  'email',
  'extension_number',
  'desk_number',
  'group_zone',
  'status_note',
  'subjects'
];

const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** テンプレート CSV (UTF-8 BOM 付き) をこの端末へ保存する */
function downloadTemplate() {
  const header = TEMPLATE_COLUMNS.join(',');
  const sample = [
    'T2026100',
    'サンプル 太郎',
    'TEACHER',
    'Init2026!8',
    '1',
    '１学年',
    'sample@example.com',
    '221',
    'A-12',
    'staff',
    '着任初日',
    '数学,国語'
  ].map(csvCell).join(',');
  const blob = new Blob(['\uFEFF' + header + '\n' + sample + '\n'], { type: 'text/csv;charset=utf-8' });
  saveBlobAsFile(blob, 'issystem-user-import-template.csv');
  showToast('テンプレートをダウンロードしました (UTF-8 BOM 付き・全12列)。', 'info');
}

/** 選択された CSV ファイルを base64 へ変換 (preview API は csvBase64 を受け取る) */
function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.split(',')[1] || '');
    };
    reader.onerror = () => reject(new Error('CSV ファイルを読み込めませんでした。'));
    reader.readAsDataURL(file);
  });
}

let currentPreview = null;

/** プレビュー表示を空へ戻す (取り消し・消費後) */
function clearPreview() {
  currentPreview = null;
  const box = document.getElementById('user-import-preview');
  box?.classList.add('hidden');
  const tbody = document.getElementById('user-import-tbody');
  if (tbody) tbody.innerHTML = '';
  const summary = document.getElementById('user-import-summary');
  if (summary) summary.textContent = '';
}

/**
 * プレビュー結果を表へ描画する。登録可の行はチェック済み、エラー行はチェックボックス無効＋赤で表示 (§5)。
 * @param {Object} res preview API の応答
 */
function renderPreview(res) {
  const box = document.getElementById('user-import-preview');
  const tbody = document.getElementById('user-import-tbody');
  const summary = document.getElementById('user-import-summary');
  if (!box || !tbody) return;

  const valid = res.valid_rows ?? 0;
  const invalid = res.invalid_rows ?? 0;
  if (summary) {
    summary.innerHTML =
      `<span class="font-bold text-main">${escapeHTML(res.fileName || '')}</span> ` +
      `全 ${res.total_rows}行 / <span class="text-success-strong font-bold">登録可 ${valid}行</span> / ` +
      `<span class="text-danger font-bold">登録不可 ${invalid}行</span> ` +
      `<span class="text-muted">(プレビュー有効期限: ${escapeHTML((res.expiresAt || '').slice(0, 16).replace('T', ' '))} JST)</span>`;
  }

  const rows = res.rows || [];
  tbody.innerHTML = rows.map((r) => {
    const errs = (r.errors || []).map((e) => `<div class="text-danger">${escapeHTML(e)}</div>`);
    const cls = r.valid ? 'text-main' : 'text-danger bg-danger-soft';
    const cb = r.valid
      ? `<input type="checkbox" data-row="${r.row_no}" class="user-import-row-check" checked>`
      : `<input type="checkbox" data-row="${r.row_no}" disabled title="登録できません">`;
    return `<tr class="${cls}">
      <td class="p-2 text-center">${cb}</td>
      <td class="p-2 font-mono">${r.row_no}</td>
      <td class="p-2 font-mono">${escapeHTML(r.staff_code || '')}</td>
      <td class="p-2">${escapeHTML(r.name || '')}</td>
      <td class="p-2 font-mono">${escapeHTML(r.role || '')}</td>
      <td class="p-2">${escapeHTML(r.grade ? `${r.grade}年 (所属: ${r.department || '-'})` : (r.department || '-'))}</td>
      <td class="p-2 font-mono">${escapeHTML(r.extension_number || '-')}</td>
      <td class="p-2 font-mono">${escapeHTML(r.desk_number || '-')}</td>
      <td class="p-2">${r.valid ? '<span class="text-success-strong">OK</span>' : errs.join('')}</td>
    </tr>`;
  }).join('');

  box.classList.remove('hidden');
  refreshLucideIcons();
}

/** CSV を preview API へ送る (utf8→base64)。プレビューカードは教務部のみ表示 (§5) */
async function runPreview(file) {
  const resultEl = document.getElementById('user-import-result');
  try {
    const csvBase64 = await readFileAsBase64(file);
    const res = await apiPost('/users/import/preview', { csvBase64, fileName: file.name });
    currentPreview = res;
    renderPreview(res);
    if (resultEl) resultEl.classList.add('hidden');
  } catch (err) {
    clearPreview();
    if (resultEl) {
      resultEl.classList.remove('hidden');
      resultEl.classList.add('text-danger', 'font-semibold');
      resultEl.textContent = err.message;
    }
    showToast(err.message, 'error');
  }
}

/** 承認行を commit API へ送る (1 トランザクション INSERT)。CONSTRAINT 違反は 409 で全ロールバック (§5) */
async function commitSelected() {
  if (!currentPreview) {
    showToast('CSV をアップロードしてください。', 'warning');
    return;
  }
  const boxes = Array.from(document.querySelectorAll('#user-import-tbody input[data-row]'));
  const rowNos = boxes.filter((b) => b.checked && !b.disabled).map((b) => Number(b.dataset.row));
  if (rowNos.length === 0) {
    showToast('登録する行を選択してください。', 'warning');
    return;
  }

  const ok = window.confirm(`${rowNos.length}件を登録します。登録者の初期パスワードは初回ログイン後に自分で変更させる必要があります。よろしいですか？`);
  if (!ok) return;

  const resultEl = document.getElementById('user-import-result');
  try {
    const res = await apiPost('/users/import/commit', { preview_id: currentPreview.preview_id, rows: rowNos });
    if (resultEl) {
      resultEl.classList.remove('hidden');
      resultEl.classList.add('text-success-strong', 'font-semibold');
      resultEl.classList.remove('text-danger');
      resultEl.textContent = res.message || `${res.created_count}件を登録しました。`;
    }
    showToast(`${res.created_count}件の教職員アカウントを登録しました (must_change_password=1)。`, 'success');
    clearPreview();
    document.dispatchEvent(new CustomEvent('users:imported'));
  } catch (err) {
    if (resultEl) {
      resultEl.classList.remove('hidden');
      resultEl.classList.add('text-danger', 'font-semibold');
      resultEl.classList.remove('text-success-strong');
      resultEl.textContent = err.message;
    }
    showToast(err.message, 'error');
    // 消費済みプレビューは使えない。CSV をアップロードし直す (§5)
    clearPreview();
  }
}

/**
 * 初期パスワード変更モーダルの表示制御 (v3.1.15 §5)。
 * @param {Object} user state.currentUser
 * @returns {boolean} true のときモーダルを表示した (アプリ系 API は 403 で遮断されている)
 */
export function applyPasswordGate(user = state.currentUser) {
  const must = user && (user.must_change_password === true || user.must_change_password === 1);
  const modal = document.getElementById('password-change-modal');
  if (modal) modal.classList.toggle('hidden', !must);
  if (must) {
    document.getElementById('forced-password-form')?.reset();
    const errEl = document.getElementById('forced-password-error');
    if (errEl) errEl.classList.add('hidden');
    refreshLucideIcons();
  }
  return Boolean(must);
}

/** 変更フォームのイベント配線 (currentPassword + newPassword)。成功で must_change_password は 0 へ (§5) */
function wirePasswordGate() {
  const form = document.getElementById('forced-password-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const current = document.getElementById('forced-current-password')?.value || '';
    const next = document.getElementById('forced-new-password')?.value || '';
    const confirm = document.getElementById('forced-new-password-confirm')?.value || '';
    const errEl = document.getElementById('forced-password-error');
    errEl?.classList.add('hidden');

    if (next.length < 8) {
      if (errEl) { errEl.textContent = '新しいパスワードは8文字以上で入力してください。'; errEl.classList.remove('hidden'); }
      return;
    }
    if (next !== confirm) {
      if (errEl) { errEl.textContent = '新しいパスワードが確認入力と一致しません。'; errEl.classList.remove('hidden'); }
      return;
    }

    try {
      const res = await apiPut('/auth/change-password', { currentPassword: current, newPassword: next });
      const updated = { ...(state.currentUser || {}), must_change_password: false };
      setUserSession(updated, res.token || state.authToken);
      closeModal('password-change-modal');
      socketClient.init();
      showToast(res.message || 'パスワードを変更しました。アプリが利用できます。', 'success');
      document.dispatchEvent(new CustomEvent('password:changed'));
    } catch (err) {
      console.warn('[PasswordGate] 変更失敗:', err.message);
      if (errEl) { errEl.textContent = err.message; errEl.classList.remove('hidden'); }
    }
  });

  document.getElementById('forced-logout-btn')?.addEventListener('click', () => {
    closeModal('password-change-modal');
    document.dispatchEvent(new CustomEvent('auth:logout'));
  });
}

/** 教務部 (KYOMU/ADMIN) のみ CSV 一括登録カードを表示する (§5) */
export function applyUserImportCardVisibility() {
  document.getElementById('user-import-card')?.classList.toggle('hidden', !isKyomuUser());
}

/**
 * 初期パスワード変更モーダルを閉じられなくする (§5: 変更完了までアプリを利用させない)。
 * ui-helpers の背景クリック・ESC で閉じる共通ルールより capture で先に処理して遮断する。
 */
function blockPasswordModalClose() {
  const modal = document.getElementById('password-change-modal');
  if (!modal) return;

  modal.addEventListener('click', (e) => {
    if (e.target === modal) {
      e.stopPropagation();
      showToast('初期パスワードの変更が完了するまでアプリは利用できません。', 'warning');
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) {
      e.stopPropagation();
      showToast('「ログアウト」ボタンでのみこの画面を閉じられます。', 'warning');
    }
  }, true);
}

/**
 * モジュール初期化 (init 内で1回呼ぶ)
 */
export function initUserImportModule() {
  document.getElementById('user-import-template-btn')?.addEventListener('click', downloadTemplate);

  document.getElementById('user-import-file')?.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    const nameEl = document.getElementById('user-import-filename');
    if (nameEl) nameEl.textContent = file ? file.name : '未選択';
    if (file) runPreview(file);
    e.target.value = ''; // 同一ファイルを再選択できる
  });

  document.getElementById('user-import-commit-btn')?.addEventListener('click', commitSelected);
  document.getElementById('user-import-cancel-btn')?.addEventListener('click', clearPreview);

  wirePasswordGate();
  blockPasswordModalClose();
  applyUserImportCardVisibility();
  refreshLucideIcons();
}

export default initUserImportModule;
