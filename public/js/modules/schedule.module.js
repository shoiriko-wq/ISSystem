/**
 * ISSystem Schedule Module
 * 校内行事カレンダー・カテゴリ複数選択フィルタ・表示モード切替・行事詳細モーダル・管理者カテゴリ管理
 * ※ カテゴリの追加・削除はシステム管理者 (ADMIN) のみ
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../api.js';
import { escapeHTML, refreshLucideIcons, openModal, closeModal, showToast, formatDate, userAvatarHtml } from '../ui-helpers.js';
import { state } from '../state.js';

const WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'];
const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

const COLOR_KEYS = ['ACCENT', 'SUCCESS', 'INFO', 'WARNING', 'DANGER', 'PURPLE', 'SLATE'];
const COLOR_LABELS = {
  ACCENT: 'アクセント',
  SUCCESS: '緑',
  INFO: '青',
  WARNING: '黄',
  DANGER: '赤',
  PURPLE: '紫',
  SLATE: 'グレー',
};

// カテゴリ色キー → UIクラス (DBには色キーのみ保存し、Tailwindクラスはここで管理)
const CAT_PALETTE = {
  ACCENT: { badge: 'bg-accent-soft text-accent-strong border-accent-soft', dot: 'bg-accent', swatch: 'bg-accent' },
  PURPLE: { badge: 'bg-accent-alt-soft text-accent-alt border-accent-alt', dot: 'bg-accent-alt', swatch: 'bg-accent-alt' },
  SUCCESS: { badge: 'bg-success-soft text-success-strong border-success-soft', dot: 'bg-success', swatch: 'bg-success' },
  WARNING: { badge: 'bg-warning-soft text-warning-strong border-warning-soft', dot: 'bg-warning', swatch: 'bg-warning' },
  INFO: { badge: 'bg-info-soft text-info-strong border-info-soft', dot: 'bg-info', swatch: 'bg-info' },
  DANGER: { badge: 'bg-danger-soft text-danger-strong border-danger-soft', dot: 'bg-danger', swatch: 'bg-danger' },
  SLATE: { badge: 'bg-surface text-soft border-divider', dot: 'bg-muted', swatch: 'bg-muted' }
};

const TITLE_MAX = 30; // カレンダー枠内に収める行事名の表示上限
const NAME_MAX = 12;  // カテゴリ名の上限
const VIEW_MODE_KEY = 'isschedule_view_mode';

let categoriesCache = [];
let selectedCategoryIds = new Set();
let viewMode = localStorage.getItem(VIEW_MODE_KEY) === 'list' ? 'list' : 'calendar';
let currentMonth = new Date();
let schedulesCache = [];
let selectedDate = '';

function palette(colorKey) {
  return CAT_PALETTE[String(colorKey || 'SLATE').toUpperCase()] || CAT_PALETTE.SLATE;
}

function jstTodayStr() {
  const d = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function firstOfMonthStr(month) {
  const y = month.getFullYear();
  const m = String(month.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}-01`;
}

function weekdayIndex(dateStr) {
  const d = new Date(dateStr);
  return (d.getDay() + 6) % 7;
}

function daysInMonth(month) {
  return new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
}

function dateStrOf(year, monthIdx, day) {
  return `${year}-${String(monthIdx + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function truncateTitle(title) {
  const t = String(title || '');
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX)}…` : t;
}

function isAdmin() {
  return Boolean(state.currentUser && state.currentUser.role === 'ADMIN');
}

function canManageEvent(ev) {
  if (!state.currentUser || !ev) return false;
  const role = state.currentUser.role;
  return role === 'ADMIN' || role === 'KYOMU' || String(state.currentUser.id) === String(ev.createdBy);
}

/** 追加・編集権限 (新規は教務委員会/管理者、既存は本人または教務委員会/管理者) */
function canEditEvent(ev) {
  if (!state.currentUser) return false;
  const role = state.currentUser.role;
  if (role === 'ADMIN' || role === 'KYOMU') return true;
  return Boolean(ev) && String(state.currentUser.id) === String(ev.createdBy);
}

function categoryById(id) {
  return categoriesCache.find((c) => c.id === Number(id)) || null;
}

/** カテゴリマスタの取得 (APIのカラーパレットキーに対応) */
async function loadCategories(force = false) {
  if (categoriesCache.length > 0 && !force) return categoriesCache;
  try {
    const res = await apiGet('/schedules/categories');
    const list = res.categories || res.data || [];
    categoriesCache = list.map((c) => ({
      id: Number(c.id),
      name: c.name,
      color_key: c.color_key || 'SLATE',
      sort_order: c.sort_order || 0,
      event_count: c.event_count || 0
    }));
  } catch (e) {
    console.warn('[Schedule] カテゴリ取得失敗:', e.message);
    // 初期カテゴリでのフォールバック
    categoriesCache = [
      { id: 1, name: '1学年', color_key: 'INFO' },
      { id: 2, name: '2学年', color_key: 'SUCCESS' },
      { id: 3, name: '3学年', color_key: 'WARNING' },
      { id: 4, name: '教務', color_key: 'ACCENT' },
      { id: 5, name: '進路', color_key: 'PURPLE' },
      { id: 6, name: '総務', color_key: 'SLATE' },
      { id: 7, name: '生徒部', color_key: 'DANGER' }
    ];
  }
  return categoriesCache;
}

