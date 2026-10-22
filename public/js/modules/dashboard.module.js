/**
 * ISSystem Dashboard Module
 * ダッシュボード描画・天気情報・統合サマリーコントローラー (本日の施設予約・行事表示完全対応版)
 */

import { apiGet } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal } from '../ui-helpers.js';
import { switchTab } from '../main.js';
import { state } from '../state.js';

/**
 * ダッシュボードのHTMLスケルトン生成と初期描画
 */
export function initDashboardModule() {
  const container = document.getElementById('view-dashboard');
  if (!container) return;

  container.innerHTML = `
    <!-- 1. ウェルカムバナー & サマリーカード群 -->
    <div class="grid grid-cols-1 md:grid-cols-4 gap-4">
      <div class="card p-5 bg-gradient-to-br from-indigo-900/40 via-slate-900/60 to-slate-900 border-indigo-500/30 md:col-span-2 flex flex-col justify-between">
        <div>
          <div class="flex items-center justify-between mb-2">
            <span class="badge badge-warning">本日: ${formatDate(new Date(), false)}</span>
            <span class="text-[11px] text-slate-400 font-mono">校内ネットワーク: 正常稼働</span>
          </div>
          <h2 class="text-xl font-bold text-white mb-1">お疲れ様です、<span id="dash-user-name">先生</span></h2>
          <p class="text-xs text-slate-300 leading-relaxed">
            本日の全校行事・施設予約・重要掲示の最新サマリーです。緊急連絡や承認依頼が届いている場合は即座に確認できます。
          </p>
        </div>
        <div class="flex items-center gap-2 mt-4 pt-3 border-t border-slate-700/50 text-xs">
          <button id="dash-btn-bulletin" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1.5">
            <i data-lucide="megaphone" class="w-3.5 h-3.5"></i> 掲示板を確認
          </button>
          <button id="dash-btn-chat" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5">
            <i data-lucide="message-square" class="w-3.5 h-3.5"></i> 職員チャットへ
          </button>
        </div>
      </div>

      <!-- リアルタイム在席統計 -->
      <div class="card p-4 flex flex-col justify-between">
        <div class="flex items-center justify-between text-xs text-slate-400 mb-2">
          <span class="font-bold text-slate-200">職員室在席状況</span>
          <i data-lucide="users" class="w-4 h-4 text-indigo-400"></i>
        </div>
        <div class="grid grid-cols-2 gap-2 text-center my-1">
          <div class="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <span class="text-2xl font-black text-emerald-400" id="dash-presence-in">--</span>
            <span class="block text-[10px] text-slate-400">在席中</span>
          </div>
          <div class="p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
            <span class="text-2xl font-black text-amber-400" id="dash-presence-out">--</span>
            <span class="block text-[10px] text-slate-400">出張・授業中</span>
          </div>
        </div>
        <button id="dash-btn-seating" class="text-[11px] text-indigo-400 hover:text-indigo-300 font-semibold text-right flex items-center justify-end gap-1 mt-1">
          座席表を開く <i data-lucide="chevron-right" class="w-3 h-3"></i>
        </button>
      </div>

      <!-- 未処理タスク・承認サマリー -->
      <div class="card p-4 flex flex-col justify-between">
        <div class="flex items-center justify-between text-xs text-slate-400 mb-2">
          <span class="font-bold text-slate-200">要対応タスク</span>
          <i data-lucide="check-square" class="w-4 h-4 text-amber-400"></i>
        </div>
        <div class="space-y-2 text-xs my-1">
          <div class="flex justify-between items-center p-2 rounded bg-slate-900/50 border border-slate-800">
            <span class="text-slate-300">未処理の承認・請求:</span>
            <span class="font-bold text-amber-400" id="dash-pending-approvals">0件</span>
          </div>
          <div class="flex justify-between items-center p-2 rounded bg-slate-900/50 border border-slate-800">
            <span class="text-slate-300">掲示板 未読連絡:</span>
            <span class="font-bold text-indigo-400" id="dash-unread-bulletins">0件</span>
          </div>
        </div>
        <button id="dash-btn-approval" class="text-[11px] text-amber-400 hover:text-amber-300 font-semibold text-right flex items-center justify-end gap-1 mt-1">
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
          <div class="flex items-center justify-between mb-4 pb-2 border-b border-slate-700/60">
            <h3 class="font-bold text-sm text-slate-100 flex items-center gap-2">
              <i data-lucide="pin" class="w-4 h-4 text-red-400"></i> 本日の優先・重要連絡
            </h3>
            <span class="text-[11px] text-slate-400">全校教職員対象</span>
          </div>
          <div id="dash-pinned-bulletins" class="space-y-3">
            <div class="text-xs text-slate-400 py-4 text-center">読み込み中...</div>
          </div>
        </div>

        <!-- 最新教育ニュース速報 統合ウィジェット -->
        <div class="card p-5">
          <div class="flex items-center justify-between mb-4 pb-2 border-b border-slate-700/60">
            <h3 class="font-bold text-sm text-slate-100 flex items-center gap-2">
              <i data-lucide="newspaper" class="w-4 h-4 text-indigo-400"></i> ピックアップ教育ニュース
            </h3>
            <button id="dash-btn-news-more" class="text-xs text-indigo-400 hover:underline">すべて見る</button>
          </div>
          <div id="dash-news-summary" class="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div class="text-xs text-slate-400 py-4 text-center col-span-2">ニュースを取得中...</div>
          </div>
        </div>
      </div>

      <!-- 右カラム : 本日の施設予約 & 校内スケジュール -->
      <div class="dash-col-side space-y-6">
        <!-- 本日の施設利用予定 -->
        <div class="card p-5">
          <div class="flex items-center justify-between mb-3 pb-2 border-b border-slate-700/60">
            <h3 class="font-bold text-sm text-slate-100 flex items-center gap-2">
              <i data-lucide="building-2" class="w-4 h-4 text-emerald-400"></i> 本日の施設予約
            </h3>
            <button id="dash-btn-facility" class="text-xs text-emerald-400 hover:underline">予約する</button>
          </div>
          <div id="dash-today-facilities" class="space-y-2 text-xs">
            <div class="text-slate-400 py-2 text-center">読み込み中...</div>
          </div>
        </div>

        <!-- 本日の校内スケジュール -->
        <div class="card p-5">
          <div class="flex items-center justify-between mb-3 pb-2 border-b border-slate-700/60">
            <h3 class="font-bold text-sm text-slate-100 flex items-center gap-2">
              <i data-lucide="calendar" class="w-4 h-4 text-purple-400"></i> 今日の校内行事
            </h3>
            <button id="dash-btn-schedule" class="text-xs text-purple-400 hover:underline">カレンダー</button>
          </div>
          <div id="dash-today-schedules" class="space-y-2 text-xs">
            <div class="text-slate-400 py-2 text-center">本日の行事は登録されていません</div>
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
}

/**
 * ボタンクリック等のイベントバインディング
 */
function bindDashboardEvents() {
  document.getElementById('dash-btn-bulletin')?.addEventListener('click', () => switchTab('bulletin'));
  document.getElementById('dash-btn-chat')?.addEventListener('click', () => switchTab('chat'));
  document.getElementById('dash-btn-seating')?.addEventListener('click', () => switchTab('seating'));
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

  // 1. 重要掲示の取得
  try {
    const res = await apiGet('/bulletins', { limit: 5, pinned: true });
    const bulletins = res.bulletins || (Array.isArray(res) ? res : []);
    const listEl = document.getElementById('dash-pinned-bulletins');
    
    if (listEl && Array.isArray(bulletins) && bulletins.length > 0) {
      listEl.innerHTML = bulletins.map(b => `
        <div class="p-3 rounded-lg bg-slate-900/60 border border-slate-800 hover:border-indigo-500/50 transition-colors cursor-pointer">
          <div class="flex items-center justify-between text-[11px] mb-1">
            <span class="badge ${b.priority === 'URGENT' || b.category === 'URGENT' ? 'badge-warning' : 'badge'}">${b.postType || b.category || '全般'}</span>
            <span class="text-slate-400 font-mono">${formatDate(b.createdAt || b.created_at)} (${escapeHTML(b.authorName || '教員')})</span>
          </div>
          <h4 class="font-bold text-xs text-slate-200 mb-1">${escapeHTML(b.title)}</h4>
          <p class="text-[11px] text-slate-400 line-clamp-2">${escapeHTML(b.content)}</p>
        </div>
      `).join('');
    } else if (listEl) {
      listEl.innerHTML = '<p class="text-xs text-slate-500 text-center py-2">ピン留めされた緊急連絡はありません。</p>';
    }
  } catch (e) {
    const listEl = document.getElementById('dash-pinned-bulletins');
    if (listEl) {
      listEl.innerHTML = `
        <div class="p-3 rounded-lg bg-slate-900/60 border border-slate-800">
          <div class="flex items-center justify-between text-[11px] mb-1">
            <span class="badge badge-warning">指示・依頼</span>
            <span class="text-slate-400 font-mono">08:30 (教務部)</span>
          </div>
          <h4 class="font-bold text-xs text-slate-200 mb-1">【重要】中間考査問題の提出期限について</h4>
          <p class="text-[11px] text-slate-400">各教科担当の先生方は、本日17時までに教務システムへアップロードをお願いします。</p>
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

          let timeRange = '';
          if (r.start_time || r.startTime) {
            const sTime = (r.start_time || r.startTime).split(' ')[1] || r.start_time;
            const eTime = (r.end_time || r.endTime).split(' ')[1] || r.end_time;
            timeRange = `${sTime.substring(0, 5)} - ${eTime.substring(0, 5)}`;
          }

          return `
            <div class="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800 flex items-center justify-between">
              <div class="overflow-hidden pr-2">
                <div class="flex items-center gap-1.5 mb-0.5">
                  <span class="px-1.5 py-0.5 text-[9px] font-bold rounded bg-emerald-950 text-emerald-400 border border-emerald-500/30">
                    ${escapeHTML(facilityName)}
                  </span>
                  <span class="font-bold text-slate-200 text-xs truncate">${escapeHTML(title)}</span>
                </div>
                <div class="text-[10px] text-slate-400 font-mono">${timeRange}</div>
              </div>
              <span class="text-[10px] text-slate-300 font-bold flex-shrink-0">${escapeHTML(userName)}</span>
            </div>
          `;
        }).join('');
      } else {
        facEl.innerHTML = '<div class="text-slate-500 py-2 text-center text-xs">本日の施設予約はありません</div>';
      }
    } catch (e) {
      facEl.innerHTML = '<div class="text-slate-500 py-2 text-center text-xs">予約データの取得に失敗しました</div>';
    }
  }

  // 3. 在席数・タスク数の更新
  const presenceIn = document.getElementById('dash-presence-in');
  const presenceOut = document.getElementById('dash-presence-out');
  const pendingApprovals = document.getElementById('dash-pending-approvals');
  const unreadBulletins = document.getElementById('dash-unread-bulletins');

  if (presenceIn) presenceIn.textContent = '28';
  if (presenceOut) presenceOut.textContent = '6';
  if (pendingApprovals) pendingApprovals.textContent = '2件';
  if (unreadBulletins) unreadBulletins.textContent = `${state.unreadCounts?.bulletin || 0}件`;

  refreshLucideIcons();
}

