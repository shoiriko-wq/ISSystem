/**
 * ISSystem Bulletin Module
 * 掲示板＝マスタ・ディテール（左=タイトル列＋未読バッジ／右=選択記事の全文・コメント）
 * 投稿日はヘッダーのタイトル行に ‹ [日付] › を埋め込む（中心日は ‹ › の間の固定幅ボタンで、
 * クリックするとミニカレンダーが開く。カレンダー単独ボタンは置かない）。
 * 選択＝即既読化で右ペインに全文が即表示。コメントは右ペインに並べ、その場で送信できる。
 * 検索は小型インライン（タイトル・本文・投稿者名を全日で検索。検索語入力中は中心日表示が「全日」になり、
 * 左列が対象日グループ見出し付きの全日の検索結果一覧になる。行クリックは中心日を動かさず右ペインに全文表示。
 * 検索語を消すと元の日付表示へ戻る。検索中は ‹ ›・本日・カレンダー（C）は止まる）、
 * キー操作の手引きは収納（キー操作ボタンで開閉）、詳細モーダル・API連携
 */

import { apiGet, apiPost, apiPut, apiPostForm, apiDelete } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast, userAvatarHtml } from '../ui-helpers.js';
import { state } from '../state.js';
import { API_BASE_URL } from '../config.js';

let bulletinsCache = [];
// ★ 検索語（小文字化済み。空なら通常の日付表示）。検索語がある間は中心日が列表表示に影響しない全日表示
let currentSearch = '';

