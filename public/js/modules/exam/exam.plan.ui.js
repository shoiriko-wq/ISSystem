/**
 * ISSystem 定期考査 年間考査計画 UI (教務部 KYOMU)
 * 作業順をステッパーで表示する:
 *   ① 年間の考査名登録（考査名のみ。1年間に実施する考査名をすべて登録する）
 *   ② 実施科目調査（調査開始で科目・実施時間・出題者/巡回者・実施コース・要望が全教員に編集可能、
 *      調査終了後は教務のみ編集。学年・教科で表示を絞って編集できる）
 *   ③ 考査期間の登録（考査名ごとに開始日・終了日・1日の時限数・標準試験時間を登録する。
 *      年度と試験日数は開始日から自動算出されるため入力不要、使用教室は 教室割の作成 タブで扱う）
 * plan_phase: DRAFT(計画) → SURVEY(調査) → REGISTERED(期間登録) → DECIDED(科目確定)
 * メニュー順: 基本情報の登録 → 年間考査計画 → 実施科目調査 → 時間割 → 教室割 → 出張等 → 監督割
 */

import { examStore, examApi, resolveActiveExamId, sectionCard, phaseBadge, isKyomuUser } from './exam.shared.js';
import { examFormHtml, bindMasterSection } from './exam.master.ui.js';
import { renderSurveySection, bindSurveySection } from './exam.subject.ui.js';
import { escapeHTML, refreshLucideIcons, showToast } from '../../ui-helpers.js';

const PLAN_PHASES = {
  DRAFT: { label: '計画', cls: 'bg-surface text-muted border border-main' },
  REGISTERED: { label: '期間登録済', cls: 'bg-accent-soft text-accent-strong border border-accent-soft' },
  SURVEY: { label: '調査中', cls: 'bg-warning-soft text-warning-strong border border-warning-soft' },
  DECIDED: { label: '科目確定', cls: 'bg-success-soft text-success-strong border border-success-soft' },
};

function phaseBadgePlan(phase) {
  const meta = PLAN_PHASES[phase] || PLAN_PHASES.DRAFT;
  return `<span class="badge text-[10px] px-1.5 py-0.5 rounded font-bold ${meta.cls}">${meta.label}</span>`;
}

function field(label, inner) {
  return `<div class="flex flex-col gap-1"><span class="text-[10px] text-muted font-semibold">${label}</span>${inner}</div>`;
}

