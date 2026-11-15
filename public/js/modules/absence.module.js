/**
 * ISSystem 年休等・出張 欠席登録モジュール
 * ダッシュボードの区分別人数タイル（クリックで登録・確認モーダルを開く。記入フォームはモーダル内）
 *
 * 権限: 教務・管理職 (server の PRIVILEGED_RECORDING_ROLES) は全教員分を記入可
 *       一般教員は自分の分だけを記入可
 */

import { apiGet, apiPost, apiDelete } from '../api.js';
import { escapeHTML, refreshLucideIcons, openModal, showToast, formatDate, userAvatarHtml } from '../ui-helpers.js';
import { state } from '../state.js';

const TYPE_META = {
  LEAVE: { label: '年休等', icon: 'calendar-x-2', textClass: 'text-danger', borderClass: 'border-danger-soft', bgClass: 'bg-danger-soft' },
  TRIP: { label: '出張', icon: 'briefcase', textClass: 'text-warning', borderClass: 'border-warning-soft', bgClass: 'bg-warning-soft' },
};

/**
 * 期間プリセット (記入欄の初期は 全日 08:30〜17:00)。
 * ラベルは開始・終了時刻から算出するのでプリセット名は DB に保存しない (server の periodLabelOf と同一ロジック)。
 * CUSTOM は個別入力 = 開始・終了を自由に設定できる (プリセット外 = ラベル「個別」)
 */
const PERIOD_PRESETS = {
  FULL: { label: '全日', start: '08:30', end: '17:00' },
  AM: { label: '半日（午前）', start: '08:30', end: '13:00' },
  PM: { label: '半日（午後）', start: '13:00', end: '17:00' },
  CUSTOM: { label: '個別入力', start: null, end: null },
};

/** HH:MM (00:00〜23:59) の形式検証 */
function isValidTimeStr(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}

/** 開始・終了時刻 (HH:MM) から期間ラベル (全日/半日（午前）/半日（午後）/個別) を算出 */
function periodLabelOf(start, end) {
  for (const key of ['FULL', 'AM', 'PM']) {
    const p = PERIOD_PRESETS[key];
    if (p.start === start && p.end === end) return p.label;
  }
  return '個別';
}

/** 対象日 (YYYY-MM-DD) に 曜日 を添える (YYYY-MM-DD (火) 形式) */
function formatAbsenceDate(dateStr) {
  const parts = String(dateStr || '').split('-');
  if (parts.length !== 3) return dateStr || '';
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  return `${dateStr} (${d.toLocaleDateString('ja-JP', { weekday: 'short' })})`;
}

let latestSummary = null;
let currentFilter = 'ALL';
let teachersLoaded = false;

/**
 * 日本時間での当日日付 (YYYY-MM-DD)
 */
function todayJst() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/**
 * モジュール初期化 (静的モーダルHTMLへのイベント登録)
 */