// ★ 投稿日状態（表示日 = YYYY-MM-DD JST。‹ › と日付クリック（カレンダー）・←/→ キーで 1 日ずつ移動）
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
    <!-- ヘッダーツールバー（検索・日付ナビ・本日・キー操作・新規投稿。コントロール高さを 2.4rem に統一） -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-surface-strong p-3 rounded-xl border border-divider mb-4">
      <h2 class="text-base font-bold text-main flex items-center gap-2 shrink-0">
        <i data-lucide="megaphone" class="w-4 h-4 text-accent"></i> 職員掲示板
      </h2>
      <div class="flex items-center gap-2 w-full sm:w-auto justify-end flex-wrap">
        <!-- ★ 検索（ヘッダー内。タイトル・本文・投稿者名を全日でインクリメンタル検索。検索語入力中は ‹ › の中心日表示が「全日」になり、
             左列が全日の検索結果一覧（対象日見出し付き）になる。検索語を消すと元の日付表示へ戻る） -->
        <div class="relative w-full sm:w-72 max-w-full shrink-0">
          <i data-lucide="search" class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none"></i>
          <input type="text" id="bulletin-search-input" class="input-field pl-8 pr-2 w-full" placeholder="タイトル・本文・投稿者名を全日で検索" aria-label="掲示検索（タイトル・本文・投稿者名・全日）">
        </div>
        <!-- ★ ‹ [日付] › を同一グループで隣接（一緒に折り返す。施設予約と同じ慣習）。
             中心日は ‹ › の間。日付は固定幅なので › を連打しても › の位置が動かない（「全日」も同幅）。
             日付クリック（または C キー）でミニカレンダーを開閉。カレンダー単独ボタンは撤廃。
             検索中は中心日が列表表示に影響しないため ‹ ›・本日・日付クリックは止まる（検索語を消すと元の日へ復帰）。 -->
        <div class="flex items-center bg-surface rounded-lg border border-main shrink-0" id="bulletin-day-group">
          <button type="button" id="bulletin-day-prev" class="icon-btn icon-btn-fixed text-soft"
                  aria-label="前日（← キー）" title="前日（← キー）"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
          <button type="button" id="bulletin-day-current" class="day-readout day-nav-btn" data-day=""
                  aria-expanded="false" aria-controls="bulletin-mini-cal"
                  aria-label="表示日（クリックでカレンダーを開く）" title="カレンダーを開く（C キー）"></button>
          <button type="button" id="bulletin-day-next" class="icon-btn icon-btn-fixed text-soft"
                  aria-label="翌日（→ キー）" title="翌日（→ キー）"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
        </div>
        <button type="button" id="bulletin-btn-today" class="btn-secondary shrink-0" title="本日（T キー）">本日</button>
        <button type="button" id="bulletin-keys-toggle" class="icon-btn icon-btn-fixed border border-divider bg-surface shrink-0"
                aria-expanded="false" aria-controls="bulletin-keys-pop" aria-label="キーボード操作の手引き" title="キー操作（? キー）"><i data-lucide="keyboard" class="w-4 h-4"></i></button>
        <button type="button" id="bulletin-btn-create" class="btn-primary font-bold flex items-center gap-1.5 shrink-0">
          <i data-lucide="plus" class="w-4 h-4"></i> 新規投稿
        </button>
      </div>
    </div>

    <!-- ★ ミニカレンダー（折りたたみ。投稿数の打点付き。‹ › の間の日付クリック・C キーで開く） -->
    <div id="bulletin-mini-cal" class="hidden mt-2 mb-2 bg-surface-strong border border-divider rounded-xl p-3"></div>

    <!-- ★ キーボード操作の手引き（収納。キー操作ボタンで開閉。常時表示しない） -->
    <div id="bulletin-keys-pop" class="hidden mt-2 mb-2 bg-surface-strong border border-divider rounded-xl p-2.5 text-sm text-soft flex flex-wrap gap-x-3 gap-y-1">
      <span><kbd class="kbd-key">↑</kbd><kbd class="kbd-key">↓</kbd> タイトル間移動（選択で既読・右ペイン連動）</span>
      <span><kbd class="kbd-key">Enter</kbd> 右ペインへフォーカス</span>
      <span><kbd class="kbd-key">←</kbd><kbd class="kbd-key">→</kbd> 前日・翌日（‹ › ボタン）</span>
      <span><kbd class="kbd-key">T</kbd> 今日</span>
      <span><kbd class="kbd-key">C</kbd> カレンダー（‹ › の間の日付をクリックでも開く）</span>
      <span>検索＝タイトル・本文・投稿者名を全日。検索中は中心日表示が「全日」になり、結果の行クリックは中心日を動かさない。検索語を消すと日付表示へ戻る</span>
      <span><kbd class="kbd-key">?</kbd> 手引き開閉</span>
    </div>

    <!-- ★ 左右分割（左=タイトル列＋未読バッジ、右=選択記事の全文・コメント） -->
    <div class="bulletin-split">
      <div class="bulletin-title-pane">
        <div class="pane-label">
          <span class="flex items-center gap-1.5"><i data-lucide="list" class="w-3.5 h-3.5 text-accent"></i> タイトル</span>
          <div class="flex items-center gap-2 min-w-0">
            <span id="bulletin-title-count" class="text-sm text-muted">0 件</span>
          </div>
        </div>
        <div id="bulletin-list-container" class="bulletin-list-container" role="listbox" aria-label="掲示タイトル">
          <div class="p-4 text-center text-sm text-muted">掲示板データを読み込み中...</div>
        </div>
      </div>
      <div id="bulletin-detail-pane" class="bulletin-detail-pane" tabindex="0" aria-live="polite" aria-label="掲示全文">
        <div class="p-6 text-center text-sm text-muted">表示日の掲示全文を読み込み中...</div>
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

  // 検索インプット（タイトル・本文・投稿者名を全日で検索。検索語がある間は中心日が列表表示に影響しない全日表示）
  document.getElementById('bulletin-search-input')?.addEventListener('input', (e) => {
    currentSearch = e.target.value.toLowerCase().trim();
    updateDayReadout();   // 中心日表示を「全日」化し ‹ ›・本日・日付クリックを止める（検索語クリアで元の日へ復帰）
    renderBulletinList();
    // ミニカレンダーが開いているなら、検索該当日（.mini-cal-hit）の枠も追従させる
    const calOpen = document.getElementById('bulletin-mini-cal');
    if (calOpen && !calOpen.classList.contains('hidden')) renderMiniCalendar();
  });

  // 添付ファイル選択プレビュー
  const fileInput = document.getElementById('bulletin-files');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      renderSelectedFiles(Array.from(fileInput.files || []));
    });
  }

  if (eventsBound) return;

  // ★ ‹ [日付] ›・本日・キー手引きは固定要素なので直接登録。
  //    ‹ › の間の日付ボタンをクリックするとミニカレンダーを開閉する（C キーも同じ）
  document.getElementById('bulletin-day-prev')?.addEventListener('click', () => shiftWindow(-1));
  document.getElementById('bulletin-day-next')?.addEventListener('click', () => shiftWindow(1));
  document.getElementById('bulletin-btn-today')?.addEventListener('click', () => selectDay(dayKey(0)));
  document.getElementById('bulletin-day-current')?.addEventListener('click', () => toggleMiniCalendar());
  document.getElementById('bulletin-keys-toggle')?.addEventListener('click', () => toggleKeysHelp());

  // ★ 左列タイトル行（クリックで選択＝即既読化→右ペイン全文。削除ボタンは置かない＝削除は詳細モーダル内・投稿者のみ）。
  //    検索語入力中の全日表示でも中心日（‹ › の間）は動かさない（全日の列表でその記事の全文だけを右に出す）
  const listEl = document.getElementById('bulletin-list-container');
  if (listEl) {
    listEl.addEventListener('click', (e) => {
      const row = e.target.closest('[data-bulletin-toggle]');
      if (!row) return;
      const id = row.getAttribute('data-bulletin-toggle');
      selectBulletin(id);
    });
  }

  // ★ 右ペイン（「詳細」・コメント送信）はペイン側で委譲
  const paneEl = document.getElementById('bulletin-detail-pane');
  if (paneEl) {
    paneEl.addEventListener('click', (e) => {
      const detail = e.target.closest('[data-bulletin-detail]');
      if (detail) {
        openBulletinDetail(detail.getAttribute('data-bulletin-detail'));
        return;
      }
      const send = e.target.closest('[data-bulletin-comment]');
      if (send) sendBulletinComment(send.getAttribute('data-bulletin-comment'));
    });
  }

  // ★ ミニカレンダー（日付選択・月送りの委譲。今日ボタンと「任意日へ」入力は撤廃済み）
  const calEl = document.getElementById('bulletin-mini-cal');
  if (calEl) {
    calEl.addEventListener('click', (e) => {
      const dayBtn = e.target.closest('[data-cal-date]');
      if (dayBtn) {
        // 検索中は中心日が列表表示に影響しないため、日付選択（中心日ジャンプ）を受け付けない
        if (dayBtn.disabled || dayBtn.getAttribute('aria-disabled') === 'true') return;
        selectDay(dayBtn.getAttribute('data-cal-date'));
        closeMiniCalendar();   // 日を選ぶと ‹ [日付] › に反映して閉じる
        return;
      }
      const monthBtn = e.target.closest('[data-cal-month]');
      if (monthBtn) { shiftCalendarMonth(monthBtn.getAttribute('data-cal-month')); return; }
    });
  }

  // ★ キーボード操作（掲示タブがアクティブな時のみ）
  document.addEventListener('keydown', bulletinKeyHandler);

  eventsBound = true;
}

