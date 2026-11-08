/**
 * ISSystem 座席表モジュール
 * ・マトリクス（行・列 1〜100）は編集可能モードでのみ設定できる
 * ・空席・配置済みカードのクリックはユーザセレクトモーダルを開く（行・列・状態の入力欄は無し）
 * ・座席カードは オンライン / 出張・年休 / 所属部局 / 担当教科 / 名前 を表示する
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../api.js';
import { escapeHTML, refreshLucideIcons, openModal, closeModal, showToast } from '../ui-helpers.js';
import { state } from '../state.js';
import { socketClient } from '../socket.js';

/** マトリクスID（編集ロックのリソースIDにも使用） */
const MATRIX_ID = 'staff_room';
/** マトリクスの最大行列数 */
const MAX_SIZE = 100;

const seatingStore = {
  rows: 5,
  cols: 6,
  seats: [],
  editMode: false,
  users: [],
  pendingCell: null,
};

/** 欠席登録のバッヂ表示（当日の LEAVE / TRIP） */
const ABSENCE_BADGES = [
  { type: 'TRIP', label: '出張', badgeClass: 'badge badge-warning' },
  { type: 'LEAVE', label: '年休', badgeClass: 'badge badge-danger' },
];

function headerEl() {
  return document.getElementById('seating-header-container');
}

function matrixEl() {
  return document.getElementById('seating-matrix-container');
}

function seatAt(row, col) {
  return seatingStore.seats.find((s) => s.row === row && s.col === col) || null;
}

/** 1..max の行列選択オプション */
function sizeOptions(max) {
  let html = '';
  for (let n = 1; n <= max; n++) html += `<option value="${n}">${n}</option>`;
  return html;
}

/** 列数に応じたカードの最小幅（狭い列数は横向きスクロールで表示） */
function cardMinWidth(cols) {
  if (cols <= 8) return 120;
  if (cols <= 14) return 104;
  if (cols <= 24) return 84;
  if (cols <= 40) return 66;
  return 54;
}


/**
 * 座席カード（オンラインバッヂ・出張/年休バッヂ・所属部局・担当教科・名前）
 */
function seatCardHtml(seat) {
  const badges = [];
  if (seat.is_online) {
    badges.push('<span class="badge badge-success" title="オンライン">オンライン</span>');
  }
  const absences = Array.isArray(seat.absences) ? seat.absences : [];
  for (const b of ABSENCE_BADGES) {
    if (absences.includes(b.type)) {
      badges.push(`<span class="${b.badgeClass}" title="${b.label}">${b.label}</span>`);
    }
  }

  const department = escapeHTML(seat.department || '');
  const subjects = escapeHTML((Array.isArray(seat.subjects) ? seat.subjects : []).join(' / '));
  const name = escapeHTML(seat.name || '');
  const clickable = seatingStore.editMode;

  return `<div class="seat-card rounded-lg bg-surface border border-main p-1.5 flex flex-col gap-1${clickable ? ' cursor-pointer hover-surface' : ' cursor-default'}" data-seat-row="${seat.row}" data-seat-col="${seat.col}" title="${name}">
    <div class="flex items-center gap-1 flex-wrap">${badges.join('')}</div>
    <div class="text-[10px] text-soft truncate">${department || '-'}</div>
    <div class="text-[11px] text-main truncate">${subjects || '-'}</div>
    <div class="text-xs font-bold text-main truncate">${name}</div>
  </div>`;
}

/**
 * 空席セル（編集可能モードでのみクリックできる）
 */
function emptySeatHtml(row, col) {
  const clickable = seatingStore.editMode;
  return `<div class="seat-card seat-card--empty rounded-lg bg-surface-transparent border border-dashed border-main p-1.5 flex items-center justify-center min-h-[3rem]${clickable ? ' cursor-pointer hover-surface' : ' cursor-default'}" data-seat-row="${row}" data-seat-col="${col}">
    <span class="text-[10px] text-soft">${row}-${col}</span>
  </div>`;
}

/**
 * ヘッダー描画（タイトル「座席表」・行列設定・編集ロック切替）
 */