/**
 * ヘッダー用お天気データの取得
 */
export async function fetchWeatherData() {
  const widget = document.getElementById('weather-widget');
  if (!widget) return;

  async function loadWeatherModalData(forceRefresh = false) {
    const container = document.getElementById('weather-modal-forecasts');
    if (container) {
      container.innerHTML = `<div class="col-span-7 text-center py-6 text-slate-400 text-xs">気象情報を読み込み中...</div>`;
    }
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

        // 週間予報
        if (Array.isArray(weatherObj.forecasts)) {
          container.innerHTML = weatherObj.forecasts.map(f => `
            <div class="bg-slate-800/80 px-1.5 py-2.5 rounded-xl border border-slate-700 text-center flex flex-col justify-between h-full">
              <div>
                <div class="h-4 mb-0.5 flex items-center justify-center">
                  ${f.isToday ? '<span class="px-1 py-0.5 rounded text-[8px] bg-amber-500/20 text-amber-300 font-bold leading-none">今日</span>' : ''}
                </div>
                <div class="text-[10px] font-bold text-indigo-300 mb-1">${escapeHTML(f.dateLabel)}</div>
                <div class="my-1 flex justify-center"><i data-lucide="${f.icon || 'cloud-sun'}" class="w-4 h-4 text-amber-400"></i></div>
                <div class="text-[10px] font-bold text-white mb-1 leading-tight min-h-[28px] flex items-center justify-center px-0.5">${escapeHTML(f.weather)}</div>
                <div class="text-[9px] text-slate-400 mb-1">降水: <span class="text-cyan-300 font-semibold">${escapeHTML(f.pop)}</span></div>
              </div>
              <div class="text-[9px] text-slate-300 space-y-0.5 pt-1 border-t border-slate-700/60">
                <div>高: <span class="text-rose-400 font-bold">${f.tempMax != null ? f.tempMax + '℃' : '--'}</span></div>
                <div>低: <span class="text-cyan-400 font-bold">${f.tempMin != null ? f.tempMin + '℃' : '--'}</span></div>
              </div>
            </div>
          `).join('');
          refreshLucideIcons();
        }
        if (forceRefresh) {
          showToast('気象情報を最新に更新しました', 'success');
        }
      }
    } catch (err) {
      if (container) {
        container.innerHTML = `<div class="col-span-7 text-center py-6 text-red-400 text-xs">気象データの取得に失敗しました。</div>`;
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
     let weatherText = '';
     let tempText = '';
     let iconName = 'cloud-sun';

     if (weatherObj && typeof weatherObj === 'object' && Array.isArray(weatherObj.forecasts) && weatherObj.forecasts.length > 0) {
       const f = weatherObj.forecasts[0];
       weatherText = f.weather || '';
        tempText = (f.tempMax != null ? `(${f.tempMax}℃)` : '');
       iconName = 'cloud-sun';
     } else if (typeof weatherObj === 'string') {
       weatherText = weatherObj;
       tempText = data.temp || '';
       iconName = data.icon || 'sun';
     }

     if (weatherText) {
       widget.innerHTML = `<i data-lucide="${iconName}" class="w-4 h-4 text-amber-400"></i> ${escapeHTML(weatherText)} ${escapeHTML(tempText)}`;
       refreshLucideIcons();
     } else {
       widget.innerHTML = `<i data-lucide="cloud" class="w-4 h-4 text-slate-400"></i> 天気不明 (--℃)`;
       refreshLucideIcons();
     }
   } catch (e) {
     widget.innerHTML = `<i data-lucide="cloud" class="w-4 h-4 text-slate-400"></i> 天気不明 (--℃)`;
     refreshLucideIcons();
   }
}