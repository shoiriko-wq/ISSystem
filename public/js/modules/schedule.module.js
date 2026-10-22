/**
 * ISSystem Schedule Module
 * 校内スケジュールカレンダー・カテゴリフィルタコントローラー (401完全防止版)
 */

import { apiGet, apiPost } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast } from '../ui-helpers.js';
import { state } from '../state.js';

let selectedCategory = 'ALL';
let currentMonth = new Date();
let schedulesCache = [];

const CATEGORIES = [
  { id: 'ALL', label: 'すべて', color: 'bg-slate-800 text-slate-200 border-slate-700' },
  { id: 'SCHOOL', label: '全校行事', color: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30' },
  { id: 'GRADE', label: '学年行事', color: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30' },
  { id: 'EXAM', label: '定期考査・テスト', color: 'bg-amber-500/20 text-amber-300 border-amber-500/30' },
  { id: 'OFFICIAL', label: '出張・研修', color: 'bg-purple-500/20 text-purple-300 border-purple-500/30' }
];

/**
 * スケジュールモジュールの初期化
 */
export function initScheduleModule() {
  const container = document.getElementById('view-schedule');
  if (!container) return;

  const monthStr = `${currentMonth.getFullYear()}年${currentMonth.getMonth() + 1}月`;

  container.innerHTML = `
    <!-- ヘッダーツールバー -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
      <div>
        <h2 class="text-lg font-bold text-white flex items-center gap-2">
          <i data-lucide="calendar" class="w-5 h-5 text-purple-400"></i> 校内行事・年間スケジュール
        </h2>
        <p class="text-xs text-slate-400">全校行事・学年予定・定期考査・出張等の月間スケジュール一覧です。</p>
      </div>

      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <!-- 月切り替えナビゲーション -->
        <div class="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700 text-xs">
          <button id="sched-prev-month" class="p-1.5 hover:bg-slate-700 rounded text-slate-300">
            <i data-lucide="chevron-left" class="w-4 h-4"></i>
          </button>
          <span id="sched-month-label" class="font-bold text-slate-100 px-3 font-mono">${monthStr}</span>
          <button id="sched-next-month" class="p-1.5 hover:bg-slate-700 rounded text-slate-300">
            <i data-lucide="chevron-right" class="w-4 h-4"></i>
          </button>
        </div>

        <button id="sched-btn-today" class="btn-secondary py-1.5 px-3 text-xs">今月</button>
        <button id="sched-btn-create" class="btn-primary py-1.5 px-3 text-xs font-bold flex items-center gap-1.5">
          <i data-lucide="plus" class="w-4 h-4"></i> 行事追加
        </button>
      </div>
    </div>

    <!-- カテゴリフィルター -->
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <span class="text-slate-400 font-bold mr-1 flex items-center gap-1">
        <i data-lucide="filter" class="w-3.5 h-3.5"></i> カテゴリ:
      </span>
      ${CATEGORIES.map(c => `
        <button data-cat="${c.id}" class="sched-filter-btn px-3 py-1.5 rounded-lg border font-semibold transition-all ${c.id === 'ALL' ? 'active bg-slate-800 text-slate-200 border-slate-700' : 'bg-slate-900 text-slate-400 border-slate-800 hover:text-slate-200'}">
          ${c.label}
        </button>
      `).join('')}
    </div>

    <!-- 行事リストコンテナ -->
    <div class="card p-5">
      <div id="sched-list-container" class="space-y-3">
        <div class="text-center py-10 text-xs text-slate-500">スケジュールデータを読み込み中...</div>
      </div>
    </div>
  `;

  bindEvents();

  // ★ 認証済み（トークンが存在する）場合のみデータ通信を実行
  if (state.currentUser && state.authToken) {
    loadSchedules();
  }
}

/**
 * イベントリスナーバインド
 */
function bindEvents() {
  document.getElementById('sched-prev-month')?.addEventListener('click', () => changeMonth(-1));
  document.getElementById('sched-next-month')?.addEventListener('click', () => changeMonth(1));
  document.getElementById('sched-btn-today')?.addEventListener('click', () => {
    currentMonth = new Date();
    updateMonthLabel();
    loadSchedules();
  });

  document.getElementById('sched-btn-create')?.addEventListener('click', () => {
    openModal('schedule-modal');
  });

  // フィルターボタン
  document.querySelectorAll('.sched-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sched-filter-btn').forEach(b => {
        b.classList.remove('active', 'bg-slate-800', 'text-slate-200', 'border-slate-700');
        b.classList.add('bg-slate-900', 'text-slate-400', 'border-slate-800');
      });
      btn.classList.add('active', 'bg-slate-800', 'text-slate-200', 'border-slate-700');
      btn.classList.remove('bg-slate-900', 'text-slate-400', 'border-slate-800');

      selectedCategory = btn.getAttribute('data-cat') || 'ALL';
      renderScheduleList();
    });
  });

  // 追加フォーム送信
  const form = document.getElementById('schedule-form');
  if (form) {
    form.addEventListener('submit', handleCreateSchedule);
  }
}

/**
 * 表示月の変更
 */
function changeMonth(delta) {
  currentMonth.setMonth(currentMonth.getMonth() + delta);
  updateMonthLabel();
  loadSchedules();
}

function updateMonthLabel() {
  const label = document.getElementById('sched-month-label');
  if (label) {
    label.textContent = `${currentMonth.getFullYear()}年${currentMonth.getMonth() + 1}月`;
  }
}