/** API行事データ → モジュール内部形式への変換 */
function mapEvent(s) {
  return {
    id: s.id,
    title: s.title,
    date: s.event_date || (s.start_date ? String(s.start_date).split('T')[0] : '') || s.date || '',
    categories: (s.categories || []).map((c) => ({
      id: Number(c.id),
      name: c.name,
      color_key: c.color_key || 'SLATE'
    })),
    targetGrade: (s.target_grade === null || s.target_grade === undefined)
      ? '全学年'
      : `${s.target_grade}年生`,
    gradeValue: (s.target_grade === null || s.target_grade === undefined)
      ? ''
      : String(s.target_grade),
    startTime: s.start_time || s.startTime || '',
    endTime: s.end_time || s.endTime || '',
    description: s.description || s.content || '',
    authorName: s.created_by_name || s.author_name || s.authorName || '教務部',
    authorAvatar: s.created_by_avatar || s.author_avatar || s.authorAvatar || null,
    createdBy: s.created_by_user_id || s.created_by || null
  };
}

/** フィルタ判定：複数選択時は「選択カテゴリのうち少なくとも1つを含む」行事がtrue */
function matchesFilter(ev) {
  if (selectedCategoryIds.size === 0) return true;
  return ev.categories.some((c) => selectedCategoryIds.has(c.id));
}

function filteredSchedules() {
  return schedulesCache.filter(matchesFilter).sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.startTime || '').localeCompare(b.startTime || '');
  });
}

/** 行事名チップ（枠内に収めるため truncate + title 上限） */
function eventChipHtml(ev, extra = 'w-full') {
  const dots = ev.categories
    .map((c) => `<span class="w-1.5 h-1.5 rounded-full shrink-0 ${palette(c.color_key).dot}"></span>`)
    .join('');
  const timeLabel = ev.startTime ? ` ${ev.startTime}` : '';
  const safeTitle = escapeHTML(`${ev.date} ${ev.title}${timeLabel}`);
  return `<button type="button" class="sched-event-chip flex items-center gap-1 rounded-md border border-divider bg-surface px-1.5 py-1 text-[11px] text-main text-left hover-surface-strong transition-colors ${extra}"
      data-event-id="${ev.id}" title="${safeTitle}">
    <span class="flex items-center gap-0.5 shrink-0">${dots}</span>
    <span class="truncate">${escapeHTML(truncateTitle(ev.title))}</span>
  </button>`;
}

/** 表示モードボタンの活性表示 */
function paintModeButtons() {
  const cal = document.getElementById('sched-mode-calendar');
  const lst = document.getElementById('sched-mode-list');
  if (!cal || !lst) return;
  const base = 'sched-mode-btn px-2.5 py-1.5 text-xs font-semibold flex items-center gap-1';
  cal.className = `${base} ${viewMode === 'calendar' ? 'bg-accent-soft text-accent-strong' : 'text-soft hover-surface-soft'}`;
  lst.className = `${base} border-l border-main ${viewMode === 'list' ? 'bg-accent-soft text-accent-strong' : 'text-soft hover-surface-soft'}`;
}

/** メイン描画 */
function renderScheduleView() {
  const container = document.getElementById('view-schedule');
  if (!container) return;

  const y = currentMonth.getFullYear();
  const m = currentMonth.getMonth();
  const monthPrefix = `${y}-${String(m + 1).padStart(2, '0')}`;
  const list = filteredSchedules().filter((ev) => String(ev.date).startsWith(monthPrefix));

  const adminBtn = isAdmin()
    ? `<button type="button" id="sched-cat-admin-btn" class="btn-secondary px-2.5 py-1.5 text-xs rounded-lg flex items-center gap-1">
         <i data-lucide="tags" class="w-3.5 h-3.5"></i> カテゴリ管理
       </button>`
    : '';

  container.innerHTML = `
    <div class="card p-3 space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="flex items-center gap-1">
          <button type="button" id="sched-prev-month" class="btn-secondary w-8 h-8 rounded-lg flex items-center justify-center" aria-label="前月"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
          <div id="sched-month-label" class="text-sm font-bold text-main min-w-[88px] text-center"></div>
          <button type="button" id="sched-next-month" class="btn-secondary w-8 h-8 rounded-lg flex items-center justify-center" aria-label="次月"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
          <button type="button" id="sched-goto-today" class="btn-secondary px-2 py-1.5 text-xs rounded-lg">今月</button>
        </div>
        <div class="flex-1"></div>
        <div class="flex rounded-lg border border-main overflow-hidden bg-surface" role="group" aria-label="表示モード">
          <button type="button" id="sched-mode-calendar" data-mode="calendar" class="sched-mode-btn px-2.5 py-1.5 text-xs font-semibold flex items-center gap-1">
            <i data-lucide="calendar" class="w-3.5 h-3.5"></i> カレンダー表示
          </button>
          <button type="button" id="sched-mode-list" data-mode="list" class="sched-mode-btn px-2.5 py-1.5 text-xs font-semibold flex items-center gap-1 border-l border-main">
            <i data-lucide="rows-3" class="w-3.5 h-3.5"></i> 1日一覧表示
          </button>
        </div>
        <button type="button" id="sched-add-btn" class="btn-primary px-2.5 py-1.5 text-xs rounded-lg flex items-center gap-1">
          <i data-lucide="plus" class="w-3.5 h-3.5"></i> 行事を追加
        </button>
        ${adminBtn}
      </div>
      <div id="sched-filter-chips" class="flex flex-wrap items-center gap-1.5"></div>
      <div id="sched-view-area"></div>
      <div id="sched-summary" class="text-[11px] text-muted"></div>
    </div>
  `;

  document.getElementById('sched-month-label').textContent = `${y}年${m + 1}月`;
  renderFilterChips();

  if (viewMode === 'calendar') renderCalendarView(y, m, list);
  else renderListView(y, m, list);

  const sel = [...selectedCategoryIds].map((id) => (categoryById(id) || { name: '?' }).name);
  document.getElementById('sched-summary').textContent = sel.length
    ? `選択カテゴリ（${list.length}件）: ${sel.join(' / ')} のうち少なくとも1つを含む行事を表示中`
    : `全カテゴリの行事を表示中（${list.length}件）`;

  bindHeaderEvents();
  refreshLucideIcons();
}

