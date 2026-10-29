/**
 * ISSystem 定期考査 考査の登録タブ
 * 考査名・日程（開始日/終了日と 1 日あたりのコマ数）・対象学年・使用教室リスト
 */

import {
  examStore,
  examApi,
  resolveActiveExamId,
  sectionCard,
  phaseBadge,
  escapeHTML,
  refreshLucideIcons,
  showToast,
  isKyomuUser,
} from './exam.shared.js';

const ROOM_TYPES = ['CLASS', 'SP1', 'SP2', 'PREP1'];
const ROOM_TYPE_LABEL = { CLASS: '普通教室', SP1: '別室1', SP2: '別室2', PREP1: '予備教室' };

/** 期間（開始日〜終了日）から日数を算出 */
function periodDays(start, end) {
  const d1 = new Date(start);
  const d2 = new Date(end);
  if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return 0;
  return Math.max(0, Math.round((d2 - d1) / 86400000) + 1);
}

function roomRowHtml(r, editable) {
  const dis = editable ? '' : 'disabled';
  const typeOpts = ROOM_TYPES.map(
    (t) => `<option value="${t}" ${String(r.room_type || 'CLASS').toUpperCase() === t ? 'selected' : ''}>${ROOM_TYPE_LABEL[t]}</option>`
  ).join('');
  const grades = (r.grades || []).join(',');
  return `<tr data-room-id="${r.id || ''}">
    <td class="border border-divider p-1.5"><input data-room="name" value="${escapeHTML(r.name || '')}" ${dis} class="input-field w-full py-1 text-[11px]" placeholder="教室名" /></td>
    <td class="border border-divider p-1.5"><select data-room="type" ${dis} class="input-field w-full py-1 text-[11px]">${typeOpts}</select></td>
    <td class="border border-divider p-1.5"><input data-room="cap" type="number" min="0" value="${r.capacity ?? ''}" ${dis} class="input-field w-16 py-1 text-[11px] text-center" /></td>
    <td class="border border-divider p-1.5"><input data-room="grades" value="${escapeHTML(grades)}" ${dis} class="input-field w-20 py-1 text-[11px]" placeholder="1,2,3" /></td>
    <td class="border border-divider p-1.5 text-center"><input data-room="alt" type="checkbox" ${r.is_alternate ? 'checked' : ''} ${dis} class="rounded" /></td>
    <td class="border border-divider p-1.5"><input data-room="notes" value="${escapeHTML(r.notes || '')}" ${dis} class="input-field w-full py-1 text-[11px]" placeholder="メモ" /></td>
    <td class="border border-divider p-1.5 text-center">${
      r.id ? '<span class="text-[10px] text-muted">更新</span>' : '<button data-room-remove class="text-[10px] text-danger-strong">削除</button>'
    }</td>
  </tr>`;
}

