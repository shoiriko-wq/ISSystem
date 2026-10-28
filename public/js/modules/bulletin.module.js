/**
 * ISSystem Bulletin Module
 * 掲示板一覧・日付ザッピング（日付ストリップ＋ミニカレンダー＋キーボード操作）・
 * インライン展開（アコーディオン）・詳細モーダル・承認・API連携
 */

import { apiGet, apiPost, apiPut } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast, userAvatarHtml } from '../ui-helpers.js';
import { state } from '../state.js';
import { API_BASE_URL } from '../config.js';

let bulletinsCache = [];
let currentCategory = 'ALL';
let currentSearch = '';

// ★ 投稿日ザッピング状態
//   'ALL' (全期間) / 'WEEK' (直近7日) / 'SPECIFIC' (特定の日)
let currentDayMode = 'ALL';
let currentDayDate = '';            // SPECIFIC 時の YYYY-MM-DD (JST)
let calendarAnchor = '';            // ミニカレンダー表示月アンカー (YYYY-MM-DD)
const expandedIds = new Set();      // インライン展開された掲示ID
let eventsBound = false;            // イベント多重登録防止

/** 未読数の安全な更新ヘルパー */
function updateUnread(count) {
  if (state && state.unreadCounts) {
    state.unreadCounts.bulletin = count;
  }
}

/**
 * 掲示板モジュールの初期化と画面構築
 */
export function initBulletinModule() {
  const container = document.getElementById('view-bulletin');
  if (!container) return;

  container.innerHTML = `
    <!-- ヘッダーツールバー -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-surface-strong p-4 rounded-xl border border-divider mb-4">
      <div>
        <h2 class="text-lg font-bold text-main flex items-center gap-2">
          <i data-lucide="megaphone" class="w-5 h-5 text-accent"></i> 職員連絡・掲示板
        </h2>
        <p class="text-xs text-muted">校内の全体連絡・指示・緊急連絡を一元共有します。</p>
      </div>
      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <button id="bulletin-btn-create" class="btn-primary py-2 px-4 text-xs font-bold flex items-center gap-2">
          <i data-lucide="plus-circle" class="w-4 h-4"></i> 新規連絡投稿
        </button>
      </div>
    </div>

    <!-- ★ 投稿日ザッピングツールバー（前日/日付チップ/翌日 + カレンダー + 日付入力） -->
    <div id="bulletin-day-toolbar" class="flex flex-wrap items-center gap-2 text-xs mb-1 bg-surface-strong border border-divider rounded-xl p-2">
      <span class="text-muted font-semibold flex items-center gap-1.5 shrink-0">
        <i data-lucide="calendar-days" class="w-3.5 h-3.5 text-accent"></i> 投稿日
      </span>
      <button id="bulletin-day-prev" class="icon-btn border border-divider bg-surface hover-border-accent"
              aria-label="前の日付へ" title="前日 (←)"><i data-lucide="chevron-left" class="w-3.5 h-3.5"></i></button>
      <div id="bulletin-day-chips" class="flex flex-wrap items-center gap-1.5"></div>
      <button id="bulletin-day-next" class="icon-btn border border-divider bg-surface hover-border-accent"
              aria-label="次の日付へ" title="翌日 (→)"><i data-lucide="chevron-right" class="w-3.5 h-3.5"></i></button>
      <button id="bulletin-cal-toggle" class="btn-secondary px-2.5 py-1 rounded-lg text-[11px] flex items-center gap-1"
              aria-expanded="false" aria-controls="bulletin-mini-cal">
        <i data-lucide="calendar" class="w-3.5 h-3.5"></i> カレンダー
      </button>
      <label class="flex items-center gap-1 text-muted text-[11px]">
        日付:
        <input type="date" id="bulletin-day-date" class="py-1 px-1.5 rounded-lg border border-main bg-surface text-main text-[11px]"
               aria-label="投稿日で絞り込み">
      </label>
      <span id="bulletin-day-summary" class="ml-auto text-[11px] text-muted font-mono"></span>
    </div>

    <!-- ★ ミニカレンダー（投稿数の打点付き。投稿日にフォーカスしてザッピング） -->
    <div id="bulletin-mini-cal" class="hidden mb-2 bg-surface-strong border border-divider rounded-xl p-3"></div>

    <p class="text-[10px] text-muted mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span>キーボード操作: <kbd class="kbd-key">↑</kbd><kbd class="kbd-key">↓</kbd> カード移動・<kbd class="kbd-key">Enter</kbd> 開閉</span>
      <span><kbd class="kbd-key">←</kbd><kbd class="kbd-key">→</kbd> 前日/翌日・<kbd class="kbd-key">T</kbd> 今日・<kbd class="kbd-key">A</kbd> すべて・<kbd class="kbd-key">C</kbd> カレンダー</span>
    </p>

    <!-- 検索 & カテゴリフィルタバー -->
    <div class="grid grid-cols-1 md:grid-cols-12 gap-3 items-center mb-4">
      <div class="md:col-span-7 flex flex-wrap items-center gap-1.5 text-xs">
        <button data-cat="ALL" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-main bg-surface text-main font-semibold active">すべて</button>
        <button data-cat="GENERAL" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-divider bg-surface-strong text-muted hover-text-main">一般掲示</button>
        <button data-cat="CIRCULAR" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-divider bg-surface-strong text-muted hover-text-main">回覧・要承認</button>
        <button data-cat="URGENT" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-divider bg-surface-strong text-muted hover-text-main">至急連絡</button>
      </div>
      <div class="md:col-span-5 relative">
        <i data-lucide="search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted"></i>
        <input type="text" id="bulletin-search-input" class="input-field pl-9 py-1.5 text-xs" placeholder="タイトルや本文から検索...">
      </div>
    </div>

    <!-- 掲示物カードグリッド（投稿日グループヘッダー＋インライン展開） -->
    <div id="bulletin-list-container" class="space-y-3">
      <div class="text-center py-10 text-xs text-muted">掲示板データを読み込み中...</div>
    </div>
  `;

  bindEvents();
  renderDayStrip();

  // 認証済み（トークンが存在する）場合のみデータ通信を実行
  if (state.currentUser && state.authToken) {
    loadBulletins();
  }
}