/** カテゴリ複数選択チップ（「すべて」で選択解除） */
function renderFilterChips() {
  const holder = document.getElementById('sched-filter-chips');
  if (!holder) return;

  const allChip = `<button type="button" data-cat-id="all" class="sched-cat-chip px-2 py-1 text-[11px] font-semibold rounded-full border ${selectedCategoryIds.size === 0 ? 'bg-accent-soft text-accent-strong border-accent-soft ring-accent' : 'bg-surface text-soft border-main hover-surface-soft'}">すべて</button>`;

  const chips = categoriesCache.map((c) => {
    const pal = palette(c.color_key);
    const active = selectedCategoryIds.has(c.id);
    return `<button type="button" data-cat-id="${c.id}" class="sched-cat-chip flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-full border ${active ? `${pal.badge} ring-accent` : 'bg-surface text-soft border-main hover-surface-soft'}" title="${escapeHTML(c.name)}">
      <span class="w-1.5 h-1.5 rounded-full shrink-0 ${pal.dot}"></span>${escapeHTML(c.name)}
    </button>`;
  }).join('');

  holder.innerHTML = allChip + chips;

  holder.querySelectorAll('.sched-cat-chip').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.catId;
      if (raw === 'all') {
        selectedCategoryIds.clear();
      } else {
        const id = Number(raw);
        if (selectedCategoryIds.has(id)) selectedCategoryIds.delete(id);
        else selectedCategoryIds.add(id);
      }
      renderScheduleView();
    });
  });
}

/** カレンダー形式（月グリッド・枠内に行事名チップ） */
function renderCalendarView(y, m, list) {
  const area = document.getElementById('sched-view-area');
  const byDate = new Map();
  for (const ev of list) {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
  }

  const firstWd = weekdayIndex(`${y}-${String(m + 1).padStart(2, '0')}-01`);
  const dim = daysInMonth(currentMonth);
  const prev = new Date(y, m, 0);
  const cells = [];

  for (let i = firstWd - 1; i >= 0; i--) {
    cells.push(calendarCellHtml(prev.getFullYear(), prev.getMonth(), prev.getDate() - i, byDate, false));
  }
  for (let day = 1; day <= dim; day++) cells.push(calendarCellHtml(y, m, day, byDate, true));

  const tail = (firstWd + dim) % 7;
  const next = new Date(y, m + 1, 1);
  for (let day = 1; day <= (tail === 0 ? 0 : 7 - tail); day++) {
    cells.push(calendarCellHtml(next.getFullYear(), next.getMonth(), day, byDate, false));
  }

  area.innerHTML = `
    <div class="grid grid-cols-7 gap-1 mb-1 text-center text-[10px] font-bold">
      ${WEEKDAYS.map((w, i) => `<div class="${i >= 5 ? 'text-danger-strong' : 'text-muted'}">${w}</div>`).join('')}
    </div>
    <div class="grid grid-cols-7 gap-1">${cells.join('')}</div>
  `;
  bindViewEvents(area);
}

function calendarCellHtml(y, m, day, byDate, isCurrentMonth) {
  const dateStr = dateStrOf(y, m, day);
  const events = byDate.get(dateStr) || [];
  const wd = WEEKDAYS[weekdayIndex(dateStr)];
  const isToday = dateStr === jstTodayStr();
  const shown = events.slice(0, 3);
  const rest = events.length - shown.length;

  const chips = shown.map((ev) => eventChipHtml(ev, 'w-full')).join('');
  const more = rest > 0
    ? `<button type="button" data-more-date="${dateStr}" class="sched-more-chip text-[10px] font-semibold text-accent-strong rounded-md bg-accent-soft px-1.5 py-0.5 w-full truncate" title="この日の行事を1日一覧表示で開く">+${rest}件 表示</button>`
    : '';

  return `<div class="sched-cell rounded-lg border ${isCurrentMonth ? 'border-divider' : 'border-muted'} p-1 bg-surface-soft ${isToday ? 'border-2 border-accent' : ''} min-h-[84px]">
    <div class="flex items-center justify-between mb-1">
      <span class="text-[11px] font-bold ${isToday ? 'text-accent-strong' : 'text-main'}">${day}</span>
      <span class="text-[10px] ${weekdayIndex(dateStr) >= 5 ? 'text-danger-strong' : 'text-muted'}">${wd}</span>
    </div>
    <div class="flex flex-col gap-1">${chips}${more}</div>
  </div>`;
}

