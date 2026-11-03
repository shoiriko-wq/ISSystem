/**
 * ISSystem Facility Module
 * 施設予約タイムライン・一括予約フォームコントローラー (RAWレスポンス深層展開 & 10分単位完全描画版)
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast, userAvatarHtml } from '../ui-helpers.js';
import { state } from '../state.js';

/**
 * JST 基準の今日 (YYYY-MM-DD) を返す
 */
function todayJst() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

let selectedDate = todayJst();

// 施設マスター（API の resources テーブルをキャッシュ。マスタ管理UIとタイムラインで共用）
let facilities = [];

/** カテゴリキー → 表示名（server の FACILITY_CATEGORY_LABELS と対応させる） */
const CATEGORY_LABELS = {
  ROOM: '教室・会議室',
  GYM: '体育施設 (体育館・武道場)',
  OUTDOOR: '屋外施設 (運動場・体育広場)',
  EQUIPMENT: '備品・設備 (プロジェクター等)',
  VEHICLE: '車両 (マイクロバス等)',
  SPECIAL: '特別教室 (PC教室・理科室等)',
};
const CATEGORY_KEYS = Object.keys(CATEGORY_LABELS);
const FACILITY_NAME_MAX = 30;

/** 教務部権限 (is_kyomu / KYOMU / ADMIN)。施設マスタの追加・改名・削除は教務部のみ */
function isKyomuUser() {
  const u = state.currentUser;
  if (!u) return false;
  const role = String(u.role || '').toUpperCase();
  return u.is_kyomu === true || u.is_kyomu === 1 || role === 'KYOMU' || role === 'ADMIN';
}

/**
 * 施設マスターの取得（使用予約件数を含む）
 * @param {boolean} force 強制再取得
 */
export async function loadFacilities(force = false) {
  if (facilities.length > 0 && !force) return facilities;
  try {
    const facRes = await apiGet('/facilities');
    const facList = (facRes && (facRes.facilities || facRes.data)) || (Array.isArray(facRes) ? facRes : []);
    facilities = (facList || []).map((f) => ({
      id: String(f.id),
      name: f.name || '施設',
      category: String(f.category || 'ROOM').toUpperCase(),
      reservation_count: Number(f.reservation_count) || 0,
      reservation_total: Number(f.reservation_total) || 0,
    }));
  } catch (err) {
    console.warn('[Facility] 施設マスター取得失敗:', err.message);
  }
  renderFacilitySelect();
  return facilities;
}

/** 予約フォームの施設セレクトをキャッシュから再描画する（選択値は維持） */
function renderFacilitySelect() {
  const selectFac = document.getElementById('facility-select');
  if (!selectFac) return;
  const current = selectFac.value;
  selectFac.innerHTML = facilities.map((f) => `<option value="${f.id}">${escapeHTML(f.name)}</option>`).join('');
  if (current && facilities.some((f) => f.id === current)) selectFac.value = current;
}

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

// 時間スケール（8時〜18時）: 本文グリッド線と同一の百分率位置で描画する
const TIME_START_H = Math.floor(TIME_START_MIN / 60);
const TIME_END_H = Math.floor(TIME_END_MIN / 60);

/**
 * 1時間刻みの垂直グリッド線 (8:00〜18:00 の 11本 = 0%〜100%)
 * ヘッダーと本文行で同一の位置に描画するため共用する（.grid-line-v は左辺 2px のみ）
 */
function gridLinesHtml() {
  return Array.from({ length: TIME_END_H - TIME_START_H + 1 }, (_, i) => {
    const pos = timeToPercent(TIME_START_MIN + i * 60);
    return `<div class="grid-line-v absolute top-0 bottom-0 pointer-events-none" style="left:${pos}%"></div>`;
  }).join('');
}