/**
 * イベントリスナー登録（委譲で動的生成要素にも対応）
 */
function bindEvents() {
  // 新規投稿ボタン
  document.getElementById('bulletin-btn-create')?.addEventListener('click', () => {
    const dateInput = document.getElementById('bulletin-target-date');
    if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
    openModal('bulletin-modal');
  });

  // 新規投稿フォーム送信（リスナー重複防止のため要素をクローン）
  const form = document.getElementById('bulletin-form');
  if (form) {
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);
    newForm.addEventListener('submit', handleCreateBulletin);
  }

  // カテゴリフィルター切り替え
  document.querySelectorAll('.bulletin-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bulletin-filter-btn').forEach(b => {
        b.classList.remove('active', 'bg-surface', 'text-main', 'border-main');
        b.classList.add('bg-surface-strong', 'text-muted', 'border-divider');
      });
      btn.classList.add('active', 'bg-surface', 'text-main', 'border-main');
      btn.classList.remove('bg-surface-strong', 'text-muted', 'border-divider');

      currentCategory = btn.getAttribute('data-cat') || 'ALL';
      renderBulletinList();
    });
  });

  // 検索インプット
  document.getElementById('bulletin-search-input')?.addEventListener('input', (e) => {
    currentSearch = e.target.value.toLowerCase().trim();
    renderBulletinList();
  });

  // 添付ファイル選択プレビュー
  const fileInput = document.getElementById('bulletin-files');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      renderSelectedFiles(Array.from(fileInput.files || []));
    });
  }

  // ★ 日付ツールバー（prev/next/チップ/カレンダー/日付入力）— 委譲で1回だけ登録
  const toolbar = document.getElementById('bulletin-day-toolbar');
  if (!eventsBound && toolbar) {
    toolbar.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-day-chip]');
      if (chip) { setDayMode('SPECIFIC', chip.getAttribute('data-day-chip')); return; }
      if (e.target.closest('#bulletin-day-prev')) { shiftDay(-1); return; }
      if (e.target.closest('#bulletin-day-next')) { shiftDay(1); return; }
      if (e.target.closest('#bulletin-cal-toggle')) { toggleMiniCalendar(); return; }
      const quick = e.target.closest('[data-quick-day]');
      if (quick) {
        const q = quick.getAttribute('data-quick-day');
        if (q === 'ALL') setDayMode('ALL');
        if (q === 'TODAY') setDayMode('SPECIFIC', dayKey(0));
        if (q === 'WEEK') setDayMode('WEEK');
      }
    });

    document.getElementById('bulletin-day-date')?.addEventListener('change', (e) => {
      setDayMode(e.target.value ? 'SPECIFIC' : 'ALL', e.target.value || '');
    });

    // ★ カード開閉・承認・コメント・詳細・日付ジャンプ（一覧は再描画されるので委譲）
    const listEl = document.getElementById('bulletin-list-container');
    if (listEl) {
      listEl.addEventListener('click', (e) => {
        const toggle = e.target.closest('[data-bulletin-toggle]');
        if (toggle) { toggleBulletinExpand(toggle.getAttribute('data-bulletin-toggle')); return; }

        const approve = e.target.closest('[data-bulletin-approve]');
        if (approve) { approveBulletin(approve.getAttribute('data-bulletin-approve')); return; }

        const comment = e.target.closest('[data-bulletin-comment]');
        if (comment) { sendBulletinComment(comment.getAttribute('data-bulletin-comment')); return; }

        const detail = e.target.closest('[data-bulletin-detail]');
        if (detail) { openBulletinDetail(detail.getAttribute('data-bulletin-detail')); return; }

        const jump = e.target.closest('[data-jump-day]');
        if (jump) { setDayMode('SPECIFIC', jump.getAttribute('data-jump-day')); return; }
      });
    }

    // ★ ミニカレンダー（日付選択・月送りの委譲）
    const calEl = document.getElementById('bulletin-mini-cal');
    if (calEl) {
      calEl.addEventListener('click', (e) => {
        const dayBtn = e.target.closest('[data-cal-date]');
        if (dayBtn && !dayBtn.disabled) { setDayMode('SPECIFIC', dayBtn.getAttribute('data-cal-date')); return; }
        const monthBtn = e.target.closest('[data-cal-month]');
        if (monthBtn) { shiftCalendarMonth(monthBtn.getAttribute('data-cal-month')); return; }
        if (e.target.closest('[data-cal-today]')) {
          calendarAnchor = dayKey(0);
          setDayMode('SPECIFIC', dayKey(0));
        }
      });
    }


    // ★ キーボードザッピング（掲示板タブがアクティブな時のみ）
    document.addEventListener('keydown', bulletinKeyHandler);

    eventsBound = true;
  }
}

