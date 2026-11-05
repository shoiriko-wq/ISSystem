/**

 * ISSystem Dashboard Module

 * ダッシュボード描画・天気情報・統合サマリーコントローラー (本日の施設予約・行事表示完全対応版)

 */



import { apiGet } from '../api.js';

import { formatDate, escapeHTML, refreshLucideIcons, openModal, showToast, userAvatarHtml } from '../ui-helpers.js';

import { switchTab } from '../main.js';

import { state } from '../state.js';

import { loadAbsenceSummary, openAbsenceModal } from './absence.module.js';

/**
 * JST の時刻帯 (5段階) と季節 (6区分) を返す
 * @param {Date} now
 */
function dashTimeAndSeason(now = new Date()) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Tokyo', month: '2-digit', hour: '2-digit',
  }).formatToParts(now);
  const pick = (t) => parseInt(parts.find((p) => p.type === t)?.value || '0', 10);
  const hour = pick('hour');
  const month = pick('month');

  const slot = hour < 5 ? 'NIGHT' : hour < 11 ? 'MORNING' : hour < 13 ? 'NOON'
    : hour < 18 ? 'AFTERNOON' : hour < 22 ? 'EVENING' : 'NIGHT';

  const season = (month >= 3 && month <= 5) ? 'SPRING'
    : month === 6 ? 'RAIN'
    : month === 7 ? 'EARLY_SUMMER'
    : (month >= 8 && month <= 9) ? 'SUMMER'
    : (month >= 10 && month <= 12) ? 'AUTUMN'
    : 'WINTER';

  return { slot, season };
}

/** 時刻帯別の労い・確認案内 */
const DASH_TIME_CLAUSES = {
  MORNING: '朝の時間帯です。午前の予定と新着掲示を先に確認してください。',
  NOON: '昼休み前後の時間帯です。午後の予定と緊急連絡を優先して確認してください。',
  AFTERNOON: '午後の授業・部活動の時間帯です。施設予約と承認依頼を確認してください。',
  EVENING: '夕方以降の時間帯です。未処理の承認依頼と当日の記録を今日中に済ませてください。',
  NIGHT: '深夜の時間帯です。緊急連絡以外は翌日の確認で十分です。早めに区切ってください。',
};

/** 季節別の状況案内 */
const DASH_SEASON_CLAUSES = {
  SPRING: '新年度・新学期の切り替わり期です。',
  RAIN: '梅雨時期につき体育施設と雨天対応の予約が増えています。',
  EARLY_SUMMER: '考査前につき試験・成績入力が集中しています。',
  SUMMER: '夏季休業・補充授業の時期です。',
  AUTUMN: '文化祭・体育祭の季節で施設予約が混み合っています。',
  WINTER: '期末考査・冬季休業の時期です。',
};

/**
 * 挨拶文を時刻・季節に応じて描画する (#dash-greeting)
 * @param {Date} now
 */
function renderDashGreeting(now = new Date()) {
  const nameEl = document.getElementById('dash-user-name');
  if (!nameEl) return;

  const { slot, season } = dashTimeAndSeason(now);
  const cu = state.currentUser;
  const name = cu?.name ? String(cu.name) : '先生';
  nameEl.textContent = `${name} 先生`;

  const h2 = document.getElementById('dash-greeting');
  if (h2) {
    h2.innerHTML = `お疲れ様です、<span id="dash-user-name" class="text-primary font-bold">${escapeHTML(name)} 先生</span> ${DASH_TIME_CLAUSES[slot]} ${DASH_SEASON_CLAUSES[season]}`;
  }
}



/**

 * ダッシュボードのHTMLスケルトン生成と初期描画

 */

