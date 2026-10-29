/**
 * ISSystem 定期考査 出張等登録タブ
 * 試験期間中の出張・外出・私用・欠席を教務が設定、教員は調査中に自分の分を登録
 */

import { state } from '../../state.js';
import {
  examStore,
  examApi,
  sectionCard,
  phaseBadge,
  escapeHTML,
  refreshLucideIcons,
  showToast,
  isKyomuUser,
} from './exam.shared.js';

const REASONS = ['出張', '外出', '私用', '欠席'];

let phase = 'DRAFT';
let staffList = [];
let preview = null;
let tripRows = [];
let lastExamId = null;
let loadedFlag = false;
const bound = new WeakSet();

function syncTrips() {
  tripRows = (examStore.board.trips || []).map((t) => ({
    id: t.id,
    teacher_id: t.teacher_id,
    teacher_name: t.teacher_name,
    day_number: Number(t.day_number),
    slot_number: Number(t.slot_number),
    reason: t.reason || '',
    from_absence: !!t.from_absence,
    can_edit: t.can_edit,
  }));
  staffList = [];
  preview = null;
  lastExamId = examStore.examId;
}

function dayOptions(sel, days) {
  return Array.from({ length: days }, (_, i) => i + 1)
    .map((d) => `<option value="${d}" ${Number(sel) === d ? 'selected' : ''}>${d}日目</option>`)
    .join('');
}

function slotOptions(sel, slots) {
  return Array.from({ length: slots }, (_, i) => i + 1)
    .map((s) => `<option value="${s}" ${Number(sel) === s ? 'selected' : ''}>${s}限</option>`)
    .join('');
}

function staffOptions(sel, list, kyomu) {
  const mine = state.currentUser;
  const opts = kyomu && list.length ? list : [{ id: mine.id, name: mine.name }];
  if (!opts.some((s) => String(s.id) === String(sel))) opts.unshift({ id: sel, name: '（教員）' });
  return opts
    .map((s) => `<option value="${s.id}" ${String(s.id) === String(sel) ? 'selected' : ''}>${escapeHTML(s.name)}</option>`)
    .join('');
}