function renderHeader() {
  const el = headerEl();
  if (!el) return;

  const editMode = seatingStore.editMode;
  el.innerHTML = `
    <div class="flex items-center gap-3 flex-wrap">
      <h2 class="text-lg font-bold text-main flex items-center gap-2">
        <i data-lucide="users" class="w-5 h-5 text-accent"></i> 座席表
      </h2>
      <div class="flex items-center gap-2 ml-auto flex-wrap">
        <label class="text-xs font-semibold text-soft" for="seat-grid-rows">行</label>
        <select id="seat-grid-rows" class="input-field h-[2.4rem] w-14 p-1 text-xs rounded bg-surface border border-main text-main" ${editMode ? '' : 'disabled'}>${sizeOptions(MAX_SIZE)}</select>
        <label class="text-xs font-semibold text-soft" for="seat-grid-cols">列</label>
        <select id="seat-grid-cols" class="input-field h-[2.4rem] w-14 p-1 text-xs rounded bg-surface border border-main text-main" ${editMode ? '' : 'disabled'}>${sizeOptions(MAX_SIZE)}</select>
        <button id="seating-edit-toggle" type="button" class="${editMode ? 'btn-primary' : 'btn-secondary'} h-[2.4rem] px-3 text-xs font-bold rounded flex items-center gap-1.5" title="${editMode ? 'クリックで編集ロック（読み取り専用）へ' : 'クリックで編集可能モードへ'}">
          <i data-lucide="${editMode ? 'lock-open' : 'lock'}" class="w-4 h-4"></i>
          <span>${editMode ? '編集可能' : '編集ロック'}</span>
        </button>
      </div>
    </div>
  `;

  const rowsSelect = el.querySelector('#seat-grid-rows');
  const colsSelect = el.querySelector('#seat-grid-cols');
  rowsSelect.value = String(seatingStore.rows);
  colsSelect.value = String(seatingStore.cols);

  rowsSelect.addEventListener('change', () => {
    applyGridSize(parseInt(rowsSelect.value, 10), seatingStore.cols);
  });
  colsSelect.addEventListener('change', () => {
    applyGridSize(seatingStore.rows, parseInt(colsSelect.value, 10));
  });

  el.querySelector('#seating-edit-toggle').addEventListener('click', toggleEditMode);

  refreshLucideIcons();
}

/**
 * マトリクス描画（rows × cols のグリッド）
 */
function renderMatrix() {
  const el = matrixEl();
  if (!el) return;

  const minW = cardMinWidth(seatingStore.cols);
  const cells = [];
  for (let row = 1; row <= seatingStore.rows; row++) {
    for (let col = 1; col <= seatingStore.cols; col++) {
      const seat = seatAt(row, col);
      cells.push(seat ? seatCardHtml(seat) : emptySeatHtml(row, col));
    }
  }

  el.innerHTML = `<div class="seating-grid gap-2" style="grid-template-columns: repeat(${seatingStore.cols}, minmax(${minW}px, 1fr));">${cells.join('')}</div>`;
}

/**
 * 編集可能モード ⇔ 編集ロックモード の切替（サーバーの排他ロックと連動）
 */
