/**
 * ISSystem Bulletin Module
 * 掲示板＝マスタ・ディテール（左=タイトル列＋未読バッジ／右=選択記事の全文・コメント）
 * 投稿日はヘッダーのタイトル行に ‹ [日付] › を埋め込む（中心日読取は ‹ › の左の固定幅）。
 * 選択＝即既読化で右ペインに全文が即表示。コメントは右ペインに並べ、その場で送信できる。
 * 検索は小型インライン、キー操作の手引きは収納（キー操作ボタンで開閉）、詳細モーダル・API連携
 */

import { apiGet, apiPost, apiPut, apiPostForm, apiDelete } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast, userAvatarHtml } from '../ui-helpers.js';
import { state } from '../state.js';
import { API_BASE_URL } from '../config.js';

let bulletinsCache = [];
let currentSearch = '';

// ★ 投稿日状態（表示日 = YYYY-MM-DD JST。‹ › と日付入力・←/→ キーで 1 日ずつ移動）
let currentDayDate = '';            // 中心日
let calendarAnchor = '';            // ミニカレンダー表示月アンカー (YYYY-MM-DD)
let selectedId = '';               // 右ペインで全文表示中の掲示ID（選択＝即既読化）
let eventsBound = false;           // イベント多重登録防止

/** 掲示ID → コメント一覧（API の ack コメント＋ローカルで送信した分） */
const commentsById = new Map();

/** 未読数の安全な更新ヘルパー */
function updateUnread(count) {
  if (state && state.unreadCounts) {
    state.unreadCounts.bulletin = count;
  }
}

/** JST 基準の今日 (YYYY-MM-DD) */
function todayJstDate() {
  return new Date(Date.now() + 9 * 3600000).toISOString().split('T')[0];
}

/**
 * 掲示開始日変更時の掲示終了日下限 (min) 同期
 * @param {string} startValue YYYY-MM-DD
 */
function syncDisplayEndMin(startValue) {
  const endInput = document.getElementById('bulletin-display-end');
  if (!endInput) return;
  endInput.min = startValue || '';
  if (endInput.value && startValue && endInput.value < startValue) {
    endInput.value = '';
    showToast('掲示終了日を掲示開始日以降の日に修正しました', 'warning');
  }
}

/**
 * 掲示期間の抽出 (API 応答の camel / snake 両形式に対応)
 * @param {Object} b
 * @returns {{start: string|null, end: string|null}}
 */
function displayPeriodOf(b) {
  return {
    start: b.displayStart || b.display_start_date || null,
    end: b.displayEnd || b.display_end_date || null,
  };
}

/** 掲示期間の表示ラベル ('2026/11/02 〜 2026/11/10' / 未設定なら空文字) */
function displayPeriodLabel(b) {
  const { start, end } = displayPeriodOf(b);
  if (!start && !end) return '';
  const startText = start ? formatDate(start, false) : '（開始日未設定）';
  const endText = end ? formatDate(end, false) : '指定なし';
  return `${startText} 〜 ${endText}`;
}

/** 掲示終了日を過ぎた投稿かどうか */
function isDisplayExpired(b) {
  const { end } = displayPeriodOf(b);
  if (!end) return false;
  return end < todayJstDate();
}

