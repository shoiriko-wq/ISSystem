/**
 * ISSystem 定期考査 実施科目と出題者の登録タブ
 * 調査開始 → 実施科目・出題者の表が全員に表示され編集可能（教員は自分の出題コマのみ）
 * 調査終了 → 教務権限者のみ以後も編集可能
 */

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
import { state } from '../../state.js';

/** 教職員プール（出題者セレクト用・bind 時にキャッシュ） */
let staffPool = null;

async function ensureStaffPool() {
  if (staffPool && staffPool.length) return staffPool;
  const res = await examApi.get('/staff/pool');
  staffPool = res.staff || [];
  return staffPool;
}

const FLAG_ITEMS = [
  { key: 'shared_slot', label: '全学年同一時限' },
  { key: 'broadcast_slot', label: '放送（学年で時限を分ける）' },
  { key: 'solo_subject', label: '単独実施（出題者が監督）' },
];

function staffOptions(selectedId) {
  const opts = (staffPool || [])
    .map((s) => `<option value="${s.id}" ${String(s.id) === String(selectedId) ? 'selected' : ''}>${escapeHTML(s.name)}${s.is_parttime ? '（非常勤）' : ''}</option>`)
    .join('');
  return `<option value="">（未設定）</option>${opts}`;
}

function subjectRowHtml(p, kyomu) {
  const can = kyomu || p.can_edit;
  const dis = can ? '' : 'disabled';
  const flags = FLAG_ITEMS.map(
    (f) => `<label class="flex items-center gap-1 text-[10px] text-soft">
        <input data-f="${f.key}" type="checkbox" ${p[f.key] ? 'checked' : ''} ${dis} class="rounded" />
        <span>${f.label}</span>
      </label>`
  ).join('');
  const gradeSel = `<select data-f="grade" ${dis} class="input-field w-14 py-1 text-[11px] text-center">
      ${[0, 1, 2, 3].map((g) => `<option value="${g}" ${Number(p.grade) === g ? 'selected' : ''}>${g === 0 ? '全' : g}</option>`).join('')}
    </select>`;
  const durSel = `<select data-f="duration_slots" ${dis} class="input-field w-14 py-1 text-[11px] text-center">
      ${[1, 2].map((d) => `<option value="${d}" ${(Number(p.duration_slots) || 1) === d ? 'selected' : ''}>${d}</option>`).join('')}
    </select>`;
  const status =
    p.submit_status === 'SUBMITTED'
      ? '<span class="badge bg-success-soft text-success-strong text-[9px] px-1.5 py-0.5 rounded font-bold">提出済</span>'
      : '<span class="badge bg-surface text-muted border border-main text-[9px] px-1.5 py-0.5 rounded font-bold">未提出</span>';
  return `<tr data-row-id="${p.id || ''}">
    <td class="border border-divider p-1.5"><input data-f="subject_name" value="${escapeHTML(p.subject_name || '')}" ${dis} class="input-field w-full py-1 text-[11px]" /></td>
    <td class="border border-divider p-1.5 text-center">${gradeSel}</td>
    <td class="border border-divider p-1.5"><select data-f="setter_teacher_id" ${dis} class="input-field w-full py-1 text-[11px]">${staffOptions(p.setter_teacher_id)}</select></td>
    <td class="border border-divider p-1.5 text-center">${durSel}</td>
    <td class="border border-divider p-1.5 space-y-1">${flags}</td>
    <td class="border border-divider p-1.5"><input data-f="notes" value="${escapeHTML(p.notes || '')}" ${dis} class="input-field w-full py-1 text-[11px]" placeholder="備考" /></td>
    <td class="border border-divider p-1.5 text-center">${status}</td>
    <td class="border border-divider p-1.5 text-center space-y-1">
      <button data-act="save" ${can ? '' : 'disabled'} class="btn-secondary py-1 px-2 text-[10px]">保存</button>
      <button data-act="submit" ${can ? '' : 'disabled'} class="btn-secondary py-1 px-2 text-[10px]">提出</button>
      ${kyomu ? `<button data-act="delete" class="text-[10px] text-danger-strong">削除</button>` : ''}
    </td>
  </tr>`;
}