/**
 * キーボードによるザッピング操作
 * ↑/↓ カードフォーカス移動、Enter/Space(ボタン既定)、←/→ 前日/翌日、T 今日、A すべて、C カレンダー
 */
function bulletinKeyHandler(e) {
  if (state.currentTab !== 'bulletin') return;
  const view = document.getElementById('view-bulletin');
  if (!view || view.classList.contains('hidden')) return;

  // 入力中のキー入力を邪魔しない
  const tag = (e.target && e.target.tagName) || '';
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)) return;
  // モーダル開時はキーボード操作をモーダル側に譲る
  const openModals = Array.from(document.querySelectorAll('.modal-overlay'))
    .filter(m => !m.classList.contains('hidden'));
  if (openModals.length > 0) return;

  const keys = Array.from(document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]'));

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (keys.length === 0) return;
    e.preventDefault();
    const idx = keys.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? Math.min(idx + 1, keys.length - 1) : Math.max(idx - 1, 0);
    keys[next < 0 ? 0 : next].focus();
    return;
  }

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    shiftDay(e.key === 'ArrowLeft' ? -1 : 1);
    return;
  }

  const k = e.key.toLowerCase();
  if (k === 't') { e.preventDefault(); setDayMode('SPECIFIC', dayKey(0)); return; }
  if (k === 'a') { e.preventDefault(); setDayMode('ALL'); return; }
  if (k === 'c') { e.preventDefault(); toggleMiniCalendar(); return; }
}

/* ==========================================================================
   日付ユーティリティ（JST キー YYYY-MM-DD ベースのザッピング）
   ========================================================================== */

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 投稿日を JST キー (YYYY-MM-DD) に正規化 */
function toJstDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 9 * 3600000).toISOString().split('T')[0];
}

