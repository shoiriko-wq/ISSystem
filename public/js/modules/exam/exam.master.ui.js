/**
 * ISSystem 定期考査 年間の考査名登録セクション（年間考査計画タブの ① に統合）
 * ① では考査名のみ登録する（１年間に実施する考査名をすべて登録する）
 * 対象学年の設定は不要（② の実施科目調査で実施教科が揃い、対象学年はそこから導出される）
 * 開始日・終了日・1日の時限数・標準試験時間は ③ 考査期間の登録で設定する
 * 使用教室リストは 教室割の作成 タブで扱う（年間考査計画には表示しない）
 * 独立タブを持たず、exam.plan.ui.js の renderPlanTab / bindPlanTab から呼ばれる
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

/** 年度表示（開始日の西暦 → academic_year → 今年） */
function yearOf(masters) {
  for (const m of masters || []) {
    const y = Number(String(m.start_date || '').slice(0, 4)) || Number(m.academic_year) || 0;
    if (y) return y;
  }
  return new Date().getFullYear();
}

/** 行の期間表示（③ の登録状況） */
function periodCell(m) {
  if (!m.id) return '<span class="text-[10px] text-muted">未保存行（登録で追加）</span>';
  if (!m.start_date || !m.end_date) return '<span class="text-[10px] text-warning-strong font-semibold">③ 期間未登録</span>';
  const d1 = String(m.start_date).slice(0, 10);
  const d2 = String(m.end_date).slice(0, 10);
  return `<span class="text-[11px] text-soft">${escapeHTML(d1)} 〜 ${escapeHTML(d2)} ／ ${Number(m.days_count) || 0}日 × ${Number(m.daily_slots) || 0}時限</span>`;
}

/** 考査名行（未保存行は data-exam-row-id="" で表す） */
function examRowHtml(m, kyomu, activeId) {
  const dis = kyomu ? '' : 'disabled';
  const isActive = !!m.id && String(m.id) === String(activeId);
  const status = isActive
    ? '<span class="badge bg-warning-soft border border-warning-soft text-warning-strong text-[10px] px-1.5 py-0.5 rounded font-bold">作業中の考査</span>'
    : m.id
      ? `<button data-exam-open="${escapeHTML(String(m.id))}" class="btn-secondary py-1 px-2 text-[10px]" ${kyomu ? '' : 'disabled'}>この考査を開く</button>`
      : '<span class="text-[10px] text-muted">新規行</span>';
  const ops = m.id
    ? `<button data-exam-end="${escapeHTML(String(m.id))}" class="text-[10px] text-danger-strong" ${kyomu ? '' : 'disabled'}>手続終了</button>`
    : '<button data-exam-remove class="text-[10px] text-danger-strong">削除</button>';
  return `<tr data-exam-row-id="${escapeHTML(String(m.id || ''))}">
    <td class="border border-divider p-1.5"><input data-exam-name value="${escapeHTML(m.title || '')}" ${dis} class="input-field w-full py-1 text-[11px]" placeholder="例: 2026年度 1学期中間考査" /></td>
    <td class="border border-divider p-1.5">${periodCell(m)}</td>
    <td class="border border-divider p-1.5 text-center">${status}</td>
    <td class="border border-divider p-1.5 text-center">${ops}</td>
  </tr>`;
}

/** ① 年間の考査名登録セクション（考査名のみ、行追加で1年分をまとめて登録） */
export function examFormHtml(masters, kyomu) {
  const list = (masters || []).filter((m) => m && m.id);
  const year = yearOf(list);
  const rows = list.map((m) => examRowHtml(m, kyomu, examStore.examId)).join('');
  const body =
    rows ||
    '<tr><td colspan="4" class="p-2 text-[11px] text-muted border border-divider">考査名が登録されていません。「行を追加」→「考査名を登録／更新」で年間の考査名を登録してください。</td></tr>';

  return sectionCard(
    'file-plus',
    `① 年間の考査名登録（${year}年度）`,
    '１年間に実施する考査名をすべて登録します。入力は考査名だけです（対象学年の設定は不要で、② の実施科目調査で実施教科が揃い、開始日・終了日・1日の時限数・標準試験時間は ③ で設定します）。',
    `<div class="overflow-x-auto">
       <table class="w-full text-left border-collapse min-w-[620px]">
         <thead><tr>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">考査名</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">考査期間（③ の登録状況）</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">状態</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">操作</th>
         </tr></thead>
         <tbody id="exam-names-body">${body}</tbody>
       </table>
     </div>
     <div class="flex flex-wrap items-center gap-2">
       <button id="exam-names-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="plus" class="w-3.5 h-3.5"></i> 行を追加
       </button>
       <button id="exam-names-save" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="save" class="w-3.5 h-3.5"></i> 考査名を登録／更新
       </button>
       <span class="text-[10px] text-muted ml-auto">教務権限者のみ編集可・行追加後は「登録／更新」が必要です</span>
     </div>`,
    phaseBadge(examStore.board?.phases?.plan_phase || 'DRAFT')
  );
}