/** 開始日〜終了日の暦日日数（試験日数の自動算出・年度は開始日の西暦） */
function daysBetween(start, end) {
  if (!start || !end) return 0;
  const s = new Date(String(start).slice(0, 10));
  const e = new Date(String(end).slice(0, 10));
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e < s) return 0;
  let n = 0;
  const cur = new Date(s);
  while (cur <= e) {
    n += 1;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

const STEPS = [
  { n: 1, title: '年間の考査名登録', desc: '1年間に実施する考査名をすべて登録（考査名のみ）', icon: 'file-plus' },
  { n: 2, title: '実施科目調査', desc: '調査開始で全教員が編集（科目・実施時間・出題者/巡回者・コース・要望）、学年・教科で絞って表示', icon: 'list-checks' },
  { n: 3, title: '考査期間の登録', desc: '考査名ごとに開始日・終了日・1日の時限数・標準試験時間を登録', icon: 'calendar-check' },
];

/** ①→②→③ の進行状態（master 有無・subject_phase・plan_phase から判定） */
function stepState(board) {
  const phases = board?.phases || {};
  const subject = phases.subject_phase || 'DRAFT';
  const plan = phases.plan_phase || 'DRAFT';
  const done1 = !!board?.master;
  const done2 = subject === 'ENDED';
  const done3 = plan === 'REGISTERED' || plan === 'DECIDED';
  return {
    1: { done: done1, active: !done1 },
    2: { done: done2, active: done1 && !done2 },
    3: { done: done3, active: done1 && done2 && !done3 },
  };
}

function stepperHtml(board) {
  const st = stepState(board);
  const cls = (s) =>
    s.done
      ? 'bg-success-soft text-success-strong border border-success-soft'
      : s.active
        ? 'bg-warning-soft text-warning-strong border border-warning-soft'
        : 'bg-surface text-muted border border-main';
  const chip = STEPS.map((s) => {
    const label = st[s.n].done ? '完了' : st[s.n].active ? '作業中' : '未着手';
    return `<div class="flex items-center gap-2 px-3 py-2 rounded-lg border text-[11px] font-semibold ${cls(st[s.n])}">
      <i data-lucide="${s.icon}" class="w-4 h-4 shrink-0"></i>
      <span class="text-[13px] font-bold">${s.n}</span>
      <span>${s.title}<br /><span class="font-normal text-[10px] opacity-80">${s.desc}</span></span>
      <span class="text-[10px] font-bold ml-auto">${label}</span>
    </div>`;
  });
  return `<div class="card p-3 space-y-2">
    <div class="text-[10px] text-muted font-semibold">作業順どりに進めてください：① 年間の考査名登録 → ② 実施科目調査（調査開始／終了）→ ③ 考査期間の登録（考査名ごとに開始日・終了日・1日の時限数・標準試験時間）</div>
    <div class="flex flex-wrap items-center gap-2">${chip.join('<span class="text-muted text-[11px]">→</span>')}</div>
  </div>`;
}

/** ② で編集する項目（調査開始で全教員に表示される） */
const SURVEY_ITEMS = [
  '試験を実施する科目（基本情報から選択）',
  '実施時間（デフォルト50分、デフォルト値は教務のみ変更）',
  '出題者・巡回者（ここでは仮登録、考査前に修正可能）',
  '実施するコース（基本情報をデフォルト表示）',
  '要望（テキストで情報を収集）',
];

function actButton(act, label, icon, enabled, btnCls) {
  return `<button data-plan-act="${act}" class="${btnCls} py-1.5 px-3 text-[11px] flex items-center gap-1" ${enabled ? '' : 'disabled'}>
    <i data-lucide="${icon}" class="w-3.5 h-3.5"></i> ${label}
  </button>`;
}

/** ② の調査開始／終了ボタン（① の登録が完了するまで調査開始は押せない、入力は下部のグリッドで行う） */
function surveyButtonsHtml(kyomu, board) {
  const subject = board?.phases?.subject_phase || 'DRAFT';
  const registered = !!board?.master;
  const startable = kyomu && registered && subject !== 'SURVEY';
  const endable = kyomu && subject === 'SURVEY';
  return `<div class="flex flex-wrap items-center gap-2">
    ${actButton('survey-start', '② 調査開始', 'play', startable, 'btn-primary')}
    ${actButton('survey-end', '② 調査終了', 'stop-circle', endable, 'btn-danger')}
    <span class="text-[10px] text-muted">調査開始で下の調査グリッドが全教員に編集可能になります（調査終了後は教務のみ編集可）。入力は下のグリッドで行い、決定は「実施科目の決定」タブで行います。</span>
  </div>
  ${registered ? '' : '<p class="text-[11px] text-warning-strong font-semibold">① で考査名が登録されるまで調査開始は押せません。</p>'}`;
}

/** 考査名ごとの ② 調査状況と決定状況の一覧（考査名ごとに ② の調査を入力するため一覧化する） */
function examStatusHtml(board) {
  const list = board?.exam_survey_status || [];
  const activeId = String(board?.master?.id ?? '');
  if (!list.length) return '<p class="text-[11px] text-muted">① で考査名が登録されると考査名ごとの調査状況が一覧表示されます。</p>';
  const rows = list.map((s) => {
    const active = String(s.id) === activeId;
    const period = `${String(s.start_date ?? '').slice(0, 10)}〜${String(s.end_date ?? '').slice(0, 10)}`;
    return `<tr class="border-t border-main/10 ${active ? 'bg-accent-soft' : ''}">
      <td class="px-1 py-1 font-semibold text-main">${escapeHTML(String(s.title ?? ''))}${active ? ' <span class="badge bg-accent-soft text-accent-strong text-[9px] px-1 rounded font-bold">対象考査</span>' : ''}</td>
      <td class="px-1 py-1 text-soft">${escapeHTML(period)}</td>
      <td class="px-1 py-1">${s.plan_rows} コマ</td>
      <td class="px-1 py-1 ${s.plan_rows > 0 && s.submitted >= s.plan_rows ? 'text-success-strong' : 'text-warning-strong'}">${s.submitted}/${s.plan_rows}</td>
      <td class="px-1 py-1 ${s.requests ? 'text-warning-strong' : 'text-muted'}">${s.requests} 件</td>
      <td class="px-1 py-1">${s.decision_rows} コマ</td>
      <td class="px-1 py-1 ${s.decision_rows > 0 && s.decided >= s.decision_rows ? 'text-success-strong' : 'text-muted'}">${s.decided}</td>
    </tr>`;
  });
  return `<div class="overflow-x-auto"><table class="w-full text-[11px]">
    <thead><tr class="text-muted text-[10px]">
      <th class="px-1 pb-1 font-semibold text-left">考査名</th>
      <th class="px-1 pb-1 font-semibold text-left">期間</th>
      <th class="px-1 pb-1 font-semibold text-left">② の計画値（調査入力）</th>
      <th class="px-1 pb-1 font-semibold text-left">提出</th>
      <th class="px-1 pb-1 font-semibold text-left">要望</th>
      <th class="px-1 pb-1 font-semibold text-left">決定行数</th>
      <th class="px-1 pb-1 font-semibold text-left">確定</th>
    </tr></thead>
    <tbody>${rows.join('')}</tbody>
  </table></div>`;
}

/** ③ 考査期間の登録（② の実施教科数を見て期間・試験日数・1日のコマ数を決定する） */
function periodCard(kyomu) {
  const board = examStore.board;
  const master = board?.master || {};
  const phases = board?.phases || {};
  const planPhase = phases.plan_phase || 'DRAFT';
  const subjectPhase = phases.subject_phase || 'DRAFT';
  const surveyEnded = subjectPhase === 'ENDED';
  const editable = kyomu && planPhase !== 'DECIDED';

  const input = (name, value, attrs = 'type="number"') =>
    `<input id="plan-${name}" value="${escapeHTML(String(value ?? ''))}" class="input-field py-1.5 px-2 text-xs w-24" ${attrs} ${editable ? '' : 'disabled'} />`;

  const summary = board?.survey_summary || null;
  const perGrade = summary?.per_grade || [];
  const datesSet = !!master.start_date && !!master.end_date;
  const neededMax = perGrade.reduce((m, g) => Math.max(m, Number(g.needed_slots) || 0), 0);
  const capacity = Number(summary?.capacity_slots) || (Number(master.days_count) || 0) * (Number(master.daily_slots) || 0);

  const gradeView = perGrade.length
    ? `<div class="flex flex-wrap gap-2 text-[11px] pt-1">
        ${perGrade
          .map(
            (g) => `<span class="badge px-2 py-1 rounded border ${
              !datesSet
                ? 'bg-surface text-muted border border-main'
                : g.feasible
                  ? 'bg-success-soft text-success-strong border-success-soft'
                  : 'bg-danger-soft text-danger-strong border-danger-soft'
            }">${g.grade}年: 実施 ${g.subjects}科目 / 必要 ${g.needed_slots}コマ${datesSet ? ` ／ キャパ ${g.capacity_slots}コマ` : ''}</span>`,
          )
          .join('')}
      </div>`
    : '<p class="text-[11px] text-muted">② の調査開始後に実施教科数・必要コマ数が集計されます。</p>';

  const actionRow = `
    <div class="flex flex-wrap items-center gap-2 text-[11px] pt-1">
      ${actButton('register', '期間登録', 'calendar-check', kyomu, 'btn-warning border border-warning-soft text-warning-strong')}
      ${actButton('decide', '実施科目確定', 'stamp', kyomu && planPhase !== 'DECIDED', 'btn-success border border-success-soft text-success-strong')}
      <span class="text-muted">実施科目確定は全科目提出後に教務が行います</span>
    </div>
    ${surveyEnded ? '' : '<p class="text-[11px] text-warning-strong font-semibold">② の実施科目調査を終了してから期間を登録してください（要望・実施教科数が揃います）。</p>'}
    ${
      datesSet && perGrade.length
        ? `<div class="text-[11px] text-muted pt-1">最多学年の必要 ${neededMax}コマ ≤ 期間キャパ ${capacity}コマ ${
            neededMax <= capacity ? '<b class="text-success-strong">収まります</b>' : '<b class="text-danger-strong">日数・コマ数を増やしてください</b>'
          }</div>`
        : ''
    }`;

  const examTitle = master.title ? `（「${master.title}」）` : '（① で対象考査を選んでください）';
  const autoDays = master.start_date && master.end_date ? daysBetween(master.start_date, master.end_date) : 0;

  return sectionCard(
    'calendar-check',
    `③ 考査期間の登録 ${examTitle}`,
    `この考査名に対する開始日・終了日・1日の時限数・標準試験時間を入力します。年度と試験日数は入力不要です（年度は開始日の西暦、試験日数は開始日〜終了日から自動算出）。計画フェーズ: ${phaseBadgePlan(planPhase)} / 実施科目: ${phaseBadge(subjectPhase)}`,
    `<div class="space-y-3">
      ${gradeView}
      <div class="flex flex-wrap items-end gap-3">
        ${field('開始日', input('start_date', master.start_date || '', 'type="date"'))}
        ${field('終了日', input('end_date', master.end_date || '', 'type="date"'))}
        ${field('1日の時限数', `<input id="plan-daily_slots" type="number" min="1" max="8" value="${escapeHTML(String(master.daily_slots ?? ''))}" class="input-field py-1.5 px-2 text-xs w-24" ${editable ? '' : 'disabled'} />`)}
        ${field('標準試験時間', `<select id="plan-default_duration" class="input-field py-1.5 px-2 text-xs w-24" ${editable ? '' : 'disabled'}>
          <option value="50" ${Number(master.default_duration ?? 50) === 50 ? 'selected' : ''}>50分</option>
          <option value="100" ${Number(master.default_duration ?? 50) === 100 ? 'selected' : ''}>100分</option>
        </select>`)}
        ${field('試験日数（自動算出）', `<span id="plan-days-preview" class="inline-flex items-center justify-center px-2 py-1.5 text-xs font-bold w-24 bg-accent-soft text-accent-strong border border-accent-soft rounded">${autoDays} 日</span>`)}
      </div>
      ${
        master.start_date && master.end_date
          ? ''
          : `<p class="text-[11px] text-soft">① で登録した考査の ${perGrade.length ? '実施教科数・必要コマ数' : '実施教科数'}を見て、開始日・終了日・1日の時限数・標準試験時間を登録します。試験日数と年度は自動算出されます。</p>`
      }
      ${actionRow}
    </div>`,
    `<button id="plan-refresh" class="btn-secondary py-1 px-2 text-[11px] flex items-center gap-1"><i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> 更新</button>`,
  );
}

function surveyCard(kyomu) {
  const board = examStore.board;
  const subjectPhase = board?.phases?.subject_phase || 'DRAFT';
  const summary = board?.survey_summary || null;
  const teachers = summary?.by_teacher || [];
  const perGrade = summary?.per_grade || [];
  const datesSet = !!board?.master?.start_date && !!board?.master?.end_date;
  const gradeBlock = perGrade.length
    ? `<div class="flex flex-wrap gap-2 text-[11px] pt-1">
        ${perGrade
          .map(
            (g) => `<span class="badge px-2 py-1 rounded border ${
              !datesSet
                ? 'bg-surface text-muted border border-main'
                : g.feasible
                  ? 'bg-success-soft text-success-strong border-success-soft'
                  : 'bg-danger-soft text-danger-strong border-danger-soft'
            }">${g.grade}年: 実施 ${g.subjects}科目（提出 ${g.submitted}/${g.subjects}${g.requests ? ` / 要望 ${g.requests}件` : ''}）${
              datesSet ? `／ 必要 ${g.needed_slots}コマ・キャパ ${g.capacity_slots}コマ` : ''
            }</span>`,
          )
          .join('')}
      </div>
      ${datesSet ? '' : '<p class="text-[11px] text-muted pt-1">キャパ（コマ数）比較は ③ 考査期間の登録後に表示されます。</p>'}`
    : '';
  const body = summary
    ? `<div class="space-y-2">
        <div class="flex flex-wrap items-center gap-3 text-[11px] text-soft">
          <span>提出: <b class="text-main">${summary.submitted}/${summary.total}</b> 科目</span>
          <span>要望: <b class="text-warning-strong">${summary.requests}</b> 件</span>
          <span>未提出: <b class="${summary.total - summary.submitted > 0 ? 'text-danger-strong' : 'text-success-strong'}">${summary.total - summary.submitted}</b> 科目</span>
        </div>
        ${gradeBlock}
        ${teachers.length
          ? `<div class="overflow-x-auto"><table class="w-full text-[11px]">
              <thead><tr class="text-muted text-[10px]"><th class="px-1 pb-1 font-semibold text-left">教員</th><th class="px-1 pb-1 font-semibold text-left">担当科目数</th><th class="px-1 pb-1 font-semibold text-left">提出</th><th class="px-1 pb-1 font-semibold text-left">確定</th><th class="px-1 pb-1 font-semibold text-left">要望</th></tr></thead>
              <tbody>${teachers
                .map(
                  (t) => `<tr class="border-t border-main/10">
                    <td class="px-1 py-1 font-semibold text-main">${escapeHTML(t.teacher_name || '（未割当）')}</td>
                    <td class="px-1 py-1">${t.total}</td>
                    <td class="px-1 py-1 ${t.submitted >= t.total ? 'text-success-strong' : 'text-warning-strong'}">${t.submitted}/${t.total}</td>
                    <td class="px-1 py-1 ${t.confirmed >= t.total ? 'text-success-strong' : 'text-muted'}">${t.confirmed}</td>
                    <td class="px-1 py-1 ${t.requests ? 'text-warning-strong' : 'text-muted'}">${t.requests} 件</td>
                  </tr>`,
                )
                .join('')}</tbody>
            </table></div>`
          : '<p class="text-[11px] text-muted">要望・提出はありません。</p>'}
      </div>`
    : '<p class="text-[11px] text-muted">調査サマリは調査開始後に表示されます。</p>';

  const itemsHtml = `<ul class="list-disc pl-4 text-[11px] text-soft space-y-0.5">
    ${SURVEY_ITEMS.map((i) => `<li>${i}</li>`).join('')}
  </ul>`;

  return sectionCard(
    'list-checks',
    '② 実施科目調査（調査開始／調査終了）',
    `調査開始で下の調査グリッドが全教員に編集可能になります。調査終了後は教務権限者のみ編集できます。実施科目フェーズ: ${phaseBadge(subjectPhase)}`,
    `<div class="space-y-2">
      ${surveyButtonsHtml(kyomu, board)}
      ${itemsHtml}
      ${examStatusHtml(board)}
      ${body}
    </div>`,
  );
}

/**
 * 年間考査計画タブを描画する（① 年間の考査名登録 → ② 実施科目調査 → ③ 考査期間の登録 の順）
 * 使用教室リストは 教室割の作成 タブで扱うため本タブには描画しない
 * @param {HTMLElement} container タブパネル
 * @param {string} notice 考査未登録時の告知文（教務は「年間の考査名登録」から作成できる）
 */
export function renderPlanTab(container, notice = '') {
  const kyomu = isKyomuUser();
  const board = examStore.board;
  const masters =
    examStore.masters && examStore.masters.length ? examStore.masters : board && board.master ? [board.master] : [];
  const noticeHtml = notice
    ? `<div class="card p-4 flex items-center gap-2 text-[11px] text-warning-strong border border-warning-soft">
        <i data-lucide="info" class="w-4 h-4 shrink-0"></i> ${escapeHTML(notice)}
      </div>`
    : '';

  container.innerHTML = `
    <div id="exam-plan-panel" class="space-y-4">
      ${noticeHtml}
      ${stepperHtml(board)}
      ${examFormHtml(masters, kyomu)}
      ${surveyCard(kyomu)}
      <div id="exam-survey-grid"></div>
      ${periodCard(kyomu)}
    </div>
  `;
  renderSurveySection(container.querySelector('#exam-survey-grid'));
  refreshLucideIcons();
}

export function bindPlanTab(container, reload) {
  const panel = container.querySelector('#exam-plan-panel');
  if (!panel) return;
  // 年間考査計画に統合された「考査の登録」セクションのイベントを連結する
  bindMasterSection(panel, reload);
  if (panel.dataset.boundPlan) return;
  panel.dataset.boundPlan = 'plan';

  // ② の調査グリッドをこのタブに埋め込む（入力はここで行い、決定は「実施科目の決定」タブで行う）
  const surveyGrid = panel.querySelector('#exam-survey-grid');
  if (surveyGrid) bindSurveySection(surveyGrid, reload, renderSurveySection);

  // ③ の入力は開始日・終了日・1日の時限数・標準試験時間のみ（年度・試験日数は自動算出）
  const readPlan = () => ({
    start_date: panel.querySelector('#plan-start_date')?.value || null,
    end_date: panel.querySelector('#plan-end_date')?.value || null,
    daily_slots: Number(panel.querySelector('#plan-daily_slots')?.value) || null,
    default_duration: Number(panel.querySelector('#plan-default_duration')?.value) || 50,
  });

  const run = async (path, body, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      const res = await examApi.post(path, body);
      showToast(res?.message || '処理を完了しました。', 'success');
      await reload();
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

  panel.addEventListener('click', (e) => {
    const id = examStore.examId;
    if (e.target.closest('#plan-refresh')) {
      resolveActiveExamId()
        .then(() => reload())
        .catch(() => reload());
      return;
    }
    const btn = e.target.closest('[data-plan-act]');
    if (!btn) return;
    if (!id) {
      showToast('対象考査を選択してください。', 'warning');
      return;
    }
    const act = btn.dataset.planAct;
    if (act === 'survey-start') run(`/exam/${id}/subject-survey/start`, {}, '② 実施科目調査を開始し、科目マスタから実施予定科目を自動種付けして全教員に編集可能にします（期間は ③ で後から登録できます）。よろしいですか？');
    if (act === 'survey-end') run(`/exam/${id}/subject-survey/end`, {}, '② の実施科目調査を終了します（以降は教務権限者のみ編集できます）。よろしいですか？');
    if (act === 'register') {
      const plan = readPlan();
      if (!plan.start_date || !plan.end_date) {
        showToast('③ では開始日と終了日を入力してください。', 'warning');
        return;
      }
      const days = daysBetween(plan.start_date, plan.end_date);
      if (days < 1) {
        showToast('③ の日程が不正です（開始日 ≦ 終了日）。', 'warning');
        return;
      }
      if (!plan.daily_slots || plan.daily_slots < 1) {
        showToast('③ では 1日の時限数（1〜8）を入力してください。', 'warning');
        return;
      }
      run(
        `/exam/${id}/plan/register`,
        plan,
        `③ の考査期間（開始日 ${plan.start_date} 〜 終了日 ${plan.end_date} ／ 試験日数 ${days}日 × 1日 ${plan.daily_slots}時限 ／ 標準試験時間 ${plan.default_duration}分）を登録します。よろしいですか？`
      );
    }
    if (act === 'decide') run(`/exam/${id}/plan/decide`, {}, '全実施科目が出題者により提出されたことを確認し、実施科目プランを確定します。よろしいですか？');
  });

  // ② の「実施科目調査を開く」ボタンはサブタブを実際に切り替える
  panel.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-goto-sub]');
    if (!tab) return;
    const target = document.querySelector(`#exam-subtabs [data-subtab="${tab.dataset.gotoSub}"]`);
    if (target) target.click();
    else showToast('移動先のメニューが見つかりません。', 'warning');
  });

  // 試験日数は開始日〜終了日から自動算出する（入力欄は開始日・終了日・1日の時限数・標準試験時間のみ）
  panel.addEventListener('change', (e) => {
    if (e.target.id !== 'plan-start_date' && e.target.id !== 'plan-end_date') return;
    const span = panel.querySelector('#plan-days-preview');
    if (!span) return;
    const d = daysBetween(panel.querySelector('#plan-start_date')?.value, panel.querySelector('#plan-end_date')?.value);
    span.textContent = d > 0 ? `${d} 日` : '− 日';
  });

  refreshLucideIcons();
}

export default renderPlanTab;

