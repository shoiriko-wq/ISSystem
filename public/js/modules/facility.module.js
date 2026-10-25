/**
 * ISSystem Facility Module
 * 施設予約タイムライン・一括予約フォームコントローラー (RAWレスポンス深層展開 & 10分単位完全描画版)
 */

import { apiGet, apiPost, apiDelete } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast } from '../ui-helpers.js';
import { state } from '../state.js';

/**
 * JST 基準の今日 (YYYY-MM-DD) を返す
 */
function todayJst() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

let selectedDate = todayJst();

// 施設マスター初期定義
let facilities = [
  { id: '1', name: '第一会議室', type: 'MEETING' },
  { id: '2', name: '第二会議室', type: 'MEETING' },
  { id: '3', name: '体育館', type: 'GYM' },
  { id: '4', name: 'プロジェクターA', type: 'SPECIAL' },
  { id: '5', name: '校外研修用マイクロバス', type: 'SPECIAL' }
];

// ★ 時限（period）概念を廃止し、8:00〜18:00 の連続時間帯として扱う
const TIME_START_MIN = 8 * 60;   // 08:00
const TIME_END_MIN = 18 * 60;    // 18:00
// ★ 10分刻みルールは撤廃。クリックした空き帯域は 1時間ブロックとして初期化する
const SLOT_MIN = 60;
const TIME_SPAN = TIME_END_MIN - TIME_START_MIN;

/**
 * 分を 'HH:MM' 表記へ変換する
 * @param {number} totalMin
 */