/** JST 基準の今日キーから offset 日分のキー */
function dayKey(offset = 0) {
  const d = new Date(Date.now() + 9 * 3600000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split('T')[0];
}

/** YYYY-MM-DD キーを offset 日ずらす */
function shiftDateKey(key, offset) {
  const p = String(key).split('-').map(Number);
  const t = Date.UTC(p[0], p[1] - 1, p[2]) + offset * 86400000;
  return new Date(t).toISOString().split('T')[0];
}

/** 曜日ラベル (YYYY-MM-DD → 月 等) */
function weekdayLabel(key) {
  const p = String(key).split('-').map(Number);
  return WEEKDAY_LABELS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
}

/** M/D 表記 */
function mdLabel(key) {
  const p = String(key).split('-');
  return `${parseInt(p[1], 10)}/${parseInt(p[2], 10)}`;
}

/** キャッシュから日別件数を算出 */
function dayCounts() {
  const map = new Map();
  bulletinsCache.forEach(b => {
    const k = toJstDay(b.postedAt || b.posted_at || b.createdAt || b.created_at);
    if (k) map.set(k, (map.get(k) || 0) + 1);
  });
  return map;
}

/** 投稿日が現在の「日ごと」表示モードに一致するか */
function matchesDay(b) {
  const posted = toJstDay(b.postedAt || b.posted_at || b.createdAt || b.created_at);
  if (currentDayMode === 'ALL') return true;
  if (!posted) return false;
  if (currentDayMode === 'TODAY') return posted === dayKey(0);
  if (currentDayMode === 'YESTERDAY') return posted === dayKey(-1);
  if (currentDayMode === 'WEEK') return posted >= dayKey(-7) && posted <= dayKey(0);
  if (currentDayMode === 'SPECIFIC') return posted === currentDayDate;
  return true;
}

/**
 * 表示モードの設定（ザッピングの中心関数）
 * @param {'ALL'|'WEEK'|'SPECIFIC'} mode
 * @param {string} [date] SPECIFIC 時の YYYY-MM-DD
 */
function setDayMode(mode, date = '') {
  currentDayMode = mode;
  currentDayDate = mode === 'SPECIFIC' ? (date || dayKey(0)) : '';
  if (mode === 'SPECIFIC') calendarAnchor = currentDayDate;

  const dateInput = document.getElementById('bulletin-day-date');
  if (dateInput) dateInput.value = currentDayDate;

  renderDayStrip();
  renderBulletinList();
  refreshLucideIcons();
}

/**
 * 前日/翌日へ移動（←/→ キー・prev/next ボタン共通）
 * @param {number} offset -1 | +1
 */
function shiftDay(offset) {
  const base = (currentDayMode === 'SPECIFIC' && currentDayDate) ? currentDayDate : dayKey(0);
  const target = shiftDateKey(base, offset);
  if (target > dayKey(0)) {
    showToast('これより先の投稿日は表示できません', 'info');
    return;
  }
  setDayMode('SPECIFIC', target);
  const chip = document.querySelector(`#bulletin-day-chips [data-day-chip="${target}"]`);
  if (chip) chip.focus();
}

/** ミニカレンダーの開閉 */
function toggleMiniCalendar() {
  const cal = document.getElementById('bulletin-mini-cal');
  const btn = document.getElementById('bulletin-cal-toggle');
  if (!cal) return;
  const opening = cal.classList.contains('hidden');
  if (opening) renderMiniCalendar();
  cal.classList.toggle('hidden', !opening);
  if (btn) btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
}

/** カレンダー表示月をずらす */
function shiftCalendarMonth(delta) {
  const d = Number(delta) || 0;
  const anchor = calendarAnchor || dayKey(0);
  const [y, m] = anchor.split('-').map(Number);
  const idx = (m - 1 + d);
  const ny = y + Math.floor(idx / 12);
  const nm = ((idx % 12) + 12) % 12 + 1;
  calendarAnchor = `${ny}-${String(nm).padStart(2, '0')}-01`;
  renderMiniCalendar();
}


/**
 * 日付ストリップ（すべて / 直近7日 / 直近の日付チップ＋件数バッジ）の再描画
 */
function renderDayStrip() {
  const chipsEl = document.getElementById('bulletin-day-chips');
  const summaryEl = document.getElementById('bulletin-day-summary');
  if (!chipsEl) return;

  const counts = dayCounts();
  const today = dayKey(0);

  const quickAll = `<button type="button" data-quick-day="ALL"
      class="day-chip${currentDayMode === 'ALL' ? ' active' : ''}" aria-pressed="${currentDayMode === 'ALL'}">すべて</button>`;
  const quickWeek = `<button type="button" data-quick-day="WEEK"
      class="day-chip${currentDayMode === 'WEEK' ? ' active' : ''}" aria-pressed="${currentDayMode === 'WEEK'}">直近7日</button>`;

  const keys = [];
  for (let i = 0; i < 7; i++) keys.push(shiftDateKey(today, -i));
  if (currentDayMode === 'SPECIFIC' && !keys.includes(currentDayDate)) keys.push(currentDayDate);
  keys.sort().reverse();

  const chips = keys.map(k => {
    const sel = currentDayMode === 'SPECIFIC' && k === currentDayDate;
    const n = counts.get(k) || 0;
    return `<button type="button" data-day-chip="${k}" class="day-chip${sel ? ' active' : ''}"
              aria-pressed="${sel}" title="${k} (${weekdayLabel(k)}) 投稿 ${n} 件">
              <span class="text-muted font-normal">${weekdayLabel(k)}</span>
              <span>${mdLabel(k)}</span>
              ${n > 0 ? `<span class="day-chip-count">${n}</span>` : ''}
            </button>`;
  }).join('');

  chipsEl.innerHTML = quickAll + quickWeek + chips;

  const total = bulletinsCache.length;
  if (summaryEl) {
    if (currentDayMode === 'ALL') {
      summaryEl.textContent = `全期間 ${total} 件`;
    } else if (currentDayMode === 'WEEK') {
      const weekCount = bulletinsCache.filter(b => matchesDay(b)).length;
      summaryEl.textContent = `直近7日 ${weekCount} 件 / 全 ${total} 件`;
    } else {
      summaryEl.textContent = `${currentDayDate} (${weekdayLabel(currentDayDate)}) ${counts.get(currentDayDate) || 0} 件 / 全 ${total} 件`;
    }
  }
}

/**
 * ミニカレンダー（投稿数打点付き）の描画
 */
function renderMiniCalendar() {
  const calEl = document.getElementById('bulletin-mini-cal');
  if (!calEl) return;

  const anchor = calendarAnchor || dayKey(0);
  const [y, m] = anchor.split('-').map(Number);
  const counts = dayCounts();
  const today = dayKey(0);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="mini-cal-day mini-cal-empty"></span>');
  for (let d = 1; d <= dim; d++) {
    const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const n = counts.get(key) || 0;
    const cls = [
      'mini-cal-day',
      key === today ? 'mini-cal-today' : '',
      (currentDayMode === 'SPECIFIC' && key === currentDayDate) ? 'mini-cal-selected' : '',
      n > 0 ? 'mini-cal-has' : '',
      key > today ? 'mini-cal-day-future' : '',
    ].filter(Boolean).join(' ');
    cells.push(`<button type="button" class="${cls}" data-cal-date="${key}" ${key > today ? 'disabled' : ''}
                 aria-label="${key} ${weekdayLabel(key)} 投稿 ${n} 件">
                 <span class="mini-cal-num">${d}</span>
                 ${n > 0 ? '<span class="mini-cal-dot"></span>' : ''}
               </button>`);
  }

  calEl.innerHTML = `
    <div class="flex items-center justify-between mb-2">
      <button type="button" class="icon-btn border border-divider bg-surface" data-cal-month="-1" aria-label="前の月">
        <i data-lucide="chevron-left" class="w-4 h-4"></i>
      </button>
      <span class="text-sm font-bold text-main">${y}年${m}月</span>
      <div class="flex items-center gap-1">
        <button type="button" class="btn-secondary px-2 py-1 text-[10px]" data-cal-today>今日</button>
        <button type="button" class="icon-btn border border-divider bg-surface" data-cal-month="1" aria-label="次の月">
          <i data-lucide="chevron-right" class="w-4 h-4"></i>
        </button>
      </div>
    </div>
    <div class="mini-cal-grid mb-1">
      ${WEEKDAY_LABELS.map(w => `<span class="mini-cal-wd">${w}</span>`).join('')}
    </div>
    <div class="mini-cal-grid">${cells.join('')}</div>
    <p class="text-[10px] text-muted mt-2">● は投稿のある日です。日付をクリックでその日に絞り込み、←/→ キーで前日/翌日へザッピングできます。</p>
  `;
  refreshLucideIcons();
}


/* ==========================================================================
   一覧描画（日付グループ＋インライン展開アコーディオン）
   ========================================================================== */

/**
 * 掲示データの取得（キャッシュ全件。日付絞り込みはクライアント側で処理し、
 * ザッピング時のネットワーク往復・スクロール喪失をなくす）
 */
export async function loadBulletins() {
  try {
    const res = await apiGet('/bulletins', {});
    bulletinsCache = res.bulletins || (Array.isArray(res) ? res : []);
  } catch (err) {
    console.warn('[Bulletin] API取得失敗のためダミー表示:', err.message);
    bulletinsCache = getDummyBulletins();
  }

  const unreadCount = bulletinsCache.filter(b => !b.isRead && b.ackStatus !== 'READ' && b.ackStatus !== 'APPROVED').length;
  updateUnread(unreadCount);

  renderDayStrip();
  renderBulletinList();
}

/** カテゴリ・検索・投稿日による絞り込みと優先度/日時降順ソート */
function filteredBulletins() {
  const filtered = bulletinsCache.filter(b => {
    const postType = b.postType || b.post_type || 'NOTICE';
    const priority = b.priority || 'NORMAL';

    let matchCat = true;
    if (currentCategory === 'GENERAL') matchCat = (postType === 'NOTICE' && priority !== 'URGENT');
    if (currentCategory === 'CIRCULAR') matchCat = (postType === 'CIRCULAR');
    if (currentCategory === 'URGENT') matchCat = (priority === 'URGENT');

    const matchQuery = !currentSearch ||
      b.title.toLowerCase().includes(currentSearch) ||
      b.content.toLowerCase().includes(currentSearch) ||
      (b.authorName && b.authorName.toLowerCase().includes(currentSearch));

    return matchCat && matchQuery && matchesDay(b);
  });

  filtered.sort((a, b) => {
    const pA = a.priority === 'URGENT' ? 1 : 0;
    const pB = b.priority === 'URGENT' ? 1 : 0;
    const dateA = new Date(a.postedAt || a.posted_at || a.createdAt || a.created_at);
    const dateB = new Date(b.postedAt || b.posted_at || b.createdAt || b.created_at);
    return pB - pA || dateB - dateA;
  });
  return filtered;
}


/**
 * 掲示カード（閉じ=プレビュー2行、開=本文全文＋添付＋操作）
 * @param {Object} b
 */
function cardHtml(b) {
  const isUrgent = b.priority === 'URGENT';
  const isCircular = b.postType === 'CIRCULAR' || b.post_type === 'CIRCULAR';
  const isRead = b.isRead || b.ackStatus === 'READ' || b.ackStatus === 'APPROVED';
  const attachments = b.attachments || [];
  const expanded = expandedIds.has(String(b.id));
  const bodyId = `bbody-${b.id}`;
  const postedRaw = b.postedAt || b.posted_at || b.createdAt || b.created_at;

  const badges = `
    ${isUrgent ? '<span class="badge badge-warning flex items-center gap-1"><i data-lucide="alert-triangle" class="w-3 h-3"></i> 至急</span>' : ''}
    <span class="badge ${isCircular ? 'bg-warning-soft text-warning-strong border-warning-soft' : 'badge'}">${isCircular ? '回覧・要承認' : '一般掲示'}</span>
    ${!isRead ? '<span class="badge bg-danger-soft text-danger border-danger-soft">未読</span>' : ''}
    ${attachments.length > 0 ? `<span class="badge bg-accent-soft text-accent-strong border-accent-soft flex items-center gap-1"><i data-lucide="paperclip" class="w-3 h-3"></i> 添付 ${attachments.length}</span>` : ''}
  `;

  return `
    <div class="card p-0 overflow-hidden transition-all ${isUrgent ? 'border-l-4 border-l-warning' : ''}"
         data-bulletin-id="${b.id}">
      <button type="button" class="w-full text-left p-3.5 hover-surface-soft transition-colors flex items-start gap-2"
              data-bulletin-toggle="${b.id}" aria-expanded="${expanded}" aria-controls="${bodyId}">
        <span class="flex-1 min-w-0">
          <span class="flex items-center gap-2 flex-wrap mb-1">${badges}
            <span class="ml-auto text-[10px] text-muted font-mono shrink-0">${formatDate(postedRaw)}</span>
          </span>
          <span class="block text-sm font-bold text-main truncate">${escapeHTML(b.title)}</span>
          ${expanded ? '' : `<span class="block text-[11px] text-soft line-clamp-2 mt-1 leading-relaxed whitespace-pre-wrap">${escapeHTML(b.content)}</span>`}
        </span>
        <i data-lucide="chevron-down" class="w-4 h-4 mt-1 shrink-0 text-muted transition-transform ${expanded ? 'rotate-180' : ''}"></i>
      </button>

      <div id="${bodyId}" class="${expanded ? '' : 'hidden'} border-t border-divider px-4 py-3">
        <div class="text-xs text-main leading-relaxed whitespace-pre-wrap">${escapeHTML(b.content)}</div>
        ${attachmentsHtml(attachments)}
        <div class="flex items-center gap-2 mt-3 flex-wrap">
          ${isCircular ? `<button type="button" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1.5" data-bulletin-approve="${b.id}">
              <i data-lucide="check-circle" class="w-3.5 h-3.5"></i> ワンクリック承認</button>` : ''}
          <button type="button" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5" data-bulletin-comment="${b.id}">
            <i data-lucide="message-square" class="w-3.5 h-3.5"></i> 補足・コメント</button>
          <button type="button" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5" data-bulletin-detail="${b.id}">
            <i data-lucide="maximize-2" class="w-3.5 h-3.5"></i> 詳細</button>
          <div class="ml-auto flex items-center gap-1.5 text-[10px] text-muted font-mono">
            ${userAvatarHtml({ name: b.authorName || b.author_name || '教員', avatarUrl: b.authorAvatar || b.author_avatar || null, size: 'xs' })}
            <span>投稿者: <strong class="text-soft">${escapeHTML(b.authorName || b.author_name || '教員')}</strong></span>
          </div>
        </div>
      </div>
    </div>`;
}

/** 添付ファイル一覧（カード内・モーダル共用） */
function attachmentsHtml(atts = []) {
  if (atts.length === 0) return '';
  return `
    <div class="mt-3">
      <p class="text-[11px] font-semibold text-soft mb-1.5 flex items-center gap-1">
        <i data-lucide="paperclip" class="w-3.5 h-3.5 text-accent"></i> 添付ファイル (${atts.length})
      </p>
      <ul class="space-y-1.5">
        ${atts.map(a => `
          <li class="flex items-center gap-2 text-[11px] bg-surface-strong border border-divider rounded-lg px-2.5 py-1.5">
            <span class="truncate text-main">${escapeHTML(a.name)}</span>
            <span class="text-muted shrink-0">${formatBytes(a.size)}</span>
            ${a.kgs ? '<span class="badge bg-warning-soft text-warning-strong border border-warning-soft shrink-0">KAGOSHIMA EDU</span>' : ''}
            <a href="${API_BASE_URL}/bulletins/attachments/${a.id}" target="_blank" rel="noopener"
               class="ml-auto text-accent-strong hover-text-accent-strong shrink-0 flex items-center gap-1">
              <i data-lucide="download" class="w-3.5 h-3.5"></i> ダウンロード
            </a>
          </li>`).join('')}
      </ul>
    </div>`;
}


/**
 * 掲示板一覧の描画（投稿日グループヘッダー＋カード）
 */
function renderBulletinList() {
  const container = document.getElementById('bulletin-list-container');
  if (!container) return;

  const filtered = filteredBulletins();

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-12 text-xs text-muted bg-surface-soft rounded-xl border border-divider">
      ${currentDayMode === 'ALL' ? '該当する掲示連絡はありません。' : '選択した投稿日に掲示連絡はありません。左右の矢印で前後の日に移動できます。'}
    </div>`;
    refreshLucideIcons();
    return;
  }

  // 投稿日ごとにグループ化（SPECIFIC モードではヘッダー不要＝ストリップに日付表示）
  const groups = new Map();
  filtered.forEach(b => {
    const k = toJstDay(b.postedAt || b.posted_at || b.createdAt || b.created_at) || 'UNKNOWN';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(b);
  });

  const dayKeys = [...groups.keys()].sort().reverse();
  const counts = dayCounts();
  const parts = [];

  dayKeys.forEach(k => {
    const items = groups.get(k);
    if (currentDayMode !== 'SPECIFIC' && k !== 'UNKNOWN') {
      const prevKey = shiftDateKey(k, -1);
      const hasPrev = (counts.get(prevKey) || 0) > 0;
      parts.push(`
        <div class="bulletin-day-head sticky top-0 z-10 flex items-center gap-2 bg-surface-strong border border-divider rounded-lg px-3 py-1.5 text-[11px] font-bold text-main">
          <i data-lucide="calendar" class="w-3.5 h-3.5 text-accent"></i>
          <span>${k} (${weekdayLabel(k)}) ・ ${items.length} 件</span>
          ${hasPrev ? `<button type="button" class="btn-secondary px-2 py-0.5 text-[10px] ml-auto flex items-center gap-1" data-jump-day="${prevKey}">
              <i data-lucide="chevron-left" class="w-3 h-3"></i> 前日</button>` : ''}
          <button type="button" class="btn-secondary px-2 py-0.5 text-[10px]${hasPrev ? '' : ' ml-auto'}" data-jump-day="${k}">この日のみ表示</button>
        </div>`);
    }
    parts.push(items.map(cardHtml).join(''));
  });

  container.innerHTML = parts.join('');
  refreshLucideIcons();
}

/**
 * カードの開閉（本文をその場で展開＝モーダル不要なザッピング）
 * 展開時に既読化し、フォーカスを開いたカードへ戻す
 */
function toggleBulletinExpand(id) {
  const key = String(id);
  const isExpanding = !expandedIds.has(key);
  if (isExpanding) {
    expandedIds.add(key);
    markBulletinRead(id);
  } else {
    expandedIds.delete(key);
  }
  renderBulletinList();
  if (isExpanding) {
    const btn = document.querySelector(`#bulletin-list-container [data-bulletin-toggle="${id}"]`);
    if (btn) btn.focus();
  }
}