/** 1日一覧表示（縦に1日ごとに区切り、枠内に横へ行事名を並べる） */
function renderListView(y, m, list) {
  const area = document.getElementById('sched-view-area');
  const byDate = new Map();
  for (const ev of list) {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
  }

  const dim = daysInMonth(currentMonth);
  const rows = [];
  for (let day = 1; day <= dim; day++) {
    const dateStr = dateStrOf(y, m, day);
    const events = byDate.get(dateStr) || [];
    if (events.length === 0) continue;
    const wd = WEEKDAYS[weekdayIndex(dateStr)];
    const isToday = dateStr === jstTodayStr();
    const chips = events.map((ev) => eventChipHtml(ev, 'w-auto max-w-[168px] shrink-0')).join('');
    rows.push(`
      <div class="flex items-start gap-2 rounded-lg border border-divider p-2 bg-surface-soft ${isToday ? 'border-2 border-accent' : ''}">
        <div class="w-11 shrink-0 text-center">
          <div class="text-sm font-bold ${isToday ? 'text-accent-strong' : 'text-main'}">${day}</div>
          <div class="text-[10px] ${weekdayIndex(dateStr) >= 5 ? 'text-danger-strong' : 'text-muted'}">${wd}</div>
        </div>
        <div class="flex flex-wrap gap-1 flex-1 min-w-0">${chips}</div>
      </div>
    `);
  }

  area.innerHTML = rows.length
    ? `<div id="sched-list-container" class="space-y-1.5">${rows.join('')}</div>`
    : `<div class="p-6 text-center text-xs text-muted">
         <i data-lucide="calendar-off" class="w-8 h-8 mx-auto mb-2 opacity-60"></i>
         <div>この月に表示できる行事がありません。カテゴリ選択を見直してください。</div>
       </div>`;
  bindViewEvents(area);
}

/** 表示モード切替（カレンダー / 1日一覧） */
function setMode(mode) {
  viewMode = mode === 'list' ? 'list' : 'calendar';
  localStorage.setItem(VIEW_MODE_KEY, viewMode);
  renderScheduleView();
}

/** ヘッダ操作（月ナビ・表示モード・行事追加・カテゴリ管理） */
function bindHeaderEvents() {
  const prev = document.getElementById('sched-prev-month');
  const next = document.getElementById('sched-next-month');
  const today = document.getElementById('sched-goto-today');
  const calBtn = document.getElementById('sched-mode-calendar');
  const listBtn = document.getElementById('sched-mode-list');
  const addBtn = document.getElementById('sched-add-btn');
  const adminBtn = document.getElementById('sched-cat-admin-btn');

  if (prev) prev.addEventListener('click', () => { currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() - 1, 1); renderScheduleView(); });
  if (next) next.addEventListener('click', () => { currentMonth = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 1); renderScheduleView(); });
  if (today) today.addEventListener('click', () => { currentMonth = new Date(); currentMonth.setDate(1); renderScheduleView(); });
  if (calBtn) calBtn.addEventListener('click', () => setMode('calendar'));
  if (listBtn) listBtn.addEventListener('click', () => setMode('list'));
  if (addBtn) addBtn.addEventListener('click', () => openScheduleForm(null));
  if (adminBtn) adminBtn.addEventListener('click', () => openCategoryAdmin());

  paintModeButtons();
}

/** ビュー内クリック（行事名クリックで詳細モーダル、+nでその日を1日一覧表示） */
function bindViewEvents(area) {
  if (!area) return;
  area.querySelectorAll('[data-event-id]').forEach((btn) => {
    btn.addEventListener('click', () => openScheduleDetail(btn.dataset.eventId));
  });
  area.querySelectorAll('[data-more-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const d = new Date(String(btn.dataset.moreDate) + 'T00:00:00');
      currentMonth = new Date(d.getFullYear(), d.getMonth(), 1);
      viewMode = 'list';
      localStorage.setItem(VIEW_MODE_KEY, 'list');
      renderScheduleView();
    });
  });
}

