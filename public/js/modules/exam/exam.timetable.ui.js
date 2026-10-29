/**
 * ISSystem 定期考査 時間割作成タブ
 * ルール設定 → 自動作成（MRV+DFS+局所交換ソルバー）→ グリッド表示 → 手動編集 → 公表／公表終了
 */

import {
  examStore,
  examApi,
  sectionCard,
  diagnosticsHtml,
  unitsForGrade,
  slotPositions,
  cellUnit,
  escapeHTML,
  refreshLucideIcons,
  showToast,
  isKyomuUser,
} from './exam.shared.js';

const RULE_ITEMS = [
  { key: 'first_period_all', label: '1限目は生徒全員が受ける科目でなければならない', hard: true },
  { key: 'last_day_all', label: '最終日は全コマを「全員が受ける科目」で埋める', hard: true },
  { key: 'day_stream_mix', label: '同じ日の試験を「すべて理系」「すべて文系」にしない', hard: false },
  { key: 'balance_even', label: '同一科目が前半・後半に偏らないよう均等化する', hard: false },
  { key: 'history_balance', label: '過去の試験日と照らし合わせて、同一科目の偏りを抑える', hard: false },
];

const WEIGHT_ITEMS = [
  { key: 'stream_mix', label: '文理混合', def: 120 },
  { key: 'balance', label: '前後半均等', def: 45 },
  { key: 'history', label: '過去分布照合', def: 30 },
];

/** 配置マップ: unitKey(planId#grade) → {key, grade, day, slot, span, subject_name, setter} */
let unitPos = new Map();
let lastSolve = null;
let manualDiag = null;

/** plan行 → 配置キー（ソルバーの unit_id と同一形式） */
function unitKeyFor(p, grade) {
  return `${p.id}#${grade}`;
}

/** 直近のソルバー結果を配置マップに反映（保存済みスロットも併せて復元） */
function applySolveResult(result, plan, slots) {
  unitPos = slotPositions(slots);
  if (result && Array.isArray(result.assignments)) {
    for (const a of result.assignments) {
      const key = a.unit_id;
      if (!key) continue;
      const p = plan.find((x) => String(x.id) === String(key.split('#')[0]));
      unitPos.set(key, {
        key,
        grade: Number(a.grade),
        day: Number(a.day),
        slot: Number(a.slot),
        span: Number(a.duration_slots) || 1,
        subject_name: a.subject_name || p?.subject_name || key,
        setter: p?.setter_teacher_name || null,
      });
    }
  }
}