/** 既読化（PUT /api/bulletins/:id/read） */
async function markBulletinRead(id) {
  const item = bulletinsCache.find(b => String(b.id) === String(id));
  if (!item) return;
  if (item.isRead || item.ackStatus === 'READ' || item.ackStatus === 'APPROVED') return;

  item.isRead = true;
  item.ackStatus = 'READ';
  try {
    await apiPut(`/bulletins/${id}/read`, {});
  } catch (e) { /* オフライン時はローカル状態のみ更新 */ }

  const unreadCount = bulletinsCache.filter(b => !b.isRead && b.ackStatus !== 'READ' && b.ackStatus !== 'APPROVED').length;
  updateUnread(unreadCount);
  renderBulletinList();
}

/** ワンクリック承認 */
async function approveBulletin(id) {
  try {
    await apiPut(`/bulletins/${id}/approve`, { comment: '確認・承認しました' });
    const item = bulletinsCache.find(b => String(b.id) === String(id));
    if (item) item.ackStatus = 'APPROVED';
    showToast('承認を完了しました', 'success');
    closeModal('bulletin-detail-modal');
    renderBulletinList();
  } catch (err) {
    showToast('承認処理に失敗しました', 'error');
  }
}

/** 投稿者への補足・コメント送信 */
async function sendBulletinComment(id) {
  const comment = prompt('投稿者への補足・確認コメントを入力してください:');
  if (!comment) return;
  try {
    await apiPost(`/bulletins/${id}/comments`, { comment });
    showToast('コメントを送信しました', 'success');
  } catch (e) {
    showToast('コメントを送信しました', 'info');
  }
}