/** スケジュール読込（選択カテゴリをAPIへ渡す → いずれか1つ以上を含む行事が返る） */
export async function loadSchedules() {
  await loadCategories(true);

  const y = currentMonth.getFullYear();
  const m = currentMonth.getMonth();
  const dim = daysInMonth(currentMonth);
  const start = `${y}-${String(m + 1).padStart(2, '0')}-01`;
  const end = `${y}-${String(m + 1).padStart(2, '0')}-${String(dim).padStart(2, '0')}`;

  const params = { startDate: start, endDate: end };
  if (selectedCategoryIds.size > 0) params.categoryIds = [...selectedCategoryIds].join(',');

  try {
    const res = await apiGet('/schedules', params);
    const raw = res.data || res.schedules || [];
    schedulesCache = raw.map(mapEvent);
  } catch (e) {
    showToast(`スケジュール取得に失敗しました: ${e.message}`, 'error');
    schedulesCache = [];
  }

  renderScheduleView();
}

/** モーダルDOM（詳細・行事追加/編集・カテゴリ管理）を生成 */
function ensureScheduleDom() {
  if (document.getElementById('schedule-detail-modal')) return;
  const container = document.getElementById('modal-container') || document.body;

  container.insertAdjacentHTML('beforeend', `
    <div id="schedule-detail-modal" class="modal-overlay hidden">
      <div class="modal-card">
        <div class="modal-header">
          <h3 class="modal-title"><i data-lucide="calendar-check" class="w-5 h-5 text-accent"></i> 行事詳細</h3>
          <button type="button" class="modal-close modal-close-x" aria-label="閉じる" title="閉じる"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <div class="modal-body" id="schedule-detail-body"></div>
        <div class="modal-footer" id="schedule-detail-actions"></div>
      </div>
    </div>

    <div id="schedule-form-modal" class="modal-overlay hidden">
      <div class="modal-card">
        <div class="modal-header">
          <h3 id="schedule-form-title" class="modal-title"><i data-lucide="plus-circle" class="w-5 h-5 text-accent"></i> 行事の登録</h3>
          <button type="button" class="modal-close modal-close-x" aria-label="閉じる" title="閉じる"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <form id="schedule-form" class="modal-form">
          <div class="modal-body space-y-3">
            <div>
              <label class="block text-xs font-semibold text-soft mb-1">行事名 <span class="text-danger">*</span>
                <span id="sched-title-counter" class="text-[10px] text-muted font-normal">0 / ${TITLE_MAX}文字</span>
              </label>
              <input type="text" id="sched-title-input" maxlength="${TITLE_MAX}" required class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main" placeholder="例: 中間考査（第1日）">
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-soft mb-1">日付 <span class="text-danger">*</span></label>
                <input type="date" id="sched-date-input" required class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main">
              </div>
              <div>
                <label class="block text-xs font-semibold text-soft mb-1">対象学年</label>
                <select id="sched-grade-input" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main">
                  <option value="">全学年</option>
                  <option value="1">1年生</option>
                  <option value="2">2年生</option>
                  <option value="3">3年生</option>
                </select>
              </div>
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div>
                <label class="block text-xs font-semibold text-soft mb-1">開始時刻</label>
                <input type="time" id="sched-start-input" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main">
              </div>
              <div>
                <label class="block text-xs font-semibold text-soft mb-1">終了時刻</label>
                <input type="time" id="sched-end-input" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main">
              </div>
            </div>
            <div>
              <label class="block text-xs font-semibold text-soft mb-1">カテゴリ <span class="text-danger">*</span>（複数選択可）</label>
              <div id="sched-cat-checks" class="flex flex-wrap gap-1.5 mt-1"></div>
            </div>
            <div>
              <label class="block text-xs font-semibold text-soft mb-1">内容・メモ</label>
              <textarea id="sched-desc-input" rows="3" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"></textarea>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="modal-close btn-secondary px-4 py-2 text-xs rounded bg-surface text-soft hover-surface-strong">閉じる</button>
            <button type="submit" class="btn-primary px-4 py-2 text-xs rounded flex items-center gap-1"><i data-lucide="save" class="w-3.5 h-3.5"></i> 保存</button>
          </div>
        </form>
      </div>
    </div>
  `);
}

/** カテゴリ管理モーダルDOM（システム管理者のみ利用） */
function ensureCategoryAdminDom() {
  if (document.getElementById('schedule-category-modal')) return;
  const container = document.getElementById('modal-container') || document.body;

  container.insertAdjacentHTML('beforeend', `
    <div id="schedule-category-modal" class="modal-overlay hidden">
      <div class="modal-card modal-card--wide">
        <div class="modal-header">
          <h3 class="modal-title"><i data-lucide="tags" class="w-5 h-5 text-accent"></i> カテゴリ管理</h3>
          <button type="button" class="modal-close modal-close-x" aria-label="閉じる" title="閉じる"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <div class="modal-body space-y-3">
          <div class="p-2 rounded-lg bg-info-soft border border-info-soft text-[11px] text-info-strong">
            カテゴリはシステム管理者（ADMIN）のみ追加・改名・削除できます。行事はカテゴリを複数登録でき、
            フィルタは選択したカテゴリの<b>いずれか1つ以上</b>を含む行事を表示します。
          </div>
          <form id="sched-cat-add-form" class="flex flex-wrap items-end gap-2">
            <div class="flex-1 min-w-[140px]">
              <label class="block text-xs font-semibold text-soft mb-1">カテゴリ名（12文字以内）</label>
              <input id="sched-cat-name" maxlength="${NAME_MAX}" required class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main" placeholder="例: 特別教室">
            </div>
            <div class="w-28">
              <label class="block text-xs font-semibold text-soft mb-1">色</label>
              <select id="sched-cat-color" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main">
                <option value="INFO">青</option>
                <option value="SUCCESS">緑</option>
                <option value="WARNING">黄</option>
                <option value="DANGER">赤</option>
                <option value="PURPLE">紫</option>
                <option value="ACCENT">アクセント</option>
                <option value="SLATE">グレー</option>
              </select>
            </div>
            <div class="w-16">
              <label class="block text-xs font-semibold text-soft mb-1">表示順</label>
              <input id="sched-cat-sort" type="number" min="0" max="999" value="0" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main">
            </div>
            <button type="submit" class="btn-primary px-3 py-2 text-xs rounded flex items-center gap-1">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i> 追加
            </button>
          </form>
          <div id="sched-cat-list" class="space-y-2"></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="modal-close btn-secondary px-4 py-2 text-xs rounded bg-surface text-soft hover-surface-strong">閉じる</button>
        </div>
      </div>
    </div>
  `);
}

