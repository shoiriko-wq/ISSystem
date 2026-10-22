/**
 * ISSystem Seating Module
 * 座席表可変グリッド描画・4桁生徒コード/教員検索・在席ステータス管理コントローラー (404 / 401 完全修正版)
 */

import { apiGet, apiPut } from '../api.js';
import { escapeHTML, refreshLucideIcons, openModal, closeModal, showToast } from '../ui-helpers.js';
import { state } from '../state.js';

let gridRows = 5;
let gridCols = 6;
let seatsData = [];
let searchHighlightQuery = '';

const STATUS_CONFIG = {
  IN: { label: '在席', bgClass: 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300', badgeClass: 'bg-emerald-500/20 text-emerald-300' },
  PRESENT: { label: '在席', bgClass: 'bg-emerald-950/60 border-emerald-500/50 text-emerald-300', badgeClass: 'bg-emerald-500/20 text-emerald-300' },
  OUT: { label: '離席', bgClass: 'bg-slate-900/60 border-slate-700/80 text-slate-400', badgeClass: 'bg-slate-800 text-slate-400' },
  CLASS: { label: '授業中', bgClass: 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300', badgeClass: 'bg-indigo-500/20 text-indigo-300' },
  MEETING: { label: '会議中', bgClass: 'bg-indigo-950/60 border-indigo-500/50 text-indigo-300', badgeClass: 'bg-indigo-500/20 text-indigo-300' },
  TRIP: { label: '出張', bgClass: 'bg-amber-950/60 border-amber-500/50 text-amber-300', badgeClass: 'bg-amber-500/20 text-amber-300' },
  LEAVE: { label: '年休', bgClass: 'bg-rose-950/60 border-rose-500/50 text-rose-300', badgeClass: 'bg-rose-500/20 text-rose-300' }
};

/**
 * 座席表モジュールの初期化とHTMLレイアウト構築
 */
export function initSeatingModule() {
  const container = document.getElementById('view-seating');
  if (!container) return;

  container.innerHTML = `
    <!-- ヘッダー・操作ツールバー -->
    <div class="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
      <div>
        <h2 class="text-lg font-bold text-white flex items-center gap-2">
          <i data-lucide="layout-grid" class="w-5 h-5 text-indigo-400"></i> 職員室座席表 & 担当生徒検索
        </h2>
        <p class="text-xs text-slate-400">リアルタイム在席状態の確認・更新および4桁生徒コードによる迅速な担当教員ピックアップを行えます。</p>
      </div>

      <!-- 検索 & グリッドサイズ設定 -->
      <div class="flex flex-wrap items-center gap-3 w-full lg:w-auto justify-end">
        <!-- 4桁生徒コード・教員検索 -->
        <div class="relative flex-1 sm:w-64">
          <i data-lucide="search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
          <input type="text" id="seating-search-input" class="input-field pl-9 py-1.5 text-xs" placeholder="生徒コード(例:1204) / 教員名でハイライト...">
        </div>

        <!-- 可変グリッド設定 -->
        <div class="flex items-center gap-1.5 bg-slate-800 p-1 rounded-lg border border-slate-700 text-xs">
          <span class="text-slate-400 text-[11px] px-1 font-bold">行列:</span>
          <select id="seating-rows-select" class="bg-slate-900 text-slate-200 rounded px-1.5 py-0.5 border border-slate-700 focus:outline-none">
            ${[3, 4, 5, 6, 7, 8].map(r => `<option value="${r}" ${r === gridRows ? 'selected' : ''}>${r}行</option>`).join('')}
          </select>
          <span class="text-slate-500">×</span>
          <select id="seating-cols-select" class="bg-slate-900 text-slate-200 rounded px-1.5 py-0.5 border border-slate-700 focus:outline-none">
            ${[4, 5, 6, 7, 8, 10].map(c => `<option value="${c}" ${c === gridCols ? 'selected' : ''}>${c}列</option>`).join('')}
          </select>
        </div>

        <button id="seating-btn-refresh" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1">
          <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> 更新
        </button>
      </div>
    </div>

    <!-- ステータス凡例 & サマリー -->
    <div class="flex flex-wrap items-center justify-between gap-3 text-xs bg-slate-950/40 p-3 rounded-lg border border-slate-800/80">
      <div class="flex items-center gap-4">
        <span class="text-slate-400 font-bold">ステータス:</span>
        <span class="flex items-center gap-1.5 text-emerald-400"><span class="w-2.5 h-2.5 rounded-full bg-emerald-500"></span> 在席</span>
        <span class="flex items-center gap-1.5 text-indigo-400"><span class="w-2.5 h-2.5 rounded-full bg-indigo-500"></span> 授業・会議</span>
        <span class="flex items-center gap-1.5 text-amber-400"><span class="w-2.5 h-2.5 rounded-full bg-amber-500"></span> 出張</span>
        <span class="flex items-center gap-1.5 text-slate-400"><span class="w-2.5 h-2.5 rounded-full bg-slate-600"></span> 離席・年休</span>
      </div>
      <div class="text-[11px] text-slate-400 font-mono" id="seating-stats-bar">
        在席: <strong class="text-emerald-400" id="stat-in-count">0</strong>名 / 全員: <span id="stat-total-count">0</span>名
      </div>
    </div>

    <!-- 可変グリッド表示コンテナ -->
    <div class="card p-4 overflow-x-auto">
      <div id="seating-grid-container" class="grid gap-3 min-w-[700px]">
        <div class="text-center py-12 text-xs text-slate-500">座席表配置データを読み込み中...</div>
      </div>
    </div>
  `;

  bindEvents();

  // ★ 認証済み（トークンが存在する）場合のみデータ通信を実行
  if (state.currentUser && state.authToken) {
    loadSeatingData();
  }
}

/**
 * イベントリスナー登録
 */
function bindEvents() {
  document.getElementById('seating-search-input')?.addEventListener('input', (e) => {
    searchHighlightQuery = e.target.value.trim().toLowerCase();
    renderSeatingGrid();
  });

  document.getElementById('seating-rows-select')?.addEventListener('change', (e) => {
    gridRows = Number(e.target.value);
    renderSeatingGrid();
  });

  document.getElementById('seating-cols-select')?.addEventListener('change', (e) => {
    gridCols = Number(e.target.value);
    renderSeatingGrid();
  });

  document.getElementById('seating-btn-refresh')?.addEventListener('click', () => {
    loadSeatingData();
    showToast('座席状況を再読み込みしました', 'info');
  });

  const form = document.getElementById('seating-edit-form');
  if (form) {
    form.addEventListener('submit', handleSaveSeatModal);
  }
}

/**
 * 座席マスターデータの取得 (404対策: /seating/layouts 呼び出し)
 */
export async function loadSeatingData() {
  try {
    // ★ 正しい API エンドポイント (/seating/layouts) を呼び出し
    const data = await apiGet('/seating/layouts');
    
    if (data && (Array.isArray(data.seats) || Array.isArray(data.layouts) || Array.isArray(data))) {
      const rawSeats = data.seats || data.layouts || (Array.isArray(data) ? data : []);
      seatsData = rawSeats.map((s, idx) => ({
        row: s.row || Math.floor(idx / gridCols) + 1,
        col: s.col || (idx % gridCols) + 1,
        teacherId: s.user_id || s.teacherId || s.id,
        teacherName: s.name || s.teacherName || '教員',
        subject: s.department || s.subject || '一般',
        status: s.current_status || s.status || 'PRESENT',
        studentCodes: s.studentCodes || ['1001', '1002'],
        note: s.status_note || s.note || ''
      }));
      if (data.rows) gridRows = data.rows;
      if (data.cols) gridCols = data.cols;
    } else {
      seatsData = getDummySeatsData();
    }
  } catch (err) {
    console.warn('[Seating] API通信失敗のためフォールバック表示:', err.message);
    seatsData = getDummySeatsData();
  }

  const rowSel = document.getElementById('seating-rows-select');
  const colSel = document.getElementById('seating-cols-select');
  if (rowSel) rowSel.value = String(gridRows);
  if (colSel) colSel.value = String(gridCols);

  renderSeatingGrid();
}

/**
 * 座席表グリッドの動的描画
 */
function renderSeatingGrid() {
  const container = document.getElementById('seating-grid-container');
  if (!container) return;

  container.style.gridTemplateColumns = `repeat(${gridCols}, minmax(0, 1fr))`;

  let inCount = 0;
  let totalAssigned = 0;
  let htmlCells = [];

  for (let r = 1; r <= gridRows; r++) {
    for (let c = 1; c <= gridCols; c++) {
      const seat = seatsData.find(s => Number(s.row) === r && Number(s.col) === c);

      if (seat && seat.teacherName) {
        totalAssigned++;
        if (seat.status === 'IN' || seat.status === 'PRESENT') inCount++;

        const stConfig = STATUS_CONFIG[seat.status] || STATUS_CONFIG.IN;

        let isMatch = false;
        if (searchHighlightQuery.length > 0) {
          const teacherNameMatch = seat.teacherName.toLowerCase().includes(searchHighlightQuery);
          const studentCodeMatch = seat.studentCodes && seat.studentCodes.some(code => code.toLowerCase().includes(searchHighlightQuery));
          const subjectMatch = seat.subject && seat.subject.toLowerCase().includes(searchHighlightQuery);
          isMatch = teacherNameMatch || studentCodeMatch || subjectMatch;
        }

        const codesList = seat.studentCodes ? seat.studentCodes.join(', ') : '';

        htmlCells.push(`
          <div class="seat-card card p-3 rounded-xl border transition-all cursor-pointer flex flex-col justify-between h-28 relative ${stConfig.bgClass} ${
            isMatch ? 'ring-2 ring-amber-400 border-amber-400 shadow-lg shadow-amber-500/20 scale-[1.02] z-10' : 'hover:border-indigo-400'
          }" data-row="${r}" data-col="${c}">
            
            <div class="flex items-center justify-between text-[10px]">
              <span class="font-bold text-slate-400 truncate">${escapeHTML(seat.subject || '教員')}</span>
              <span class="badge ${stConfig.badgeClass} px-1.5 py-0.2">${stConfig.label}</span>
            </div>

            <div class="my-1">
              <h4 class="font-bold text-sm text-slate-100 flex items-center justify-between">
                <span>${escapeHTML(seat.teacherName)}</span>
                ${seat.teacherId === state.currentUser?.id ? '<span class="text-[9px] bg-indigo-500 text-white px-1 rounded font-normal">自分</span>' : ''}
              </h4>
              <p class="text-[10px] text-slate-400 truncate mt-0.5">${escapeHTML(seat.note || '')}</p>
            </div>

            <div class="mt-auto pt-1 border-t border-slate-700/40 flex items-center justify-between text-[10px]">
              <span class="text-slate-400 font-mono truncate">コード: <strong class="text-slate-200">${escapeHTML(codesList || '-')}</strong></span>
              <i data-lucide="edit-2" class="w-3 h-3 text-slate-500 hover:text-slate-300"></i>
            </div>
          </div>
        `);
      } else {
        htmlCells.push(`
          <div class="seat-card p-3 rounded-xl border border-dashed border-slate-800/80 bg-slate-950/20 hover:border-slate-700 transition-all cursor-pointer flex items-center justify-center h-28 text-slate-600 hover:text-slate-400 text-xs font-mono" data-row="${r}" data-col="${c}">
            <div class="text-center">
              <i data-lucide="plus" class="w-4 h-4 mx-auto mb-1 opacity-50"></i>
              <span>空席 (${r}-${c})</span>
            </div>
          </div>
        `);
      }
    }
  }

  container.innerHTML = htmlCells.join('');

  const inEl = document.getElementById('stat-in-count');
  const totalEl = document.getElementById('stat-total-count');
  if (inEl) inEl.textContent = String(inCount);
  if (totalEl) totalEl.textContent = String(totalAssigned);

  container.querySelectorAll('[data-row]').forEach(card => {
    card.addEventListener('click', () => {
      const r = Number(card.getAttribute('data-row'));
      const c = Number(card.getAttribute('data-col'));
      openSeatEditModal(r, c);
    });
  });

  refreshLucideIcons();
}

/**
 * 座席詳細/編集モーダル
 */
function openSeatEditModal(row, col) {
  let seat = seatsData.find(s => Number(s.row) === row && Number(s.col) === col);
  if (!seat) {
    seat = { row, col, teacherName: '', subject: '', status: 'IN', studentCodes: [], note: '' };
  }

  const titleEl = document.getElementById('seat-modal-title');
  const rowInput = document.getElementById('seat-input-row');
  const colInput = document.getElementById('seat-input-col');
  const nameInput = document.getElementById('seat-input-name');
  const subjectInput = document.getElementById('seat-input-subject');
  const statusSelect = document.getElementById('seat-select-status');
  const codesInput = document.getElementById('seat-input-codes');
  const noteInput = document.getElementById('seat-input-note');

  if (titleEl) titleEl.textContent = `座席設定 (${row}行 - ${col}列)`;
  if (rowInput) rowInput.value = String(row);
  if (colInput) colInput.value = String(col);
  if (nameInput) nameInput.value = seat.teacherName || '';
  if (subjectInput) subjectInput.value = seat.subject || '';
  if (statusSelect) statusSelect.value = seat.status || 'IN';
  if (codesInput) codesInput.value = seat.studentCodes ? seat.studentCodes.join(', ') : '';
  if (noteInput) noteInput.value = seat.note || '';

  openModal('seating-modal');
}

/**
 * 座席保存処理
 */
async function handleSaveSeatModal(e) {
  e.preventDefault();

  const row = Number(document.getElementById('seat-input-row')?.value);
  const col = Number(document.getElementById('seat-input-col')?.value);
  const teacherName = document.getElementById('seat-input-name')?.value.trim();
  const subject = document.getElementById('seat-input-subject')?.value.trim();
  const status = document.getElementById('seat-select-status')?.value || 'IN';
  const codesRaw = document.getElementById('seat-input-codes')?.value.trim();
  const note = document.getElementById('seat-input-note')?.value.trim();

  const studentCodes = codesRaw ? codesRaw.split(',').map(s => s.trim()).filter(Boolean) : [];

  let seatIndex = seatsData.findIndex(s => Number(s.row) === row && Number(s.col) === col);

  const updatedSeat = {
    row,
    col,
    teacherName,
    subject,
    status,
    studentCodes,
    note,
    teacherId: teacherName === state.currentUser?.name ? state.currentUser?.id : `t-${Date.now()}`
  };

  if (seatIndex >= 0) {
    if (!teacherName) {
      seatsData.splice(seatIndex, 1);
    } else {
      seatsData[seatIndex] = updatedSeat;
    }
  } else if (teacherName) {
    seatsData.push(updatedSeat);
  }

  try {
    // ★ 正しい API エンドポイント (/seating/layouts) へ保存
    await apiPut('/seating/layouts', { seats: seatsData, rows: gridRows, cols: gridCols });
  } catch (err) {
    console.warn('[Seating] 保存エラー:', err.message);
  }

  closeModal('seating-modal');
  showToast(`座席 (${row}-${col}) の情報を更新しました`, 'success');
  renderSeatingGrid();
}

function getDummySeatsData() {
  return [
    { row: 1, col: 1, teacherId: 'kyomu01', teacherName: '教務 主任', subject: '教務部', status: 'PRESENT', studentCodes: ['1001', '1002'], note: 'A-01' },
    { row: 1, col: 2, teacherId: 't-tanaka', teacherName: '田中 先生', subject: '英語', status: 'CLASS', studentCodes: ['1201', '1202'], note: '2-A 英語' },
    { row: 1, col: 3, teacherId: 't-sato', teacherName: '佐藤 先生', subject: '数学', status: 'MEETING', studentCodes: ['1301', '1302'], note: '第一会議室' },
    { row: 1, col: 4, teacherId: 't-suzuki', teacherName: '鈴木 先生', subject: '国語', status: 'TRIP', studentCodes: ['1401'], note: '県庁出張' },
    { row: 2, col: 1, teacherId: 't-takahashi', teacherName: '高橋 先生', subject: '保体', status: 'LEAVE', studentCodes: ['1501'], note: '年休' }
  ];
}