export function initDashboardModule() {

  const container = document.getElementById('view-dashboard');

  if (!container) return;



  container.innerHTML = `

    <!-- 1. ウェルカムバナー & サマリーカード群 -->

    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">

      <div class="card card--framed p-5 bg-gradient-to-br from-accent-soft via-surface-soft to-surface-strong border-accent-soft md:col-span-2 flex flex-col justify-between">

        <div>

          <div class="flex items-center justify-between mb-2">

            <span class="badge badge-warning">本日: ${formatDate(new Date(), false)}</span>

            <span class="text-[11px] text-muted font-mono">校内ネットワーク: 正常稼働</span>

          </div>

          <h2 class="text-xl font-bold text-main mb-1" id="dash-greeting">お疲れ様です、<span id="dash-user-name" class="text-primary font-bold">先生</span></h2>

          <p class="text-xs text-soft leading-relaxed">

            本日の全校行事・施設予約・重要掲示の最新サマリーです。緊急連絡や承認依頼が届いている場合は即座に確認できます。

          </p>

        </div>

        <div class="flex items-center gap-2 mt-4 text-xs">

          <button id="dash-btn-bulletin" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1.5">

            <i data-lucide="megaphone" class="w-3.5 h-3.5"></i> 掲示板を確認

          </button>

          <button id="dash-btn-chat" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5">

            <i data-lucide="message-square" class="w-3.5 h-3.5"></i> 職員チャットへ

          </button>

        </div>

      </div>



      <!-- 本日の 年休等・出張 (区分別人数 + 記入ボタンから登録モーダルを開く) -->

      <div class="card card--framed p-4 flex flex-col justify-between">

        <div class="flex items-center justify-between text-sm text-muted mb-2">

          <span class="font-bold text-main">年休等・出張</span>

          <i data-lucide="calendar-x-2" class="w-4 h-4 text-danger"></i>

        </div>

        <!-- 区分別人数 (absence.module.js の renderAbsenceCounts が数値を流し込む) -->
        <div class="flex items-center justify-center gap-5 mb-3">
          <div class="flex items-center gap-1.5" title="本日年休等（年休・半日休・早退・遅刻・欠席）の人数">
            <i data-lucide="bed-double" class="w-4 h-4 text-info shrink-0"></i>
            <span class="text-sm text-soft">年休等</span>
            <span id="dash-absence-leave" class="text-lg font-bold text-info">0名</span>
          </div>
          <div class="flex items-center gap-1.5" title="本日出張（校外・校内研修）の人数">
            <i data-lucide="briefcase" class="w-4 h-4 text-success shrink-0"></i>
            <span class="text-sm text-soft">出張</span>
            <span id="dash-absence-trip" class="text-lg font-bold text-success">0名</span>
          </div>
        </div>

        <button id="dash-btn-absence" class="btn-primary w-full flex items-center justify-center gap-1.5 py-2 px-3 text-sm font-bold"
                title="年休等・出張を記入する">
          <i data-lucide="pen-line" class="w-4 h-4"></i> <span class="pt-0.5">記入する</span>
        </button>
      </div>



      <!-- 未処理タスク・承認サマリー -->

      <div class="card card--framed p-4 flex flex-col justify-between">

        <div class="flex items-center justify-between text-xs text-muted mb-2">

          <span class="font-bold text-main">要対応タスク</span>

          <i data-lucide="check-square" class="w-4 h-4 text-warning"></i>

        </div>

        <div class="space-y-2 text-xs my-1">

          <div class="flex justify-between items-center p-2 rounded bg-surface-strong border border-divider">

            <span class="text-soft">未処理の承認・請求:</span>

            <span class="font-bold text-warning" id="dash-pending-approvals">0件</span>

          </div>

          <div class="flex justify-between items-center p-2 rounded bg-surface-strong border border-divider">

            <span class="text-soft">掲示板 未読連絡:</span>

            <span class="font-bold text-accent" id="dash-unread-bulletins">0件</span>

          </div>

        </div>

        <button id="dash-btn-approval" class="text-[11px] text-warning hover-text-warning-strong font-semibold text-right flex items-center justify-end gap-1 mt-1">

          承認依頼一覧へ <i data-lucide="chevron-right" class="w-3 h-3"></i>

        </button>

      </div>

    </div>



    <!-- 2. 主要グリッドコンテンツ -->

    <div class="dashboard-grid mt-6">

      

      <!-- 左カラム : 重要掲示板 & 教育ニュースサマリー -->

      <div class="dash-col-main space-y-6">

        <!-- 本日の優先・重要連絡 -->

        <div class="card p-5">

          <div class="flex items-center justify-between mb-4">

            <h3 class="font-bold text-sm text-main flex items-center gap-2">

              <i data-lucide="megaphone" class="w-4 h-4 text-accent"></i> 本日の連絡

            </h3>

            <span class="text-sm text-muted">全校教職員対象</span>

          </div>

          <div id="dash-pinned-bulletins" class="dash-news-list">

            <div class="text-sm text-muted py-4 text-center">読み込み中...</div>

          </div>

        </div>



        <!-- 最新教育ニュース速報 統合ウィジェット -->

        <div class="card p-5">

          <div class="flex items-center justify-between mb-4">

            <h3 class="font-bold text-sm text-main flex items-center gap-2">

              <i data-lucide="newspaper" class="w-4 h-4 text-accent"></i> ピックアップ教育ニュース

            </h3>

            <button id="dash-btn-news-more" class="text-xs text-accent hover:underline">すべて見る</button>

          </div>

          <div id="dash-news-summary" class="grid grid-cols-1 md:grid-cols-2 gap-3">

            <div class="text-xs text-muted py-4 text-center col-span-2">ニュースを取得中...</div>

          </div>

        </div>

      </div>



      <!-- 右カラム : 本日の施設予約 & 校内スケジュール -->

      <div class="dash-col-side space-y-6">

        <!-- 本日の施設利用予定 -->

        <div class="card p-5">

          <div class="flex items-center justify-between mb-3">

            <h3 class="font-bold text-sm text-main flex items-center gap-2">

              <i data-lucide="building-2" class="w-4 h-4 text-success"></i> 本日の施設予約

            </h3>

            <button id="dash-btn-facility" class="text-xs text-success hover:underline">予約する</button>

          </div>

          <div id="dash-today-facilities" class="space-y-2 text-xs">

            <div class="text-muted py-2 text-center">読み込み中...</div>

          </div>

        </div>



        <!-- 本日の校内スケジュール -->

        <div class="card p-5">

          <div class="flex items-center justify-between mb-3">

            <h3 class="font-bold text-sm text-main flex items-center gap-2">

              <i data-lucide="calendar" class="w-4 h-4 text-accent-alt"></i> 今日の校内行事

            </h3>

            <button id="dash-btn-schedule" class="text-xs text-accent-alt hover:underline">カレンダー</button>

          </div>

          <div id="dash-today-schedules" class="space-y-2 text-xs">

            <div class="text-muted py-2 text-center">本日の行事は登録されていません</div>

          </div>

        </div>

      </div>

    </div>

  `;



  bindDashboardEvents();



  if (state.currentUser || state.authToken) {

    loadDashboardData();

    fetchWeatherData();

  }

  // 1分ごとに挨拶文を再評価 (時刻帯・季節の変化を反映)

  setInterval(() => {

    renderDashGreeting();

    refreshLucideIcons();

  }, 60 * 1000);

}