/** 行事詳細モーダル（行事名クリックで開く） */
function openScheduleDetail(eventId) {
  const ev = schedulesCache.find((e) => String(e.id) === String(eventId));
  if (!ev) {
    showToast('行事が見つかりません。', 'error');
    return;
  }

  const catChips = ev.categories.map((c) =>
    `<span class="px-2 py-1 text-[11px] font-bold rounded-full border ${palette(c.color_key).badge}">${escapeHTML(c.name)}</span>`
  ).join('');

  const timeLabel = ev.startTime ? `${ev.startTime} ~ ${ev.endTime || '時間未設定'}` : '終日（時間未設定）';

  document.getElementById('schedule-detail-body').innerHTML = `
    <h4 class="text-lg font-extrabold leading-tight text-main mb-3">${escapeHTML(ev.title)}</h4>
    <dl class="grid grid-cols-[64px_1fr] gap-x-2 gap-y-2 text-xs mb-3">
      <dt class="text-muted font-semibold">日付</dt>
      <dd class="font-bold text-main">${formatDate(ev.date, false)}（${WEEKDAYS[weekdayIndex(ev.date)]}）</dd>
      <dt class="text-muted font-semibold">時刻</dt>
      <dd class="font-semibold text-main">${timeLabel}</dd>
      <dt class="text-muted font-semibold">カテゴリ</dt>
      <dd class="flex flex-wrap gap-1">${catChips || '<span class="text-muted">カテゴリ未設定</span>'}</dd>
      <dt class="text-muted font-semibold">対象</dt>
      <dd class="font-semibold text-main">${escapeHTML(ev.targetGrade)}</dd>
      ${ev.authorName ? `<dt class="text-muted font-semibold">登録者</dt><dd><span class="inline-flex items-center gap-2">${userAvatarHtml({ name: ev.authorName, avatarUrl: ev.authorAvatar, size: 'xs' })}<span class="font-semibold text-main">${escapeHTML(ev.authorName)}</span></span></dd>` : ''}
    </dl>
    ${ev.description ? `<div class="p-2 rounded-lg bg-surface-soft border border-divider text-xs text-main whitespace-pre-wrap leading-relaxed">${escapeHTML(ev.description)}</div>` : ''}
  `;

  const canManage = canManageEvent(ev);
  const actions = document.getElementById('schedule-detail-actions');
  actions.innerHTML = `
    <button type="button" class="modal-close btn-secondary px-4 py-2 text-xs rounded bg-surface text-soft hover-surface-strong">閉じる</button>
    ${canManage ? `<button type="button" id="sched-edit-btn" class="btn-secondary px-4 py-2 text-xs rounded bg-surface text-soft hover-surface-strong flex items-center gap-1"><i data-lucide="pencil" class="w-3.5 h-3.5"></i> 編集</button>
      <button type="button" id="sched-delete-btn" class="btn-danger px-4 py-2 text-xs rounded bg-danger-soft text-danger-strong hover-danger-strong flex items-center gap-1"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> 削除</button>` : ''}
  `;

  const editBtn = document.getElementById('sched-edit-btn');
  if (editBtn) editBtn.addEventListener('click', () => {
    closeModal('schedule-detail-modal');
    openScheduleForm(ev);
  });

  const delBtn = document.getElementById('sched-delete-btn');
  if (delBtn) delBtn.addEventListener('click', () => deleteScheduleEvent(ev));

  openModal('schedule-detail-modal');
}

/** 行事削除（KYOMU・ADMIN・登録者本人のみ） */
async function deleteScheduleEvent(ev) {
  if (!window.confirm(`「${ev.title}」を削除しますか？`)) return;
  try {
    await apiDelete(`/schedules/${ev.id}`);
    showToast(`「${ev.title}」を削除しました。`, 'success');
    closeModal('schedule-detail-modal');
    await loadSchedules();
  } catch (e) {
    showToast(`削除に失敗しました: ${e.message}`, 'error');
  }
}

/** 行事追加・編集フォーム */
let editingEventId = null;

