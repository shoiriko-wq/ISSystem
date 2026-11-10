/**
 * ISSystem Facility Mini Calendar（施設物品予約のミニカレンダー）
 * ‹ [日付読み上げ] › の日付クリック・C キーで開閉するミニカレンダー。
 * 形は職員掲示板のミニカレンダーと同一（年月部分 ‹ [年月] › はスケジュールのカレンダーと同じ形）。
 * ● は対象日に予約のある日（月別件数は API /api/facilities/month-counts から取る）。
 */
import { apiGet } from '../api.js';
import { refreshLucideIcons } from '../ui-helpers.js';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];

/** 'YYYY-MM-DD' の曜字（UTC キーで計算して JST ズレを防ぐ） */
function weekdayLabel(key) {
  const p = String(key).split('-').map(Number);
  return WEEKDAY_LABELS[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
}

/**
 * ミニカレンダーを作る（施設タブの DOM を使う）
 * @param {Object} opts
 * @param {function(): string} opts.getDay 表示日 (YYYY-MM-DD) を読む
 * @param {function(string): void} opts.pickDay 表示日を選ぶ（タイムライン再読込）
 * @param {function(): string} opts.todayKey 本日 (YYYY-MM-DD)
 */
export function createFacilityCalendar(opts) {
  const { getDay, pickDay, todayKey } = opts;

  let calendarAnchor = `${getDay().slice(0, 7)}-01`;   // カレンダー表示月のアンカー（月初）
  let calMonthMenuOpen = false;
  let calMenuYear = Number(getDay().slice(0, 4));
  let calMenuDocBound = false;

  /** 件数キャッシュを当月分だけ作る（表示日の件数は module 側が onDayCount で反映する） */
  function putCounts(mkey, dateKey, n) {
    const map = monthCountsCache[mkey] || (monthCountsCache[mkey] = {});
    map[dateKey] = n;
  }

  const monthCountsCache = {};

  async function loadMonthCounts(key) {
    const mkey = key.slice(0, 7);
    if (monthCountsCache[mkey]) return monthCountsCache[mkey];
    try {
      const data = await apiGet('/facilities/month-counts', { date: key });
      const counts = (data && data.counts) || {};
      monthCountsCache[mkey] = counts;
      return counts;
    } catch (err) {
      console.warn('[FacilityCalendar] 月別予約件数取得失敗:', err.message);
      return {};
    }
  }

  /** ‹ › の間の日付読み上げを書き換える（MM/DD (曜)。data-day は表示日） */
  function updateReadout() {
    const readout = document.getElementById('facility-day-current');
    if (!readout) return;
    const key = getDay();
    readout.dataset.day = key;
    const parts = key.split('-');
    readout.textContent = `${parts[1]}/${parts[2]} (${weekdayLabel(key)})`;
    readout.setAttribute('aria-label', `表示日: ${key} ${weekdayLabel(key)}（クリックでカレンダーを開く）`);
    readout.title = readout.getAttribute('aria-expanded') === 'true' ? 'カレンダーを閉じる' : 'カレンダーを開く（C キー）';
  }

  /** 年月選択メニューの中身（年 ‹ › + 12ヶ月 + 「本日へ」）。スケジュールの sched-* クラスを共用 */
  function calMonthMenuHtml(y, curY, curM) {
    const items = Array.from({ length: 12 }, (_, i) => {
      const cur = y === curY && i + 1 === curM;   // 現在表示中の月
      const current = cur ? ' aria-current="true"' : '';
      return `<button type="button" class="sched-month-item" data-menu-month="${i}" aria-label="${y}年${i + 1}月へ"${current}>${i + 1}月</button>`;
    }).join('');
    return `
    <div class="flex items-center justify-center gap-2 mb-2">
      <button type="button" class="icon-btn icon-btn-fixed border border-main bg-surface text-soft" data-menu-year="-1" aria-label="前年（${y - 1}年）" title="前年（${y - 1}年）"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
      <span class="text-sm font-bold text-main min-w-[3.2rem] text-center">${y}年</span>
      <button type="button" class="icon-btn icon-btn-fixed border border-main bg-surface text-soft" data-menu-year="1" aria-label="次年（${y + 1}年）" title="次年（${y + 1}年）"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
    </div>
    <div class="grid grid-cols-4 gap-1.5">${items}</div>
    <div class="flex justify-center mt-2">
      <button type="button" class="btn-secondary px-2.5 py-1 text-[11px] rounded-lg" data-menu-today aria-label="本日へ（本日へ移動してカレンダーを閉じる）" title="本日へ">本日へ</button>
    </div>`;
  }

  /** 年月選択メニューの描画（開いていなければ hidden にして中身を空にする） */
  function renderCalMonthMenu() {
    const menu = document.getElementById('facility-month-menu');
    const labelBtn = document.getElementById('facility-month-menu-btn');
    if (!menu) return;
    if (!calMonthMenuOpen) {
      menu.classList.add('hidden');
      menu.innerHTML = '';
      if (labelBtn) labelBtn.setAttribute('aria-expanded', 'false');
      return;
    }
    const curY = Number(calendarAnchor.split('-')[0]);
    const curM = Number(calendarAnchor.split('-')[1]);
    menu.classList.remove('hidden');
    menu.innerHTML = calMonthMenuHtml(calMenuYear, curY, curM);
    if (labelBtn) labelBtn.setAttribute('aria-expanded', 'true');
    refreshLucideIcons();
  }

  /** 年月選択メニューを開く（ラベルの直下、中央）。表示日は動かさない */
  function openCalMonthMenu() {
    calMenuYear = Number(calendarAnchor.split('-')[0]);
    calMonthMenuOpen = true;
    renderCalMonthMenu();
    const menu = document.getElementById('facility-month-menu');
    const target = menu && (menu.querySelector('[aria-current="true"]') || menu.querySelector('[data-menu-month="0"]'));
    if (target) target.focus({ preventScroll: true });
  }

  /** 年月選択メニューを閉じる（Escape・外クリック・月選択後。焦点は年月ラベルへ返す） */
  function closeCalMonthMenu(returnFocus = true) {
    calMonthMenuOpen = false;
    renderCalMonthMenu();
    if (returnFocus) {
      const labelBtn = document.getElementById('facility-month-menu-btn');
      if (labelBtn) labelBtn.focus({ preventScroll: true });
    }
  }

  /** メニューで月を選ぶ：表示月だけ動かす（表示日は変更しない） */
  function gotoCalendarMonth(y, mIdx) {
    calendarAnchor = `${y}-${String(mIdx + 1).padStart(2, '0')}-01`;
    calMonthMenuOpen = false;
    renderMiniCalendar();   // 内側を再描画（メニューは hidden で再生成）
    loadMonthCounts(calendarAnchor).then((counts) => {
      const cal = document.getElementById('facility-mini-cal');
      if (cal && !cal.classList.contains('hidden')) renderMiniCalendar(counts);
    });
    const focusLabel = document.getElementById('facility-month-menu-btn');
    if (focusLabel) focusLabel.focus({ preventScroll: true });
  }

  /** ミニカレンダー描画（予約件数打点付き。年月部分 ‹ [年月] › はスケジュールのカレンダーと同一形） */
  function renderMiniCalendar(countsArg) {
    const calEl = document.getElementById('facility-mini-cal');
    if (!calEl) return;
    const anchor = calendarAnchor || `${getDay().slice(0, 7)}-01`;
    const [y, m] = anchor.split('-').map(Number);
    const counts = countsArg || monthCountsCache[anchor.slice(0, 7)] || {};
    const today = todayKey();
    const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const dim = new Date(Date.UTC(y, m, 0)).getUTCDate();

    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<span class="mini-cal-day mini-cal-empty"></span>');
    for (let d = 1; d <= dim; d++) {
      const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      const n = counts[key] || 0;
      const cls = [
        'mini-cal-day',
        key === today ? 'mini-cal-today' : '',
        key === getDay() ? 'mini-cal-selected' : '',
        n > 0 ? 'mini-cal-has' : '',
      ].filter(Boolean).join(' ');
      cells.push(
        `<button type="button" class="${cls}" data-cal-date="${key}" aria-label="${key} ${weekdayLabel(key)} 予約 ${n} 件">` +
        `<span class="mini-cal-num">${d}</span>${n > 0 ? '<span class="mini-cal-dot"></span>' : ''}</button>`
      );
    }

    calEl.innerHTML = `
    <div class="relative flex justify-center mb-2">
      <div class="flex items-center gap-1.5">
        <button type="button" class="icon-btn icon-btn-fixed border border-main bg-surface text-soft" data-cal-month="-1"
                aria-label="前月（1ヶ月前へ）" title="前月（1ヶ月前へ）"><i data-lucide="chevron-left" class="w-4 h-4"></i></button>
        <h3 class="text-sm font-bold text-main" aria-live="polite">
          <button type="button" id="facility-month-menu-btn" data-cal-month-menu
                  class="sched-month-label-btn flex items-center gap-1 px-2.5 py-0.5 leading-4 rounded-lg border border-main bg-surface"
                  aria-haspopup="dialog" aria-expanded="false" aria-controls="facility-month-menu"
                  aria-label="${y}年${m}月（クリックで年月選択を開く）" title="クリックで年・月を直接選べます">
            ${y}年${m}月<i data-lucide="chevron-down" class="w-3.5 h-3.5 text-muted"></i>
          </button>
        </h3>
        <button type="button" class="icon-btn icon-btn-fixed border border-main bg-surface text-soft" data-cal-month="1"
                aria-label="次月（1ヶ月先へ）" title="次月（1ヶ月先へ）"><i data-lucide="chevron-right" class="w-4 h-4"></i></button>
      </div>
      <!-- オーバーレイ（ラベル行の直下、中央）。フローに影響しない（スケジュールと同じ運用） -->
      <div id="facility-month-menu" class="sched-month-menu hidden" role="dialog" aria-label="年月選択"></div>
    </div>
    <div class="mini-cal-grid mb-1">
      ${WEEKDAY_LABELS.map((w) => `<span class="mini-cal-wd">${w}</span>`).join('')}
    </div>
    <div class="mini-cal-grid">${cells.join('')}</div>
    <p class="text-sm text-muted mt-2">● は対象日に予約のある日です。日付をクリックでその日のタイムラインを表示してカレンダーは閉じます。‹ › ボタンで前日・翌日（1日分）へ、‹ › の間の日付クリック（<kbd class="kbd-key">C</kbd> キー）でこのカレンダーを開閉できます。年月ラベル（‹ › の間）をクリックすると年月選択メニューが開き、年 ‹ ›・月・「本日へ」で移動できます。本日へは「本日へ」と <kbd class="kbd-key">T</kbd> キーで戻ります。</p>
  `;
    renderCalMonthMenu();
    refreshLucideIcons();
  }

  /** カレンダー表示月をずらす（前月・次月。表示日は動かさない） */
  function shiftCalendarMonth(delta) {
    const d = Number(delta) || 0;
    const anchor = calendarAnchor || `${getDay().slice(0, 7)}-01`;
    const [y, m] = anchor.split('-').map(Number);
    const idx = m - 1 + d;
    const ny = y + Math.floor(idx / 12);
    const nm = ((idx % 12) + 12) % 12 + 1;
    calendarAnchor = `${ny}-${String(nm).padStart(2, '0')}-01`;
    renderMiniCalendar();
    loadMonthCounts(calendarAnchor).then((counts) => {
      const cal = document.getElementById('facility-mini-cal');
      if (cal && !cal.classList.contains('hidden')) renderMiniCalendar(counts);
    });
  }

  /** ミニカレンダーを開く（‹ › の間の日付クリック・C キー） */
  function open() {
    const cal = document.getElementById('facility-mini-cal');
    if (!cal) return;
    calendarAnchor = `${getDay().slice(0, 7)}-01`;
    calMonthMenuOpen = false;
    cal.classList.remove('hidden');
    renderMiniCalendar();
    loadMonthCounts(calendarAnchor).then((counts) => {
      const again = document.getElementById('facility-mini-cal');
      if (again && !again.classList.contains('hidden')) renderMiniCalendar(counts);
    });
    const btn = document.getElementById('facility-day-current');
    if (btn) {
      btn.setAttribute('aria-expanded', 'true');
      btn.title = 'カレンダーを閉じる';
    }
    updateReadout();
  }

  /** ミニカレンダーを閉じる（日付選択後は ‹ [日付] › に反映して閉じる） */
  function close() {
    calMonthMenuOpen = false;
    renderCalMonthMenu();
    const cal = document.getElementById('facility-mini-cal');
    const btn = document.getElementById('facility-day-current');
    if (cal) cal.classList.add('hidden');
    if (btn) {
      btn.setAttribute('aria-expanded', 'false');
      btn.title = 'カレンダーを開く（C キー）';
    }
    updateReadout();
  }

  /** 開閉切替 */
  function toggle() {
    const cal = document.getElementById('facility-mini-cal');
    if (!cal) return;
    if (cal.classList.contains('hidden')) open();
    else close();
  }

  /** 表示日が動いた時（‹ › ボタン・予約作成後）に開いているカレンダーを追従させる */
  function syncMonth() {
    const cal = document.getElementById('facility-mini-cal');
    if (!cal || cal.classList.contains('hidden')) return;
    calendarAnchor = `${getDay().slice(0, 7)}-01`;
    calMonthMenuOpen = false;
    renderMiniCalendar();
  }

  /** 表示日の予約件数を件数キャッシュへ反映して ● を追従させる */
  function markDayCount(dateKey, n) {
    const mkey = String(dateKey).slice(0, 7);
    putCounts(mkey, dateKey, n);
    syncMonth();
  }

  /** カレンダーの操作紐付け（日付セル・年月 ‹ ›・年月選択メニュー・外クリック・矢印移動） */
  function bind() {
    const calEl = document.getElementById('facility-mini-cal');
    if (!calEl) return;

    calEl.addEventListener('click', (e) => {
      const dayBtn = e.target.closest('[data-cal-date]');
      if (dayBtn) {
        // 日を選ぶと ‹ [日付] › に反映して閉じる（タイムラインは module 側が再読込）
        pickDay(dayBtn.getAttribute('data-cal-date'));
        close();
        return;
      }
      const monthBtn = e.target.closest('[data-cal-month]');
      if (monthBtn) { shiftCalendarMonth(monthBtn.getAttribute('data-cal-month')); return; }

      // 年月ラベル（‹ › の間）：クリックで年月選択メニューを開閉
      const labelBtn = e.target.closest('[data-cal-month-menu]');
      if (labelBtn) {
        if (calMonthMenuOpen) closeCalMonthMenu(false);
        else openCalMonthMenu();
        return;
      }
      // メニューの年 ‹ ›（innerHTML を作り替えるので再描画後に同じボタンへフォーカスを戻す）
      const yBtn = e.target.closest('[data-menu-year]');
      if (yBtn) {
        const dir = Number(yBtn.getAttribute('data-menu-year'));
        calMenuYear += dir;
        renderCalMonthMenu();
        const again = document.getElementById('facility-month-menu')?.querySelector(`[data-menu-year="${dir}"]`);
        if (again) again.focus({ preventScroll: true });
        return;
      }
      const mBtn = e.target.closest('[data-menu-month]');
      if (mBtn) { gotoCalendarMonth(calMenuYear, Number(mBtn.getAttribute('data-menu-month'))); return; }
      const tBtn = e.target.closest('[data-menu-today]');
      if (tBtn) { gotoCalendarToday(); return; }
    });

    // メニュー内のキーボード操作（矢印で月ボタン間移動＝4列、Home/End、Esc で閉じてラベルへ）
    calEl.addEventListener('keydown', (e) => {
      if (!calMonthMenuOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); closeCalMonthMenu(true); return; }
      const items = Array.from(calEl.querySelectorAll('.sched-month-item'));
      const idx = items.indexOf(document.activeElement);
      if (idx < 0) return;
      const cols = 4;
      const moves = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols, Home: -idx, End: items.length - 1 - idx };
      const d = moves[e.key];
      if (d === undefined) return;
      e.preventDefault();
      const next = items[idx + d];
      if (next) next.focus();
    });

    // ★ メニュー外クリックで閉じる（capture=true。メニュー自身の click（年 ‹ ›）が innerHTML を作り替えると
    //    e.target が DOM から切り離され、外側クリックと誤判定されて年 ‹ › が機能しないため）
    if (!calMenuDocBound) {
      calMenuDocBound = true;
      document.addEventListener('click', (e) => {
        if (!calMonthMenuOpen) return;
        if (e.target.closest('#facility-month-menu') || e.target.closest('#facility-month-menu-btn')) return;
        calMonthMenuOpen = false;
        renderCalMonthMenu();
      }, true);
    }
  }

  /** キーボード（C=カレンダー開閉、T=本日へ、Escape=メニュー/カレンダーを閉じる） */
  function keyHandler(e) {
    const cal = document.getElementById('facility-mini-cal');
    if (!cal) return;
    if (e.key === 'Escape') {
      if (calMonthMenuOpen) { e.preventDefault(); closeCalMonthMenu(true); return; }
      if (!cal.classList.contains('hidden')) { e.preventDefault(); close(); }
      return;
    }
    const k = (e.key || '').toLowerCase();
    if (k === 't') { e.preventDefault(); pickDay(todayKey()); close(); updateReadout(); return; }
    if (k === 'c') { e.preventDefault(); toggle(); }
  }

  /** メニュー内の「本日へ」：本日を表示日へ選び、カレンダーを閉じる */
  function gotoCalendarToday() {
    calMonthMenuOpen = false;
    renderCalMonthMenu();
    calendarAnchor = `${todayKey().slice(0, 7)}-01`;
    pickDay(todayKey());
    close();
    updateReadout();
  }

  return { bind, updateReadout, toggle, open, close, keyHandler, syncMonth, markDayCount, gotoCalendarToday };
}