/**

 * ボタンクリック等のイベントバインディング

 */

function bindDashboardEvents() {

  document.getElementById('dash-btn-bulletin')?.addEventListener('click', () => switchTab('bulletin'));

  document.getElementById('dash-btn-chat')?.addEventListener('click', () => switchTab('chat'));

  // 年休等・出張の記入ボタン (dash-btn-absence) は absence.module.js でバインド

  document.getElementById('dash-btn-approval')?.addEventListener('click', () => switchTab('approval'));

  document.getElementById('dash-btn-news-more')?.addEventListener('click', () => switchTab('news'));

  document.getElementById('dash-btn-facility')?.addEventListener('click', () => switchTab('facility'));

  document.getElementById('dash-btn-schedule')?.addEventListener('click', () => switchTab('schedule'));

}



/**

 * ダッシュボード表示用データの取得と描画

 */

export async function loadDashboardData() {

  // ユーザー名表示更新

  const userEl = document.getElementById('dash-user-name');

  if (userEl && state.currentUser) {

    userEl.textContent = `${state.currentUser.name || state.currentUser.id} 先生`;

  }

  // 時刻と季節に合わせた挨拶を再生成 (深夜・朝・夕方、季節ごとの状況案内)

  renderDashGreeting();



  // 1. 重要掲示の取得

  try {

    const res = await apiGet('/bulletins', { limit: 100 });

    const bulletins = res.bulletins || (Array.isArray(res) ? res : []);

    const listEl = document.getElementById('dash-pinned-bulletins');

    // 対象日（掲示期間 display_start_date〜display_end_date）が今日の記事のみ
    const today = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });
    const todays = bulletins.filter((b) => {
      const start = b.display_start_date || b.displayStart || b.start_date || b.startDate;
      const end = b.display_end_date || b.displayEnd || b.end_date || b.endDate;
      if (start && end) return start <= today && today <= end;
      if (start) return start === today;
      if (end) return end === today;
      return false;
    });

    if (listEl && todays.length > 0) {

      listEl.innerHTML = todays.map((b) => {

        const author = {
          name: b.authorName || b.author_name || '教員',
          avatarUrl: b.authorAvatar || b.author_avatar || null,
        };

        return `
          <div class="dash-news-item">
            <h4 class="dash-news-title">${escapeHTML(b.title || '')}</h4>
            <div class="dash-news-author">
              ${userAvatarHtml({ ...author, size: 'xs' })}
              <span class="dash-news-author-name">${escapeHTML(author.name)} 教員</span>
            </div>
            <p class="dash-news-body">${escapeHTML(b.content || '')}</p>
          </div>
        `;

      }).join('');

    } else if (listEl) {

      listEl.innerHTML = '<p class="text-sm text-muted text-center py-2">本日の連絡はありません。</p>';

    }

  } catch (e) {

    const listEl = document.getElementById('dash-pinned-bulletins');

    if (listEl) {

      listEl.innerHTML = `

        <div class="p-3 rounded-lg bg-surface-strong border border-divider">

          <div class="flex items-center justify-between text-[11px] mb-1">

            <span class="badge badge-warning">指示・依頼</span>

            <span class="text-muted font-mono">08:30 (教務部)</span>

          </div>

          <h4 class="font-bold text-xs text-main mb-1">【重要】中間考査問題の提出期限について</h4>

          <p class="text-[11px] text-muted">各教科担当の先生方は、本日17時までに教務システムへアップロードをお願いします。</p>

        </div>

      `;

    }

  }



  // ★ 2. 本日の施設予約データの取得と描画 (追加部分)

  const todayStr = new Date().toISOString().split('T')[0];

  const facEl = document.getElementById('dash-today-facilities');

  if (facEl) {

    try {

      const res = await apiGet('/facilities/daily-overview', { date: todayStr });

      const rawList = res.facilitiesOverview || res.overview || res.reservations || res.data || (Array.isArray(res) ? res : []);



      if (rawList && rawList.length > 0) {

        facEl.innerHTML = rawList.map(r => {

          const facilityName = r.facility_name || r.facilityName || r.name || '施設';

          const title = r.title || r.purpose || '利用';

          const userName = r.user_name || r.userName || '教員';

          const avatarUrl = r.avatar_url || r.avatarUrl || null;



          let timeRange = '';

          if (r.start_time || r.startTime) {

            const sTime = (r.start_time || r.startTime).split(' ')[1] || r.start_time;

            const eTime = (r.end_time || r.endTime).split(' ')[1] || r.end_time;

            timeRange = `${sTime.substring(0, 5)} - ${eTime.substring(0, 5)}`;

          }



          return `

            <div class="p-2.5 rounded-lg bg-surface-strong border border-divider flex items-center justify-between">

              <div class="overflow-hidden pr-2">

                <div class="flex items-center gap-1.5 mb-0.5">

                  <span class="px-1.5 py-0.5 text-[9px] font-bold rounded bg-success-inset text-success border border-success-soft">

                    ${escapeHTML(facilityName)}

                  </span>

                  <span class="font-bold text-main text-xs truncate">${escapeHTML(title)}</span>

                </div>

                <div class="text-[10px] text-muted font-mono">${timeRange}</div>

              </div>

              <div class="flex items-center gap-1.5 flex-shrink-0">
                ${userAvatarHtml({ name: userName, avatarUrl, size: 'xs' })}
                <span class="text-[10px] text-soft font-bold">${escapeHTML(userName)}</span>
              </div>

            </div>

          `;

        }).join('');

      } else {

        facEl.innerHTML = '<div class="text-muted py-2 text-center text-xs">本日の施設予約はありません</div>';

      }

    } catch (e) {

      facEl.innerHTML = '<div class="text-muted py-2 text-center text-xs">予約データの取得に失敗しました</div>';

    }

  }



  // 3. 要対応タスク数（未処理承認・未読掲示）の更新

  // 年休等・出張サマリー (absence.module.js) を読み込み人数表示

  await loadAbsenceSummary();

  const pendingApprovals = document.getElementById('dash-pending-approvals');

  const unreadBulletins = document.getElementById('dash-unread-bulletins');



  // 未処理の承認申請 (PENDING) 件数を実データから取得
  if (pendingApprovals) {
    try {
      const approvalRes = await apiGet('/approvals', { status: 'PENDING' });
      const approvalList = approvalRes.approvals || (Array.isArray(approvalRes) ? approvalRes : []);
      const pendingCount = approvalList.filter((a) => (a.status || 'PENDING') === 'PENDING').length;
      pendingApprovals.textContent = `${pendingCount}件`;
    } catch (e) {
      console.warn('[Dashboard] 未処理承認数の取得に失敗:', e.message);
      pendingApprovals.textContent = '--';
    }
  }

  if (unreadBulletins) unreadBulletins.textContent = `${state.unreadCounts?.bulletin || 0}件`;



  refreshLucideIcons();

}