/**
 * 掲示板モジュールの初期化と画面構築（左=タイトル列、右=全文ペインの分割）
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
      <div class="flex items-center gap-2 w-full sm:w-auto justify-end flex-wrap">
        <!-- ★ 中心日読取（‹ › の左。固定幅なので › を連打しても › の位置が動かない） -->
        <span id="bulletin-day-current" class="day-readout" data-day="" aria-label="表示日"></span>
        <!-- ★ ‹ › は同一グループで隣接（一緒に折り返す。施設予約と同じ慣習） -->
        <div class="flex items-center bg-surface rounded-lg border border-main shrink-0">
          <button type="button" id="bulletin-day-prev" class="icon-btn icon-btn-fixed text-soft"
                  aria-label="前日（← キー）" title="前日（← キー）"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
          <button type="button" id="bulletin-day-next" class="icon-btn icon-btn-fixed text-soft"
                  aria-label="翌日（→ キー）" title="翌日（→ キー）"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
        </div>
        <button type="button" id="bulletin-btn-today" class="btn-secondary py-1.5 px-2.5 text-xs shrink-0" title="本日（T キー）">本日</button>
        <button type="button" id="bulletin-cal-toggle" class="icon-btn icon-btn-fixed border border-divider bg-surface shrink-0"
                aria-expanded="false" aria-controls="bulletin-mini-cal" aria-label="カレンダーで任意日へ（C キー）" title="カレンダー（C キー）"><i data-lucide="calendar" class="w-4 h-4"></i></button>
        <button type="button" id="bulletin-keys-toggle" class="icon-btn icon-btn-fixed border border-divider bg-surface shrink-0"
                aria-expanded="false" aria-controls="bulletin-keys-pop" aria-label="キーボード操作の手引き" title="キー操作（? キー）"><i data-lucide="keyboard" class="w-4 h-4"></i></button>
        <button type="button" id="bulletin-btn-create" class="btn-primary py-1.5 px-3 text-xs font-bold flex items-center gap-1.5 shrink-0">
          <i data-lucide="plus" class="w-4 h-4"></i> 新規投稿
        </button>
      </div>
    </div>

    <!-- ★ ミニカレンダー（折りたたみ。投稿数の打点付き。C キー・カレンダーボタンで開く） -->
    <div id="bulletin-mini-cal" class="hidden mt-2 mb-2 bg-surface-strong border border-divider rounded-xl p-3"></div>

    <!-- ★ キーボード操作の手引き（収納。キー操作ボタンで開閉。常時表示しない） -->
    <div id="bulletin-keys-pop" class="hidden mt-2 mb-2 bg-surface-strong border border-divider rounded-xl p-2.5 text-[11px] text-soft flex flex-wrap gap-x-3 gap-y-1">
      <span><kbd class="kbd-key">↑</kbd><kbd class="kbd-key">↓</kbd> タイトル間移動（選択で既読・右ペイン連動）</span>
      <span><kbd class="kbd-key">Enter</kbd> 右ペインへフォーカス</span>
      <span><kbd class="kbd-key">←</kbd><kbd class="kbd-key">→</kbd> 前日・翌日</span>
      <span><kbd class="kbd-key">T</kbd> 今日</span>
      <span><kbd class="kbd-key">C</kbd> カレンダー</span>
      <span><kbd class="kbd-key">?</kbd> 手引き開閉</span>
    </div>

    <!-- ★ 検索（小型。タイトル・本文をインクリメンタル検索） -->
    <div class="relative mt-3 mb-3 w-72 max-w-full">
      <i data-lucide="search" class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"></i>
      <input type="text" id="bulletin-search-input" class="input-field pl-8 pr-2 py-1 text-xs w-full" placeholder="タイトル・本文を検索" aria-label="掲示検索">
    </div>

    <!-- ★ 左右分割（左=タイトル列＋未読バッジ、右=選択記事の全文・コメント） -->
    <div class="bulletin-split">
      <div class="bulletin-title-pane">
        <div class="pane-label">
          <span class="flex items-center gap-1.5"><i data-lucide="list" class="w-3.5 h-3.5 text-accent"></i> タイトル</span>
          <span id="bulletin-title-count" class="text-[11px] text-muted">0 件</span>
        </div>
        <div id="bulletin-list-container" class="bulletin-list-container" role="listbox" aria-label="掲示タイトル">
          <div class="p-4 text-center text-xs text-muted">掲示板データを読み込み中...</div>
        </div>
      </div>
      <div id="bulletin-detail-pane" class="bulletin-detail-pane" tabindex="0" aria-live="polite" aria-label="掲示全文">
        <div class="p-6 text-center text-xs text-muted">表示日の掲示全文を読み込み中...</div>
      </div>
    </div>
  `;

  bindEvents();

  // 初期表示日 = 今日 (JST)。左列はその日のタイトルだけを出す
  currentDayDate = currentDayDate || todayJstDate();
  calendarAnchor = currentDayDate;
  updateDayReadout();

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
    const today = todayJstDate();
    const dateInput = document.getElementById('bulletin-target-date');
    if (dateInput) dateInput.value = today;
    const startInput = document.getElementById('bulletin-display-start');
    if (startInput) startInput.value = today;
    const endInput = document.getElementById('bulletin-display-end');
    if (endInput) {
      endInput.value = '';
      endInput.min = today;
    }
    openModal('bulletin-modal');
  });

  // 新規投稿フォーム送信（リスナー重複防止のため要素をクローン。掲示開始日変更は newForm 側で委譲）
  const form = document.getElementById('bulletin-form');
  if (form) {
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);
    newForm.addEventListener('submit', handleCreateBulletin);
    newForm.addEventListener('change', (e) => {
      if (e.target?.id === 'bulletin-display-start') {
        syncDisplayEndMin(e.target.value);
      }
    });
  }

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

  if (eventsBound) return;

  // ★ ヘッダーの日付ナビ（中心日読取・‹ ›・本日・カレンダー・キー手引き）は固定要素なので直接登録
  document.getElementById('bulletin-day-prev')?.addEventListener('click', () => shiftWindow(-1));
  document.getElementById('bulletin-day-next')?.addEventListener('click', () => shiftWindow(1));
  document.getElementById('bulletin-btn-today')?.addEventListener('click', () => selectDay(dayKey(0)));
  document.getElementById('bulletin-cal-toggle')?.addEventListener('click', () => toggleMiniCalendar());
  document.getElementById('bulletin-keys-toggle')?.addEventListener('click', () => toggleKeysHelp());

  // ★ 左列タイトル行（クリックで選択＝即既読化→右ペイン全文。行フォーカス時に削除ボタンが現れる）はリスト側で委譲
  const listEl = document.getElementById('bulletin-list-container');
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const del = e.target.closest('[data-bulletin-delete]');
      if (del) {
        e.stopPropagation();
        deleteBulletinPost(del.getAttribute('data-bulletin-delete'));
        return;
      }
      const row = e.target.closest('[data-bulletin-toggle]');
      if (row) selectBulletin(row.getAttribute('data-bulletin-toggle'));
    });
  }

  // ★ 右ペイン（「詳細」・「削除」・コメント送信）はペイン側で委譲
  const paneEl = document.getElementById('bulletin-detail-pane');
  if (paneEl) {
    paneEl.addEventListener('click', (e) => {
      const del = e.target.closest('[data-bulletin-delete]');
      if (del) {
        deleteBulletinPost(del.getAttribute('data-bulletin-delete'));
        return;
      }
      const detail = e.target.closest('[data-bulletin-detail]');
      if (detail) {
        openBulletinDetail(detail.getAttribute('data-bulletin-detail'));
        return;
      }
      const send = e.target.closest('[data-bulletin-comment]');
      if (send) sendBulletinComment(send.getAttribute('data-bulletin-comment'));
    });
  }

  // ★ ミニカレンダー（日付選択・月送り・任意日入力の委譲）
  const calEl = document.getElementById('bulletin-mini-cal');
  if (calEl) {
    calEl.addEventListener('click', (e) => {
      const dayBtn = e.target.closest('[data-cal-date]');
      if (dayBtn) { selectDay(dayBtn.getAttribute('data-cal-date')); return; }
      const monthBtn = e.target.closest('[data-cal-month]');
      if (monthBtn) { shiftCalendarMonth(monthBtn.getAttribute('data-cal-month')); return; }
      if (e.target.closest('[data-cal-today]')) {
        calendarAnchor = dayKey(0);
        selectDay(dayKey(0));
      }
    });
    calEl.addEventListener('change', (e) => {
      if (e.target?.id === 'bulletin-day-date') {
        selectDay(e.target.value || dayKey(0));
        renderMiniCalendar();
      }
    });
  }

  // ★ キーボード操作（掲示タブがアクティブな時のみ）
  document.addEventListener('keydown', bulletinKeyHandler);

  eventsBound = true;
}

/**
 * キーボードによるザッピング操作
 * ↑/↓ タイトル行間移動（選択＝即既読化・右ペイン全文が連動）、Enter 右ペイン（全文）へフォーカス、
 * ←/→ 前日・翌日（±1日）、T 今日、C カレンダー、? 手引き開閉
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
    .filter((m) => !m.classList.contains('hidden'));
  if (openModals.length > 0) return;

  const ids = bulletinRowIds();

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (ids.length === 0) return;
    e.preventDefault();
    const idx = ids.indexOf(String(selectedId));
    const next = e.key === 'ArrowDown'
      ? Math.min(idx < 0 ? 0 : idx + 1, ids.length - 1)
      : Math.max(idx < 0 ? 0 : idx - 1, 0);
    selectBulletin(ids[next], e.key === 'ArrowDown' ? 1 : -1);
    return;
  }

  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault();
    shiftWindow(e.key === 'ArrowLeft' ? -1 : 1);
    return;
  }

  if (e.key === 'Enter' || e.key === ' ') {
    if (selectedId) {
      e.preventDefault();
      focusDetailPane();
    }
    return;
  }

  const k = e.key.toLowerCase();
  if (k === 't') { e.preventDefault(); selectDay(dayKey(0)); return; }
  if (k === 'c') { e.preventDefault(); toggleMiniCalendar(); return; }
  if (e.key === '?' || e.key === '/') { e.preventDefault(); toggleKeysHelp(); return; }
}

/** 左列タイトル行の掲示ID一覧（表示順は filteredBulletins と同一） */
function bulletinRowIds() {
  return Array.from(document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]'))
    .map((row) => String(row.getAttribute('data-bulletin-toggle')));
}