function rulesFormHtml(rules, editable) {
  const dis = editable ? '' : 'disabled';
  const boxes = RULE_ITEMS.map((r) => {
    const on = rules[r.key] !== false;
    return `<label class="flex items-start gap-2 text-[11px] text-soft cursor-pointer">
        <input type="checkbox" data-rule="${r.key}" ${on ? 'checked' : ''} ${dis} class="rounded mt-0.5">
        <span>
          <span class="font-semibold ${r.hard ? 'text-danger-strong' : 'text-warning-strong'}">${escapeHTML(r.label)}</span>
          <span class="text-muted block text-[10px]">${r.hard ? 'HARD 制約（満たせない場合は軟制約へ緩和して探索）' : 'SOFT 制約（重み付き）'}</span>
        </span>
      </label>`;
  }).join('');

  const weights = WEIGHT_ITEMS.map((w) => {
    const val = rules.weights && rules.weights[w.key] != null ? rules.weights[w.key] : w.def;
    return `<div class="flex items-center gap-2">
        <label class="text-[10px] text-muted w-20">${w.label}</label>
        <input type="number" data-weight="${w.key}" value="${val}" min="0" max="1000" step="5" ${dis}
               class="input-field w-16 py-1 text-[11px] text-center">
      </div>`;
  }).join('');

  return sectionCard(
    'sliders',
    '時間割の制約ルール',
    '教務権限者のみ編集できます。保存後に「時間割を作成」で自動配置します。',
    `<div class="grid grid-cols-1 md:grid-cols-2 gap-2">${boxes}</div>
     <div class="flex flex-wrap gap-4 pt-1">${weights}</div>

function phaseBadgeSmall(phase) {
  const meta = {
    DRAFT: ['作成中', 'bg-surface text-muted border border-main'],
    SURVEY: ['調査中', 'bg-warning-soft text-warning-strong border border-warning-soft'],
    PUBLISHED: ['公表中', 'bg-success-soft text-success-strong border border-success-soft'],
    ENDED: ['終了', 'bg-danger-soft text-danger-strong border border-danger-soft'],
  }[phase] || ['作成中', 'bg-surface text-muted border border-main'];
  return `<span class="badge text-[10px] px-1.5 py-0.5 rounded font-bold ${meta[1]}">${meta[0]}</span>`;
}

function toolbarHtml(master, editable, phase) {
  const days = Number(master.days_count) || 0;
  const slots = Number(master.daily_slots) || 0;
  const grades = (master.grades || []).map((g) => `${g}年`).join(' / ');
  const kyomu = isKyomuUser();
  return `<div class="card p-4 space-y-2">
    <div class="flex flex-wrap items-center gap-3 text-[11px] text-muted">
      <span class="font-bold text-main">期間 ${escapeHTML(master.start_date)} 〜 ${escapeHTML(master.end_date)}</span>
      <span>${days}日間 × ${slots}時限 / ${grades}</span>
      ${phaseBadgeSmall(phase)}
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <button id="exam-tt-solve" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${editable ? '' : 'disabled'}>
        <i data-lucide="wand-2" class="w-3.5 h-3.5"></i> 時間割を作成
      </button>
      <button id="exam-tt-save-manual" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${editable ? '' : 'disabled'}>
        <i data-lucide="pencil" class="w-3.5 h-3.5"></i> 手動編集を保存
      </button>
      <button id="exam-tt-publish" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu && phase !== 'ENDED' ? '' : 'disabled'}>
        <i data-lucide="megaphone" class="w-3.5 h-3.5"></i> 公表
      </button>
      <button id="exam-tt-end" class="btn-danger py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
        <i data-lucide="lock" class="w-3.5 h-3.5"></i> 公表終了
      </button>
      <span class="text-[10px] text-muted ml-auto">${kyomu ? '教務：全タブ編集可' : '教員：公表閲覧のみ'}</span>
    </div>
    ${editable
      ? `<p class="text-[10px] text-muted">セルの科目を教務権限者が差し替えられます（保存時に制約チェックが走り、違反は表示されます）。</p>`
      : `<p class="text-[10px] text-muted">公表中のグリッドは閲覧のみです。編集は教務権限者に行ってください。</p>`}
  </div>`;
}

function periodLabel(master, s) {
  const periods = master.period_times || [];
  const p = periods.find((x) => Number(x.slot ?? x.slot_number) === s);
  if (!p) return '';
  const a = p.start || p.from;
  const b = p.end || p.to;
  return a && b ? `<span class="text-[9px] text-muted block">${escapeHTML(a)}〜${escapeHTML(b)}</span>` : '';
}

function cellPickerHtml(units, g, d, s, selected, editable) {
  if (!editable) return '';
  const opts = units
    .map((p) => {
      const label = `${escapeHTML(p.subject_name)}${Number(p.duration_slots) > 1 ? ` (${p.duration_slots}時限)` : ''}`;
      return `<option value="${unitKeyFor(p, g)}" ${unitKeyFor(p, g) === selected ? 'selected' : ''}>${label}</option>`;
    })
    .join('');
  return `<select data-cell-grade="${g}" data-cell-day="${d}" data-cell-slot="${s}"
              class="input-field w-full py-1 text-[10px] bg-transparent border border-dashed border-main">
          <option value="">（空）</option>${opts}
        </select>`;
}

function gridSectionHtml(master, plan, editable) {
  const days = Number(master.days_count) || 0;
  const slots = Number(master.daily_slots) || 0;

  const tables = (master.grades || [])
    .map((g) => {
      const units = unitsForGrade(plan, g);
      const header = `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">日</th>
        ${Array.from({ length: slots }, (_, i) => i + 1)
          .map((s) => `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">${s}限${periodLabel(master, s)}</th>`)
          .join('')}`;

      const rows = Array.from({ length: days }, (_, di) => di + 1)
        .map((d) => {
          const cells = Array.from({ length: slots }, (_, si) => si + 1)
            .map((s) => {
              const u = cellUnit(unitPos, g, d, s);
              if (!u) {
                return `<td class="border border-divider p-1 align-top">${cellPickerHtml(units, g, d, s, '', editable) || '<span class="text-[10px] text-muted">空</span>'}</td>`;
              }
              if (!u.isStart) {
                return `<td class="border border-divider p-1 align-top bg-accent-inset">
                    <span class="text-[10px] text-accent-strong font-bold">↳ ${escapeHTML(u.subject_name)} 継続</span>
                  </td>`;
              }
              const spanBadge = u.span > 1 ? `<span class="badge bg-accent-soft text-accent-strong text-[9px] px-1">${u.span}時限</span>` : '';
              const setterLine = u.setter ? `<span class="text-[9px] text-muted block">${escapeHTML(u.setter)} 出題</span>` : '';
              const inner = editable
                ? `${cellPickerHtml(units, g, d, s, u.key, editable)}${setterLine}${spanBadge}`
                : `<span class="text-[11px] font-bold text-main block">${escapeHTML(u.subject_name)} ${spanBadge}</span>${setterLine}`;
              return `<td class="border border-divider p-1 align-top">${inner}</td>`;
            })
            .join('');
          return `<tr class="border-t border-divider"><th class="px-2 py-1.5 text-[10px] font-bold text-main bg-inset">${d}日目</th>${cells}</tr>`;
        })
        .join('');

      return `<div class="mt-2">
          <h4 class="text-xs font-bold text-main mb-1">${g}学年 の時間割</h4>
          <div class="overflow-x-auto">
            <table class="w-full text-left border-collapse min-w-[640px]"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table>
          </div>
        </div>`;
    })
    .join('');

  return sectionCard('grid-3x3', '時間割グリッド', '日 × 時限 × 学年。数学Ⅲ（100分＝2時限）は連結表示されます。', tables);
}

     ${editable
       ? `<div class="flex gap-2 pt-1">
            <button id="exam-tt-rules-save" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1">
              <i data-lucide="save" class="w-3.5 h-3.5"></i> ルールを保存
            </button>
          </div>`
       : `<p class="text-[10px] text-muted">ルール編集は教務権限者のみです。</p>`}`
  );
}