/**
 * キーボードによるザッピング操作
 * ↑/↓ タイトル行間移動（選択＝即既読化・右ペイン全文が連動）、Enter 右ペイン（全文）へフォーカス、
 * ←/→ 前日・翌日（±1日）、T 今日、C カレンダー、? 手引き開閉。
 * 検索語入力中は中心日が列表表示に影響しないため ←/→・T・C は受け付けない（↑/↓・Enter・? はそのまま）
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
    // 検索中は中心日が列表表示に影響しないため日付ザッピングを受け付けない（‹ ›・本日・C も停止）
    if (currentSearch) {
      e.preventDefault();
      return;
    }
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
  if (k === 't' || k === 'c') {
    e.preventDefault();
    if (currentSearch) return;   // 検索中は中心日・カレンダー操作を止める（全日表示）
    if (k === 't') selectDay(dayKey(0));
    else toggleMiniCalendar();
    return;
  }
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

/** 掲示の「対象日」キー (YYYY-MM-DD)。対象日未設定の旧レコードは投稿日で補完する */
function targetDayOf(b) {
  const raw = String(b.targetDate || b.target_date || b.targetDay || b.target_day || '').substring(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return toJstDay(b.postedAt || b.posted_at || b.createdAt || b.created_at);
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

/** 対象日の短いラベル (YYYY-MM-DD → MM/DD(曜)) */
function dayShortLabel(key) {
  const parts = String(key || '').split('-');
  if (parts.length < 3) return '';
  return `${parts[1]}/${parts[2]}(${weekdayLabel(key)})`;
}

/**
 * 検索語に該当する箇所を <mark> で囲む（残りはエスケープ。検索語が部分一致でも安全に 1 箇所だけ強調）
 * @param {string} text 表示する文字列
 * @param {string} query 検索語（小文字化済み）
 */
function highlightHtml(text, query) {
  const s = String(text || '');
  if (!query) return escapeHTML(s);
  const idx = s.toLowerCase().indexOf(query);
  if (idx < 0) return escapeHTML(s);
  const end = idx + query.length;
  return `${escapeHTML(s.slice(0, idx))}<mark class="bulletin-hit">${escapeHTML(s.slice(idx, end))}</mark>${escapeHTML(s.slice(end))}`;
}

/** キャッシュから対象日別の件数を算出（ミニカレンダーの打点） */
function dayCounts() {
  const map = new Map();
  bulletinsCache.forEach((b) => {
    const k = targetDayOf(b);
    if (k) map.set(k, (map.get(k) || 0) + 1);
  });
  return map;
}

/** 対象日が中心日と一致するか（対象日未設定のレコードは投稿日で判定） */
function matchesDay(b) {
  return targetDayOf(b) === (currentDayDate || dayKey(0));
}

/** 2つの YYYY-MM-DD キーの日数差 (b - a) */
function dayDiff(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}

/**
 * 移動方向がわかるスライドアニメーション
 * 日付ザッピング(軸x)は中心日表示と左列を小刻みにナッジする。
 * タイトル移動(軸y)は左列全体を動かさない — 選択枠(選択行)だけが移動する。
 * 右ペインは常にフェードイン程度（全体をフラッシュ・移動させない）。
 * @param {number} dir 1=未来(右)/次(下) / -1=過去(左)/前(上) / 0=なし
 * @param {'x'|'y'} [axis] 軸。日付ザッピング='x'、タイトル移動='y'
 * @param {number} [days] 移動日数（絶対値）。未指定なら 1 日扱い
 * @param {number|null} [prevTop] タイトル移動時の移動前選択行の top（選択枠のFLIP移動用）
 */
function animateShift(dir, axis = 'x', days = 1, prevTop = null) {
  if (!dir || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) return;

  const span = Math.max(1, Math.min(Math.abs(days) || 1, 7));
  const prop = axis === 'y' ? 'translateY' : 'translateX';
  // 1日はずっと小さく、複数日ジャンプだけ大きく動く（中心日は ≤6px、左列は ≤12px、タイトル移動は左列を動かさない）
  const contentStep = axis === 'y' ? 0 : dir * (3 + span * 2);
  const readoutStep = axis === 'x' ? dir * Math.min(3 + span, 6) : 0;
  const fade = 0.62;
  const opts = {
    duration: axis === 'y' ? 200 : 150,
    easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    fill: 'both'
  };

  const slide = (el, offset) => {
    if (!el || typeof el.animate !== 'function' || !offset) return;
    el.animate(
      [{ transform: `${prop}(${offset}px)`, opacity: fade }, { transform: `${prop}(0)`, opacity: 1 }],
      opts
    );
  };

  slide(document.getElementById('bulletin-day-current'), readoutStep);
  // 左列全体はタイトル移動で動かない (axis 'y' では contentStep=0)。日付ザッピングの小ナッジだけ
  slide(document.getElementById('bulletin-list-container'), contentStep);

  // 右ペインは位置を動かさない。フェードイン程度
  const pane = document.getElementById('bulletin-detail-pane');
  if (pane && typeof pane.animate === 'function') {
    pane.animate([{ opacity: fade }, { opacity: 1 }], opts);
  }

  // タイトル移動は「選択枠が移動する」アニメーションだけ行う
  if (axis === 'y' && prevTop !== null) {
    const row = document.querySelector(`#bulletin-list-container [data-bulletin-toggle="${selectedId}"]`);
    if (row && typeof row.animate === 'function') {
      const delta = prevTop - row.getBoundingClientRect().top;
      if (delta) {
        row.animate(
          [
            { transform: `translateY(${delta}px)`, offset: 0 },
            { transform: 'translateY(0)', offset: 1 }
          ],
          opts
        );
      }
    }
  }
}

/** 中心日読取（‹ › の間の固定幅ボタン。data-day に YYYY-MM-DD を保持。クリックでミニカレンダー開閉）。
 *  検索語入力中は表示を「全日」に変え、‹ ›・本日・日付クリック（カレンダー開閉）を止める。data-day は保持するので検索語を消すと元の日へ復帰 */
function updateDayReadout() {
  const readout = document.getElementById('bulletin-day-current');
  if (!readout) return;
  const key = currentDayDate || dayKey(0);
  readout.dataset.day = key;
  setDayNavEnabled(!currentSearch);

  if (currentSearch) {
    readout.textContent = '全日';
    readout.setAttribute('aria-label', '全日の検索結果を表示中');
    readout.title = '検索中は全日の結果を表示（検索語を消すと元の日付表示へ戻ります）';
    return;
  }

  const parts = key.split('-');
  const label = `${parts[1]}/${parts[2]} (${weekdayLabel(key)})`;
  readout.textContent = label;
  readout.setAttribute('aria-label', `表示日: ${key} ${weekdayLabel(key)}（クリックでカレンダーを開く）`);
  if (readout.getAttribute('aria-expanded') !== 'true') {
    readout.title = 'カレンダーを開く（C キー）';
  }
}

/** ‹ ›・本日・中心日（カレンダー開閉）ボタンの有効／無効切替（寸法は固定のまま。検索中は中心日が列表表示に影響しない） */
function setDayNavEnabled(enabled) {
  ['bulletin-day-prev', 'bulletin-day-next', 'bulletin-btn-today', 'bulletin-day-current'].forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !enabled;
    el.setAttribute('aria-disabled', String(!enabled));
    if (enabled && el.getAttribute('aria-expanded') === 'true') {
      el.title = 'カレンダーを閉じる';
    }
  });
}