/**
 * 詳細モーダルの表示 & 既読処理
 * @param {string} id
 */
async function openBulletinDetail(id) {
  const item = bulletinsCache.find(b => String(b.id) === String(id));
  if (!item) return;

  if (!item.isRead && item.ackStatus !== 'READ' && item.ackStatus !== 'APPROVED') {
    item.isRead = true;
    item.ackStatus = 'READ';
    try {
      await apiPut(`/bulletins/${id}/read`, {});
    } catch (e) {}
    const unreadCount = bulletinsCache.filter(b => !b.isRead && b.ackStatus !== 'READ' && b.ackStatus !== 'APPROVED').length;
    updateUnread(unreadCount);
    renderBulletinList();
  }

  const titleEl = document.getElementById('detail-bulletin-title');
  const metaEl = document.getElementById('detail-bulletin-meta');
  const contentEl = document.getElementById('detail-bulletin-content');
  const actionsEl = document.getElementById('detail-bulletin-actions');
  const attachEl = document.getElementById('detail-bulletin-attachments');

  if (titleEl) titleEl.textContent = item.title;
  if (metaEl) {
    metaEl.innerHTML = `
      <span>種別: <strong class="text-accent-strong">${item.postType === 'CIRCULAR' ? '回覧板' : '一般掲示'}</strong></span>
      <span class="flex items-center gap-1.5">投稿者: ${userAvatarHtml({ name: item.authorName || item.author_name || '教員', avatarUrl: item.authorAvatar || item.author_avatar || null, size: 'xs' })}${escapeHTML(item.authorName || item.author_name || '教員')}</span>
      <span>投稿日: <strong class="text-main">${formatDate(item.postedAt || item.posted_at || item.createdAt || item.created_at)}</strong></span>
    `;
  }
  if (contentEl) contentEl.textContent = item.content;

  // 添付ファイル一覧
  if (attachEl) {
    const atts = item.attachments || [];
    attachEl.innerHTML = atts.length > 0
      ? attachmentsHtml(atts)
      : `<p class="text-[11px] text-muted">添付ファイルはありません。</p>`;
  }

  if (actionsEl) {
    const isCircular = item.postType === 'CIRCULAR' || item.post_type === 'CIRCULAR';
    actionsEl.innerHTML = `
      ${isCircular ? `
        <button id="btn-approve-bulletin" class="btn-primary py-1.5 px-3 text-xs bg-success hover-success-strong flex items-center gap-1.5">
          <i data-lucide="check-circle" class="w-3.5 h-3.5"></i> ワンクリック承認
        </button>` : ''}
      <button id="btn-revise-request" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5 text-warning border-warning-soft">
        <i data-lucide="message-square" class="w-3.5 h-3.5"></i> 補足・コメント
      </button>
      <button class="modal-close btn-secondary py-1.5 px-4 text-xs">閉じる</button>
    `;

    document.getElementById('btn-approve-bulletin')?.addEventListener('click', () => approveBulletin(id));
    document.getElementById('btn-revise-request')?.addEventListener('click', () => sendBulletinComment(id));
  }

  openModal('bulletin-detail-modal');
  refreshLucideIcons();
}