function openScheduleForm(ev) {
  if (!canEditEvent(ev)) {
    showToast('行事の登録・編集は教務委員会・システム管理者、および登録者本人のみです。', 'error');
    return;
  }

  editingEventId = ev ? ev.id : null;
  const titleHead = document.getElementById('schedule-form-title');
  titleHead.innerHTML = ev
    ? `<i data-lucide="pencil" class="w-5 h-5 text-accent"></i> 行事の編集`
    : `<i data-lucide="plus-circle" class="w-5 h-5 text-accent"></i> 行事の登録`;

  const todayStr = jstTodayStr();
  document.getElementById('sched-title-input').value = ev ? ev.title : '';
  document.getElementById('sched-date-input').value = ev ? ev.date : todayStr;
  document.getElementById('sched-start-input').value = ev && ev.startTime ? ev.startTime : '';
  document.getElementById('sched-end-input').value = ev && ev.endTime ? ev.endTime : '';
  document.getElementById('sched-grade-input').value = ev ? (ev.gradeValue || '') : '';
  document.getElementById('sched-desc-input').value = ev && ev.description ? ev.description : '';

  updateTitleCounter();
  renderCategoryChecks(ev ? ev.categories.map((c) => c.id) : []);
  openModal('schedule-form-modal');
}

function updateTitleCounter() {
  const input = document.getElementById('sched-title-input');
  const counter = document.getElementById('sched-title-counter');
  if (!input || !counter) return;
  const len = input.value.length;
  counter.textContent = `${len} / ${TITLE_MAX}文字`;
  counter.className = len >= TITLE_MAX ? 'text-[10px] text-danger-strong font-normal' : 'text-[10px] text-muted font-normal';
}

/** フォーム内カテゴリ複数選択（チェックボックス） */
function renderCategoryChecks(preselected) {
  const holder = document.getElementById('sched-cat-checks');
  if (!holder) return;

  const selected = new Set((preselected || []).map(Number));
  holder.innerHTML = categoriesCache.map((c) => {
    const checked = selected.has(c.id);
    const pal = palette(c.color_key);
    return `<label class="sched-cat-check flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold rounded-full border cursor-pointer ${checked ? `${pal.badge} ring-accent` : 'bg-surface text-soft border-main'}">
      <input type="checkbox" value="${c.id}" ${checked ? 'checked' : ''} class="rounded border-main accent-accent">
      <span>${escapeHTML(c.name)}</span>
    </label>`;
  }).join('');

  holder.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      const label = cb.closest('label');
      const c = categoriesCache.find((x) => x.id === Number(cb.value));
      const pal = palette(c ? c.color_key : 'ACCENT');
      label.className = `sched-cat-check flex items-center gap-1.5 px-2 py-1 text-[11px] font-semibold rounded-full border cursor-pointer ${cb.checked ? `${pal.badge} ring-accent` : 'bg-surface text-soft border-main'}`;
    });
  });
}

/** フォーム送信（1つ以上のカテゴリを必須化 → POST/PUT /api/schedules） */
async function submitScheduleForm(event) {
  event.preventDefault();

  const title = document.getElementById('sched-title-input').value.trim();
  const date = document.getElementById('sched-date-input').value;
  const categoryIds = Array.from(document.querySelectorAll('#sched-cat-checks input[type=checkbox]:checked')).map((cb) => Number(cb.value));

  if (!title) { showToast('行事名を入力してください。', 'error'); return; }
  if (!date) { showToast('日付を選択してください。', 'error'); return; }
  if (categoryIds.length === 0) { showToast('カテゴリを1つ以上選択してください。', 'error'); return; }

  const body = {
    date,
    event_date: date,
    title,
    start_time: document.getElementById('sched-start-input').value || null,
    end_time: document.getElementById('sched-end-input').value || null,
    description: document.getElementById('sched-desc-input').value.trim() || null,
    target_grade: document.getElementById('sched-grade-input').value || null,
    category_ids: categoryIds,
  };

  try {
    if (editingEventId) {
      await apiPut(`/schedules/${editingEventId}`, body);
      showToast(`「${title}」を更新しました。`, 'success');
    } else {
      await apiPost('/schedules', body);
      showToast(`「${title}」を登録しました。`, 'success');
    }
    closeModal('schedule-form-modal');
    await loadSchedules();
  } catch (e) {
    showToast(`保存に失敗しました: ${e.message}`, 'error');
  }
}

/** カテゴリ管理モーダル（ADMINのみ・カテゴリの追加改名削除と使用件数表示） */
function openCategoryAdmin() {
  if (!isAdmin()) {
    showToast('カテゴリの追加・改名・削除はシステム管理者のみです。', 'error');
    return;
  }
  ensureCategoryAdminDom();
  renderCategoryAdminList();
  openModal('schedule-category-modal');
}