/**
 * 表示日の設定（左列・右ペインの再描画を駆動する中心関数）
 * @param {string} date YYYY-MM-DD
 * @param {number} [dir] 移動方向 (1=未来/右, -1=過去/左)。省略時は日付差から算出
 */
function selectDay(date, dir = 0) {
  // 検索語がある間は中心日が列表表示に影響しないため日付変更を受け付けない。
  //   ‹ ›・本日・C・カレンダー日付クリックは UI で止まり、この関数にも入らせない（中心日と data-day は保持）
  if (currentSearch) return;
  const target = String(date || '').substring(0, 10) || dayKey(0);
  // 中心日とその中心日読取（「全日」表示と data-day）は updateDayReadout で追従
  // 移動日数（アニメーションの大きさ用。1日ずれは小さく、複数日ジャンプだけ大きく動く）
  const span = Math.abs(dayDiff(currentDayDate, target)) || 1;
  const shift = dir || Math.sign(dayDiff(currentDayDate, target)) || 0;
  const hadFocus = document.activeElement && document.activeElement.closest('#bulletin-list-container');
  currentDayDate = target;
  calendarAnchor = target;

  updateDayReadout();

  // ミニカレンダーが開いているなら、中心日（‹ › の間）に合わせて月の表示も追従させる
  const calOpen = document.getElementById('bulletin-mini-cal');
  if (calOpen && !calOpen.classList.contains('hidden')) renderMiniCalendar();

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

/** ミニカレンダーの開閉（‹ [日付] › の日付クリック・C キー。開いている日は表示日）。検索中は中心日が列表表示に影響しないので開閉を受け付けない */
function toggleMiniCalendar() {
  if (currentSearch) return;
  const cal = document.getElementById('bulletin-mini-cal');
  const btn = document.getElementById('bulletin-day-current');
  if (!cal) return;
  const opening = cal.classList.contains('hidden');
  if (opening) {
    calendarAnchor = currentDayDate || dayKey(0);
    renderMiniCalendar();
  }
  cal.classList.toggle('hidden', !opening);
  if (btn) {
    btn.setAttribute('aria-expanded', opening ? 'true' : 'false');
    btn.title = opening ? 'カレンダーを閉じる' : 'カレンダーを開く（C キー）';
  }
}

/** ミニカレンダーを閉じる（日付選択後は ‹ [日付] › に反映して閉じる） */
function closeMiniCalendar() {
  const cal = document.getElementById('bulletin-mini-cal');
  const btn = document.getElementById('bulletin-day-current');
  if (!cal) return;
  cal.classList.add('hidden');
  if (btn) {
    btn.setAttribute('aria-expanded', 'false');
    btn.title = 'カレンダーを開く（C キー）';
  }
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
  // 検索語がある日は、全対象日の検索該当数（対象日ベース）を打点に重ねる
  const hitCounts = currentSearch
    ? allSearchMatches().reduce((map, b) => {
        const k = targetDayOf(b);
        map.set(k, (map.get(k) || 0) + 1);
        return map;
      }, new Map())
    : null;
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();

  const cells = [];
  for (let i = 0; i < lead; i++) cells.push('<span class="mini-cal-day mini-cal-empty"></span>');
  for (let d = 1; d <= dim; d++) {
    const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const n = counts.get(key) || 0;
    const hit = hitCounts ? (hitCounts.get(key) || 0) : 0;
    const cls = [
      'mini-cal-day',
      key === today ? 'mini-cal-today' : '',
      key === currentDayDate ? 'mini-cal-selected' : '',
      n > 0 ? 'mini-cal-has' : '',
      hit > 0 ? 'mini-cal-hit' : '',
    ].filter(Boolean).join(' ');
    // 検索中は中心日が列表表示に影響しないので、カレンダーからの日付選択は受け付けない（該当日の枠と件数は出す）
    const off = currentSearch ? ' disabled aria-disabled="true"' : '';
    cells.push(`<button type="button" class="${cls}" data-cal-date="${key}"${off}
               aria-label="${key} ${weekdayLabel(key)} 対象日 ${n} 件${hit > 0 ? `（検索該当 ${hit} 件）` : ''}">
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
      <button type="button" class="icon-btn border border-divider bg-surface" data-cal-month="1" aria-label="次の月">
        <i data-lucide="chevron-right" class="w-4 h-4"></i>
      </button>
    </div>
    <div class="mini-cal-grid mb-1">
      ${WEEKDAY_LABELS.map((w) => `<span class="mini-cal-wd">${w}</span>`).join('')}
    </div>
    <div class="mini-cal-grid">${cells.join('')}</div>
    <p class="text-sm text-muted mt-2">● は対象日に掲示のある日です。日付をクリックでその日の記事を表示してカレンダーは閉じます。‹ › ボタンと ←/→ キーで前日・翌日（1日分）へ、‹ › の間の日付クリック（<kbd class="kbd-key">C</kbd> キー）でこのカレンダーを開閉できます。本日へは ‹ › の間の「本日」ボタンと T キーで戻ります。${currentSearch ? '検索語がある日（accent の枠）が全日の検索結果に該当する日です。検索中は中心日が列表表示に影響しないため、日付は選べません。' : ''}</p>
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

/** 検索語（タイトル・本文・投稿者名）に該当するか。検索語が空なら全件 true */
function matchesQuery(b) {
  if (!currentSearch) return true;
  const q = currentSearch;
  return String(b.title || '').toLowerCase().includes(q) ||
    String(b.content || '').toLowerCase().includes(q) ||
    Boolean(b.authorName && String(b.authorName).toLowerCase().includes(q));
}

/** 全日の検索該当（検索語が空なら全件）。対象日降順 → 投稿日時降順 */
function allSearchMatches() {
  const hits = bulletinsCache.filter((b) => matchesQuery(b));
  hits.sort((a, b) => {
    const dayA = targetDayOf(a);
    const dayB = targetDayOf(b);
    if (dayA !== dayB) return dayA < dayB ? 1 : -1;
    return postedDesc(a, b);
  });
  return hits;
}

/** 投稿日時降順比較（新しさが上） */
function postedDesc(a, b) {
  const dateA = new Date(a.postedAt || a.posted_at || a.createdAt || a.created_at);
  const dateB = new Date(b.postedAt || b.posted_at || b.createdAt || b.created_at);
  return dateB - dateA;
}

/**
 * 左列表示用の絞り込みとソート
 * 検索語がある間は中心日が列表表示に影響しないため検索該当全件を全日表示（対象日降順 → 投稿日時降順）、
 * 検索語が空なら中心日の掲示を投稿日時降順（カテゴリフィルタは撤廃）
 */
function filteredBulletins() {
  if (currentSearch) return allSearchMatches();

  const filtered = bulletinsCache.filter((b) => matchesQuery(b) && matchesDay(b));
  filtered.sort(postedDesc);
  return filtered;
}

/** 未読判定（未読 = 既読でも承認済みでもない） */
function isUnreadBulletin(b) {
  return !b.isRead && b.ackStatus !== 'READ' && b.ackStatus !== 'APPROVED';
}

/**
 * 掲示の投稿者がログインユーザー本人か（削除ボタンは投稿者本人にだけ表示する）
 * @param {Object} b 掲示
 */
function isBulletinAuthor(b) {
  const myId = String((state.currentUser && (state.currentUser.id || state.currentUser.staff_code)) || '');
  const authorId = String((b && (b.authorId || b.author_id)) || '');
  return Boolean(myId) && Boolean(authorId) && myId === authorId;
}

/** 掲示ID でキャッシュの掲示を探す */
function findBulletin(id) {
  return bulletinsCache.find((b) => String(b.id) === String(id)) || null;
}

/**
 * 右ペインヘッダーのバッジ群（未読バッジは撤廃済み。掲示終了・添付のみ。
 * 読者向けに日付・掲示期間の表記は置かない）
 */
function paneBadgeHtml(b) {
  const attachments = b.attachments || [];
  return `
    ${isDisplayExpired(b) ? '<span class="badge bg-surface-strong text-muted border-divider flex items-center gap-1 shrink-0"><i data-lucide="calendar-off" class="w-3 h-3"></i> 掲示終了</span>' : ''}
    ${attachments.length > 0 ? `<span class="badge bg-accent-soft text-accent-strong border-accent-soft flex items-center gap-1 shrink-0"><i data-lucide="paperclip" class="w-3 h-3"></i> 添付 ${attachments.length}</span>` : ''}
  `;
}

/**
 * 右ペインタイトル行の投稿者（アバターアイコン＋投稿者名。右寄せ）
 * @param {Object} b 掲示
 */
function paneAuthorHtml(b) {
  const author = b.authorName || b.author_name || '教員';
  const avatar = b.authorAvatar || b.author_avatar || null;
  return `
    <div class="pane-author" aria-label="投稿者" title="投稿者">
      ${userAvatarHtml({ name: author, avatarUrl: avatar, size: 'sm' })}
      <span class="pane-author-name">${escapeHTML(String(author))}</span>
    </div>`;
}

/**
 * 左列タイトル行（1行・右端に未読バッジ、行頭シグニファイア › でクリック誘導。全文は右ペインに出す。削除は詳細モーダル内のみ）
 * 全日の検索結果一覧（showDay）では行頭に対象日チップを出し、タイトル内の検索該当を <mark> で強調する
 * @param {Object} b
 * @param {boolean} selected 選択中（既読化済み・強調表示）か
 * @param {boolean} [showDay] 対象日チップを出すか（全日の検索結果一覧でのみ true）
 */
function titleRowHtml(b, selected, showDay = false) {
  const unread = isUnreadBulletin(b);
  const titleHtml = currentSearch ? highlightHtml(b.title, currentSearch) : escapeHTML(String(b.title || ''));
  const dayChip = showDay ? `<span class="bulletin-row-day">${escapeHTML(dayShortLabel(targetDayOf(b)))}</span>` : '';
  return `
    <div class="bulletin-title-row${selected ? ' active' : ''}" data-bulletin-toggle="${b.id}"
         data-unread="${unread ? 'true' : 'false'}" role="option" tabindex="0"
         aria-selected="${selected ? 'true' : 'false'}"
         ${showDay ? `data-target-day="${targetDayOf(b)}"` : ''}>
      <span class="bulletin-row-signifier" aria-hidden="true"><i data-lucide="chevron-right" class="w-3.5 h-3.5"></i></span>
      ${dayChip}
      <span class="bulletin-row-title">${titleHtml}</span>
      ${unread ? '<span class="bulletin-unread-badge" aria-hidden="true">未読</span>' : ''}
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

/** 左列タイトル行の描画（日付・件数の欄は左列ヘッダーに寄せる。行は1行タイトル＋未読バッジ）。
 *  検索語入力中は全日の検索結果を対象日見出しでグループ化する（件数は「N 件」。表示切替ピルは撤廃、中心日は動かさない） */
function renderRows() {
  const container = document.getElementById('bulletin-list-container');
  if (!container) return;

  const filtered = filteredBulletins();
  const inSearch = Boolean(currentSearch);
  const countEl = document.getElementById('bulletin-title-count');

  // 左列ヘッダー（件数表示のみ。検索ピルは撤廃 — 検索中は常に全日表示）
  if (countEl) countEl.textContent = `${filtered.length} 件`;

  if (filtered.length === 0) {
    container.innerHTML = inSearch
      ? `<div class="p-5 text-center text-sm text-muted">
          <i data-lucide="search-x" class="w-6 h-6 mx-auto mb-2 opacity-60"></i>
          <div>検索語「${escapeHTML(currentSearch)}」に該当する掲示は全日にありません（タイトル・本文・投稿者名を検索）。検索語を消すと通常の日付表示へ戻ります。</div>
        </div>`
      : `<div class="p-5 text-center text-sm text-muted">
          <i data-lucide="calendar-off" class="w-6 h-6 mx-auto mb-2 opacity-60"></i>
          <div>この日の掲示連絡はありません。<kbd class="kbd-key">←</kbd><kbd class="kbd-key">→</kbd>・‹ › ボタンで前日・翌日、‹ › の間の日付クリック（<kbd class="kbd-key">C</kbd> キー）でカレンダーを開いて好きな日へ移動できます。</div>
        </div>`;
    refreshLucideIcons();
    return;
  }

  if (inSearch) {
    // 対象日降順のグループ（見出し + 行）。行クリックは中心日を動かさず、その記事の全文を右ペインに出す
    const groups = [];
    filtered.forEach((b) => {
      const key = targetDayOf(b);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.items.push(b);
      else groups.push({ key, items: [b] });
    });
    container.innerHTML = groups.map((g) => {
      const sep = `<div class="bulletin-day-sep" aria-hidden="true">
        <span class="flex items-center gap-1.5"><i data-lucide="calendar" class="w-3.5 h-3.5"></i> ${escapeHTML(dayShortLabel(g.key))}</span>
        <span class="bulletin-day-sep-count">${g.items.length} 件</span>
      </div>`;
      return sep + g.items.map((b) => titleRowHtml(b, String(b.id) === String(selectedId), true)).join('');
    }).join('');
  } else {
    container.innerHTML = filtered
      .map((b) => titleRowHtml(b, String(b.id) === String(selectedId)))
      .join('');
  }
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
    pane.innerHTML = `<div class="p-6 text-center text-sm text-muted">
      <i data-lucide="inbox" class="w-7 h-7 mx-auto mb-2 opacity-60"></i>
      <div>${currentSearch
        ? '検索語に該当する掲示は全日にありません（タイトル・本文・投稿者名を検索）。検索語を消すと通常の日付表示へ戻ります。'
        : 'この日に掲示された連絡はありません。<kbd class="kbd-key">←</kbd><kbd class="kbd-key">→</kbd>・‹ › ボタンで前日・翌日へ移動できます。日付（‹ › の間）をクリックするとカレンダーが開きます。'}</div>
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
        ${paneAuthorHtml(b)}
        <div class="pane-badges">${paneBadgeHtml(b)}</div>
        <button type="button" class="btn-primary py-1 px-2.5 text-sm font-bold flex items-center gap-1 shrink-0"
                data-bulletin-detail="${b.id}" title="投稿日時・掲示期間・添付をモーダルで開く">
          <i data-lucide="maximize-2" class="w-3.5 h-3.5"></i> 詳細
        </button>
      </div>
      <pre class="pane-body-text">${escapeHTML(String(b.content || ''))}</pre>
      ${attachmentsHtml(atts)}
      <div class="bulletin-comments">
        <p class="comment-heading"><i data-lucide="message-square" class="w-3.5 h-3.5 text-accent"></i> 投稿者への補足・コメント (${comments.length})</p>
        ${comments.length > 0 ? `<ul class="comment-list">${comments.map(commentHtml).join('')}</ul>` : '<p class="comment-empty">まだコメントはありません。</p>'}
        <div class="comment-form">
          <label for="bulletin-comment-input" class="text-sm text-muted shrink-0">補足・確認コメント</label>
          <!-- チャット送信フォームと同一レイアウト（入力欄 flex-1／送信ボタンは内容幅で下端揃え） -->
          <div class="comment-form-row">
            <div class="flex-1">
              <textarea id="bulletin-comment-input" rows="2" class="input-field w-full min-w-0 p-2 text-sm" placeholder="投稿者へ補足・確認コメントを書く" aria-label="補足・確認コメント"></textarea>
            </div>
            <button type="button" id="bulletin-comment-send" class="btn-primary py-2 px-4 h-[42px] font-bold text-xs flex items-center justify-center gap-1.5 flex-shrink-0"
                    data-bulletin-comment="${b.id}"><i data-lucide="send" class="w-4 h-4"></i> 送信</button>
          </div>
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
    // サーバー永続化コメント（bulletin_comments）。ack コメントと時刻昇順で併せる
    const postedComments = (detail.comments || [])
      .filter((c) => String(c.comment_text || c.commentText || c.comment || '').trim())
      .map((c) => ({
        authorName: c.author_name || c.authorName || c.user_name || c.userName || c.name || '教員',
        avatarUrl: c.author_avatar || c.avatar_url || c.avatarUrl || null,
        commentText: String(c.comment_text || c.commentText || c.comment).trim(),
        createdAt: c.created_at || c.createdAt || null,
      }));
    const merged = [...apiComments, ...postedComments]
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    const mine = (commentsById.get(key) || []).filter((c) => c.mine);
    commentsById.set(key, [...merged, ...mine]);
    if (window.__bulletinDebug) {
      window.__bulletinDebug.push({ key, serverKeys: (detail.comments || []).length, acks: acks.length, merged: merged.length, paneSel: String(selectedId) === key });
    }
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

  // 移動前選択行の top を記録（renderRows で行が入れ替わる前に測り、選択枠のFLIP移動に使う）
  const prevRow = prevIdx >= 0
    ? document.querySelector(`#bulletin-list-container [data-bulletin-toggle="${selectedId}"]`)
    : null;
  const prevTop = prevRow ? prevRow.getBoundingClientRect().top : null;

  selectedId = key;
  markBulletinRead(key);          // 非同期 PUT（ローカル状態は即更新で未読バッジが消失）
  renderRows();
  renderDetailPane(item);
  animateShift(shift, 'y', 1, prevTop);
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
 * 掲示の削除（詳細モーダル内の「削除」ボタンからのみ。投稿者本人にだけボタンが出る）
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
      <span>対象日: <strong class="text-main">${formatDate(targetDayOf(item), false)}</strong></span>
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
      : `<p class="text-sm text-muted">添付ファイルはありません。</p>`;
  }

  if (actionsEl) {
    // 削除は本文・掲示期間などを確認できる詳細モーダル内にだけ置く。投稿者本人以外には表示しない
    actionsEl.innerHTML = `
      <button id="btn-detail-comment" class="btn-secondary py-1.5 px-3 text-sm flex items-center gap-1.5 text-warning border-warning-soft">
        <i data-lucide="message-square" class="w-3.5 h-3.5"></i> 補足・コメント
      </button>
      ${isBulletinAuthor(item) ? `<button type="button" id="btn-detail-delete" class="btn-danger py-1.5 px-3 text-sm flex items-center gap-1.5 bg-danger-soft text-danger-strong border border-danger-soft" title="この掲示を削除（投稿者のみ）"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> 削除</button>` : ''}
      <button class="modal-close btn-secondary py-1.5 px-4 text-sm">閉じる</button>
    `;

    document.getElementById('btn-detail-comment')?.addEventListener('click', () => {
      closeModal('bulletin-detail-modal');
      selectBulletin(id);
      focusDetailPane();
      showToast('右ペイン下のコメント欄から送信してください', 'info');
    });

    document.getElementById('btn-detail-delete')?.addEventListener('click', () => {
      closeModal('bulletin-detail-modal');
      deleteBulletinPost(id);
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

  // 新規投稿は左列に出るように中心日を「対象日」へ寄せる（対象日未設定なら投稿日）
  currentDayDate = targetDate || toJstDay(postedAt) || currentDayDate;
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
    <li class="flex items-center gap-2 text-sm text-soft">
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