function tripsTableHtml(rows, kyomu, editable, staff, days, slots) {
  const body = rows
    .map(
      (t) => `<tr data-trip-id="${t.id}">
        <td class="border border-divider p-1.5"><select data-trip="teacher_id" class="input-field w-full py-1 text-[11px]" ${kyomu && editable ? '' : 'disabled'}>${staffOptions(t.teacher_id, staff, kyomu)}</select></td>
        <td class="border border-divider p-1.5"><select data-trip="day_number" class="input-field w-16 py-1 text-[11px] text-center" ${kyomu && editable ? '' : 'disabled'}>${dayOptions(t.day_number, days)}</select></td>
        <td class="border border-divider p-1.5"><select data-trip="slot_number" class="input-field w-16 py-1 text-[11px] text-center" ${kyomu && editable ? '' : 'disabled'}>${slotOptions(t.slot_number, slots)}</select></td>
        <td class="border border-divider p-1.5"><select data-trip="reason" class="input-field w-full py-1 text-[11px]" ${kyomu && editable ? '' : 'disabled'}>${REASONS.map((r) => `<option value="${r}" ${t.reason === r ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td class="border border-divider p-1.5 text-center">${t.from_absence ? '<span class="badge bg-warning-soft text-warning-strong text-[10px]">出欠由来</span>' : '<span class="text-[10px] text-muted">手動</span>'}</td>
        <td class="border border-divider p-1.5 text-center">
          <button data-trip-save="${t.id}" class="btn-secondary py-1 px-2 text-[10px]" ${editable ? '' : 'disabled'}>保存</button>
          <button data-trip-del="${t.id}" class="text-[10px] text-danger-strong" ${editable ? '' : 'disabled'}>削除</button>
        </td>
      </tr>`
    )
    .join('');
  return `<div class="overflow-x-auto">
    <table class="w-full text-left border-collapse min-w-[560px]">
      <thead><tr>
        <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">教員</th>
        <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">日</th>
        <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">時限</th>
        <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">区分</th>
        <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">出欠</th>

        <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">操作</th>
      </tr></thead>
      <tbody>${body || '<tr><td colspan="6" class="p-2 text-[11px] text-muted border border-divider">登録がありません。</td></tr>'}</tbody>
    </table>
  </div>`;
}
export function renderTripTab(container) {
  const board = examStore.board;
  if (!board) {
    container.innerHTML = `<div class="card p-6 text-center text-xs text-muted">考査データを読み込み中…</div>`;
    return;
  }
  phase = board.phases.trip_phase;
  const kyomu = isKyomuUser();
  const editable = board.editable.trip;
  const days = Number(board.master.days_count) || 0;
  const slots = Number(board.master.daily_slots) || 0;
  if (lastExamId !== examStore.examId) syncTrips();

  const phaseCard = sectionCard(
    'plane',
    '出張等登録フェーズ',
    '教務が調査開始（出欠抽出）→ 教員登録 → 公表 → 公表終了 の順で進行します。',
    `<div class="flex flex-wrap items-center gap-2">
       <span class="text-xs text-soft">出張等 ${phaseBadge(phase)}</span>
       ${kyomu && phase === 'DRAFT' ? '<button id="exam-trip-start" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1"><i data-lucide="play" class="w-3.5 h-3.5"></i> 調査開始（出欠抽出）</button>' : ''}
       ${kyomu && phase === 'SURVEY' ? '<button id="exam-trip-publish" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1"><i data-lucide="megaphone" class="w-3.5 h-3.5"></i> 調査終了（公表）</button>' : ''}
       ${kyomu && phase === 'PUBLISHED' ? '<button id="exam-trip-end" class="btn-danger py-1.5 px-3 text-xs flex items-center gap-1"><i data-lucide="lock" class="w-3.5 h-3.5"></i> 公表終了</button>' : ''}
       <span class="text-[10px] text-muted ml-auto">${kyomu ? '教務：公表中・終了後も編集可' : '教員：調査中のみ編集可（自分の分）'}</span>
     </div>`
  );
  const previewCard = kyomu
    ? sectionCard(
        'file-search',
        '出欠記録からの抽出プレビュー',
        `試験期間（${board.master.start_date}〜${board.master.end_date}）の出欠を出張等候補として抽出します。`,
        preview
          ? `<p class="text-[11px] text-soft">抽出候補 ${preview.derived_count} 件 / 登録済み ${preview.saved_count} 件</p>
             <ul class="text-[10px] text-muted max-h-40 overflow-y-auto mt-1">
               ${preview.derived.slice(0, 20).map((d) => `<li>${escapeHTML(d.teacher_name || '')} ${d.day_number}日目 ${d.slot_number}限 — ${escapeHTML(d.reason)}</li>`).join('')}
             </ul>`
          : `<p class="text-[11px] text-muted">読み込み中…</p>`
      )
    : '';

  const tableCard = sectionCard(
    'clipboard-list',
    '出張・外出・私用・欠席の登録',
    '教務は全教員分を登録、教員は調査中に自分の分を登録します。',
    tripsTableHtml(tripRows, kyomu, editable, staffList, days, slots) +
      `<div class="flex flex-wrap items-center gap-2 pt-1">
         <button id="exam-trip-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${editable ? '' : 'disabled'}>
           <i data-lucide="plus" class="w-3.5 h-3.5"></i> 行を追加
         </button>
         <button id="exam-trip-save-all" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${editable ? '' : 'disabled'}>
           <i data-lucide="save" class="w-3.5 h-3.5"></i> 一括保存
         </button>
       </div>`
  );

  container.innerHTML = phaseCard + previewCard + tableCard;
  refreshLucideIcons();
}



export async function bindTripTab(container, reload) {
  const id = examStore.examId;
  const kyomu = isKyomuUser();
  if (lastExamId !== id) syncTrips();

  if (!loadedFlag) {
    loadedFlag = true;
    try {
      const pool = await examApi.get('/staff/pool');
      staffList = pool.staff || [];
      if (kyomu) preview = await examApi.get(`/exam/${id}/trips/preview`);
      renderTripTab(container);
    } catch (e) {
      console.warn('[Trip] load', e);
    }
  }

  if (bound.has(container)) return;
  bound.add(container);

  container.addEventListener('change', (e) => {
    const t = e.target;
    const tr = t.closest('tr');
    if (!t.dataset.trip || !tr) return;
    const row = tripRows.find((r) => String(r.id) === tr.dataset.tripId);
    if (!row) return;
    if (t.dataset.trip === 'teacher_id') row.teacher_id = t.value;
    if (t.dataset.trip === 'day_number') row.day_number = Number(t.value);
    if (t.dataset.trip === 'slot_number') row.slot_number = Number(t.value);
    if (t.dataset.trip === 'reason') row.reason = t.value;
  });

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const body = tripRows.map((t) => ({
      teacher_id: t.teacher_id,
      day_number: t.day_number,
      slot_number: t.slot_number,
      reason: t.reason,
    }));
    try {
      if (btn.id === 'exam-trip-start') {
        const r = await examApi.post(`/exam/${id}/trips/start`, {});
        showToast(`出欠から ${r.derived_count}件 を抽出し、調査を開始しました`, 'success');
        await reload();
        return;
      }
      if (btn.id === 'exam-trip-publish') {
        await examApi.post(`/exam/${id}/trips/publish`, {});
        showToast('出張等を公表しました', 'success');
        await reload();
        return;
      }
      if (btn.id === 'exam-trip-end') {
        await examApi.post(`/exam/${id}/trips/end`, {});
        showToast('出張等の公表を終了しました', 'success');
        await reload();
        return;
      }
      if (btn.dataset.tripDel) {
        await examApi.del(`/exam/${id}/trips/${btn.dataset.tripDel}`);
        showToast('出張等を削除しました', 'success');
        await reload();
        return;
      }
      if (btn.dataset.tripSave) {
        const row = tripRows.find((r) => String(r.id) === btn.dataset.tripSave);
        if (row) await examApi.post(`/exam/${id}/trips`, [row]);
        showToast('出張等を保存しました', 'success');
        await reload();
        return;
      }
      if (btn.id === 'exam-trip-save-all') {
        const r = await examApi.post(`/exam/${id}/trips`, body);
        showToast(`${r.saved}件 保存しました`, 'success');
        await reload();
        return;
      }
      if (btn.id === 'exam-trip-add') {
        const mine = state.currentUser;
        tripRows.push({
          id: `tmp-${Date.now()}`,
          teacher_id: kyomu ? (staffList[0] ? staffList[0].id : mine.id) : mine.id,
          teacher_name: mine.name,
          day_number: 1,
          slot_number: 1,
          reason: '出張',
          from_absence: false,
        });
        renderTripTab(container);
        return;
      }
    } catch (err) {
      showToast(err.message || '出張等の処理に失敗しました', 'error');
    }
  });
}

