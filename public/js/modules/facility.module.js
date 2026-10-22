/**
 * ISSystem Facility Module
 * 施設予約タイムライン・一括予約フォームコントローラー (RAWレスポンス深層展開 & 10分単位完全描画版)
 */

import { apiGet, apiPost, apiDelete } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast } from '../ui-helpers.js';
import { state } from '../state.js';

let selectedDate = '2026-10-15';

// 施設マスター初期定義
let facilities = [
  { id: '1', name: '第一会議室', type: 'MEETING' },
  { id: '2', name: '第二会議室', type: 'MEETING' },
  { id: '3', name: '体育館', type: 'GYM' },
  { id: '4', name: 'プロジェクターA', type: 'SPECIAL' },
  { id: '5', name: '校外研修用マイクロバス', type: 'SPECIAL' }
];

// タイムラインの列定義
const PERIODS = [
  { id: 1, label: '1限', time: '08:50 - 09:40', startMin: 530, endMin: 580 },
  { id: 2, label: '2限', time: '09:50 - 10:40', startMin: 590, endMin: 640 },
  { id: 3, label: '3限', time: '10:50 - 11:40', startMin: 650, endMin: 700 },
  { id: 4, label: '4限', time: '11:50 - 12:40', startMin: 710, endMin: 760 },
  { id: 8, label: '昼休み', time: '12:40 - 13:25', startMin: 760, endMin: 805, isLunch: true },
  { id: 5, label: '5限', time: '13:25 - 14:15', startMin: 805, endMin: 855 },
  { id: 6, label: '6限', time: '14:25 - 15:15', startMin: 865, endMin: 915 },
  { id: 7, label: '7限/放課後', time: '15:25 - 17:00', startMin: 925, endMin: 1020 }
];

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

    <!-- タイムラインマトリクス表示エリア -->
    <div class="card p-4 overflow-hidden mt-4">
      <div class="timeline-scroll-container overflow-x-auto">
        <table class="w-full text-left border-collapse text-xs min-w-[900px]">
          <thead>
            <tr class="border-b border-slate-800 bg-slate-900/80">
              <th class="p-3 w-40 text-slate-300 font-bold">施設名称</th>
              ${PERIODS.map(p => `
                <th class="p-3 text-center border-l border-slate-800/80 ${p.isLunch ? 'bg-amber-950/20' : ''}">
                  <div class="font-bold ${p.isLunch ? 'text-amber-300' : 'text-slate-200'}">${p.label}</div>
                  <div class="text-[10px] text-slate-500 font-mono font-normal">${p.time}</div>
                </th>
              `).join('')}
            </tr>
          </thead>
          <tbody id="facility-matrix-body" class="divide-y divide-slate-800/60">
            <tr>
              <td colspan="9" class="text-center py-12 text-slate-500">予約データを読み込み中...</td>
            </tr>
          </tbody>
        </table>
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
            <label class="block text-xs font-bold text-slate-300 mb-1">利用時間帯 (10分刻み) <span class="text-rose-400">*</span></label>
            <div class="grid grid-cols-2 gap-3 mb-2">
              <div>
                <span class="text-[10px] text-slate-400 block mb-0.5">開始時刻</span>
                <input type="time" id="facility-start-time" step="600" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-emerald-500" value="08:50" required>
              </div>
              <div>
                <span class="text-[10px] text-slate-400 block mb-0.5">終了時刻</span>
                <input type="time" id="facility-end-time" step="600" class="w-full bg-slate-800 border border-slate-700 rounded-lg p-2 text-xs text-white focus:outline-none focus:border-emerald-500" value="09:40" required>
              </div>
            </div>

            <div class="flex flex-wrap gap-1">
              <button type="button" class="btn-preset text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded" data-start="08:50" data-end="09:40">1限</button>
              <button type="button" class="btn-preset text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded" data-start="09:50" data-end="10:40">2限</button>
              <button type="button" class="btn-preset text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded" data-start="10:50" data-end="11:40">3限</button>
              <button type="button" class="btn-preset text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded" data-start="11:50" data-end="12:40">4限</button>
              <button type="button" class="btn-preset text-[10px] bg-amber-950 hover:bg-amber-900 text-amber-300 border border-amber-700/60 px-2 py-1 rounded font-bold" data-start="12:40" data-end="13:20">昼休み</button>
              <button type="button" class="btn-preset text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded" data-start="13:25" data-end="14:15">5限</button>
              <button type="button" class="btn-preset text-[10px] bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 px-2 py-1 rounded" data-start="14:25" data-end="15:15">6限</button>
              <button type="button" class="btn-preset text-[10px] bg-indigo-950 hover:bg-indigo-900 text-indigo-300 border border-indigo-700/60 px-2 py-1 rounded font-bold" data-start="15:25" data-end="17:00">放課後</button>
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
    selectedDate = '2026-10-15';
    if (picker) picker.value = selectedDate;
    loadReservations();
  });

  document.getElementById('facility-btn-create')?.addEventListener('click', () => {
    const dateInput = document.getElementById('facility-date-input');
    if (dateInput) dateInput.value = selectedDate;
    openModal('facility-modal');
  });

  document.querySelectorAll('.btn-preset').forEach(btn => {
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
  const d = new Date(selectedDate);
  d.setDate(d.getDate() + days);
  selectedDate = d.toISOString().split('T')[0];
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

function formatMinutesToTime(totalMin) {
  const h = String(Math.floor(totalMin / 60)).padStart(2, '0');
  const m = String(totalMin % 60).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * タイムラインマトリクスの描画
 */
function renderMatrix() {
  const tbody = document.getElementById('facility-matrix-body');
  if (!tbody) return;

  tbody.innerHTML = facilities.map(fac => {
    return `
      <tr class="hover:bg-slate-900/30 transition-colors">
        <td class="p-3 font-bold text-slate-200 bg-slate-900/40 border-r border-slate-800">
          <div class="flex items-center gap-2">
            <i data-lucide="${getFacilityIcon(fac.type)}" class="w-4 h-4 text-emerald-400"></i>
            <span>${escapeHTML(fac.name)}</span>
          </div>
        </td>
        ${PERIODS.map(p => {
          const res = reservationsCache.find(r => {
            // 施設マッチング
            const isSameFacility = (
              r.facilityId === fac.id || 
              r.facilityName === fac.name || 
              (r.facilityId && fac.id && (r.facilityId === fac.id || fac.id.includes(r.facilityId) || r.facilityId.includes(fac.id)))
            );
            
            // 時間・コマの判定
            let isTimeOverlap = false;
            if (r.startMin > 0 && r.endMin > 0) {
              isTimeOverlap = (r.startMin < p.endMin && r.endMin > p.startMin);
            } else if (r.period > 0) {
              isTimeOverlap = (r.period === p.id);
            }

            return isSameFacility && isTimeOverlap;
          });

          return `
            <td class="p-1.5 text-center border-l border-slate-800/80 h-16 align-middle ${p.isLunch ? 'bg-amber-950/10' : ''}">
              ${res ? `
                <div class="reservation-chip p-1.5 rounded-lg text-left text-[11px] bg-emerald-950/70 border border-emerald-500/50 hover:border-emerald-400 transition-all cursor-pointer flex flex-col justify-between h-full" data-res-id="${res.id}">
                  <div class="font-bold text-emerald-200 truncate">${escapeHTML(res.purpose)}</div>
                  <div class="text-[10px] text-emerald-400 font-mono flex items-center justify-between mt-0.5">
                    <span>${res.timeRangeStr || '予約中'}</span>
                    <span class="text-emerald-300/80 truncate ml-1">${escapeHTML(res.userName)}</span>
                  </div>
                </div>
              ` : `
                <button class="w-full h-full rounded border border-dashed border-slate-800/60 hover:border-slate-700 hover:bg-slate-800/40 text-[10px] text-slate-600 hover:text-slate-400 transition-all flex items-center justify-center gap-1 btn-quick-reserve" data-facility-id="${fac.id}" data-start="${formatMinutesToTime(p.startMin)}" data-end="${formatMinutesToTime(p.endMin)}">
                  <i data-lucide="plus" class="w-3 h-3"></i> 空き
                </button>
              `}
            </td>
          `;
        }).join('')}
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('[data-res-id]').forEach(chip => {
    chip.addEventListener('click', () => {
      openReservationDetail(chip.getAttribute('data-res-id'));
    });
  });

  tbody.querySelectorAll('.btn-quick-reserve').forEach(btn => {
    btn.addEventListener('click', () => {
      const fId = btn.getAttribute('data-facility-id');
      const start = btn.getAttribute('data-start');
      const end = btn.getAttribute('data-end');
      
      const selectFac = document.getElementById('facility-select');
      const startInput = document.getElementById('facility-start-time');
      const endInput = document.getElementById('facility-end-time');
      const dateInput = document.getElementById('facility-date-input');

      if (selectFac) selectFac.value = fId;
      if (startInput) startInput.value = start;
      if (endInput) endInput.value = end;
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