/* ==========================================================================
   日付ユーティリティ（JST キー YYYY-MM-DD ベースのザッピング）
   ========================================================================== */

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 投稿日を JST キー (YYYY-MM-DD) に正規化 */
function toJstDay(iso) {
  if (!iso) return '';
  const s = String(iso);
  // オフセット (Z / +HH:MM / -HH:MM) を含まない素朴 'YYYY-MM-DD HH:MM:SS' は JST 壁時計 → 暦日を直接抽出
  const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T]\d{2}:\d{2}/);
  if (naive && !/[Zz]|[+-]\d{2}/.test(s)) {
    return naive[1];
  }
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

/** キャッシュから日別件数を算出 */
function dayCounts() {
  const map = new Map();
  bulletinsCache.forEach((b) => {
    const k = toJstDay(b.postedAt || b.posted_at || b.createdAt || b.created_at);
    if (k) map.set(k, (map.get(k) || 0) + 1);
  });
  return map;
}

/** 投稿日が中心日と一致するか */
function matchesDay(b) {
  const posted = toJstDay(b.postedAt || b.posted_at || b.createdAt || b.created_at);
  return posted === (currentDayDate || dayKey(0));
}

/** 2つの YYYY-MM-DD キーの日数差 (b - a) */
function dayDiff(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

/**
 * 移動方向がわかるスライドアニメーション（中心日表示・左列・右ペイン）
 * 1日ずれは小さなナッジ、複数日ジャンプだけが少し大きく動く（1日移動が激しすぎないようにする）
 * @param {number} dir 1=未来(右)/次(下) / -1=過去(左)/前(上) / 0=なし
 * @param {'x'|'y'} [axis] 軸。日付ザッピング='x'、タイトル移動='y'
 * @param {number} [days] 移動日数（絶対値）。未指定なら 1 日扱い
 */
function animateShift(dir, axis = 'x', days = 1) {
  if (!dir || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;

  const span = Math.max(1, Math.min(Math.abs(days) || 1, 7));
  const prop = axis === 'y' ? 'translateY' : 'translateX';
  // 1日はずっと小さく、複数日ジャンプだけ大きく動く（中心日は ≤6px、内容は ≤12px）
  const contentStep = axis === 'y' ? dir * 10 : dir * (3 + span * 2);
  const readoutStep = axis === 'x' ? dir * Math.min(3 + span, 6) : 0;
  const fade = 0.62;
  const opts = {
    duration: axis === 'y' ? 200 : 150,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)'
  };

  const slide = (el, offset) => {
    if (!el || typeof el.animate !== 'function' || !offset) return;
    el.animate(
      [{ transform: `${prop}(${offset}px)`, opacity: fade }, { transform: `${prop}(0)`, opacity: 1 }],
      opts
    );
  };

  slide(document.getElementById('bulletin-day-current'), readoutStep);
  slide(document.getElementById('bulletin-list-container'), contentStep);
  slide(document.getElementById('bulletin-detail-pane'), contentStep);
}

/** 中心日読取（‹ › の左の固定幅。data-day に YYYY-MM-DD を保持） */
function updateDayReadout() {
  const readout = document.getElementById('bulletin-day-current');
  if (!readout) return;
  const key = currentDayDate || dayKey(0);
  const parts = key.split('-');
  const label = `${parts[1]}/${parts[2]} (${weekdayLabel(key)})`;
  readout.dataset.day = key;
  readout.textContent = label;
  readout.setAttribute('aria-label', `表示日: ${key} ${weekdayLabel(key)}`);
}

/**
 * 表示日の設定（左列・右ペインの再描画を駆動する中心関数）
 * @param {string} date YYYY-MM-DD
 * @param {number} [dir] 移動方向 (1=未来/右, -1=過去/左)。省略時は日付差から算出
 */
function selectDay(date, dir = 0) {
  const target = String(date || '').substring(0, 10) || dayKey(0);
  // 移動日数（アニメーションの大きさ用。1日ずれは小さく、複数日ジャンプだけ大きく動く）
  const span = Math.abs(dayDiff(currentDayDate, target)) || 1;
  const shift = dir || Math.sign(dayDiff(currentDayDate, target)) || 0;
  const hadFocus = document.activeElement && document.activeElement.closest('#bulletin-list-container');
  currentDayDate = target;
  calendarAnchor = target;

  updateDayReadout();

  const dateInput = document.getElementById('bulletin-day-date');
  if (dateInput && dateInput.value !== target) dateInput.value = target;

  renderBulletinList();
  animateShift(shift, 'x', span);
  if (hadFocus) focusSelectedRow();
  refreshLucideIcons();
}

/**
 * 中心日をずらす（prev/next ボタン・←/→ キーとも ±1日。中心日表示は固定幅のまま追従）
 * @param {number} offset 日数（-1 で前日・+1 で翌日。カレンダーからのジャンプ時は大きな値も可）
 */
function shiftWindow(offset) {
  const base = currentDayDate || dayKey(0);
  selectDay(shiftDateKey(base, offset), Math.sign(offset) || 0);
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
      key === currentDayDate ? 'mini-cal-selected' : '',
      n > 0 ? 'mini-cal-has' : '',
    ].filter(Boolean).join(' ');
    cells.push(`<button type="button" class="${cls}" data-cal-date="${key}"
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
      ${WEEKDAY_LABELS.map((w) => `<span class="mini-cal-wd">${w}</span>`).join('')}
    </div>
    <div class="mini-cal-grid">${cells.join('')}</div>
    <div class="flex items-center gap-2 mt-2">
      <label for="bulletin-day-date" class="text-[10px] text-muted shrink-0">任意日へ</label>
      <input type="date" id="bulletin-day-date" class="input-field py-1 px-2 text-xs" aria-label="投稿日" value="${anchor}">
    </div>
    <p class="text-[10px] text-muted mt-2">● は投稿のある日です。日付をクリックでその日の記事を表示し、←/→ キーと ‹ › ボタンで前日・翌日（1日分）へ移動できます。</p>
  `;
  refreshLucideIcons();
}

/** キーボード操作の手引き（収納パネル）の開閉 */
function toggleKeysHelp() {
  const pop = document.getElementById('bulletin-keys-pop');
  const btn = document.getElementById('bulletin-keys-toggle');
  if (!pop) return;
  const opening = pop.classList.contains('hidden');
  pop.classList.toggle('hidden', !opening);
  if (btn) btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
}

/* ==========================================================================
   マスタ・ディテール描画（左=タイトル列、右=全文ペイン）
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

  const unreadCount = bulletinsCache.filter(isUnreadBulletin).length;
  updateUnread(unreadCount);

  renderBulletinList();
}

/** 検索・投稿日による絞り込みと日時降順ソート（カテゴリフィルタは撤廃） */
function filteredBulletins() {
  const filtered = bulletinsCache.filter((b) => {
    const matchQuery = !currentSearch ||
      String(b.title || '').toLowerCase().includes(currentSearch) ||
      String(b.content || '').toLowerCase().includes(currentSearch) ||
      (b.authorName && String(b.authorName).toLowerCase().includes(currentSearch));

    return matchQuery && matchesDay(b);
  });

  filtered.sort((a, b) => {
    const dateA = new Date(a.postedAt || a.posted_at || a.createdAt || a.created_at);
    const dateB = new Date(b.postedAt || b.posted_at || b.createdAt || b.created_at);
    return dateB - dateA;
  });
  return filtered;
}

/** 未読判定（未読 = 既読でも承認済みでもない） */
function isUnreadBulletin(b) {
  return !b.isRead && b.ackStatus !== 'READ' && b.ackStatus !== 'APPROVED';
}

/** 掲示ID でキャッシュの掲示を探す */
function findBulletin(id) {
  return bulletinsCache.find((b) => String(b.id) === String(id)) || null;
}

/** 右ペインヘッダーのバッジ群（読者向けに日付・掲示期間の表記は置かない） */
function paneBadgeHtml(b) {
  const attachments = b.attachments || [];
  return `
    ${isUnreadBulletin(b) ? '<span class="badge bg-danger-soft text-danger border-danger-soft shrink-0">未読</span>' : ''}
    ${isDisplayExpired(b) ? '<span class="badge bg-surface-strong text-muted border-divider flex items-center gap-1 shrink-0"><i data-lucide="calendar-off" class="w-3 h-3"></i> 掲示終了</span>' : ''}
    ${attachments.length > 0 ? `<span class="badge bg-accent-soft text-accent-strong border-accent-soft flex items-center gap-1 shrink-0"><i data-lucide="paperclip" class="w-3 h-3"></i> 添付 ${attachments.length}</span>` : ''}
  `;
}

/**
 * 左列タイトル行（1行・右端に未読バッジ、行頭シグニファイア › でクリック誘導。全文は右ペインに出す）
 * @param {Object} b
 * @param {boolean} selected 選択中（既読化済み・強調表示）か
 */
function titleRowHtml(b, selected) {
  const unread = isUnreadBulletin(b);
  return `
    <div class="bulletin-title-row${selected ? ' active' : ''}" data-bulletin-toggle="${b.id}"
         data-unread="${unread ? 'true' : 'false'}" role="option" tabindex="0"
         aria-selected="${selected ? 'true' : 'false'}">
      <span class="bulletin-row-signifier" aria-hidden="true"><i data-lucide="chevron-right" class="w-3.5 h-3.5"></i></span>
      <span class="bulletin-row-title">${escapeHTML(String(b.title || ''))}</span>
      ${unread ? '<span class="bulletin-unread-badge" aria-hidden="true">未読</span>' : ''}
      <span class="bulletin-row-delete"><button type="button" class="bulletin-row-delete-btn"
                data-bulletin-delete="${b.id}" title="この掲示を削除">削除</button></span>
    </div>`;
}

/**
 * 掲示板一覧の描画（左=タイトル列＋右=全文ペイン。選択記事の全文を右に即表示）
 */
function renderBulletinList() {
  const filtered = filteredBulletins();

  // 右ペイン表示中の選択が現在の絞り込みから外れた場合、その日の最初の項目を自動選択
  const ids = filtered.map((b) => String(b.id));
  const autoSelect = ids.length > 0 && !ids.includes(String(selectedId));
  if (autoSelect) {
    selectedId = ids[0];
  } else if (ids.length === 0) {
    selectedId = '';
  }

  renderRows();
  if (autoSelect && selectedId) markBulletinRead(selectedId);  // 表示＝全文が見えるので選択時点で既読化
  renderDetailPane(findBulletin(selectedId));
  refreshLucideIcons();
  if (selectedId) loadComments(selectedId);
}

/** 左列タイトル行の描画（日付・件数の欄は左列ヘッダーに寄せる。行は1行タイトル＋未読バッジ） */
function renderRows() {
  const container = document.getElementById('bulletin-list-container');
  if (!container) return;

  const filtered = filteredBulletins();
  const countEl = document.getElementById('bulletin-title-count');
  if (countEl) countEl.textContent = `${filtered.length} 件`;

  if (filtered.length === 0) {
    container.innerHTML = `<div class="p-5 text-center text-xs text-muted">
      <i data-lucide="calendar-off" class="w-6 h-6 mx-auto mb-2 opacity-60"></i>
      <div>この日の掲示連絡はありません。<kbd class="kbd-key">←</kbd><kbd class="kbd-key">→</kbd>・‹ › ボタンで前日・翌日、<kbd class="kbd-key">C</kbd> キーでカレンダーから任意日へ移動できます。</div>
    </div>`;
    refreshLucideIcons();
    return;
  }

  container.innerHTML = filtered
    .map((b) => titleRowHtml(b, String(b.id) === String(selectedId)))
    .join('');
  refreshLucideIcons();
}

/**
 * 右ペイン（選択記事の全文・添付・コメント）の描画
 * @param {Object|null} b 選択中の掲示
 */
function renderDetailPane(b) {
  const pane = document.getElementById('bulletin-detail-pane');
  if (!pane) return;

  if (!b) {
    pane.innerHTML = `<div class="p-6 text-center text-xs text-muted">
      <i data-lucide="inbox" class="w-7 h-7 mx-auto mb-2 opacity-60"></i>
      <div>この日に掲示された連絡はありません。<kbd class="kbd-key">←</kbd><kbd class="kbd-key">→</kbd>・‹ › ボタンで前日・翌日へ移動できます。</div>
    </div>`;
    refreshLucideIcons();
    return;
  }

  const atts = b.attachments || [];
  const comments = commentsById.get(String(b.id)) || [];

  pane.innerHTML = `
    <div class="bulletin-detail-body">
      <div class="pane-header">
        <h3 class="pane-title">${escapeHTML(String(b.title || ''))}</h3>
        <div class="pane-badges">${paneBadgeHtml(b)}</div>
        <button type="button" class="btn-primary py-1 px-2.5 text-[11px] font-bold flex items-center gap-1 shrink-0"
                data-bulletin-detail="${b.id}" title="投稿日時・掲示期間・添付をモーダルで開く">
          <i data-lucide="maximize-2" class="w-3.5 h-3.5"></i> 詳細
        </button>
        <button type="button" class="btn-secondary py-1 px-2.5 text-[11px] font-bold flex items-center gap-1 shrink-0 text-danger"
                data-bulletin-delete="${b.id}" title="この掲示を削除">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> 削除
        </button>
      </div>
      <pre class="pane-body-text">${escapeHTML(String(b.content || ''))}</pre>
      ${attachmentsHtml(atts)}
      <div class="bulletin-comments">
        <p class="comment-heading"><i data-lucide="message-square" class="w-3.5 h-3.5 text-accent"></i> 投稿者への補足・コメント (${comments.length})</p>
        ${comments.length > 0 ? `<ul class="comment-list">${comments.map(commentHtml).join('')}</ul>` : '<p class="comment-empty">まだコメントはありません。</p>'}
        <div class="comment-form">
          <label for="bulletin-comment-input" class="text-[10px] text-muted shrink-0">補足・確認コメント</label>
          <textarea id="bulletin-comment-input" rows="2" class="input-field w-full min-w-0 p-2 text-xs" placeholder="投稿者へ補足・確認コメントを書く" aria-label="補足・確認コメント"></textarea>
          <button type="button" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5 shrink-0"
                  data-bulletin-comment="${b.id}"><i data-lucide="send" class="w-3.5 h-3.5"></i> 送信</button>
        </div>
      </div>
    </div>`;
  refreshLucideIcons();
}

/** コメント1件（投稿者名・本文・時刻。自分が送ったものは「自分」表記） */
function commentHtml(c) {
  const time = c.createdAt ? timeOfJstLabel(c.createdAt) : '';
  return `
    <li class="comment-item">
      <div class="comment-head">
        ${userAvatarHtml({ name: c.authorName || '教員', avatarUrl: c.avatarUrl || '', size: 'xs' })}
        <span class="comment-author">${escapeHTML(String(c.authorName || '教員'))}</span>
        ${time ? `<span class="comment-time">${time}</span>` : ''}
        ${c.mine ? '<span class="badge bg-accent-soft text-accent-strong border-accent-soft shrink-0">自分</span>' : ''}
      </div>
      <p class="comment-body">${escapeHTML(String(c.commentText || ''))}</p>
    </li>`;
}

/**
 * 1件の掲示に対するコメント（ack コメント）を取得して右ペインに反映
 * @param {string} id 掲示ID
 */
async function loadComments(id) {
  const key = String(id);
  try {
    const res = await apiGet(`/bulletins/${key}`);
    const detail = res.bulletin || res;
    const acks = detail.acknowledgements || detail.acknowledgments || [];
    const apiComments = acks
      .filter((a) => String(a.comment || '').trim())
      .map((a) => ({
        authorName: a.author_name || a.authorName || a.user_name || a.userName || a.name
          || a.user_id || a.userId || '教員',
        avatarUrl: a.avatar_url || a.avatarUrl || null,
        commentText: String(a.comment).trim(),
        createdAt: a.acknowledged_at || a.acknowledgedAt || null,
      }));
    const mine = (commentsById.get(key) || []).filter((c) => c.mine);
    commentsById.set(key, [...apiComments, ...mine]);
  } catch (e) {
    /* オフライン時はローカル送信分だけ残す */
  }

  if (String(selectedId) === key) {
    renderDetailPane(findBulletin(key));
    refreshLucideIcons();
  }
}

/**
 * 投稿者への補足・コメント送信（右ペインのその場。送信後はサーバー応答へ置き換える）
 * @param {string} id 掲示ID
 */
async function sendBulletinComment(id) {
  const key = String(id);
  const input = document.getElementById('bulletin-comment-input');
  const text = input ? String(input.value).trim() : '';
  if (!text) {
    showToast('コメントを入力してください', 'warning');
    return;
  }

  const local = {
    authorName: (state.currentUser && (state.currentUser.name || state.currentUser.userId)) || '自分',
    avatarUrl: (state.currentUser && (state.currentUser.avatar_url || state.currentUser.avatarUrl)) || null,
    commentText: text,
    createdAt: new Date().toISOString(),
    mine: true,
  };
  commentsById.set(key, [...(commentsById.get(key) || []), local]);
  renderDetailPane(findBulletin(key));
  refreshLucideIcons();

  try {
    await apiPost(`/bulletins/${key}/comments`, { comment: text });
    showToast('コメントを送信しました', 'success');
    // サーバーの ack コメントに反映されるためローコピーは捨てて再取得
    commentsById.delete(key);
    await loadComments(key);
  } catch (e) {
    showToast('コメント送信に失敗しました', 'error');
    commentsById.set(key, (commentsById.get(key) || []).filter((c) => c !== local));
    if (String(selectedId) === key) renderDetailPane(findBulletin(key));
  }
}

/**
 * タイトル行の選択（左列の行クリック・↑/↓ キー。選択時点で既読化し、右ペインに全文を表示）
 * @param {string} id 掲示ID
 * @param {number} [dir] 移動方向（1=次/下、-1=前/上）。省略時は表示順の位置差から算出
 */
function selectBulletin(id, dir = 0) {
  const key = String(id);
  const items = filteredBulletins();
  const item = items.find((b) => String(b.id) === key);
  if (!item) return;

  const prevIdx = items.findIndex((b) => String(b.id) === String(selectedId));
  const nextIdx = items.findIndex((b) => String(b.id) === key);
  const shift = dir || Math.sign(nextIdx - prevIdx) || 0;

  selectedId = key;
  markBulletinRead(key);          // 非同期 PUT（ローカル状態は即更新で未読バッジが消失）
  renderRows();
  renderDetailPane(item);
  animateShift(shift, 'y');
  focusSelectedRow();
  refreshLucideIcons();
  loadComments(key);
}

/** 選択タイトル行へフォーカスを引き継ぐ（↑/↓ 移動でキーボード操作を止めない） */
function focusSelectedRow() {
  const row = document.querySelector(`#bulletin-list-container [data-bulletin-toggle="${selectedId}"]`);
  if (!row) return;
  row.focus();
  row.scrollIntoView({ block: 'nearest' });
}

/** 右ペイン（全文）へフォーカスを移す（Enter キー） */
function focusDetailPane() {
  const pane = document.getElementById('bulletin-detail-pane');
  if (!pane) return;

  pane.focus();
  pane.scrollIntoView({ block: 'nearest' });
}

/**
 * 掲示の削除（行フォーカス時の削除ボタン・右ペインヘッダーの「削除」から）
 * 確認後に DELETE /api/bulletins/:id。成功時はキャッシュから除き、次の行へ選択を進める
 * @param {string} id 掲示ID
 */
async function deleteBulletinPost(id) {
  const key = String(id);
  const item = bulletinsCache.find((b) => String(b.id) === key);
  const title = item ? String(item.title || '') : '';
  if (!window.confirm(`「${title}」を削除しますか？`)) return;

  try {
    await apiDelete(`/bulletins/${key}`);
    bulletinsCache = bulletinsCache.filter((b) => String(b.id) !== key);
    commentsById.delete(key);
    const ids = filteredBulletins().map((b) => String(b.id));
    if (!ids.includes(String(selectedId))) selectedId = ids[0] || '';
    updateUnread(bulletinsCache.filter(isUnreadBulletin).length);
    showToast('削除しました', 'success');
    renderBulletinList();
    focusSelectedRow();
  } catch (err) {
    console.warn('[Bulletin] 削除失敗:', err.message);
    showToast('削除に失敗しました', 'error');
  }
}

/** 既読化（PUT /api/bulletins/:id/read）。左列の未読バッジだけ更新する */
async function markBulletinRead(id) {
  const item = bulletinsCache.find((b) => String(b.id) === String(id));
  if (!item) return;
  if (item.isRead || item.ackStatus === 'READ' || item.ackStatus === 'APPROVED') return;

  item.isRead = true;
  item.ackStatus = 'READ';
  try {
    await apiPut(`/bulletins/${id}/read`, {});
  } catch (e) { /* オフライン時はローカル状態のみ更新 */ }

  const unreadCount = bulletinsCache.filter(isUnreadBulletin).length;
  updateUnread(unreadCount);
  renderRows();  // 未読バッジの消失だけ反映（右ペインは再描画しない）
}

/** JST 基準の投稿時刻 (HH:MM)。日付は左列の共通前提なので時刻だけ出す */
function timeOfJstLabel(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const jst = new Date(d.getTime() + 9 * 3600000);
  const h = String(jst.getUTCHours()).padStart(2, '0');
  const m = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 詳細モーダルの表示 & 既読処理（読者向けの情報を全部載せる）
 * @param {string} id 掲示ID
 */
async function openBulletinDetail(id) {
  const item = bulletinsCache.find((b) => String(b.id) === String(id));
  if (!item) return;

  if (!item.isRead && item.ackStatus !== 'READ' && item.ackStatus !== 'APPROVED') {
    item.isRead = true;
    item.ackStatus = 'READ';
    try {
      await apiPut(`/bulletins/${id}/read`, {});
    } catch (e) { /* オフライン時はローカル状態のみ更新 */ }
    const unreadCount = bulletinsCache.filter(isUnreadBulletin).length;
    updateUnread(unreadCount);
    renderRows();  // 左列の未読バッジを更新
  }

  const titleEl = document.getElementById('detail-bulletin-title');
  const metaEl = document.getElementById('detail-bulletin-meta');
  const contentEl = document.getElementById('detail-bulletin-content');
  const actionsEl = document.getElementById('detail-bulletin-actions');
  const attachEl = document.getElementById('detail-bulletin-attachments');

  if (titleEl) titleEl.textContent = item.title;
  if (metaEl) {
    const author = item.authorName || item.author_name || '教員';
    const avatar = item.authorAvatar || item.author_avatar || null;
    metaEl.innerHTML = `
      <span class="flex items-center gap-1.5">${paneBadgeHtml(item)}</span>
      <span class="flex items-center gap-1.5">投稿者: ${userAvatarHtml({ name: author, avatarUrl: avatar, size: 'xs' })}${escapeHTML(author)}</span>
      <span>投稿日時: <strong class="text-main">${formatDate(item.postedAt || item.posted_at || item.createdAt || item.created_at)}</strong></span>
      ${displayPeriodLabel(item) ? `<span>掲示期間: <strong class="text-main">${displayPeriodLabel(item)}</strong></span>` : '<span>掲示期間: <strong class="text-main">指定なし</strong></span>'}
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
    actionsEl.innerHTML = `
      <button id="btn-detail-comment" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5 text-warning border-warning-soft">
        <i data-lucide="message-square" class="w-3.5 h-3.5"></i> 補足・コメント
      </button>
      <button class="modal-close btn-secondary py-1.5 px-4 text-xs">閉じる</button>
    `;

    document.getElementById('btn-detail-comment')?.addEventListener('click', () => {
      closeModal('bulletin-detail-modal');
      selectBulletin(id);
      focusDetailPane();
      showToast('右ペイン下のコメント欄から送信してください', 'info');
    });
  }

  openModal('bulletin-detail-modal');
  refreshLucideIcons();
}

/** 添付ファイル一覧（右ペイン・モーダル共用） */
function attachmentsHtml(atts = []) {
  if (atts.length === 0) return '';
  return `
    <div class="attachment-block">
      <p class="attachment-heading"><i data-lucide="paperclip" class="w-3.5 h-3.5 text-accent"></i> 添付ファイル (${atts.length})</p>
      <ul class="attachment-list">
        ${atts.map((a) => `
          <li class="attachment-item">
            <span class="truncate text-main">${escapeHTML(String(a.name || ''))}</span>
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
 * 新規投稿処理
 */
async function handleCreateBulletin(e) {
  e.preventDefault();

  const title = document.getElementById('bulletin-title')?.value.trim();
  const content = document.getElementById('bulletin-content')?.value.trim();
  const targetDate = document.getElementById('bulletin-target-date')?.value || '';
  const displayStart = document.getElementById('bulletin-display-start')?.value || '';
  const displayEnd = document.getElementById('bulletin-display-end')?.value || '';

  if (!title || !content) {
    showToast('タイトルと本文は必須です', 'warning');
    return;
  }

  // 掲示開始日・掲示終了日とも任意 (未設定なら投稿日が掲示開始日)。終了日は開始日以降
  if (displayStart && displayEnd && displayEnd < displayStart) {
    showToast('掲示終了日は掲示開始日以降の日にしてください', 'warning');
    return;
  }

  // 投稿日時（JST 現在時刻・日ごと表示の基準）
  const postedAt = new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00');

  const fileInput = document.getElementById('bulletin-files');
  const files = fileInput ? Array.from(fileInput.files || []) : [];

  if (files.length > 10) {
    showToast('添付ファイルは1回につき10件までです', 'warning');
    return;
  }

  const maxBytes = 10 * 1024 * 1024;
  const oversize = files.find((f) => f.size > maxBytes);
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
      fd.append('postedAt', postedAt);
      fd.append('targetDate', targetDate);
      fd.append('displayStart', displayStart);
      fd.append('displayEnd', displayEnd);
      fd.append('targetScope', JSON.stringify(targetScope));
      files.forEach((f) => fd.append('files', f, f.name));
      await apiPostForm('/bulletins/upload', fd);
      showToast(`投稿しました（添付 ${files.length} 件）`, 'success');
    } else {
      await apiPost('/bulletins', {
        title,
        content,
        postedAt,
        targetDate,
        displayStart,
        displayEnd,
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

  // 新規投稿は左列に出るように中心日を投稿日へ寄せる
  currentDayDate = toJstDay(postedAt) || currentDayDate;
  calendarAnchor = currentDayDate;
  updateDayReadout();
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

  listEl.innerHTML = files.map((f) => `
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
  const today = new Date(Date.now() + 9 * 3600000).toISOString().split('T')[0];
  return [
    {
      id: 'post_1',
      title: '【教務部】中間考査採点票の提出期限について',
      content: '中間考査の全科目採点票の最終締め切りは明後日17時です。未提出の教科・学年はお早めにご提出ください。',
      authorName: '教務部・佐藤',
      postedAt: `${today} 08:30:00`,
      displayStart: today,
      displayEnd: null,
      ackStatus: 'UNREAD'
    },
    {
      id: 'post_2',
      title: '避難訓練の実施要項および各クラスの避難経路確認',
      content: '来週火曜日の6限に全校避難訓練を実施します。各担任の先生は事前に生徒へ非常口の周知を行ってください。',
      authorName: '生徒指導部・田中',
      postedAt: `${today} 09:10:00`,
      displayStart: today,
      displayEnd: null,
      ackStatus: 'READ'
    }
  ];
}