/** 考査が1件も残っていないときの ① セクション（考査名登録のみ） */
export function renderMasterSection(container) {
  const kyomu = isKyomuUser();
  container.innerHTML = `${examFormHtml(examStore.masters || [], kyomu)}
    <div class="card-static p-3 text-[11px] text-muted flex items-center gap-2">
      <i data-lucide="info" class="w-4 h-4 shrink-0"></i>
      ① で考査名を登録すると、② 実施科目調査 → ③ 考査期間の登録 へ進めます（使用教室は 教室割の作成 タブで登録します）。
    </div>`;
  refreshLucideIcons();
}

/** 行から {id, title} を収集する（考査名のみ） */
function collectExamRows(container) {
  return [...container.querySelectorAll('tr[data-exam-row-id]')]
    .map((tr) => ({
      id: tr.dataset.examRowId || null,
      title: (tr.querySelector('[data-exam-name]')?.value || '').trim(),
    }))
    .filter((r) => r.title);
}

export function bindMasterSection(container, reload) {
  if (container.dataset.bound === 'master') return;
  container.dataset.bound = 'master';

  container.addEventListener('click', async (e) => {
    // ① 行追加（未保存の空白行）
    if (e.target.closest('#exam-names-add')) {
      const body = container.querySelector('#exam-names-body');
      if (!body) return;
      const placeholder = body.querySelector('td[colspan]');
      if (placeholder) placeholder.closest('tr').remove();
      body.insertAdjacentHTML('beforeend', examRowHtml({ title: '' }, isKyomuUser(), examStore.examId));
      refreshLucideIcons();
      return;
    }

    // 未保存行の削除
    const rm = e.target.closest('[data-exam-remove]');
    if (rm) {
      rm.closest('tr')?.remove();
      return;
    }

    // 行の考査を作業対象として開く（ヘッダの対象考査も切り替わる）
    const openBtn = e.target.closest('[data-exam-open]');
    if (openBtn) {
      examStore.examId = openBtn.dataset.examOpen;
      showToast('対象考査を切り替えました', 'info');
      await reload();
      return;
    }

    // 考査手続の終了（非active化）
    const endBtn = e.target.closest('[data-exam-end]');
    if (endBtn) {
      const id = endBtn.dataset.examEnd;
      if (!window.confirm('この考査の手続を終了（非active化）します。よろしいですか？')) return;
      endBtn.disabled = true;
      try {
        await examApi.post(`/exam/${id}/deactivate`, {});
        if (String(id) === String(examStore.examId)) {
          examStore.examId = null;
          examStore.board = null;
        }
        examStore.masters = [];
        const next = await resolveActiveExamId();
        examStore.examId = next;
        showToast('考査手続を終了しました', 'info');
        if (next) await reload();
        else renderMasterSection(container);
      } catch (err) {
        showToast(err.message || '手続終了に失敗しました', 'error');
        endBtn.disabled = false;
      }
      return;
    }

    // ① 考査名の登録／更新（考査名のみ）
    const saveBtn = e.target.closest('#exam-names-save');
    if (saveBtn) {
      const rows = collectExamRows(container);
      if (!rows.length) {
        showToast('登録する考査名を入力してください。', 'warning');
        return;
      }
      saveBtn.disabled = true;
      try {
        const created = [];
        for (const r of rows) {
          if (r.id) await examApi.put(`/exam/${r.id}`, { title: r.title });
          else created.push(await examApi.post('/exam', { title: r.title }));
        }
        if (!examStore.examId && created.length) examStore.examId = created[0].id;
        examStore.masters = [];
        await resolveActiveExamId();
        showToast(
          created.length
            ? `考査名を ${created.length}件 登録しました（各行で ② 調査開始 → ③ 期間登録へ進めます）`
            : '考査名を更新しました',
          'success'
        );
        await reload();
      } catch (err) {
        showToast(err.message || '考査名の登録に失敗しました', 'error');
        saveBtn.disabled = false;
      }
      return;
    }
  });
}

export default { renderMasterSection, examFormHtml, bindMasterSection };