async function toggleEditMode() {
  const toggle = document.getElementById('seating-edit-toggle');
  if (toggle) toggle.disabled = true;

  try {
    if (seatingStore.editMode) {
      await apiDelete('/seating/matrix/lock');
      seatingStore.editMode = false;
      showToast('編集ロックモードへ切り替えました（読み取り専用）。', 'info');
    } else {
      await apiPost('/seating/matrix/lock', { resourceId: MATRIX_ID });
      seatingStore.editMode = true;
      showToast('編集可能モードへ切り替えました。行列と席を編集できます。', 'success');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }

  renderHeader();
  renderMatrix();
}

/**
 * マトリクス（行列＋席割当て）の保存。編集可能モードでのみ成功する
 * @param {Object} [options] - { silent: true } でトースト省略
 */
async function persistMatrix(options = {}) {
  const res = await apiPut('/seating/matrix', {
    resourceId: MATRIX_ID,
    rows: seatingStore.rows,
    cols: seatingStore.cols,
    seats: seatingStore.seats.map((s) => ({ row: s.row, col: s.col, user_id: s.user_id })),
  });

  if (!options.silent) {
    showToast(res.message || '座席表を保存しました。', 'success');
  }

  // 他クライアントへ再読込通知 (KYOMU / ADMIN のみサーバーがブロードキャスト)
  try {
    socketClient.emitGridUpdated(MATRIX_ID);
  } catch {
    /* ソケット未接続時は通知を省略 */
  }

  return res;
}

/**
 * 行列設定の適用（範囲外の席はマトリクスから除き、編集モードなら保存）
 */
async function applyGridSize(rows, cols) {
  const r = Math.min(MAX_SIZE, Math.max(1, Number(rows) || 1));
  const c = Math.min(MAX_SIZE, Math.max(1, Number(cols) || 1));

  seatingStore.rows = r;
  seatingStore.cols = c;
  seatingStore.seats = seatingStore.seats.filter((s) => s.row <= r && s.col <= c);

  renderMatrix();

  try {
    await persistMatrix({ silent: true });
  } catch (err) {
    showToast(err.message, 'error');
  }
}

/**
 * 登録ユーザ一覧の取得（モーダルのユーザセレクト用・キャッシュ）
 */
async function ensureUsers() {
  if (seatingStore.users.length) return seatingStore.users;

  const res = await apiGet('/users');
  seatingStore.users = res.users || [];
  return seatingStore.users;
}

/**
 * 席クリック処理（編集可能モードのみモーダルを開く）
 */
function handleSeatClick(e) {
  const card = e.target.closest('[data-seat-row]');
  if (!card) return;

  if (!seatingStore.editMode) {
    showToast('編集可能モードへ切り替えてから席を選択してください。', 'info');
    return;
  }

  const row = parseInt(card.dataset.seatRow, 10);
  const col = parseInt(card.dataset.seatCol, 10);

  if (row > seatingStore.rows || col > seatingStore.cols) return;

  openSeatModal(row, col);
}

/**
 * ユーザセレクトモーダルの表示（席のユーザ割当て／解除）
 * @param {number} row
 * @param {number} col
 */
async function openSeatModal(row, col) {
  seatingStore.pendingCell = { row, col };

  try {
    const users = await ensureUsers();
    const seat = seatAt(row, col);
    const select = document.getElementById('seat-input-user');
    const titleText = document.getElementById('seat-modal-title-text');

    if (titleText) titleText.textContent = `座席設定 (${row}行 - ${col}列)`;

    const options = ['<option value="">設定なし（席を空にする）</option>'];
    for (const u of users) {
      const label = [u.name, u.department, (u.subjects || []).join(' / ')]
        .filter(Boolean)
        .join(' / ');
      const selected = seat && seat.user_id === u.id ? ' selected' : '';
      options.push(`<option value="${u.id}"${selected}>${escapeHTML(label)}</option>`);
    }

    if (select) {
      select.innerHTML = options.join('');
      select.value = seat ? seat.user_id : '';
    }

    openModal('seating-modal');
    if (select) select.focus();
  } catch (err) {
    showToast(err.message || '登録ユーザを取得できませんでした。', 'error');
  }
}

/**
 * モーダル保存（席へのユーザ割当て／解除）
 */
async function handleSeatFormSubmit(e) {
  e.preventDefault();

  const cell = seatingStore.pendingCell;
  if (!cell) return;

  const userId = document.getElementById('seat-input-user')?.value || '';

  // 対象席の既存割当てを除去
  seatingStore.seats = seatingStore.seats.filter((s) => !(s.row === cell.row && s.col === cell.col));

  if (userId) {
    const user = seatingStore.users.find((u) => u.id === userId);
    if (!user) {
      closeModal('seating-modal');
      return;
    }
    // 同一ユーザの既存席は移動（二重割当て防止）
    seatingStore.seats = seatingStore.seats.filter((s) => s.user_id !== userId);
    seatingStore.seats.push({
      row: cell.row,
      col: cell.col,
      user_id: user.id,
      name: user.name,
      department: user.department || '',
      subjects: user.subjects || [],
      is_online: user.id === state.currentUser?.id,
      absences: [],
    });
  }

  closeModal('seating-modal');

  try {
    await persistMatrix();
    renderMatrix();
  } catch (err) {
    showToast(err.message, 'error');
    await loadSeatingData();
  }
}

/**
 * 座席表の読み込み（タブ表示・ソケット通知時に呼ばれる）
 */
export async function loadSeatingData() {
  try {
    const matrixRes = await apiGet('/seating/matrix');
    await ensureUsers();

    seatingStore.rows = Number(matrixRes.matrix.rows) || 5;
    seatingStore.cols = Number(matrixRes.matrix.cols) || 6;
    seatingStore.seats = matrixRes.seats || [];

    // 自分のアクティブロックがあるか（= 編集可能モード）
    const lock = matrixRes.editingLock;
    seatingStore.editMode = !!lock && lock.user_id === state.currentUser?.id;

    renderHeader();
    renderMatrix();
  } catch (err) {
    console.warn('[Seating] 読み込みエラー:', err.message);
    showToast(err.message || '座席表を読み込めませんでした。', 'error');
  }
}

/**
 * 座席表モジュールの初期化（ヘッダー・マトリクス・モーダルイベントの構築）
 */
export function initSeatingModule() {
  const container = document.getElementById('view-seating');
  if (!container) return;

  container.innerHTML = `
    <!-- ヘッダー（タイトル・行列設定・編集ロック切替） -->
    <div id="seating-header-container" class="bg-surface-strong p-4 rounded-xl border border-divider"></div>

    <!-- 座席マトリクス（カード枠維持のため .seating-matrix-container を付与） -->
    <div id="seating-matrix-container" class="seating-matrix-container card bg-surface-strong p-4 rounded-xl border border-main overflow-x-auto"></div>
  `;

  const form = document.getElementById('seating-edit-form');
  if (form) form.addEventListener('submit', handleSeatFormSubmit);

  const matrixContainer = matrixEl();
  if (matrixContainer) matrixContainer.addEventListener('click', handleSeatClick);

  // ソケット通知（在席ステータス変更）からの再読込フック
  window.seatingModule = { handleStatusChange: loadSeatingData };
}