/**

 * ヘッダー用お天気データの取得

 * ★ モーダル表示のちらつき対策: キャッシュを保持し、変化があった場合のみ再描画する

 */

// モーダル/ウィジェット用の天気キャッシュ (取得成功時のみ保持)

let cachedWeatherObj = null;

let lastForecastHtml = null;

let lastWidgetHtml = null;

/**

 * 週間予報グリッドを描画する (列数を実データ数に合わせ、レイアウト崩れとちらつきを防止)

 * @param {Object} weatherObj

 * @param {boolean} force - 変化がなくても再描画する

 */

function renderWeatherGrid(weatherObj, force = false) {

  const container = document.getElementById('weather-modal-forecasts');

  if (!container) return;

  const forecasts = Array.isArray(weatherObj && weatherObj.forecasts) ? weatherObj.forecasts : [];

  const cols = Math.max(1, Math.min(7, forecasts.length));

  // 列数を実データ数に合わせる (固定 7列だと 2件時にカードが引き伸ばされ表示が崩れる)

  container.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

  if (forecasts.length === 0) {

    const emptyHtml = `<div class="col-span-full text-center py-6 text-muted text-xs">週間予報データがありません。</div>`;

    if (lastForecastHtml === emptyHtml && !force) return;

    lastForecastHtml = emptyHtml;

    container.innerHTML = emptyHtml;

    return;

  }

  const html = forecasts.map(f => `

    <div class="bg-surface px-1.5 py-2.5 rounded-xl border border-main text-center flex flex-col justify-between h-full min-h-[128px]">

      <div>

        <div class="h-4 mb-0.5 flex items-center justify-center">

          ${f.isToday ? '<span class="px-1 py-0.5 rounded text-[8px] bg-warning-soft text-warning-strong font-bold leading-none">今日</span>' : ''}

        </div>

        <div class="text-[10px] font-bold text-accent-strong mb-1">${escapeHTML(f.dateLabel || f.rawDate || f.date || '')}</div>

        <div class="my-1 flex justify-center"><i data-lucide="${f.icon || 'cloud-sun'}" class="w-4 h-4 text-warning"></i></div>

        <div class="text-[10px] font-bold text-main mb-1 leading-tight min-h-[28px] flex items-center justify-center px-0.5">${escapeHTML(f.weather || '')}</div>

        <div class="text-[9px] text-muted mb-1">降水: <span class="text-info font-semibold">${escapeHTML(f.pop || '--')}</span></div>

      </div>

      <div class="text-[9px] text-soft space-y-0.5 pt-1 border-t border-main">

        <div>高: <span class="text-danger font-bold">${f.tempMax != null ? f.tempMax + '℃' : '--'}</span></div>

        <div>低: <span class="text-info font-bold">${f.tempMin != null ? f.tempMin + '℃' : '--'}</span></div>

      </div>

    </div>

  `).join('');

  // ★ 内容が変化しない限り innerHTML を書き換えない → ちらつき・レイアウトジャンプを防止

  if (lastForecastHtml === html && !force) return;

  lastForecastHtml = html;

  container.innerHTML = html;

  refreshLucideIcons();

}