export function initAbsenceModule() {
  // 対象日変更
  document.getElementById('absence-date')?.addEventListener('change', (e) => {
    loadAbsenceSummary(e.target.value);
  });

  // 期間プリセット選択 → 開始・終了時刻をプリセット値へ自動設定 (CUSTOM は現在の値を保つ)
  document.getElementById('absence-period-select')?.addEventListener('change', (e) => {
    const preset = PERIOD_PRESETS[e.target.value] || PERIOD_PRESETS.CUSTOM;
    if (!preset.start || !preset.end) return;
    const startInput = document.getElementById('absence-start-time');
    const endInput = document.getElementById('absence-end-time');
    if (startInput) startInput.value = preset.start;
    if (endInput) endInput.value = preset.end;
  });

  // 開始・終了の手動変更 → プリセットと一致すればセレクトを該当プリセットへ、不一致は「個別入力」へ
  const syncPeriodFromTimes = () => {
    const startInput = document.getElementById('absence-start-time');
    const endInput = document.getElementById('absence-end-time');
    const periodSelect = document.getElementById('absence-period-select');
    if (!startInput || !endInput || !periodSelect) return;
    const s = (startInput.value || '').substring(0, 5);
    const e = (endInput.value || '').substring(0, 5);
    const matched = ['FULL', 'AM', 'PM'].find((k) => PERIOD_PRESETS[k].start === s && PERIOD_PRESETS[k].end === e);
    periodSelect.value = matched || 'CUSTOM';
  };
  document.getElementById('absence-start-time')?.addEventListener('change', syncPeriodFromTimes);
  document.getElementById('absence-end-time')?.addEventListener('change', syncPeriodFromTimes);

  // 更新ボタン
  document.getElementById('absence-btn-refresh')?.addEventListener('click', () => {
    const dateInput = document.getElementById('absence-date');
    loadAbsenceSummary(dateInput ? dateInput.value : todayJst());
    showToast('年休等・出張登録を再読み込みしました', 'info');
  });

  // 登録フォーム送信
  document.getElementById('absence-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await submitAbsenceRecord();
  });

  // 区別フィルタ
  document.querySelectorAll('.absence-filter-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      currentFilter = btn.dataset.absenceFilter || 'ALL';
      document.querySelectorAll('.absence-filter-btn').forEach((b) => {
        b.classList.toggle('border-accent', b === btn);
        b.classList.toggle('text-accent-strong', b === btn);
      });
      renderAbsenceList();
    });
  });

  // 一覧の取消ボタン (イベント委譲)
  document.getElementById('absence-list')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-absence-delete]');
    if (!btn) return;
    const recordId = btn.dataset.absenceDelete;
    const record = (latestSummary?.records || []).find((r) => String(r.id) === String(recordId));
    if (!record) return;

    if (!window.confirm(`「${record.user_name} 教員」の「${TYPE_META[record.record_type]?.label || record.record_type}」登録を取消しますか？`)) {
      return;
    }

    btn.disabled = true;
    try {
      const data = await apiDelete(`/absences/${recordId}`);
      showToast(data.message || '登録を取消しました', 'success');
      await loadAbsenceSummary(record.record_date);
    } catch (err) {
      showToast(err.message || '登録の取消に失敗しました', 'error');
      btn.disabled = false;
    }
  });

  // ダッシュボードの年休等・出張の区分別人数タイルのクリックで登録・確認モーダルを開く（記入ボタンは撤去済み）

  // ダッシュボードの区分別人数タイル → クリックでその区分の「本日の詳細リスト」を表示
  const bindAbsenceTile = (id, filterType) => {
    const tile = document.getElementById(id);
    if (!tile) return;
    const open = () => openAbsenceModal(filterType);
    tile.addEventListener('click', open);
    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        open();
      }
    });
  };
  bindAbsenceTile('dash-absence-leave-tile', 'LEAVE');
  bindAbsenceTile('dash-absence-trip-tile', 'TRIP');
}

/**
 * 年休等・出張サマリー取得と描画 (ダッシュボード人数 + モーダル一覧)
 * @param {string} targetDate YYYY-MM-DD (省略時は本日)
 */
export async function loadAbsenceSummary(targetDate = null) {
  if (!state.currentUser || !state.authToken) return;

  const date = targetDate || todayJst();
  const dateInput = document.getElementById('absence-date');
  if (dateInput) dateInput.value = date;

  try {
    const data = await apiGet('/absences', { date });
    latestSummary = {
      date: data.date || date,
      counts: data.counts || { LEAVE: 0, TRIP: 0 },
      records: data.records || [],
      can_record: data.can_record === true,
    };

    renderAbsenceCounts();
    renderAbsenceList();

    if (!teachersLoaded) {
      await loadTeacherOptions();
      teachersLoaded = true;
    }
  } catch (err) {
    const list = document.getElementById('absence-list');
    if (list) {
      list.innerHTML = `<div class="text-center py-6 text-xs text-danger">年休等・出張データの取得に失敗しました。</div>`;
      refreshLucideIcons();
    }
  }
}

/**
 * モーダル内の区分別人数表示と権限案内
 * モーダルの赤・黄色の人数枠は撤廃した（件数だけフィルタ行の「表示: n 件」で示す）。
 * ダッシュボードの区分別人数タイル（n名）と権限案内を描画する。
 */