function resultSectionHtml() {
  const parts = [];
  if (lastSolve) {
    const r = lastSolve;
    const stats = r.stats || {};
    const diag = r.diagnostics || {};
    const statsLine = `<div class="flex flex-wrap gap-3 text-[11px] text-soft">
        <span>充填率 <strong class="text-accent-strong">${stats.fillRate ?? 0}%</strong></span>
        <span>未配置 <strong class="${stats.unplacedUnits ? 'text-danger-strong' : 'text-success-strong'}">${stats.unplacedUnits ?? 0}</strong> 単位</span>
        <span>ペナルティ <strong class="text-warning-strong">${r.penalty ?? 0}</strong></span>
        <span>保存 ${r.saved ?? 0} コマ</span>
        ${r.relaxed ? `<span class="text-danger-strong">※ 1限／最終日の HARD 制約を軟制約へ緩和して構成しました</span>` : ''}
        ${r.feasible === false ? `<span class="text-danger-strong">※ HARD 制約下の完全配置が見つかりませんでした</span>` : ''}
      </div>`;
    parts.push(sectionCard('activity', '自動作成結果', 'MRV順序付け + 深さ優先探索 + 局所交換（乱数不使用・決定的）',
      `${statsLine}${diagnosticsHtml([...(diag.hard || []), ...(diag.soft || [])])}`));
  }
  if (manualDiag) {
    const hard = manualDiag.hard || [];
    const soft = manualDiag.soft || [];
    parts.push(sectionCard('shield-alert', `手動編集の制約チェック（保存 ${manualDiag.saved ?? 0} コマ）`,
      hard.length ? 'HARD 違反があります。グリッドを調整してください。' : 'HARD 違反はありません。',
      diagnosticsHtml([...hard, ...soft])));
  }
  return parts.join('');
}

/** 配置マップ → 保存用スロット行 */
function buildSlotRows() {
  const plan = examStore.board?.subject_plan || [];
  return [...unitPos.values()].map((p) => {
    const planId = String(p.key).split('#')[0];
    const row = plan.find((x) => String(x.id) === planId);
    return {
      class_id: `G${p.grade}`,
      grade: p.grade,
      subject_id: p.key,
      subject_name: p.subject_name,
      subject_teacher_id: row?.setter_teacher_id ?? null,
      setter_teacher_name: row?.setter_teacher_name ?? p.setter ?? null,
      day_number: p.day,
      slot_number: p.slot,
      slot_span: p.span,
      room_type: 'CLASS',
    };
  });
}