/**

 * 初回のみスケルトン表示 (キャッシュ済みなら既存内容維持でちらつき防止)

 */

function showWeatherGridSkeleton() {

  const container = document.getElementById('weather-modal-forecasts');

  if (!container) return;

  if (cachedWeatherObj) {

    renderWeatherGrid(cachedWeatherObj, true);

    return;

  }

  const cols = 7;

  container.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;

  const skeleton = Array.from({ length: cols }, () =>

    `<div class="bg-surface rounded-xl border border-main min-h-[128px] shimmer-loading"></div>`

  ).join('');

  lastForecastHtml = skeleton;

  container.innerHTML = skeleton;

}

/**

 * ヘッダー天気ウィジェットを描画 (内容が変わったときだけ書き換え)

 */

function renderWeatherWidget(widget, weatherObj) {

  let weatherText = '';

  let tempText = '';

  let iconName = 'cloud-sun';

  if (weatherObj && typeof weatherObj === 'object' && Array.isArray(weatherObj.forecasts) && weatherObj.forecasts.length > 0) {

    const f = weatherObj.forecasts[0];

    weatherText = f.weather || f.weatherText || '';

    tempText = f.tempMax != null ? `(${f.tempMax}℃)` : (f.tempMaxMin ? `(${f.tempMax}℃/${f.tempMin}℃)` : '');

    iconName = f.icon && String(f.icon).length > 2 ? f.icon : 'cloud-sun';

  }

  const html = weatherText

    ? `<i data-lucide="${iconName}" class="w-4 h-4 text-warning"></i> ${escapeHTML(weatherText)} ${escapeHTML(tempText)}`

    : `<i data-lucide="cloud" class="w-4 h-4 text-muted"></i> 天気不明 (--℃)`;

  if (lastWidgetHtml === html) return;

  lastWidgetHtml = html;

  widget.innerHTML = html;

  refreshLucideIcons();

}