function renderAbsenceCounts() {
  if (!latestSummary) return;
  const counts = latestSummary.counts;

  // ダッシュボードの区分別人数表示
  const dashLeaveEl = document.getElementById('dash-absence-leave');
  const dashTripEl = document.getElementById('dash-absence-trip');
  if (dashLeaveEl) dashLeaveEl.textContent = `${counts.LEAVE ?? 0}名`;
  if (dashTripEl) dashTripEl.textContent = `${counts.TRIP ?? 0}名`;

  const noteEl = document.getElementById('absence-permission-note');
  if (noteEl) {
    noteEl.innerHTML = latestSummary.can_record
      ? `<i data-lucide="shield-check" class="w-3.5 h-3.5 text-success"></i> 教務・管理職権限: 全教員の「年休等・出張」を記入できます。`
      : `<i data-lucide="shield" class="w-3.5 h-3.5 text-muted"></i> 一般教員権限: 自分の分のみ記入できます（教務・管理職が全教員分を記入可）。`;
    refreshLucideIcons();
  }
}


/**
 * 登録一覧の描画 (クリックした区分でフィルタ)
 */
function renderAbsenceList() {
  const list = document.getElementById('absence-list');
  if (!list) return;

  const records = latestSummary ? latestSummary.records : [];
  const filtered = currentFilter === 'ALL' ? records : records.filter((r) => r.record_type === currentFilter);

  const filterLabel = currentFilter === 'ALL' ? 'すべて' : TYPE_META[currentFilter]?.label || currentFilter;
  const filterNote = document.getElementById('absence-filter-note');
  if (filterNote) {
    filterNote.textContent = `表示: ${filterLabel} (${filtered.length} 件)`;
  }

  if (filtered.length === 0) {
    list.innerHTML = `<div class="text-center py-8 text-xs text-muted">本日の「${filterLabel}」登録はありません。</div>`;
    return;
  }

  const myId = String(state.currentUser?.id || state.currentUser?._id || '');

  list.innerHTML = filtered.map((r) => {
    const meta = TYPE_META[r.record_type] || TYPE_META.LEAVE;
    const isSelf = String(r.user_id) === myId;
    const canDelete = latestSummary.can_record || isSelf;
    // 期間 (HH:MM)。プリセット名は保存せずラベルは開始・終了時刻から算出する
    const start = r.start_time || '08:30';
    const end = r.end_time || '17:00';

    return `
      <div class="flex items-center justify-between gap-3 p-3 rounded-lg border ${meta.borderClass} bg-surface-strong">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="badge ${meta.bgClass} ${meta.textClass} font-bold">${meta.label}</span>
            ${userAvatarHtml({ name: r.user_name || '教員', avatarUrl: r.avatar_url || r.avatarUrl || null, size: 'xs' })}
            <span class="text-xs font-bold text-main truncate">${escapeHTML(r.user_name)} 先生</span>
            ${isSelf ? '<span class="text-[9px] px-1.5 rounded bg-accent-soft text-accent-strong font-bold">自分</span>' : ''}
          </div>
          <div class="text-[11px] text-soft mt-1 flex items-center gap-1.5 font-mono">
            <i data-lucide="calendar" class="w-3.5 h-3.5 flex-shrink-0 text-muted"></i>
            <span>${escapeHTML(formatAbsenceDate(r.record_date))}</span>
            <i data-lucide="clock" class="w-3.5 h-3.5 flex-shrink-0 text-muted"></i>
            <span>${periodLabelOf(start, end)} ${start}〜${end}</span>
          </div>
          <div class="text-[10px] text-muted mt-0.5 font-mono">
            登録 by ${escapeHTML(r.recorded_by_name) || '不明'} / ${formatDate(r.updated_at, true)}
          </div>
        </div>
        ${canDelete
          ? `<button data-absence-delete="${r.id}" class="btn-secondary py-1 px-2.5 text-[10px] text-danger-strong flex items-center gap-1 flex-shrink-0">
              <i data-lucide="eraser" class="w-3 h-3"></i> 取消
            </button>`
          : ''}
      </div>
    `;
  }).join('');

  refreshLucideIcons();
}