function examFormHtml(master, kyomu) {
  const m = master || {};
  const dis = kyomu ? '' : 'disabled';
  const grades = (m.grades && m.grades.length ? m.grades : [1, 2, 3]).map(Number);
  const boxes = [1, 2, 3]
    .map(
      (g) => `<label class="flex items-center gap-1.5 text-[11px] text-soft cursor-pointer">
        <input type="checkbox" data-m-grade="${g}" ${grades.includes(g) ? 'checked' : ''} ${dis} class="rounded" />
        <span>${g}学年</span>
      </label>`
    )
    .join('');

  return sectionCard(
    'file-plus',
    '考査名・日程・コマ数・対象学年',
    '日程（日にち）と 1 日あたりのコマ数を決定します。日数は開始日〜終了日から自動算出されます。',
    `<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
       <div class="lg:col-span-2">
         <label class="block text-[10px] text-muted mb-1">考査名</label>
         <input id="exam-m-title" value="${escapeHTML(m.title || '')}" ${dis} class="input-field w-full py-1.5 text-xs" placeholder="例: 2026年度 1学期中間考査" />
       </div>
       <div>
         <label class="block text-[10px] text-muted mb-1">開始日</label>
         <input id="exam-m-start" type="date" value="${escapeHTML(String(m.start_date || '').slice(0, 10))}" ${dis} class="input-field w-full py-1.5 text-xs" />
       </div>
       <div>
         <label class="block text-[10px] text-muted mb-1">終了日</label>
         <input id="exam-m-end" type="date" value="${escapeHTML(String(m.end_date || '').slice(0, 10))}" ${dis} class="input-field w-full py-1.5 text-xs" />
       </div>
       <div>
         <label class="block text-[10px] text-muted mb-1">1日あたりのコマ数</label>
         <input id="exam-m-slots" type="number" min="1" max="8" value="${Number(m.daily_slots) || 5}" ${dis} class="input-field w-full py-1.5 text-xs" />
       </div>
       <div class="flex items-end gap-2 pb-1">
         <span class="text-[10px] text-muted">対象学年</span>
         <div class="flex gap-3">${boxes}</div>
       </div>
     </div>
     <div class="flex flex-wrap items-center gap-2 pt-1">
       <button id="exam-m-create" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="plus" class="w-3.5 h-3.5"></i> 新規登録
       </button>
       <button id="exam-m-update" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu && m.id ? '' : 'disabled'}>
         <i data-lucide="save" class="w-3.5 h-3.5"></i> 更新
       </button>
       <button id="exam-m-deactivate" class="btn-danger py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu && m.id ? '' : 'disabled'}>
         <i data-lucide="lock" class="w-3.5 h-3.5"></i> 手続終了（非active化）
       </button>
       <span class="text-[10px] text-muted ml-auto">教務権限者のみ編集できます</span>
     </div>`,
    phaseBadge('DRAFT')
  );
}


function roomsHtml(rooms, kyomu, master) {
  const rows = rooms.map((r) => roomRowHtml(r, kyomu)).join('');
  const grid = master
    ? `<span class="text-[11px] text-muted">期間 ${escapeHTML(String(master.start_date).slice(0, 10))} 〜 ${escapeHTML(String(master.end_date).slice(0, 10))} ／ ${master.days_count}日間 × ${master.daily_slots}時限 ／ ${(master.grades || []).map((g) => `${g}年`).join(' / ')}</span>`
    : '<span class="text-[11px] text-muted">考査が登録されていません。</span>';
  return sectionCard(
    'layout-grid',
    '使用教室リスト',
    '考査期間に使用する教室を登録します（普通教室・別室・予備教室）。行追加と更新が行えます（教室削除の API は未提供）。',
    `<div>${grid}</div>
     <div class="overflow-x-auto">
       <table class="w-full text-left border-collapse min-w-[620px]">
         <thead><tr>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">教室名</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">種別</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">収容</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">対応学年</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">予備</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">メモ</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">状態</th>
         </tr></thead>
         <tbody id="exam-rooms-body">${rows || '<tr><td colspan="7" class="p-2 text-[11px] text-muted border border-divider">教室が登録されていません。</td></tr>'}</tbody>
       </table>
     </div>
     <div class="flex flex-wrap items-center gap-2">
       <button id="exam-rooms-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="plus" class="w-3.5 h-3.5"></i> 行を追加
       </button>
       <button id="exam-rooms-save" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="save" class="w-3.5 h-3.5"></i> 教室リストを保存
       </button>
       <span class="text-[10px] text-muted ml-auto">対応学年は「1,2,3」形式。全学年共通の特殊教室は空欄</span>
     </div>`
  );
}

export function renderMasterTab(container) {
  const board = examStore.board;
  const kyomu = isKyomuUser();
  const master = board ? board.master : null;
  const rooms = board ? board.rooms || [] : [];
  container.innerHTML = `${examFormHtml(master, kyomu)}${roomsHtml(rooms, kyomu, master)}`;
  refreshLucideIcons();
}


/** 登録・更新用の表单値_collect（考査名・日程・コマ数・対象学年） */
function collectPayload(container) {
  return {
    title: container.querySelector('#exam-m-title')?.value.trim() || '',
    start_date: container.querySelector('#exam-m-start')?.value || '',
    end_date: container.querySelector('#exam-m-end')?.value || '',
    daily_slots: Number(container.querySelector('#exam-m-slots')?.value) || 1,
    grades: [...container.querySelectorAll('[data-m-grade]')].filter((c) => c.checked).map((c) => Number(c.dataset.mGrade)),
  };
}