function renderCategoryAdminList() {
  const holder = document.getElementById('sched-cat-list');
  if (!holder) return;

  if (categoriesCache.length === 0) {
    holder.innerHTML = '<div class="p-3 text-xs text-muted text-center">カテゴリがありません。上のフォームから追加してください。</div>';
    return;
  }

  holder.innerHTML = categoriesCache.map((c) => {
    const pal = palette(c.color_key);
    const colorOptions = COLOR_KEYS.map((k) => `<option value="${k}" ${c.color_key === k ? 'selected' : ''}>${COLOR_LABELS[k]}</option>`).join('');
    return `<div class="sched-cat-row flex flex-wrap items-center gap-2 p-2 rounded-lg border border-divider bg-surface-soft" data-cat-id="${c.id}">
      <span class="w-2.5 h-2.5 rounded-full shrink-0 ${pal.dot}"></span>
      <input type="text" data-field="name" value="${escapeHTML(c.name)}" maxlength="${NAME_MAX}" class="w-28 p-1.5 text-xs rounded bg-surface border border-main text-main" required>
      <select data-field="color_key" class="w-24 p-1.5 text-xs rounded bg-surface border border-main text-main">${colorOptions}</select>
      <input type="number" data-field="sort_order" value="${Number(c.sort_order) || 0}" min="0" max="999" class="w-14 p-1.5 text-xs rounded bg-surface border border-main text-main">
      <span class="text-[10px] text-muted font-semibold shrink-0">使用 ${Number(c.event_count) || 0}件</span>
      <div class="flex items-center gap-1 ml-auto">
        <button type="button" data-action="save" class="btn-primary px-2 py-1.5 text-[11px] rounded flex items-center gap-1"><i data-lucide="save" class="w-3 h-3"></i> 保存</button>
        <button type="button" data-action="delete" class="btn-danger px-2 py-1.5 text-[11px] rounded bg-danger-soft text-danger-strong hover-danger-strong flex items-center gap-1"><i data-lucide="trash-2" class="w-3 h-3"></i> 削除</button>
      </div>
    </div>`;
  }).join('');

  holder.querySelectorAll('.sched-cat-row').forEach((row) => {
    const id = Number(row.dataset.catId);

    row.querySelector('[data-action=save]').addEventListener('click', async () => {
      const name = row.querySelector('[data-field=name]').value.trim();
      const color_key = row.querySelector('[data-field=color_key]').value;
      const sort_order = Number(row.querySelector('[data-field=sort_order]').value) || 0;
      if (!name) { showToast('カテゴリ名を入力してください。', 'error'); return; }

      try {
        await apiPut(`/schedules/categories/${id}`, { name, color_key, sort_order });
        showToast(`「${name}」を更新しました。`, 'success');
        await loadCategories(true);
        renderCategoryAdminList();
        renderScheduleView();
      } catch (e) {
        showToast(`更新に失敗しました: ${e.message}`, 'error');
      }
    });

    row.querySelector('[data-action=delete]').addEventListener('click', async () => {
      const cat = categoriesCache.find((c) => c.id === id);
      const usage = cat ? Number(cat.event_count) || 0 : 0;
      const message = usage > 0
        ? `「${cat.name}」は ${usage}件の行事で使用されています。カテゴリを削除しますか？（行事は残ります）`
        : `「${cat ? cat.name : 'このカテゴリ'}」を削除しますか？`;
      if (!window.confirm(message)) return;

      try {
        await apiDelete(`/schedules/categories/${id}`);
        selectedCategoryIds.delete(id);
        showToast(`カテゴリ「${cat ? cat.name : ''}」を削除しました。`, 'success');
        await loadCategories(true);
        renderCategoryAdminList();
        renderScheduleView();
      } catch (e) {
        showToast(`削除に失敗しました: ${e.message}`, 'error');
      }
    });
  });
}

/** カテゴリ追加フォーム（ADMIN） */
async function submitCategoryAddForm(event) {
  event.preventDefault();
  if (!isAdmin()) {
    showToast('カテゴリ追加はシステム管理者のみです。', 'error');
    return;
  }

  const name = document.getElementById('sched-cat-name').value.trim();
  const color_key = document.getElementById('sched-cat-color').value;
  const sort_order = Number(document.getElementById('sched-cat-sort').value) || 0;

  if (!name) { showToast('カテゴリ名を入力してください。', 'error'); return; }

  try {
    const res = await apiPost('/schedules/categories', { name, color_key, sort_order });
    showToast(`カテゴリ「${name}」を追加しました。`, 'success');
    document.getElementById('sched-cat-name').value = '';
    const newId = res.category ? res.category.id : null;
    await loadCategories(true);
    if (newId) selectedCategoryIds.add(newId);
    renderCategoryAdminList();
    renderScheduleView();
  } catch (e) {
    showToast(`カテゴリ追加に失敗しました: ${e.message}`, 'error');
  }
}

/** モジュール初期化（DOM生成・フォーム・カテゴリ読み込み・初回描画） */
export async function initScheduleModule() {
  ensureScheduleDom();
  ensureCategoryAdminDom();

  const form = document.getElementById('schedule-form');
  if (form) form.addEventListener('submit', submitScheduleForm);

  const titleInput = document.getElementById('sched-title-input');
  if (titleInput) titleInput.addEventListener('input', updateTitleCounter);

  const catAddForm = document.getElementById('sched-cat-add-form');
  if (catAddForm) catAddForm.addEventListener('submit', submitCategoryAddForm);

  await loadCategories(true);
  await loadSchedules();
}


