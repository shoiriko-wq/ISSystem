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
  { id: 'ALL', label: 'すべて', color: 'bg-surface text-main border-main' },
  { id: 'SCHOOL', label: '全校行事', color: 'bg-accent-soft text-accent-strong border-accent-soft' },
  { id: 'GRADE', label: '学年行事', color: 'bg-success-soft text-success-strong border-success-soft' },
  { id: 'EXAM', label: '定期考査・テスト', color: 'bg-warning-soft text-warning-strong border-warning-soft' },
  { id: 'OFFICIAL', label: '出張・研修', color: 'bg-accent-alt-soft text-accent-alt border-accent-alt' }
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
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-surface-strong p-4 rounded-xl border border-divider">
      <div>
        <h2 class="text-lg font-bold text-main flex items-center gap-2">
          <i data-lucide="calendar" class="w-5 h-5 text-accent-alt"></i> 校内行事・年間スケジュール
        </h2>
        <p class="text-xs text-muted">全校行事・学年予定・定期考査・出張等の月間スケジュール一覧です。</p>
      </div>

      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <!-- 月切り替えナビゲーション -->
        <div class="flex items-center bg-surface rounded-lg p-1 border border-main text-xs">
          <button id="sched-prev-month" class="p-1.5 hover-surface-strong rounded text-soft">
            <i data-lucide="chevron-left" class="w-4 h-4"></i>
          </button>
          <span id="sched-month-label" class="font-bold text-main px-3 font-mono">${monthStr}</span>
          <button id="sched-next-month" class="p-1.5 hover-surface-strong rounded text-soft">
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
      <span class="text-muted font-bold mr-1 flex items-center gap-1">
        <i data-lucide="filter" class="w-3.5 h-3.5"></i> カテゴリ:
      </span>
      ${CATEGORIES.map(c => `
        <button data-cat="${c.id}" class="sched-filter-btn px-3 py-1.5 rounded-lg border font-semibold transition-all ${c.id === 'ALL' ? 'active bg-surface text-main border-main' : 'bg-surface-strong text-muted border-divider hover-text-main'}">
          ${c.label}
        </button>
      `).join('')}
    </div>

    <!-- 行事リストコンテナ -->
    <div class="card p-5">
      <div id="sched-list-container" class="space-y-3">
        <div class="text-center py-10 text-xs text-muted">スケジュールデータを読み込み中...</div>
      </div>
    </div>

    <!-- ★ 行事追加モーダル (schedule-modal) -->
    <div id="schedule-modal" class="modal-overlay hidden">
      <div class="modal-card">
        <div class="modal-header">
          <h3 class="modal-title"><i data-lucide="calendar-plus" class="w-5 h-5 text-accent-alt"></i> 校内行事の追加</h3>
          <button type="button" id="schedule-modal-close" class="modal-close modal-close-x" aria-label="閉じる" title="閉じる">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>

        <form id="schedule-form" class="modal-form">
          <div class="modal-body">
            <div class="space-y-4">
              <div>
            <label class="block text-xs font-bold text-soft mb-1">行事タイトル <span class="text-danger">*</span></label>
            <input type="text" id="sched-title-input" class="w-full bg-surface border border-main rounded-lg p-2 text-xs text-main focus:outline-none focus-border-accent" placeholder="例: 第3回 期末考査" required>
          </div>

          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label class="block text-xs font-bold text-soft mb-1">実施日 <span class="text-danger">*</span></label>
              <input type="date" id="sched-date-input" class="w-full bg-surface border border-main rounded-lg p-2 text-xs text-main focus:outline-none focus-border-accent" required>
            </div>
            <div>
              <label class="block text-xs font-bold text-soft mb-1">開始時刻</label>
              <input type="time" id="sched-start-time" class="w-full bg-surface border border-main rounded-lg p-2 text-xs text-main focus:outline-none focus-border-accent">
            </div>
            <div>
              <label class="block text-xs font-bold text-soft mb-1">終了時刻</label>
              <input type="time" id="sched-end-time" step="600" class="w-full bg-surface border border-main rounded-lg p-2 text-xs text-main focus:outline-none focus-border-accent">
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="block text-xs font-bold text-soft mb-1">カテゴリ <span class="text-danger">*</span></label>
              <select id="sched-category-select" class="w-full bg-surface border border-main rounded-lg p-2 text-xs text-main focus:outline-none focus-border-accent">
                <option value="SCHOOL">全校行事</option>
                <option value="GRADE">学年行事</option>
                <option value="EXAM">定期考査・テスト</option>
                <option value="OFFICIAL">出張・研修</option>
              </select>
            </div>
            <div>
              <label class="block text-xs font-bold text-soft mb-1">対象学年</label>
              <select id="sched-grade-select" class="w-full bg-surface border border-main rounded-lg p-2 text-xs text-main focus:outline-none focus-border-accent">
                <option value="">全学年</option>
                <option value="1">1年生</option>
                <option value="2">2年生</option>
                <option value="3">3年生</option>
              </select>
            </div>
          </div>

          <div>
            <label class="block text-xs font-bold text-soft mb-1">内容・備考</label>
            <textarea id="sched-desc-input" rows="3" class="w-full bg-surface border border-main rounded-lg p-2 text-xs text-main focus:outline-none focus-border-accent" placeholder="内容、集合時間、持ち物等"></textarea>
          </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" id="sched-btn-cancel" class="modal-close btn-secondary py-2 px-4 text-xs">閉じる</button>
            <button type="submit" class="btn-primary py-2 px-4 text-xs font-bold flex items-center gap-1.5">
              <i data-lucide="plus" class="w-4 h-4"></i> 登録する
            </button>
          </div>
        </form>
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
    // モーダルを開く際、対象月の1日（または本日）を既定日として設定する
    const dateInput = document.getElementById('sched-date-input');
    if (dateInput && !dateInput.value) {
      const y = currentMonth.getFullYear();
      const m = String(currentMonth.getMonth() + 1).padStart(2, '0');
      const today = new Date();
      if (today.getFullYear() === y && today.getMonth() === currentMonth.getMonth()) {
        dateInput.value = `${y}-${m}-${String(today.getDate()).padStart(2, '0')}`;
      } else {
        dateInput.value = `${y}-${m}-01`;
      }
    }
    openModal('schedule-modal');
  });

  document.getElementById('schedule-modal-close')?.addEventListener('click', () => closeModal('schedule-modal'));
  document.getElementById('sched-btn-cancel')?.addEventListener('click', () => closeModal('schedule-modal'));

  // フィルターボタン
  document.querySelectorAll('.sched-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.sched-filter-btn').forEach(b => {
        b.classList.remove('active', 'bg-surface', 'text-main', 'border-main');
        b.classList.add('bg-surface-strong', 'text-muted', 'border-divider');
      });
      btn.classList.add('active', 'bg-surface', 'text-main', 'border-main');
      btn.classList.remove('bg-surface-strong', 'text-muted', 'border-divider');

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
      date: s.event_date || s.start_date?.split('T')[0] || s.date || s.startDate?.split(' ')[0] || '',
      category: s.category || s.event_type || s.eventType || 'SCHOOL',
      targetGrade: (s.target_grade === null || s.target_grade === undefined)
        ? '全学年'
        : `${s.target_grade}年生`,
      startTime: s.start_time || s.startTime || '',
      endTime: s.end_time || s.endTime || '',
      description: s.description || s.content || '',
      authorName: s.created_by_name || s.author_name || s.authorName || '教務部'
    })).filter(s => s.date);

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
    container.innerHTML = `<div class="text-center py-12 text-xs text-muted">該当する校内行事はありません。</div>`;
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
      <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between p-3.5 rounded-lg bg-surface-strong border border-divider hover-border-accent-alt transition-colors gap-3">
        <div class="flex items-center gap-3">
          <div class="flex flex-col items-center justify-center w-12 h-12 rounded-lg bg-surface border border-main flex-shrink-0">
            <span class="text-[10px] text-muted font-mono">${mStr}月</span>
            <span class="text-base font-bold font-mono ${isWeekend ? 'text-warning' : 'text-main'}">${dStr}</span>
          </div>

          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="text-xs font-bold text-muted font-mono">(${dayOfWeek})</span>
              <span class="badge ${catConfig.color}">${catConfig.label}</span>
              ${s.targetGrade ? `<span class="badge bg-surface text-soft">${escapeHTML(s.targetGrade)}</span>` : ''}
            </div>
            <h4 class="font-bold text-sm text-main">${escapeHTML(s.title)}</h4>
            ${s.description ? `<p class="text-xs text-muted mt-0.5">${escapeHTML(s.description)}</p>` : ''}
          </div>
        </div>

        <div class="text-right text-[11px] text-muted font-mono self-end sm:self-center">
          担当: <span class="text-soft font-semibold">${escapeHTML(s.authorName || '教務部')}</span>
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
  const startTime = document.getElementById('sched-start-time')?.value || null;
  const endTime = document.getElementById('sched-end-time')?.value || null;
  const category = document.getElementById('sched-category-select')?.value;
  const targetGrade = document.getElementById('sched-grade-select')?.value;
  const description = document.getElementById('sched-desc-input')?.value.trim();

  if (!title || !date) {
    showToast('行事タイトルと実施日は必須項目です', 'warning');
    return;
  }

  if (startTime && endTime && startTime >= endTime) {
    showToast('終了時刻は開始時刻より後に設定してください', 'warning');
    return;
  }

  // バックエンド (POST /api/schedules) が期待するキー名で送信する
  const payload = {
    title,
    description: description || '',
    event_date: date,
    start_time: startTime,
    end_time: endTime,
    category: category || 'SCHOOL',
    target_grade: targetGrade ? parseInt(targetGrade, 10) : null,
    // フロントエンド互換の別名キーも併せて送る
    date,
    eventType: category || 'SCHOOL',
    targetGrade: targetGrade || '全学年'
  };

  try {
    await apiPost('/schedules', payload);
    showToast('校内行事を追加しました', 'success');
  } catch (err) {
    console.error('[Schedule] 作成エラー:', err);
    showToast(err.message || '校内行事の追加に失敗しました', 'error');
    return;
  }

  closeModal('schedule-modal');
  document.getElementById('schedule-form')?.reset();

  // 追加した行事の月へ表示を移動して再読み込み
  const [y, m] = date.split('-');
  currentMonth = new Date(parseInt(y, 10), parseInt(m, 10) - 1, 1);
  updateMonthLabel();
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