function surveyHeadHtml(master, phases, kyomu) {
  const phase = phases.subject_phase;
  const startable = kyomu && phase !== 'SURVEY';
  const endable = kyomu && phase === 'SURVEY';
  const period = master
    ? `<span>期間 ${escapeHTML(String(master.start_date).slice(0, 10))} 〜 ${escapeHTML(String(master.end_date).slice(0, 10))} ／ ${master.days_count}日間 × ${master.daily_slots}時限</span>`
    : '';
  return sectionCard(
    'list-checks',
    '実施科目と出題者の登録',
    '調査開始で全員の表が編集可能になります。教員は自分の出題コマのみ編集・提出できます。',
    `<div class="flex flex-wrap items-center gap-3 text-[11px] text-muted">
       ${phaseBadge(phase)} ${period}
     </div>
     <div class="flex flex-wrap items-center gap-2">
       <button id="exam-sub-start" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${startable ? '' : 'disabled'}>
         <i data-lucide="play" class="w-3.5 h-3.5"></i> 調査開始
       </button>
       <button id="exam-sub-end" class="btn-danger py-1.5 px-3 text-xs flex items-center gap-1" ${endable ? '' : 'disabled'}>
         <i data-lucide="stop-circle" class="w-3.5 h-3.5"></i> 調査終了
       </button>
       <button id="exam-sub-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="plus" class="w-3.5 h-3.5"></i> 行を追加
       </button>
       <span class="text-[10px] text-muted ml-auto">${kyomu ? '教務：調査終了後も全行編集可' : '教員：調査期間中のみ編集可'}</span>
     </div>`,
    phaseBadge(phase)
  );
}

