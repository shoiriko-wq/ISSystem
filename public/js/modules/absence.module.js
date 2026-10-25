/**
 * ISSystem 年休等・出張 欠席登録モジュール
 * ダッシュボードの「年休等 / 出張」人数表示・クリック詳細モーダル・手動記入フォーム
 *
 * 権限: 教務・管理職 (server の PRIVILEGED_RECORDING_ROLES) は全教員分を記入可
 *       一般教員は自分の分だけを記入可
 */

import { apiGet, apiPost, apiDelete } from '../api.js';
import { escapeHTML, refreshLucideIcons, openModal, showToast, formatDate } from '../ui-helpers.js';
import { state } from '../state.js';

const TYPE_META = {
  LEAVE: { label: '年休等', icon: 'calendar-x-2', textClass: 'text-rose-400', borderClass: 'border-rose-500/30', bgClass: 'bg-rose-500/10' },
  TRIP: { label: '出張', icon: 'briefcase', textClass: 'text-amber-400', borderClass: 'border-amber-500/30', bgClass: 'bg-amber-500/10' },
};

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
        b.classList.toggle('border-indigo-500/60', b === btn);
        b.classList.toggle('text-indigo-300', b === btn);
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

  // ダッシュボードの人数タイル・記入ボタン
  document.getElementById('dash-tile-leave')?.addEventListener('click', () => openAbsenceModal('LEAVE'));
  document.getElementById('dash-tile-trip')?.addEventListener('click', () => openAbsenceModal('TRIP'));
  document.getElementById('dash-btn-absence')?.addEventListener('click', () => openAbsenceModal('ALL'));
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

    renderAbsenceDashboardCard();
    renderAbsenceCounts();
    renderAbsenceList();

    if (!teachersLoaded) {
      await loadTeacherOptions();
      teachersLoaded = true;
    }
  } catch (err) {
    const leaveEl = document.getElementById('dash-absence-leave');
    const tripEl = document.getElementById('dash-absence-trip');
    if (leaveEl) leaveEl.textContent = '--';
    if (tripEl) tripEl.textContent = '--';
    const list = document.getElementById('absence-list');
    if (list) {
      list.innerHTML = `<div class="text-center py-6 text-xs text-red-400">年休等・出張データの取得に失敗しました。</div>`;
      refreshLucideIcons();
    }
  }
}

/**
 * ダッシュボードの人数タイル描画
 */
function renderAbsenceDashboardCard() {
  if (!latestSummary) return;
  const counts = latestSummary.counts;

  const leaveEl = document.getElementById('dash-absence-leave');
  const tripEl = document.getElementById('dash-absence-trip');
  if (leaveEl) leaveEl.textContent = String(counts.LEAVE ?? 0);
  if (tripEl) tripEl.textContent = String(counts.TRIP ?? 0);

  const updatedEl = document.getElementById('dash-absence-updated');
  if (updatedEl) {
    updatedEl.textContent = `${latestSummary.date} 登録 ${latestSummary.records.length} 件`;
  }
}

/**
 * モーダル内の区分別人数表示と権限案内
 */
function renderAbsenceCounts() {
  if (!latestSummary) return;
  const counts = latestSummary.counts;

  const leaveCountEl = document.getElementById('absence-count-leave');
  const tripCountEl = document.getElementById('absence-count-trip');
  if (leaveCountEl) leaveCountEl.textContent = String(counts.LEAVE ?? 0);
  if (tripCountEl) tripCountEl.textContent = String(counts.TRIP ?? 0);

  const noteEl = document.getElementById('absence-permission-note');
  if (noteEl) {
    noteEl.innerHTML = latestSummary.can_record
      ? `<i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-400"></i> 教務・管理職権限: 全教員の「年休等・出張」を記入できます。`
      : `<i data-lucide="shield" class="w-3.5 h-3.5 text-slate-400"></i> 一般教員権限: 自分の分のみ記入できます（教務・管理職が全教員分を記入可）。`;
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
    list.innerHTML = `<div class="text-center py-8 text-xs text-slate-500">本日の「${filterLabel}」登録はありません。</div>`;
    return;
  }

  const myId = String(state.currentUser?.id || state.currentUser?._id || '');

  list.innerHTML = filtered.map((r) => {
    const meta = TYPE_META[r.record_type] || TYPE_META.LEAVE;
    const isSelf = String(r.user_id) === myId;
    const canDelete = latestSummary.can_record || isSelf;

    return `
      <div class="flex items-center justify-between gap-3 p-3 rounded-lg border ${meta.borderClass} bg-slate-900/60">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="badge ${meta.bgClass} ${meta.textClass} font-bold">${meta.label}</span>
            <span class="text-xs font-bold text-white truncate">${escapeHTML(r.user_name)} 先生</span>
            ${isSelf ? '<span class="text-[9px] px-1.5 rounded bg-indigo-500/20 text-indigo-300 font-bold">自分</span>' : ''}
          </div>
          <div class="text-[11px] text-slate-300 mt-1 truncate">
            理由: ${escapeHTML(r.reason) || '<span class="text-slate-500">（未記入）</span>'}
          </div>
          <div class="text-[10px] text-slate-500 mt-0.5 font-mono">
            ${escapeHTML(r.record_date)} 登録 by ${escapeHTML(r.recorded_by_name) || '不明'} / ${formatDate(r.updated_at, true)}
          </div>
        </div>
        ${canDelete
          ? `<button data-absence-delete="${r.id}" class="btn-secondary py-1 px-2.5 text-[10px] text-rose-300 flex items-center gap-1 flex-shrink-0">
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
    btn.classList.toggle('border-indigo-500/60', active);
    btn.classList.toggle('text-indigo-300', active);
  });

  openModal('absence-modal');
  loadAbsenceSummary(document.getElementById('absence-date')?.value || todayJst());
}

/**
 * 手動記入フォームの送信
 */
async function submitAbsenceRecord() {
  const userSelect = document.getElementById('absence-user-select');
  const typeSelect = document.getElementById('absence-type-select');
  const reasonInput = document.getElementById('absence-reason-input');
  const dateInput = document.getElementById('absence-date');
  const saveBtn = document.getElementById('absence-btn-save');

  const payload = {
    user_id: userSelect ? userSelect.value : '',
    record_type: typeSelect ? typeSelect.value : '',
    record_date: dateInput ? dateInput.value : todayJst(),
    reason: reasonInput ? reasonInput.value.trim() : '',
  };

  if (!payload.user_id) {
    showToast('登録対象の教員を選択してください', 'warning');
    return;
  }

  if (saveBtn) saveBtn.disabled = true;

  try {
    const data = await apiPost('/absences', payload);
    showToast(data.message || '登録しました', 'success');

    if (reasonInput) reasonInput.value = '';
    await loadAbsenceSummary(payload.record_date);
  } catch (err) {
    showToast(err.message || '年休等・出張の登録に失敗しました', 'error');
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

export default { initAbsenceModule, loadAbsenceSummary, openAbsenceModal };