function formatMinutesToTime(totalMin) {
  const h = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const m = String(totalMin % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * 'HH:MM' 表記を分数へ変換する
 * @param {string} hhmm
 */
function parseTimeToMinutes(hhmm) {
  const match = String(hhmm || '').match(/(\d{1,2}):(\d{2})/);
  if (!match) return -1;
  return parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
}

/**
 * タイムライン上の位置 (百分率) を算出する
 * @param {number} minutes
 */
function timeToPercent(minutes) {
  const clamped = Math.min(TIME_END_MIN, Math.max(TIME_START_MIN, minutes));
  return ((clamped - TIME_START_MIN) / TIME_SPAN) * 100;
}

// 時間スケールヘッダーセル (1時間単位)
const TIME_START_H = Math.floor(TIME_START_MIN / 60);
const TIME_END_H = Math.floor(TIME_END_MIN / 60);
const timeScaleCells = Array.from({ length: TIME_END_H - TIME_START_H }, (_, i) => {
  const hour = TIME_START_H + i;
  return `<div class="flex-1 border-l border-slate-800/60 px-1 py-2 text-left">${String(hour).padStart(2, '0')}:00</div>`;
}).join('');

let reservationsCache = [];

/**
 * モジュールの初期化
 */
export function initFacilityModule() {
  const container = document.getElementById('view-facility');
  if (!container) return;

  container.innerHTML = `
    <!-- ヘッダー・日付コントロール -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
      <div>
        <h2 class="text-lg font-bold text-white flex items-center gap-2">
          <i data-lucide="building-2" class="w-5 h-5 text-emerald-400"></i> 特別教室・施設予約タイムライン
        </h2>
        <p class="text-xs text-slate-400">体育館・PC教室・会議室等の予約状況確認および新規取得を行えます。</p>
      </div>

      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <div class="flex items-center bg-slate-800 rounded-lg p-1 border border-slate-700 text-xs">
          <button id="facility-prev-day" class="p-1.5 hover:bg-slate-700 rounded text-slate-300">
            <i data-lucide="chevron-left" class="w-4 h-4"></i>
          </button>
          <input type="date" id="facility-date-picker" class="bg-transparent text-slate-100 font-bold px-2 py-0.5 focus:outline-none text-xs" value="${selectedDate}">
          <button id="facility-next-day" class="p-1.5 hover:bg-slate-700 rounded text-slate-300">
            <i data-lucide="chevron-right" class="w-4 h-4"></i>
          </button>
        </div>

        <button id="facility-btn-today" class="btn-secondary py-1.5 px-3 text-xs">本日</button>
        <button id="facility-btn-create" class="btn-primary py-1.5 px-3 text-xs font-bold flex items-center gap-1.5">
          <i data-lucide="plus" class="w-4 h-4"></i> 新規予約
        </button>
      </div>
    </div>

    <!-- タイムラインマトリクス表示エリア (時間帯バンド表示) -->
    <div class="card p-4 overflow-hidden mt-4">
      <div class="flex items-center justify-between mb-3 text-xs text-slate-400">
        <span class="flex items-center gap-1.5"><i data-lucide="clock" class="w-3.5 h-3.5 text-emerald-400"></i> ${TIME_START_H}時〜${TIME_END_H}時の連続タイムライン (時限・10分刻み区切りなし)</span>
        <span class="text-slate-500">バンドをクリック → 詳細 / キャンセル、空き帯域をクリック → 予約作成</span>
      </div>
      <div class="timeline-scroll-container overflow-x-auto">
        <div class="min-w-[880px]">
          <!-- 時間スケールヘッダー -->
          <div class="flex border-b border-slate-800 bg-slate-900/80 text-[10px] text-slate-500 font-mono">
            <div class="w-40 shrink-0 p-2 font-bold text-slate-300 font-sans">施設名称</div>
            <div class="flex-1 flex">
              ${timeScaleCells}
            </div>
          </div>
          <div id="facility-matrix-body" class="divide-y divide-slate-800/60">
            <div class="py-12 text-center text-slate-500 text-xs">予約データを読み込み中...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- モーダルダイアログ -->
    <div id="facility-modal" class="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center hidden p-4">
      <div class="bg-slate-900 border border-slate-800 rounded-xl max-w-md w-full p-6 text-slate-100 shadow-2xl relative">
        <div class="flex items-center justify-between pb-4 mb-4 border-b border-slate-800">
          <h3 class="text-base font-bold flex items-center gap-2">
            <i data-lucide="calendar-plus" class="w-5 h-5 text-emerald-400"></i> 施設・備品 新規予約
          </h3>
          <button id="facility-modal-close" class="text-slate-400 hover:text-white p-1">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>

        <form id="facility-form" class="space-y-4">
          <div>
            <label class="block text-xs font-bold text-slate-300 mb-1">対象施設・備品 <span class="text-rose-400">*</span></label>
            <select id="facility-select" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs focus:outline-none focus:border-emerald-500 text-white" required>
            </select>
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-300 mb-1">利用日 <span class="text-rose-400">*</span></label>
            <input type="date" id="facility-date-input" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs focus:outline-none focus:border-emerald-500 text-white" value="${selectedDate}" required>
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-300 mb-1">利用開始・終了時刻 <span class="text-rose-400">*</span></label>
            <p class="text-[10px] text-slate-500 mb-2">時限・期間の区切りや10分刻みの制約はなく、8:00〜18:00 の任意の時刻 (分単位) で予約できます。</p>
            <div class="grid grid-cols-2 gap-3 mb-2">
              <div>
                <span class="text-[10px] text-slate-400 block mb-0.5">開始時刻</span>
                <input type="time" id="facility-start-time" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-emerald-500" value="08:50" required>
              </div>
              <div>
                <span class="text-[10px] text-slate-400 block mb-0.5">終了時刻</span>
                <input type="time" id="facility-end-time" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-emerald-500" value="09:40" required>
              </div>
            </div>

            <div class="flex flex-wrap gap-1 items-center">
              <span class="text-[10px] text-slate-500 mr-1">時短:</span>
              <button type="button" class="btn-duration text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded" data-minutes="30">30分</button>
              <button type="button" class="btn-duration text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded" data-minutes="60">1時間</button>
              <button type="button" class="btn-duration text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded" data-minutes="90">1時間30分</button>
              <button type="button" class="btn-duration text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded" data-minutes="120">2時間</button>
              <button type="button" class="btn-daylight text-[10px] bg-indigo-950 hover:bg-indigo-900 text-indigo-300 border border-indigo-700/60 px-2 py-1 rounded font-bold" data-start="08:00" data-end="18:00">終日 (8:00-18:00)</button>
            </div>
          </div>

          <div>
            <label class="block text-xs font-bold text-slate-300 mb-1">利用目的・件名 <span class="text-rose-400">*</span></label>
            <input type="text" id="facility-purpose-input" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs focus:outline-none focus:border-emerald-500 text-white" placeholder="例: 昼休み委員会集会、教務部定例会議" required>
          </div>

          <div class="flex items-center justify-end gap-2 pt-4 border-t border-slate-800">
            <button type="button" id="facility-btn-cancel" class="btn-secondary py-2 px-4 text-xs">キャンセル</button>
            <button type="submit" class="btn-primary py-2 px-4 text-xs font-bold">予約を確定する</button>
          </div>
        </form>
      </div>
    </div>
  `;

  bindEvents();
  refreshLucideIcons();
  if (state.currentUser && state.authToken) {
    loadReservations();
  }
}

function bindEvents() {
  const picker = document.getElementById('facility-date-picker');
  picker?.addEventListener('change', (e) => {
    selectedDate = e.target.value;
    loadReservations();
  });

  document.getElementById('facility-prev-day')?.addEventListener('click', () => changeDate(-1));
  document.getElementById('facility-next-day')?.addEventListener('click', () => changeDate(1));

  document.getElementById('facility-btn-today')?.addEventListener('click', () => {
    selectedDate = todayJst();
    if (picker) picker.value = selectedDate;
    loadReservations();
  });

  document.getElementById('facility-btn-create')?.addEventListener('click', () => {
    const dateInput = document.getElementById('facility-date-input');
    if (dateInput) dateInput.value = selectedDate;
    openModal('facility-modal');
  });

  // 終了時刻プリセット (開始時刻からの経過分数)
  document.querySelectorAll('.btn-duration').forEach(btn => {
    btn.addEventListener('click', () => {
      const minutes = parseInt(btn.getAttribute('data-minutes'), 10) || 60;
      const startInput = document.getElementById('facility-start-time');
      const endInput = document.getElementById('facility-end-time');
      if (!startInput || !endInput) return;

      const startMin = parseTimeToMinutes(startInput.value);
      if (startMin < 0) return;
      const endMin = Math.min(TIME_END_MIN, startMin + minutes);
      endInput.value = formatMinutesToTime(endMin);
    });
  });

  // 指定時間帯プリセット (終日など)
  document.querySelectorAll('.btn-daylight').forEach(btn => {
    btn.addEventListener('click', () => {
      const start = btn.getAttribute('data-start');
      const end = btn.getAttribute('data-end');
      const startInput = document.getElementById('facility-start-time');
      const endInput = document.getElementById('facility-end-time');

      if (startInput && start) startInput.value = start;
      if (endInput && end) endInput.value = end;
    });
  });


  const closeModalFn = () => closeModal('facility-modal');
  document.getElementById('facility-modal-close')?.addEventListener('click', closeModalFn);
  document.getElementById('facility-btn-cancel')?.addEventListener('click', closeModalFn);

  const form = document.getElementById('facility-form');
  if (form) {
    form.addEventListener('submit', handleCreateReservation);
  }
}

function changeDate(days) {
  // JST の日付キーとして加減算する (UTC ズレ防止)
  const base = new Date(`${selectedDate}T12:00:00+09:00`);
  base.setDate(base.getDate() + days);
  selectedDate = base.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  const picker = document.getElementById('facility-date-picker');
  if (picker) picker.value = selectedDate;
  loadReservations();
}

/**
 * 施設・予約データのネスト解体パース処理
 */
export async function loadReservations() {
  if (!state.currentUser || !state.authToken) return;
  console.log(`[Facility] 日付: ${selectedDate} のロード開始`);

  // 1. 施設マスター取得
  try {
    const facRes = await apiGet('/facilities');
    const facList = (facRes && (facRes.facilities || facRes.data)) || (Array.isArray(facRes) ? facRes : []);
    
    if (facList && facList.length > 0) {
      facilities = facList.map(f => ({
        id: String(f.id),
        name: f.name || '施設',
        type: f.category === 'ROOM' ? 'MEETING' : 'SPECIAL'
      }));
    }
  } catch (err) {
    console.warn('[Facility] 施設マスター取得失敗:', err.message);
  }

  const selectFac = document.getElementById('facility-select');
  if (selectFac) {
    selectFac.innerHTML = facilities.map(f => `<option value="${f.id}">${escapeHTML(f.name)}</option>`).join('');
  }

  // 2. 予約サマリー取得＆深層データ抽出
  try {
    const data = await apiGet('/facilities/daily-overview', { date: selectedDate });
    console.log('[Facility] 生レスポンス:', data);

    let items = [];
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object') {
      items = data.facilitiesOverview || data.overview || data.reservations || data.data || [];
    }

    let extractedList = [];

    // ネストされた予約リストの展開（施設オブジェクト内に入っている場合も抽出）
    items.forEach(item => {
      if (item.reservations && Array.isArray(item.reservations) && item.reservations.length > 0) {
        item.reservations.forEach(sub => {
          extractedList.push({
            ...sub,
            facility_id: sub.facility_id || sub.resource_id || item.facility_id || item.id,
            facility_name: sub.facility_name || item.facility_name || item.name
          });
        });
      } else if (item.start_time || item.startTime || item.title || item.purpose) {
        extractedList.push(item);
      }
    });

    console.log('[Facility] 展開後の予約リスト:', extractedList);

    reservationsCache = extractedList.map(r => {
      const startTimeRaw = r.start_time || r.startTime || '';
      const endTimeRaw = r.end_time || r.endTime || '';

      let startMin = 0;
      let endMin = 0;

      if (startTimeRaw) {
        const match = startTimeRaw.match(/(\d{1,2}):(\d{2})/);
        if (match) startMin = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
      }
      if (endTimeRaw) {
        const match = endTimeRaw.match(/(\d{1,2}):(\d{2})/);
        if (match) endMin = parseInt(match[1], 10) * 60 + parseInt(match[2], 10);
      } else if (startMin > 0) {
        endMin = startMin + 40;
      }

      const timeRangeStr = (startMin > 0 && endMin > 0) ? `${formatMinutesToTime(startMin)} - ${formatMinutesToTime(endMin)}` : '';
      const fId = String(r.resource_id || r.facility_id || r.facilityId || r.resourceId || '');

      return {
        id: String(r.id || Math.random()),
        facilityId: fId,
        facilityName: r.facility_name || r.facilityName || '',
        period: Number(r.period || r.slot || 0),
        startMin,
        endMin,
        timeRangeStr,
        purpose: r.title || r.purpose || '予約あり',
        userId: String(r.user_id || r.userId || ''),
        userName: r.user_name || r.userName || '教員'
      };
    });

    console.log('[Facility] キャッシュ作成完了:', reservationsCache);

  } catch (err) {
    console.warn('[Facility] 予約データ取得例外:', err.message);
  }

  renderMatrix();
}

/**
 * タイムラインマトリクスの描画 (時限ではなく開始〜終了時刻のバンド表示)
 */
function renderMatrix() {
  const tbody = document.getElementById('facility-matrix-body');
  if (!tbody) return;

  // 1時間ごとのグリッド線 (8:00〜18:00)
  const gridLines = Array.from({ length: TIME_END_H - TIME_START_H + 1 }, (_, i) => {
    const pos = timeToPercent(TIME_START_MIN + i * 60);
    return `<div class="absolute top-0 bottom-0 border-l border-slate-800/50 pointer-events-none" style="left:${pos}%"></div>`;
  }).join('');

  tbody.innerHTML = facilities.map(fac => {
    const facRes = reservationsCache.filter(r => {
      const isSameFacility = (
        r.facilityId === fac.id ||
        r.facilityName === fac.name ||
        (r.facilityId && fac.id && (r.facilityId === fac.id || fac.id.includes(r.facilityId) || r.facilityId.includes(fac.id)))
      );
      return isSameFacility;
    });

    const bands = facRes.map(res => {
      const s = res.startMin >= 0 ? res.startMin : TIME_START_MIN;
      const e = res.endMin > s ? res.endMin : s + 30;
      const left = timeToPercent(s);
      const width = Math.max(2, timeToPercent(e) - left);
      return `
        <div class="reservation-chip absolute top-1 bottom-1 rounded-lg px-2 py-1 text-[11px] bg-emerald-950/80 border border-emerald-500/50 hover:border-emerald-400 transition-all cursor-pointer overflow-hidden"
             style="left:${left}%; width:${width}%" data-res-id="${res.id}" title="${escapeHTML(res.purpose)} (${res.timeRangeStr})">
          <div class="font-bold text-emerald-200 truncate leading-tight">${escapeHTML(res.purpose)}</div>
          <div class="text-[10px] text-emerald-400 font-mono flex items-center gap-1 mt-0.5">
            <span>${res.timeRangeStr || '予約中'}</span>
            <span class="text-emerald-300/80 truncate">${escapeHTML(res.userName)}</span>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="flex hover:bg-slate-900/30 transition-colors" data-facility-row="${fac.id}">
        <div class="w-40 shrink-0 p-3 font-bold text-slate-200 bg-slate-900/40 border-r border-slate-800 flex items-center gap-2">
          <i data-lucide="${getFacilityIcon(fac.type)}" class="w-4 h-4 text-emerald-400"></i>
          <span class="truncate">${escapeHTML(fac.name)}</span>
        </div>
        <div class="flex-1 relative h-16 btn-quick-reserve-area cursor-crosshair" data-facility-id="${fac.id}">
          ${gridLines}
          ${bands}
        </div>
      </div>
    `;
  }).join('');

  // バンドクリック → 予約詳細・キャンセル
  tbody.querySelectorAll('[data-res-id]').forEach(chip => {
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      openReservationDetail(chip.getAttribute('data-res-id'));
    });
  });

  // 空き時間帯クリック → クリック位置の時刻から予約作成モーダルを開く
  tbody.querySelectorAll('.btn-quick-reserve-area').forEach(area => {
    area.addEventListener('click', (e) => {
      const rect = area.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      const rawMin = TIME_START_MIN + Math.round(ratio * TIME_SPAN);
      const snapped = Math.round(rawMin / SLOT_MIN) * SLOT_MIN;
      const startClamped = Math.min(TIME_END_MIN - SLOT_MIN, Math.max(TIME_START_MIN, snapped));
      const endClamped = Math.min(TIME_END_MIN, startClamped + SLOT_MIN);

      const selectFac = document.getElementById('facility-select');
      const startInput = document.getElementById('facility-start-time');
      const endInput = document.getElementById('facility-end-time');
      const dateInput = document.getElementById('facility-date-input');

      if (selectFac) selectFac.value = area.getAttribute('data-facility-id');
      if (startInput) startInput.value = formatMinutesToTime(startClamped);
      if (endInput) endInput.value = formatMinutesToTime(endClamped);
      if (dateInput) dateInput.value = selectedDate;

      openModal('facility-modal');
    });
  });

  refreshLucideIcons();
}


function openReservationDetail(resId) {
  const res = reservationsCache.find(r => String(r.id) === String(resId));
  if (!res) return;

  const fac = facilities.find(f => f.id === res.facilityId || f.name === res.facilityName);

  const confirmDelete = confirm(`【施設予約詳細】\n施設: ${fac ? fac.name : res.facilityId}\n時間: ${res.timeRangeStr || '指定なし'}\n目的: ${res.purpose}\n予約者: ${res.userName}\n\nこの予約をキャンセル・削除しますか？`);

  if (confirmDelete) {
    apiDelete(`/facilities/reservations/${resId}`)
      .then(() => {
        showToast('予約をキャンセルしました', 'success');
        loadReservations();
      })
      .catch((err) => {
        console.warn('[Facility] キャンセルAPI失敗:', err.message);
        reservationsCache = reservationsCache.filter(r => String(r.id) !== String(resId));
        showToast('予約をキャンセルしました', 'info');
        renderMatrix();
      });
  }
}

async function handleCreateReservation(e) {
  e.preventDefault();

  const facilityId = document.getElementById('facility-select')?.value;
  const date = document.getElementById('facility-date-input')?.value || selectedDate;
  const startTimeVal = document.getElementById('facility-start-time')?.value;
  const endTimeVal = document.getElementById('facility-end-time')?.value;
  const purpose = document.getElementById('facility-purpose-input')?.value.trim();

  if (!facilityId || !startTimeVal || !endTimeVal || !purpose) {
    showToast('すべての必須項目を入力してください', 'warning');
    return;
  }

  if (startTimeVal >= endTimeVal) {
    showToast('終了時刻は開始時刻より後に設定してください', 'warning');
    return;
  }

  const startTime = `${date} ${startTimeVal}:00`;
  const endTime = `${date} ${endTimeVal}:00`;

  const payload = {
    facility_id: facilityId,
    facilityId: facilityId,
    resource_id: facilityId,
    resourceId: facilityId,
    title: purpose,
    purpose: purpose,
    target_date: date,
    targetDate: date,
    start_time: startTime,
    startTime: startTime,
    end_time: endTime,
    endTime: endTime
  };

  try {
    await apiPost('/facilities/reservations', payload);
    closeModal('facility-modal');
    document.getElementById('facility-form')?.reset();
    
    selectedDate = date;
    const picker = document.getElementById('facility-date-picker');
    if (picker) picker.value = selectedDate;
    await loadReservations();
  } catch (err) {
    console.error('[Facility] 予約投稿エラー:', err);
    const errMsg = err.message || '重複予約があるため登録できません。';
    showToast(errMsg, 'error');
    alert(`【予約登録エラー】\n${errMsg}`);
  }
}

function getFacilityIcon(type) {
  switch (type) {
    case 'GYM': return 'activity';
    case 'OUTDOOR': return 'sun';
    case 'SPECIAL': return 'monitor';
    case 'MEETING': return 'users';
    default: return 'building';
  }
}