/**
 * 教員セレクトの選択肢生成 (権限に応じて選択可否を付与)
 */
async function loadTeacherOptions() {
  const select = document.getElementById('absence-user-select');
  if (!select) return;

  try {
    const data = await apiGet('/absences/teachers');
    const teachers = data.teachers || [];

    select.innerHTML = teachers.map((t) => {
      const dept = t.department ? ` (${escapeHTML(t.department)})` : '';
      return `<option value="${t.id}" ${t.selectable ? '' : 'disabled'}>${escapeHTML(t.name)} 先生${dept}</option>`;
    }).join('');

    // 一般教員は自分の分のみ選択可能なため自分のを既定選択
    const myId = String(state.currentUser?.id || state.currentUser?._id || '');
    const self = teachers.find((t) => String(t.id) === myId);
    if (self && latestSummary && !latestSummary.can_record) {
      select.value = self.id;
    }
  } catch (err) {
    select.innerHTML = `<option value="">教員一覧の取得に失敗しました</option>`;
  }
}


/**
 * 人数クリックでモーダルを開く (区分フィルタ付き)
 * @param {'LEAVE'|'TRIP'|'ALL'} filterType
 */
export function openAbsenceModal(filterType = 'ALL') {
  currentFilter = TYPE_META[filterType] ? filterType : 'ALL';

  document.querySelectorAll('.absence-filter-btn').forEach((btn) => {
    const active = (btn.dataset.absenceFilter || 'ALL') === currentFilter;
    btn.classList.toggle('border-accent', active);
    btn.classList.toggle('text-accent-strong', active);
  });

  openModal('absence-modal');
  loadAbsenceSummary(document.getElementById('absence-date')?.value || todayJst());
}

/**
 * 手動記入フォームの送信 (対象日・期間・区分・対象教員。理由・行き先入力は撤廃)
 * 期間は HH:MM。終了が開始より後でないと登録できない (server 側の校验と同一条件)
 */
async function submitAbsenceRecord() {
  const userSelect = document.getElementById('absence-user-select');
  const typeSelect = document.getElementById('absence-type-select');
  const dateInput = document.getElementById('absence-date');
  const periodSelect = document.getElementById('absence-period-select');
  const startInput = document.getElementById('absence-start-time');
  const endInput = document.getElementById('absence-end-time');
  const saveBtn = document.getElementById('absence-btn-save');

  const preset = PERIOD_PRESETS[periodSelect ? periodSelect.value : 'FULL'] || PERIOD_PRESETS.CUSTOM;
  const start = (startInput ? startInput.value : '').substring(0, 5) || preset.start || '08:30';
  const end = (endInput ? endInput.value : '').substring(0, 5) || preset.end || '17:00';

  const payload = {
    user_id: userSelect ? userSelect.value : '',
    record_type: typeSelect ? typeSelect.value : '',
    record_date: dateInput ? dateInput.value : todayJst(),
    period_preset: periodSelect ? periodSelect.value : 'FULL',
    start_time: start,
    end_time: end,
  };

  if (!payload.user_id) {
    showToast('登録対象の教員を選択してください', 'warning');
    return;
  }
  if (!payload.record_date) {
    showToast('対象日を入力してください', 'warning');
    return;
  }
  if (!isValidTimeStr(start) || !isValidTimeStr(end)) {
    showToast('期間の開始・終了は HH:MM (00:00〜23:59) で入力してください', 'warning');
    return;
  }
  if (end <= start) {
    showToast(`期間が不正です（${start}〜${end}）。終了は開始より後にしてください`, 'warning');
    return;
  }

  if (saveBtn) saveBtn.disabled = true;

  try {
    const data = await apiPost('/absences', payload);
    showToast(data.message || '登録しました', 'success');
    await loadAbsenceSummary(payload.record_date);
  } catch (err) {
    showToast(err.message || '年休等・出張の登録に失敗しました', 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

export default { initAbsenceModule, loadAbsenceSummary, openAbsenceModal };