export function bindMasterTab(container, reload) {
  if (container.dataset.bound === 'master') return;
  container.dataset.bound = 'master';

  container.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

    // 教室リスト：行追加・行削除（未保存行のみ削除可）
    if (btn.id === 'exam-rooms-add') {
      const body = container.querySelector('#exam-rooms-body');
      const placeholder = body.querySelector('td[colspan]');
      if (placeholder) placeholder.closest('tr').remove();
      body.insertAdjacentHTML('beforeend', roomRowHtml({ room_type: 'CLASS' }, true));
      refreshLucideIcons();
      return;
    }
    if (btn.hasAttribute('data-room-remove')) {
      btn.closest('tr')?.remove();
      return;
    }
    if (btn.id === 'exam-rooms-save') {
      const rows = [...container.querySelectorAll('tr[data-room-id]')]
        .map((tr) => {
          const get = (k) => tr.querySelector(`[data-room="${k}"]`);
          return {
            id: tr.dataset.roomId || undefined,
            name: get('name').value.trim(),
            room_type: get('type').value,
            capacity: Number(get('cap').value) || null,
            grades: get('grades').value.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n)),
            is_alternate: get('alt').checked,
            notes: get('notes').value.trim() || null,
          };
        })
        .filter((r) => r.name);
      if (!examStore.examId) {
        showToast('先に考査を登録してください。', 'warning');
        return;
      }
      if (!rows.length) {
        showToast('保存する教室名がありません。', 'warning');
        return;
      }
      btn.disabled = true;
      try {
        const saved = await examApi.post(`/exam/${examStore.examId}/rooms`, rows);
        showToast(`使用教室を ${saved.length}室 保存しました`, 'success');
        await reload();
      } catch (err) {
        showToast(err.message || '教室リストの保存に失敗しました', 'error');
        btn.disabled = false;
      }
      return;
    }

    // 考査の登録・更新
    if (btn.id === 'exam-m-create' || btn.id === 'exam-m-update') {
      const payload = collectPayload(container);
      if (!payload.title) {
        showToast('考査名を入力してください。', 'warning');
        return;
      }
      if (!payload.start_date || !payload.end_date) {
        showToast('開始日と終了日を入力してください。', 'warning');
        return;
      }
      if (periodDays(payload.start_date, payload.end_date) <= 0) {
        showToast('終了日は開始日以降の日にちで指定してください。', 'warning');
        return;
      }
      if (!payload.grades.length) {
        showToast('対象学年を 1 つ以上選択してください。', 'warning');
        return;
      }
      btn.disabled = true;
      try {
        if (btn.id === 'exam-m-create') {
          const created = await examApi.post('/exam', payload);
          examStore.examId = created.id;
          await resolveActiveExamId();
          showToast(`考査「${created.title}」を登録しました（${periodDays(payload.start_date, payload.end_date)}日間 × ${payload.daily_slots}時限）`, 'success');
        } else {
          const updated = await examApi.put(`/exam/${examStore.examId}`, payload);
          showToast(`考査「${updated.title}」の情報を更新しました`, 'success');
        }
        await reload();
      } catch (err) {
        showToast(err.message || '考査登録に失敗しました', 'error');
        btn.disabled = false;
      }
      return;
    }

    // 考査手続の終了（非active化）
    if (btn.id === 'exam-m-deactivate') {
      if (!window.confirm('この考査の手続を終了（非active化）します。よろしいですか？')) return;
      btn.disabled = true;
      try {
        await examApi.post(`/exam/${examStore.examId}/deactivate`, {});
        examStore.examId = null;
        examStore.board = null;
        examStore.masters = [];
        showToast('考査手続を終了しました', 'info');
        const next = await resolveActiveExamId();
        if (next) {
          examStore.examId = next;
          await reload();
        } else {
          renderMasterTab(container);
        }
      } catch (err) {
        showToast(err.message || '手続終了に失敗しました', 'error');
        btn.disabled = false;
      }
    }
  });
}

export default { renderMasterTab, bindMasterTab };