export function renderSubjectTab(container) {
  const board = examStore.board;
  const kyomu = isKyomuUser();
  if (!board) {
    container.innerHTML = `<div class="card p-6 text-center text-xs text-muted">考査データを読み込み中…</div>`;
    return;
  }
  const plan = (board.subject_plan || [])
    .slice()
    .sort((a, b) => Number(a.grade) - Number(b.grade) || String(a.subject_name).localeCompare(String(b.subject_name)));
  const rows = plan.map((p) => subjectRowHtml(p, kyomu)).join('');
  container.innerHTML = `
    ${surveyHeadHtml(board.master, board.phases, kyomu)}
    <div class="card p-4 space-y-2">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse min-w-[720px]">
          <thead><tr>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">実施科目</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">学年</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">出題者（担当者）</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">時限数</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">条件</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">備考</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">状態</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">操作</th>
          </tr></thead>
          <tbody id="exam-sub-body">${rows || '<tr><td colspan="8" class="p-2 text-[11px] text-muted border border-divider">実施科目が登録されていません。教務が「調査開始」を押すと全科目分の表が作成されます。</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  refreshLucideIcons();
}


export function bindSubjectTab(container, reload) {
  if (container.dataset.bound === 'subject') return;
  container.dataset.bound = 'subject';

  // 教員プールを取得して出題者セレクトを反映（イベント委譲のため再描画安全）
  ensureStaffPool()
    .then(() => renderSubjectTab(container))
    .catch(() => {});

  const payloadFromRow = (tr) => {
    const orig = (examStore.board.subject_plan || []).find((r) => String(r.id) === String(tr.dataset.rowId)) || {};
    const out = { ...orig };
    tr.querySelectorAll('[data-f]').forEach((el) => {
      const key = el.dataset.f;
      out[key] = el.type === 'checkbox' ? el.checked : el.value;
    });
    out.subject_name = String(out.subject_name || '').trim();
    out.subject_id = out.subject_id || null;
    out.grade = Number(out.grade) || 0;
    out.duration_slots = Number(out.duration_slots) || 1;
    out.fixed_slot = out.fixed_slot ? Number(out.fixed_slot) : null;
    out.student_count = out.student_count ? Number(out.student_count) : null;
    out.setter_teacher_id = out.setter_teacher_id || null;
    out.stream = out.stream || 'OTHER';
    out.scope = out.scope || 'GRADE';
    out.submit_status = out.submit_status || 'PENDING';
    if (tr.dataset.rowId) out.id = tr.dataset.rowId;
    return out;
  };

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.id === 'exam-sub-start' || btn.id === 'exam-sub-end') {
      if (btn.id === 'exam-sub-end' && !window.confirm('調査を終了します。以後は教務権限者のみ編集可能になります。よろしいですか？')) return;
      btn.disabled = true;
      try {
        if (btn.id === 'exam-sub-start') {
          await examApi.post(`/exam/${examStore.examId}/subject-survey/start`, {});
          showToast('実施科目調査を開始しました（全員分の表が編集可能になりました）', 'success');
        } else {
          await examApi.post(`/exam/${examStore.examId}/subject-survey/end`, {});
          showToast('実施科目調査を終了しました（以後は教務権限者のみ編集）', 'info');
        }
        await reload();
      } catch (err) {
        showToast(err.message || '調査操作に失敗しました', 'error');
        btn.disabled = false;
      }
      return;
    }

    if (btn.id === 'exam-sub-add') {
      const body = container.querySelector('#exam-sub-body');
      const placeholder = body.querySelector('td[colspan]');
      if (placeholder) placeholder.closest('tr').remove();
      const blank = {
        grade: 0,
        stream: 'OTHER',
        scope: 'GRADE',
        duration_slots: 1,
        shared_slot: false,
        broadcast_slot: false,
        solo_subject: false,
        submit_status: 'PENDING',
        setter_teacher_id: isKyomuUser() ? null : state.currentUser?.id,
      };
      body.insertAdjacentHTML('beforeend', subjectRowHtml(blank, isKyomuUser()));
      refreshLucideIcons();
      return;
    }

    const tr = btn.closest('tr[data-row-id]');
    if (!tr) return;

    if (btn.dataset.act === 'delete') {
      if (!tr.dataset.rowId) {
        showToast('未保存の行は削除できません。', 'warning');
        return;
      }
      if (!window.confirm('この実施科目行を削除します。よろしいですか？')) return;
      try {
        await examApi.del(`/exam/${examStore.examId}/subject-row/${tr.dataset.rowId}`);
        showToast('実施科目行を削除しました', 'info');
        await reload();
      } catch (err) {
        showToast(err.message || '削除に失敗しました', 'error');
      }
      return;
    }

    const payload = payloadFromRow(tr);
    if (!payload.subject_name) {
      showToast('実施科目名を入力してください。', 'warning');
      return;
    }
    btn.disabled = true;
    try {
      if (btn.dataset.act === 'submit') {
        if (!tr.dataset.rowId) {
          const saved = await examApi.post(`/exam/${examStore.examId}/subject-row`, payload);
          tr.dataset.rowId = saved.id;
        }
        await examApi.post(`/exam/${examStore.examId}/subject-row/${tr.dataset.rowId}/submit`, {});
        showToast('提出を完了しました', 'success');
      } else {
        const saved = await examApi.post(`/exam/${examStore.examId}/subject-row`, payload);
        if (!tr.dataset.rowId) tr.dataset.rowId = saved.id;
        showToast(`実施科目「${saved.subject_name}」(${saved.grade === 0 ? '全' : saved.grade}) を登録しました`, 'success');
      }
      await reload();
    } catch (err) {
      showToast(err.message || '実施科目の登録に失敗しました', 'error');
      btn.disabled = false;
    }
  });
}

export default { renderSubjectTab, bindSubjectTab };