/**
 * 新規投稿処理
 */
async function handleCreateBulletin(e) {
  e.preventDefault();

  const title = document.getElementById('bulletin-title')?.value.trim();
  const category = document.getElementById('bulletin-category')?.value;
  const content = document.getElementById('bulletin-content')?.value.trim();
  const isPinned = document.getElementById('bulletin-pinned')?.checked || false;
  const targetDate = document.getElementById('bulletin-target-date')?.value || '';

  if (!title || !content) {
    showToast('タイトルと本文は必須です', 'warning');
    return;
  }

  const postType = (category === 'INSTRUCTION' || category === 'CIRCULAR') ? 'CIRCULAR' : 'NOTICE';
  const priority = (category === 'URGENT' || isPinned) ? 'URGENT' : 'NORMAL';

  // 投稿日時（JST 現在時刻・日ごと表示の基準）
  const postedAt = new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00');

  const fileInput = document.getElementById('bulletin-files');
  const files = fileInput ? Array.from(fileInput.files || []) : [];

  if (files.length > 10) {
    showToast('添付ファイルは1回につき10件までです', 'warning');
    return;
  }

  const maxBytes = 10 * 1024 * 1024;
  const oversize = files.find(f => f.size > maxBytes);
  if (oversize) {
    showToast(`「${oversize.name}」は10MBを超えています`, 'warning');
    return;
  }

  const targetScope = { grade: 'ALL', department: 'ALL' };

  try {
    if (files.length > 0) {
      const fd = new FormData();
      fd.append('title', title);
      fd.append('content', content);
      fd.append('postType', postType);
      fd.append('priority', priority);
      fd.append('postedAt', postedAt);
      fd.append('targetDate', targetDate);
      fd.append('targetScope', JSON.stringify(targetScope));
      files.forEach((f) => fd.append('files', f, f.name));
      await apiPostForm('/bulletins/upload', fd);
      showToast(`投稿しました（添付 ${files.length} 件）`, 'success');
    } else {
      await apiPost('/bulletins', {
        title,
        content,
        postType,
        priority,
        postedAt,
        targetDate,
        targetScope,
        attachments: []
      });
      showToast('投稿しました', 'success');
    }
  } catch (err) {
    console.error('[Bulletin] 投稿エラー:', err);
    showToast(err.message || '投稿に失敗しました', 'error');
    return;
  }

  closeModal('bulletin-modal');
  const form = document.getElementById('bulletin-form');
  form?.reset();
  if (fileInput) fileInput.value = '';
  renderSelectedFiles([]);
  loadBulletins();
}