export async function fetchWeatherData() {

  const widget = document.getElementById('weather-widget');

  if (!widget) return;



  async function loadWeatherModalData(forceRefresh = false) {

    const container = document.getElementById('weather-modal-forecasts');

    // ★ キャッシュがあれば即表示 (ローディング書き換えによるちらつきを防止)

    if (container) showWeatherGridSkeleton();

    try {

      const endpoint = forceRefresh ? '/news/weather?refresh=true' : '/news/weather';

      const data = await apiGet(endpoint);

      const weatherObj = data && data.weather;

      if (weatherObj) {

        // 更新日時のセット

        const updatedAtStr = weatherObj.updatedAt ? new Date(weatherObj.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '--:--';

        const weatherUpdatedEl = document.getElementById('weather-updated-at');

        if (weatherUpdatedEl) weatherUpdatedEl.textContent = `更新: ${updatedAtStr}`;



        // 警報情報

        const warningEl = document.getElementById('warning-content-text');

        const warningUpdatedEl = document.getElementById('warning-updated-at');

        if (warningEl) {

          warningEl.textContent = weatherObj.warning ? weatherObj.warning.text : '現在、兵庫県・西宮市周辺に特段の警報・注意報は発令されていません。';

        }

        if (warningUpdatedEl) {

          const wTime = weatherObj.warning?.updatedAt ? new Date(weatherObj.warning.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : updatedAtStr;

          warningUpdatedEl.textContent = `更新: ${wTime}`;

        }



        // 災害情報

        const disasterEl = document.getElementById('disaster-content-text');

        const disasterUpdatedEl = document.getElementById('disaster-updated-at');

        if (disasterEl) {

          disasterEl.textContent = weatherObj.disaster ? weatherObj.disaster.text : '現在、近畿地方に影響を与える台風や大規模地震の発生情報はありません。';

        }

        if (disasterUpdatedEl) {

          const dTime = weatherObj.disaster?.updatedAt ? new Date(weatherObj.disaster.updatedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : updatedAtStr;

          disasterUpdatedEl.textContent = `更新: ${dTime}`;

        }



        // 週間予報 (キャッシュ更新して差分描画)

        cachedWeatherObj = weatherObj;

        renderWeatherGrid(weatherObj);

        if (forceRefresh) {

          showToast('気象情報を最新に更新しました', 'success');

        }

      }

    } catch (err) {

      if (container) {

        container.innerHTML = `<div class="col-span-7 text-center py-6 text-danger text-xs">気象データの取得に失敗しました。</div>`;

      }

      if (forceRefresh) {

        showToast('気象情報の更新に失敗しました', 'error');

      }

    }

  }



  // クリックで詳細モーダルを開くイベントを設定

  if (!widget.dataset.boundClick) {

    widget.dataset.boundClick = 'true';

    widget.style.cursor = 'pointer';

    widget.title = 'クリックして西宮・阪神地域の週間予報・防災情報を見る';

    widget.addEventListener('click', () => {

      openModal('weather-detail-modal');

      loadWeatherModalData(false);

    });

  }



   try {

     const data = await apiGet('/news/weather');

     const weatherObj = data && data.weather;

     if (weatherObj) cachedWeatherObj = weatherObj;

     renderWeatherWidget(widget, weatherObj);

   } catch (e) {

     const fallbackHtml = `<i data-lucide="cloud" class="w-4 h-4 text-muted"></i> 天気不明 (--℃)`;

     if (lastWidgetHtml === fallbackHtml) return;

     lastWidgetHtml = fallbackHtml;

     widget.innerHTML = fallbackHtml;

     refreshLucideIcons();

   }

}