export function renderTimetableTab(container) {
  const board = examStore.board;
  if (!board) {
    container.innerHTML = `<div class="card p-6 text-center text-xs text-muted">考査データを読み込み中…</div>`;
    return;
  }
  unitPos = slotPositions(board.slots);
  const master = board.master;
  const plan = board.subject_plan || [];
  const editable = board.editable.timetable;
  const phase = board.phases.timetable_phase;

  container.innerHTML = `
    ${rulesFormHtml(board.timetable_rules || {}, editable)}
    ${toolbarHtml(master, editable, phase)}
    ${gridSectionHtml(master, plan, editable)}
    ${resultSectionHtml()}
  `;
  refreshLucideIcons();

/**
 * 時間割タブのイベント绑定
 * @param {HTMLElement} container
 * @param {Function} reload 考査ボード再取得（board 更新）
 */
export function bindTimetableTab(container, reload) {
  const rerender = async () => {
    await reload();
    renderTimetableTab(container);
  };

  container.addEventListener('change', (e) => {
    const sel = e.target.closest('[data-cell-grade]');
    if (!sel) return;
    const g = Number(sel.dataset.cellGrade);
    const d = Number(sel.dataset.cellDay);
    const s = Number(sel.dataset.cellSlot);
    const key = sel.value;
    const occupant = cellUnit(unitPos, g, d, s);
    if (occupant && occupant.key !== key) unitPos.delete(occupant.key);
    if (key) {
      const plan = examStore.board?.subject_plan || [];
      const p = plan.find((x) => unitKeyFor(x, g) === key);
      const span = Number(p?.duration_slots) || 1;
      for (const [k, pos] of [...unitPos.entries()]) {
        if (pos.grade === g && pos.day === d && pos.slot < s + span && pos.slot + pos.span > s && k !== key) {
          unitPos.delete(k);
        }
      }
      unitPos.set(key, {
        key,
        grade: g,
        day: d,
        slot: s,
        span,
        subject_name: p?.subject_name || key,
        setter: p?.setter_teacher_name || null,
      });
    }
    renderTimetableTab(container);
  });

  container.querySelector('#exam-tt-rules-save')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const rules = { ...(examStore.board.timetable_rules || {}) };
    rules.weights = { ...(rules.weights || {}) };
    container.querySelectorAll('[data-rule]').forEach((cb) => (rules[cb.dataset.rule] = cb.checked));
    container.querySelectorAll('[data-weight]').forEach((n) => (rules.weights[n.dataset.weight] = Number(n.value) || 0));
    btn.disabled = true;
    try {
      await examApi.post(`/exam/${examStore.examId}/timetable-rules`, rules);
      showToast('時間割ルールを保存しました', 'success');
      await rerender();
    } catch (err) {
      showToast(err.message || 'ルール保存に失敗しました', 'error');
      btn.disabled = false;
    }
  });

  container.querySelector('#exam-tt-solve')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const result = await examApi.post(`/exam/${examStore.examId}/timetable`, {});
      lastSolve = result;
      manualDiag = null;
      const board = await reload();
      applySolveResult(result, board.subject_plan || [], board.slots || []);
      renderTimetableTab(container);
      const st = result.stats || {};
      showToast(
        result.saved
          ? `時間割を ${result.saved} コマ 作成（充填率 ${st.fillRate}% / 未配置 ${st.unplacedUnits}）`
          : '配置可能な時間割が見つかりませんでした',
        result.saved && st.unplacedUnits === 0 ? 'success' : 'warning'
      );
    } catch (err) {
      showToast(err.message || '時間割作成に失敗しました', 'error');
      btn.disabled = false;
    }
  });

  container.querySelector('#exam-tt-save-manual')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const rows = buildSlotRows();
    if (rows.length === 0) {
      showToast('配置されているコマがありません。', 'warning');
      return;
    }
    btn.disabled = true;
    try {
      const data = await examApi.post(`/exam/${examStore.examId}/timetable/slots`, rows);
      manualDiag = data.diagnostics || { hard: [], soft: [] };
      await rerender();
      const hard = (data.violations || []).length;
      showToast(hard ? `保存しました（HARD 違反 ${hard} 件）` : `手動編集を ${data.saved} コマ 保存しました`, hard ? 'warning' : 'success');
    } catch (err) {
      showToast(err.message || '手動編集の保存に失敗しました', 'error');
      btn.disabled = false;
    }
  });

  container.querySelector('#exam-tt-publish')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!window.confirm('時間割を全員に公表します。よろしいですか？')) return;
    btn.disabled = true;
    try {
      await examApi.post(`/exam/${examStore.examId}/timetable/publish`, {});
      showToast('時間割を公表しました（全員に表示）', 'success');
      await rerender();
    } catch (err) {
      showToast(err.message || '公表に失敗しました', 'error');
      btn.disabled = false;
    }
  });

  container.querySelector('#exam-tt-end')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (!window.confirm('公表を終了します。以後は教務権限者のみ編集可能になります。よろしいですか？')) return;
    btn.disabled = true;
    try {
      await examApi.post(`/exam/${examStore.examId}/timetable/end`, {});
      showToast('時間割フェーズを終了しました（以後 教務のみ編集可）', 'info');
      await rerender();
    } catch (err) {
      showToast(err.message || '公表終了に失敗しました', 'error');
      btn.disabled = false;
    }
  });
}

export default { renderTimetableTab, bindTimetableTab, resetTimetableState };

}

export function resetTimetableState() {
  lastSolve = null;
  manualDiag = null;
  unitPos = new Map();
}