/**
 * 選択ファイル一覧の表示（投稿モーダル内）
 * @param {Array<File>} files
 */
function renderSelectedFiles(files = []) {
  const listEl = document.getElementById('bulletin-files-list');
  if (!listEl) return;

  if (files.length === 0) {
    listEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = files.map(f => `
    <li class="flex items-center gap-2 text-[11px] text-soft">
      <i data-lucide="paperclip" class="w-3 h-3 text-accent shrink-0"></i>
      <span class="truncate">${escapeHTML(f.name)}</span>
      <span class="text-muted shrink-0">${formatBytes(f.size)}</span>
    </li>
  `).join('');
  refreshLucideIcons();
}

/** バイト数表示の整形 */
function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** API 取得失敗時のダミーデータ（開発・検証用） */
function getDummyBulletins() {
  return [
    {
      id: 'post_1',
      title: '【教務部】中間考査採点票の提出期限について',
      postType: 'CIRCULAR',
      priority: 'URGENT',
      content: '中間考査の全科目採点票の最終締め切りは明後日17時です。未提出の教科・学年はお早めにご提出ください。',
      authorName: '教務部・佐藤',
      createdAt: new Date(Date.now() - 2 * 86400000).toISOString(),
      ackStatus: 'UNREAD'
    },
    {
      id: 'post_2',
      title: '避難訓練の実施要項および各クラスの避難経路確認',
      postType: 'NOTICE',
      priority: 'NORMAL',
      content: '来週火曜日の6限に全校避難訓練を実施します。各担任の先生は事前に生徒へ非常口の周知を行ってください。',
      authorName: '生徒指導部・田中',
      createdAt: new Date(Date.now() - 3 * 86400000).toISOString(),
      ackStatus: 'READ'
    }
  ];
}