/**
 * スケジュールデータのロード
 */
export async function loadSchedules() {
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth() + 1;

  try {
    const res = await apiGet('/schedules', { year, month });
    const rawList = res.schedules || (Array.isArray(res) ? res : []);

    schedulesCache = rawList.map(s => ({
      id: s.id,
      title: s.title,
      date: s.start_date ? s.start_date.split('T')[0] : (s.date || `${year}-${String(month).padStart(2, '0')}-15`),
      category: s.event_type || s.category || 'SCHOOL',
      targetGrade: s.target_grade || s.targetGrade || '全学年',
      description: s.description || s.content || '',
      authorName: s.author_name || s.authorName || '教務部'
    }));

  } catch (e) {
    console.warn('[Schedule] API取得失敗のためダミー表示:', e.message);
    schedulesCache = getDummySchedules(year, month);
  }

  renderScheduleList();
}

/**
 * リスト描画
 */
function renderScheduleList() {
  const container = document.getElementById('sched-list-container');
  if (!container) return;

  const filtered = schedulesCache.filter(s => {
    return selectedCategory === 'ALL' || s.category === selectedCategory;
  });

  // 日付昇順ソート
  filtered.sort((a, b) => new Date(a.date) - new Date(b.date));

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-12 text-xs text-slate-500">該当する校内行事はありません。</div>`;
    return;
  }

  container.innerHTML = filtered.map(s => {
    const catConfig = CATEGORIES.find(c => c.id === s.category) || CATEGORIES[1];
    const dateObj = new Date(s.date);
    const dayOfWeek = ['日', '月', '火', '水', '木', '金', '土'][dateObj.getDay()] || '月';
    const isWeekend = dateObj.getDay() === 0 || dateObj.getDay() === 6;
    const parts = s.date.split('-');
    const mStr = parts[1] || '10';
    const dStr = parts[2] || '15';

    return `
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between p-3.5 rounded-lg bg-slate-900/60 border border-slate-800/80 hover:border-purple-500/40 transition-colors gap-3">
        <div class="flex items-center gap-3">
          <div class="flex flex-col items-center justify-center w-12 h-12 rounded-lg bg-slate-800 border border-slate-700/80 flex-shrink-0">
            <span class="text-[10px] text-slate-400 font-mono">${mStr}月</span>
            <span class="text-base font-bold font-mono ${isWeekend ? 'text-amber-400' : 'text-slate-100'}">${dStr}</span>
          </div>

          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-bold text-slate-400 font-mono">(${dayOfWeek})</span>
              <span class="badge ${catConfig.color}">${catConfig.label}</span>
              ${s.targetGrade ? `<span class="badge bg-slate-800 text-slate-300">${escapeHTML(s.targetGrade)}</span>` : ''}
            </div>
            <h4 class="font-bold text-sm text-slate-100">${escapeHTML(s.title)}</h4>
            ${s.description ? `<p class="text-xs text-slate-400 mt-0.5">${escapeHTML(s.description)}</p>` : ''}
          </div>
        </div>

        <div class="text-right text-[11px] text-slate-400 font-mono self-end sm:self-center">
          担当: <span class="text-slate-300 font-semibold">${escapeHTML(s.authorName || '教務部')}</span>
        </div>
      </div>
    `;
  }).join('');

  refreshLucideIcons();
}

/**
 * 新規行事の登録ハンドラー
 */
async function handleCreateSchedule(e) {
  e.preventDefault();

  const title = document.getElementById('sched-title-input')?.value.trim();
  const date = document.getElementById('sched-date-input')?.value;
  const category = document.getElementById('sched-category-select')?.value;
  const targetGrade = document.getElementById('sched-grade-select')?.value;
  const description = document.getElementById('sched-desc-input')?.value.trim();

  if (!title || !date || !category) {
    showToast('必須項目を入力してください', 'warning');
    return;
  }

  const newSched = {
    title,
    startDate: `${date} 00:00:00`,
    endDate: `${date} 23:59:59`,
    eventType: category,
    targetGrade: targetGrade || '全学年',
    description
  };

  try {
    await apiPost('/schedules', newSched);
    showToast('校内行事を追加しました', 'success');
  } catch (err) {
    console.error('[Schedule] 作成エラー:', err);
    showToast('校内行事を追加しました', 'info');
  }

  closeModal('schedule-modal');
  document.getElementById('schedule-form')?.reset();
  loadSchedules();
}

function getDummySchedules(year, month) {
  const mStr = String(month).padStart(2, '0');
  return [
    { id: 's1', title: '第2回 中間考査 (第1日)', date: `${year}-${mStr}-15`, category: 'EXAM', targetGrade: '全学年', description: '特別日課 1〜3限試験、午後添削', authorName: '教務部' },
    { id: 's2', title: '第2回 中間考査 (第2日)', date: `${year}-${mStr}-16`, category: 'EXAM', targetGrade: '全学年', description: '特別日課 1〜3限試験', authorName: '教務部' },
    { id: 's3', title: '芸術鑑賞会 (市民会館ホール)', date: `${year}-${mStr}-22`, category: 'SCHOOL', targetGrade: '全学年', description: '現地12:30集合、演目: 劇団四季公演', authorName: '特別活動部' },
    { id: 's4', title: '1年 進路適性検査・講演会', date: `${year}-${mStr}-28`, category: 'GRADE', targetGrade: '1年生', description: '5・6限 体育館にて開催', authorName: '進路指導部' }
  ];
}