// 時間ラベル（08:00〜17:00 を本文グリッド線と同一の % 位置に配置。18:00 は右端境界線のみ）
const timeScaleLabels = Array.from({ length: TIME_END_H - TIME_START_H }, (_, i) => {
  const hour = TIME_START_H + i;
  const pos = timeToPercent(hour * 60);
  return `<div class="absolute top-0 bottom-0 flex items-center pl-1.5" style="left:${pos}%">${String(hour).padStart(2, '0')}:00</div>`;
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
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-surface-strong p-4 rounded-xl border border-divider">
      <div>
        <h2 class="text-lg font-bold text-main flex items-center gap-2">
          <i data-lucide="building-2" class="w-5 h-5 text-success"></i> 特別教室・施設予約タイムライン
        </h2>
        <p class="text-xs text-muted">体育館・PC教室・会議室等の予約状況確認および新規取得を行えます。</p>
      </div>

      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <div class="flex items-center bg-surface rounded-lg p-1 border border-main text-xs">
          <button id="facility-prev-day" class="p-1.5 hover-surface-strong rounded text-soft">
            <i data-lucide="chevron-left" class="w-4 h-4"></i>
          </button>
          <input type="date" id="facility-date-picker" class="bg-transparent text-main font-bold px-2 py-0.5 focus:outline-none text-xs" value="${selectedDate}">
          <button id="facility-next-day" class="p-1.5 hover-surface-strong rounded text-soft">
            <i data-lucide="chevron-right" class="w-4 h-4"></i>
          </button>
        </div>

        <button id="facility-btn-today" class="btn-secondary py-1.5 px-3 text-xs">本日</button>
        <button id="facility-btn-create" class="btn-primary py-1.5 px-3 text-xs font-bold flex items-center gap-1.5">
          <i data-lucide="plus" class="w-4 h-4"></i> 新規予約
        </button>
        ${isKyomuUser() ? `
        <button id="facility-btn-manage" class="btn-secondary py-1.5 px-3 text-xs font-bold flex items-center gap-1.5" title="施設・備品の追加・改名・削除 (教務部のみ)">
          <i data-lucide="building-2" class="w-4 h-4"></i> 施設管理
        </button>` : ''}
      </div>
    </div>

    <!-- タイムラインマトリクス表示エリア (時間帯バンド表示) -->
    <div class="card p-4 overflow-hidden mt-4">
      <div class="flex items-center justify-between mb-3 text-xs text-muted">
        <span class="flex items-center gap-1.5"><i data-lucide="clock" class="w-3.5 h-3.5 text-success"></i> ${TIME_START_H}時〜${TIME_END_H}時の連続タイムライン (時限・10分刻み区切りなし)</span>
        <span class="text-muted">バンドをクリック → 詳細 / キャンセル、空き帯域をクリック → 予約作成</span>
      </div>
      <div class="timeline-scroll-container overflow-x-auto">
        <div class="min-w-[880px]">
          <!-- 時間スケールヘッダー（グリッド線は本文行と共用し、ラベルは同一 % 位置に配置） -->
          <div id="facility-time-header" class="flex h-10 items-stretch bg-surface-strong text-[10px] text-muted font-mono">
            <div class="w-40 shrink-0 border-r border-divider p-2 flex items-center font-bold text-soft font-sans">施設名称</div>
            <div class="flex-1 relative">
              ${gridLinesHtml()}
              ${timeScaleLabels}
            </div>
          </div>
          <div id="facility-matrix-body" class="divide-y divide-divider">
            <div class="py-12 text-center text-muted text-xs">予約データを読み込み中...</div>
          </div>
        </div>
      </div>
    </div>

    <!-- モーダルダイアログ（統一仕様） -->
    <div id="facility-modal" class="modal-overlay hidden">
      <div class="modal-card">
        <div class="modal-header">
          <h3 class="modal-title"><i data-lucide="calendar-plus" class="w-5 h-5 text-success"></i> 施設・備品 新規予約</h3>
          <button type="button" id="facility-modal-close" class="modal-close modal-close-x" aria-label="閉じる" title="閉じる">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>

        <form id="facility-form" class="modal-form">
          <div class="modal-body">
            <div class="space-y-4">
              <div>
            <label class="block text-xs font-bold text-soft mb-1">対象施設・備品 <span class="text-danger">*</span></label>
            <select id="facility-select" class="w-full bg-surface border border-main rounded-lg p-2 text-xs focus:outline-none focus-border-accent text-main" required>
            </select>
          </div>

          <div>
            <label class="block text-xs font-bold text-soft mb-1">利用日 <span class="text-danger">*</span></label>
            <input type="date" id="facility-date-input" class="w-full bg-surface border border-main rounded-lg p-2 text-xs focus:outline-none focus-border-accent text-main" value="${selectedDate}" required>
          </div>

          <div>
            <label class="block text-xs font-bold text-soft mb-1">利用開始・終了時刻 <span class="text-danger">*</span></label>
            <p class="text-[10px] text-muted mb-2">時限・期間の区切りや10分刻みの制約はなく、8:00〜18:00 の任意の時刻 (分単位) で予約できます。</p>
            <div class="grid grid-cols-2 gap-3 mb-2">
              <div>
                <span class="text-[10px] text-muted block mb-0.5">開始時刻</span>
                <input type="time" id="facility-start-time" class="w-full bg-surface border border-main rounded-lg p-2 text-xs text-main focus:outline-none focus-border-accent" value="08:50" required>
              </div>
              <div>
                <span class="text-[10px] text-muted block mb-0.5">終了時刻</span>
                <input type="time" id="facility-end-time" class="w-full bg-surface border border-main rounded-lg p-2 text-xs text-main focus:outline-none focus-border-accent" value="09:40" required>
              </div>
            </div>

            <div class="flex flex-wrap gap-1 items-center">
              <span class="text-[10px] text-muted mr-1">時短:</span>
              <button type="button" class="btn-duration text-[10px] bg-surface hover-surface-strong text-soft border border-main px-2 py-1 rounded" data-minutes="30">30分</button>
              <button type="button" class="btn-duration text-[10px] bg-surface hover-surface-strong text-soft border border-main px-2 py-1 rounded" data-minutes="60">1時間</button>
              <button type="button" class="btn-duration text-[10px] bg-surface hover-surface-strong text-soft border border-main px-2 py-1 rounded" data-minutes="90">1時間30分</button>
              <button type="button" class="btn-duration text-[10px] bg-surface hover-surface-strong text-soft border border-main px-2 py-1 rounded" data-minutes="120">2時間</button>
              <button type="button" class="btn-daylight text-[10px] bg-accent-inset hover-accent-soft text-accent-strong border border-accent-soft px-2 py-1 rounded font-bold" data-start="08:00" data-end="18:00">終日 (8:00-18:00)</button>
            </div>
          </div>

          <div>
            <label class="block text-xs font-bold text-soft mb-1">利用目的・件名 <span class="text-danger">*</span></label>
            <input type="text" id="facility-purpose-input" class="w-full bg-surface border border-main rounded-lg p-2 text-xs focus:outline-none focus-border-accent text-main" placeholder="例: 昼休み委員会集会、教務部定例会議" required>
          </div>

            </div>
          </div>
          <div class="modal-footer">
            <button type="button" id="facility-btn-cancel" class="modal-close btn-secondary py-2 px-4 text-xs">閉じる</button>
            <button type="submit" class="btn-primary py-2 px-4 text-xs font-bold">予約を確定する</button>
          </div>
        </form>
      </div>
    </div>
  `;

  bindEvents();
  // マスタ管理モーダル (教務部) を初期生成し追加フォームを紐付ける
  ensureFacilityMasterDom();
  document.getElementById('facility-master-add-form')?.addEventListener('submit', submitFacilityMasterAdd);
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

  // 施設マスタ管理 (教務部 KYOMU のみヘッダーに出る)
  document.getElementById('facility-btn-manage')?.addEventListener('click', openFacilityMasterAdmin);

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

  // 1. 施設マスター取得（使用予約件数込み。マスタ管理UIと同一キャッシュ）
  await loadFacilities(true);

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
        userName: r.user_name || r.userName || '教員',
        avatarUrl: r.avatar_url || r.avatarUrl || null
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

  // グリッド線はヘッダーと共用 (timeToPercent と同一 % 位置、.grid-line-v は左辺 2px のみ)

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
        <div class="reservation-chip absolute top-1 bottom-1 rounded-lg px-2 py-1 text-[11px] bg-success-inset border border-success hover-border-success transition-all cursor-pointer overflow-hidden"
             style="left:${left}%; width:${width}%" data-res-id="${res.id}" title="${escapeHTML(res.purpose)} (${res.timeRangeStr})">
          <div class="font-bold text-success-strong truncate leading-tight">${escapeHTML(res.purpose)}</div>
          <div class="text-[10px] text-success font-mono flex items-center gap-1 mt-0.5">
            <span>${res.timeRangeStr || '予約中'}</span>
            ${userAvatarHtml({ name: res.userName, avatarUrl: res.avatarUrl, size: 'xs' })}
            <span class="text-success-strong truncate">${escapeHTML(res.userName)}</span>
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="flex hover-surface-soft transition-colors" data-facility-row="${fac.id}">
        <div class="w-40 shrink-0 p-3 font-bold text-main bg-surface-strong border-r border-divider flex items-center gap-2">
          <i data-lucide="${getFacilityIcon(fac.category)}" class="w-4 h-4 text-success"></i>
          <span class="truncate">${escapeHTML(fac.name)}</span>
        </div>
        <div class="flex-1 relative h-16 btn-quick-reserve-area cursor-crosshair" data-facility-id="${fac.id}">
          ${gridLinesHtml()}
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

/** タイムライン行のアイコン (resources.category キーに対応) */
function getFacilityIcon(category) {
  switch (String(category || '').toUpperCase()) {
    case 'GYM': return 'activity';
    case 'OUTDOOR': return 'sun';
    case 'EQUIPMENT': return 'monitor';
    case 'SPECIAL': return 'monitor';
    case 'VEHICLE': return 'bus';
    case 'ROOM': return 'users';
    default: return 'building';
  }

/* ==========================================================================
 * 施設・備品マスタ管理 (教務部 KYOMU のみ・追加・改名・削除)
 * 改名は既存予約の表示へ即反映 (予約は施設ID参照)。削除は有効な予約が残ると 409 で拒否される。
 * ======================================================================== */

/** カテゴリ select の options HTML */
function categoryOptionsHtml(selected = 'ROOM') {
  return CATEGORY_KEYS.map((key) => `<option value="${key}"${key === selected ? ' selected' : ''}>${CATEGORY_LABELS[key]}</option>`).join('');
}

/** マスタ管理モーダル DOM (初回のみ生成) */
function ensureFacilityMasterDom() {
  if (document.getElementById('facility-master-modal')) return;
  const container = document.getElementById('modal-container') || document.body;

  container.insertAdjacentHTML('beforeend', `
    <div id="facility-master-modal" class="modal-overlay hidden">
      <div class="modal-card">
        <div class="modal-header">
          <h3 class="modal-title"><i data-lucide="building-2" class="w-5 h-5 text-accent"></i> 施設・備品マスタ管理</h3>
          <button type="button" class="modal-close modal-close-x" aria-label="閉じる" title="閉じる">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>
        <div class="modal-body">
          <div class="p-2 rounded-lg bg-info-soft border border-info-soft text-[11px] text-info-strong mb-3">
            施設・備品マスタは<b>教務部 (KYOMU)</b> のみ追加・改名・削除できます。改名は既存予約の表示へ即座に反映されます。
            <b>有効な予約が残る施設は削除できません</b>（先に予約をキャンセルしてください）。削除するとキャンセル済みの予約履歴も除去されます。
          </div>
          <form id="facility-master-add-form" class="flex flex-wrap items-end gap-2 mb-3">
            <div class="flex-1 min-w-[170px]">
              <label class="block text-xs font-bold text-soft mb-1">施設・備品名（${FACILITY_NAME_MAX}文字以内） <span class="text-danger">*</span></label>
              <input id="facility-master-add-name" maxlength="${FACILITY_NAME_MAX}" required class="w-full bg-surface border border-main rounded-lg p-2 text-xs focus:outline-none focus-border-accent text-main" placeholder="例: 第三会議室、PC教室B">
            </div>
            <div class="w-48">
              <label class="block text-xs font-bold text-soft mb-1">カテゴリ</label>
              <select id="facility-master-add-category" class="w-full bg-surface border border-main rounded-lg p-2 text-xs focus:outline-none focus-border-accent text-main">${categoryOptionsHtml('ROOM')}</select>
            </div>
            <button type="submit" class="btn-primary py-2 px-3 text-xs font-bold flex items-center gap-1">
              <i data-lucide="plus" class="w-3.5 h-3.5"></i> 追加
            </button>
          </form>
          <div id="facility-master-list" class="space-y-2"></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="modal-close btn-primary py-2 px-4 text-xs font-bold">閉じる</button>
        </div>
      </div>
    </div>
  `);
}

/** マスタ一覧（教務部用の編集行＋予約使用件数バッジ）を描画する */
function renderFacilityMasterList() {
  const holder = document.getElementById('facility-master-list');
  if (!holder) return;

  if (facilities.length === 0) {
    holder.innerHTML = '<div class="p-3 text-xs text-muted text-center">施設・備品がありません。上のフォームから追加してください。</div>';
    refreshLucideIcons();
    return;
  }

  holder.innerHTML = facilities.map((f) => `
    <div class="facility-master-row flex flex-wrap items-center gap-2 p-2 rounded-lg border border-divider bg-surface-soft" data-facility-master-id="${f.id}">
      <input type="text" data-field="name" value="${escapeHTML(f.name)}" maxlength="${FACILITY_NAME_MAX}" class="w-44 bg-surface border border-main rounded p-1.5 text-xs focus:outline-none focus-border-accent text-main" required>
      <select data-field="category" class="w-48 bg-surface border border-main rounded p-1.5 text-xs focus:outline-none focus-border-accent text-main">${categoryOptionsHtml(f.category)}</select>
      <span class="text-[10px] text-muted shrink-0" title="有効予約 ${f.reservation_count || 0} 件 / キャンセル履歴含む ${f.reservation_total || 0} 件">
        <i data-lucide="calendar-check" class="w-3 h-3 inline"></i> 有効予約 ${f.reservation_count || 0} 件
      </span>
      <button type="button" data-action="save" class="btn-secondary py-1 px-2.5 text-[11px] rounded flex items-center gap-1">
        <i data-lucide="save" class="w-3 h-3"></i> 保存
      </button>
      <button type="button" data-action="delete" class="btn-secondary py-1 px-2.5 text-[11px] rounded flex items-center gap-1 text-danger-strong">
        <i data-lucide="trash-2" class="w-3 h-3"></i> 削除
      </button>
    </div>
  `).join('');

  bindFacilityMasterRows(holder);
  refreshLucideIcons();
}

/** 各行の「保存」「削除」ボタンを紐付ける */
function bindFacilityMasterRows(holder) {
  holder.querySelectorAll('.facility-master-row').forEach((row) => {
    const id = String(row.dataset.facilityMasterId);

    row.querySelector('[data-action=save]').addEventListener('click', async () => {
      const name = row.querySelector('[data-field=name]').value.trim();
      const category = row.querySelector('[data-field=category]').value;
      if (!name) { showToast('施設・備品名を入力してください。', 'error'); return; }

      try {
        await apiPut(`/facilities/${id}`, { name, category });
        showToast(`施設「${name}」を変更しました。`, 'success');
        await loadFacilities(true);
        renderFacilityMasterList();
        renderMatrix();
      } catch (e) {
        showToast(`変更に失敗しました: ${e.message}`, 'error');
      }
    });

    row.querySelector('[data-action=delete]').addEventListener('click', async () => {
      const target = facilities.find((f) => String(f.id) === id);
      const active = target ? Number(target.reservation_count) || 0 : 0;
      const history = target ? Number(target.reservation_total) || 0 : 0;

      if (active > 0) {
        showToast(`「${target ? target.name : ''}」は有効な予約が ${active} 件残っているため削除できません。先に予約をキャンセルしてください。`, 'error');
        return;
      }

      const message = history > 0
        ? `「${target ? target.name : 'この施設'}」はキャンセル済みの予約履歴が ${history} 件あります。削除すると履歴も除去されます。削除しますか？`
        : `「${target ? target.name : 'この施設'}」を削除しますか？`;
      if (!window.confirm(message)) return;

      try {
        await apiDelete(`/facilities/${id}`);
        showToast(`施設「${target ? target.name : ''}」を削除しました。`, 'success');
        await loadFacilities(true);
        renderFacilityMasterList();
        renderMatrix();
      } catch (e) {
        showToast(`削除に失敗しました: ${e.message}`, 'error');
      }
    });
  });
}

/** 施設追加フォーム (教務部 KYOMU) */
async function submitFacilityMasterAdd(event) {
  event.preventDefault();
  if (!isKyomuUser()) {
    showToast('施設マスタの追加は教務部 (KYOMU) のみです。', 'error');
    return;
  }

  const nameInput = document.getElementById('facility-master-add-name');
  const categoryInput = document.getElementById('facility-master-add-category');
  const name = nameInput ? nameInput.value.trim() : '';
  const category = categoryInput ? categoryInput.value : 'ROOM';

  if (!name) { showToast('施設・備品名を入力してください。', 'error'); return; }

  try {
    const res = await apiPost('/facilities', { name, category });
    showToast(res.message || `施設「${name}」を追加しました。`, 'success');
    if (nameInput) nameInput.value = '';
    await loadFacilities(true);
    renderFacilityMasterList();
    renderMatrix();
  } catch (e) {
    showToast(`追加に失敗しました: ${e.message}`, 'error');
  }
}

/** 施設マスタ管理モーダルを開く (教務部のみ) */
export function openFacilityMasterAdmin() {
  if (!isKyomuUser()) {
    showToast('施設マスタの追加・改名・削除は教務部 (KYOMU) のみです。', 'error');
    return;
  }
  ensureFacilityMasterDom();
  renderFacilityMasterList();
  openModal('facility-master-modal');
  refreshLucideIcons();
}

}