/**
 * ISSystem 定期考査 年間考査計画 UI (教務部 KYOMU)
 * 作業順をステッパーで表示する:
 *   ① 年間の考査名登録（考査名のみ。1年間に実施する考査名をすべて登録する）
 *   ② 実施科目調査（調査開始で科目・実施時間・出題者/巡回者・実施コース・要望が全教員に編集可能、
 *      調査終了後は教務のみ編集。学年・教科で表示を絞って編集できる）
 *   ③ 考査期間の登録（考査名を行とした表で、各行に開始日・終了日・1日の時限数を入力する（標準試験時間入力なし）。
 *      年度と試験日数は自動算出、各行は焦点が行の外へ移った瞬間に自動登録する（基本情報の登録と同一の作法）、
 *      使用教室は 教室割の作成 タブで扱う）
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
  { n: 3, title: '考査期間の登録', desc: '考査名を行とした表で開始日・終了日・1日の時限数を登録（標準試験時間入力なし）', icon: 'calendar-check' },
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
    <div class="text-[10px] text-muted font-semibold">作業順どりに進めてください：① 年間の考査名登録 → ② 実施科目調査（調査開始／終了）→ ③ 考査期間の登録（考査名を行とする表で開始日・終了日・1日の時限数。標準試験時間入力なし）</div>
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

/** 考査名を行とする ③ の表の1行（開始日・終了日・1日の時限数を入力する。標準試験時間入力はなく、試験日数とキャパは自動算出で表示する） */
function periodRowHtml(m, editable, activeId, statusById) {
  const dis = editable ? '' : 'disabled';
  const id = String(m.id);
  const isActive = id === String(activeId);
  const days = daysBetween(m.start_date, m.end_date);
  const slots = Number(m.daily_slots) || 0;
  const cap = days * slots;
  const st = statusById.get(id) || {};
  const registered = !!m.start_date && !!m.end_date && slots > 0;
  const badge = isActive
    ? '<span class="badge bg-warning-soft border border-warning-soft text-warning-strong text-[10px] px-1.5 py-0.5 rounded font-bold">作業中の考査</span>'
    : registered
      ? `<span class="badge bg-success-soft border border-success-soft text-success-strong text-[10px] px-1.5 py-0.5 rounded font-bold">期間登録済${Number(st.decided) > 0 ? ` ／ 確定 ${Number(st.decided)}行` : ''}</span>`
      : '<span class="badge bg-surface border border-main text-muted text-[10px] px-1.5 py-0.5 rounded font-bold">期間未登録</span>';
  const openBtn = isActive
    ? '<span class="text-[10px] text-muted">（対象考査）</span>'
    : `<button data-plan-open="${escapeHTML(id)}" class="btn-secondary py-1 px-2 text-[10px]" ${dis}>この考査を開く</button>`;
  const dstr = (v) => String(v ?? '').slice(0, 10);
  return `<tr data-plan-row-id="${escapeHTML(id)}"${isActive ? ' class="bg-accent-soft"' : ''}>
    <td class="border border-divider p-1.5 font-semibold text-main text-[11px]">${escapeHTML(String(m.title ?? ''))}</td>
    <td class="border border-divider p-1.5"><input data-pf="start_date" type="date" value="${escapeHTML(dstr(m.start_date))}" class="input-field py-1 px-1.5 text-[11px] w-28" ${dis} /></td>
    <td class="border border-divider p-1.5"><input data-pf="end_date" type="date" value="${escapeHTML(dstr(m.end_date))}" class="input-field py-1 px-1.5 text-[11px] w-28" ${dis} /></td>
    <td class="border border-divider p-1.5 text-center"><input data-pf="daily_slots" type="number" min="1" max="8" value="${escapeHTML(String(m.daily_slots ?? ''))}" class="input-field py-1 px-1.5 text-[11px] w-12" ${dis} /></td>
    <td class="border border-divider p-1.5 text-center"><span data-pdays class="text-[11px] font-bold ${days > 0 ? 'text-accent-strong' : 'text-muted'}">${days > 0 ? `${days} 日` : '− 日'}</span></td>
    <td class="border border-divider p-1.5 text-center"><span data-pcap class="text-[11px] ${cap > 0 ? 'text-soft' : 'text-muted'}">${cap > 0 ? `${cap} コマ` : '− コマ'}</span></td>
    <td class="border border-divider p-1.5 text-center text-[11px]">${Number(st.plan_rows) || 0} コマ</td>
    <td class="border border-divider p-1.5 text-center">${badge}</td>
    <td class="border border-divider p-1.5 text-center">${openBtn}</td>
  </tr>`;
}

/** ③ 考査期間の登録（考査名を行とした表。各行で開始日・終了日・1日の時限数を入力し、焦点が行の外へ移った瞬間に自動登録する = 基本情報の登録と同じ作法） */
function periodTable(kyomu, board) {
  const phases = board?.phases || {};
  const planPhase = phases.plan_phase || 'DRAFT';
  const subjectPhase = phases.subject_phase || 'DRAFT';
  const surveyEnded = subjectPhase === 'ENDED';
  const activeId = String(board?.master?.id ?? '');

  const masters = (examStore.masters && examStore.masters.length ? examStore.masters : board && board.master ? [board.master] : []).filter((m) => m && m.id);
  const statusById = new Map((board?.exam_survey_status || []).map((s) => [String(s.id), s]));
  const rowEditable = (m) => kyomu && !(String(m.id) === activeId && planPhase === 'DECIDED');
  const tableRows = masters.length
    ? masters.map((m) => periodRowHtml(m, rowEditable(m), activeId, statusById)).join('')
    : '<tr><td colspan="9" class="p-2 text-[11px] text-muted border border-divider">考査名が登録されていません。① で考査名を登録するとこの表に行が並びます。</td></tr>';

  const master = board?.master || {};
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
    : '<p class="text-[11px] text-muted">② の調査開始後に実施教科数・必要コマ数が集計されます（対象考査の学年別比較）。</p>';

  const actionRow = `
    <div class="flex flex-wrap items-center gap-2 text-[11px] pt-1">
      ${actButton('decide', '実施科目確定', 'stamp', kyomu && planPhase !== 'DECIDED', 'btn-success border border-success-soft text-success-strong')}
      <span class="text-muted">各行の期間入力は焦点が行の外へ移った瞬間に自動登録されます（行の「保存」ボタンはありません）。実施科目確定は対象考査の全科目提出後に教務が行います。</span>
    </div>
    ${surveyEnded ? '' : '<p class="text-[11px] text-warning-strong font-semibold">② の実施科目調査を終了してから期間を登録してください（要望・実施教科数が揃います）。</p>'}
    ${
      datesSet && perGrade.length
        ? `<div class="text-[11px] text-muted pt-1">対象考査「${escapeHTML(String(master.title ?? ''))}」の最多学年の必要 ${neededMax}コマ ≤ 期間キャパ ${capacity}コマ ${
            neededMax <= capacity ? '<b class="text-success-strong">収まります</b>' : '<b class="text-danger-strong">日数・コマ数を増やしてください</b>'
          }</div>`
        : ''
    }`;
  return sectionCard(
    'calendar-check',
    '③ 考査期間の登録（考査名ごとの表）',
    '行が考査名です。各行で開始日・終了日・1日の時限数を入力します（標準試験時間の入力はありません。実施時間は ② の実施科目調査で科目ごとに設定します）。試験日数・キャパ（日数×時限数）は自動算出、年度は開始日の西暦から導出されます。計画フェーズ: ' + phaseBadgePlan(planPhase) + ' / 実施科目: ' + phaseBadge(subjectPhase),
    `<div class="space-y-3">
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse min-w-[880px]">
          <thead><tr>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">考査名</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">開始日</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">終了日</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">1日の時限数</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">試験日数（自動）</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">キャパ（自動）</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">② 実施コマ</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">状態</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">操作</th>
          </tr></thead>
          <tbody id="plan-period-body">${tableRows}</tbody>
        </table>
      </div>
      ${gradeView}
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
      ${periodTable(kyomu, board)}
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

  // ③ の表の各行は焦点が行の外へ移った瞬間に自動登録する（基本情報の登録と同じ作法、行の「保存」ボタンは無い）
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
    const openRow = e.target.closest('[data-plan-open]');
    if (openRow) {
      examStore.examId = openRow.dataset.planOpen;
      showToast('対象考査を切り替えました（対象考査の行が強調されます）。', 'info');
      reload();
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

  // ③ の表の自動登録（基本情報の登録と同一の作法）: 焦点が行の外へ移った瞬間にその行を書く。
  // 行内の次の入力欄へ移っている間は書き終えていないので書かない。内容が変わっていない行は書かない。
  if (panel.__planAutoCtl) panel.__planAutoCtl.abort();
  const autoCtl = new AbortController();
  panel.__planAutoCtl = autoCtl;
  const sig = { signal: autoCtl.signal };
  const rowVals = (tr) => ({
    start_date: (tr.querySelector('[data-pf="start_date"]')?.value || '').trim(),
    end_date: (tr.querySelector('[data-pf="end_date"]')?.value || '').trim(),
    daily_slots: Number(tr.querySelector('[data-pf="daily_slots"]')?.value) || 0,
  });
  /** 行の試験日数とキャパ（日数×時限数）を入力値から再計算して表示する（標準試験時間の入力欄はない） */
  const paintRow = (tr) => {
    const v = rowVals(tr);
    const d = daysBetween(v.start_date, v.end_date);
    const cap = d * v.daily_slots;
    const pd = tr.querySelector('[data-pdays]');
    if (pd) {
      pd.textContent = d > 0 ? `${d} 日` : '− 日';
      pd.className = `text-[11px] font-bold ${d > 0 ? 'text-accent-strong' : 'text-muted'}`;
    }
    const pc = tr.querySelector('[data-pcap]');
    if (pc) {
      pc.textContent = cap > 0 ? `${cap} コマ` : '− コマ';
      pc.className = `text-[11px] ${cap > 0 ? 'text-soft' : 'text-muted'}`;
    }
  };
  const writeQueue = [];
  let writing = false;
  const flushQueue = async () => {
    if (writing) return;
    const job = writeQueue.shift();
    if (!job) return;
    writing = true;
    const id = job.tr.dataset.planRowId;
    const name = (examStore.masters.find((m) => String(m.id) === String(id)) || {}).title || id;
    try {
      const res = await examApi.post(`/exam/${id}/plan/register`, {
        start_date: job.v.start_date,
        end_date: job.v.end_date,
        daily_slots: job.v.daily_slots,
        default_duration: 50,
      });
      showToast(res?.message || `考査「${name}」の期間を登録しました。`, 'success');
      examStore.masters = [];
      await reload();
    } catch (err) {
      job.tr.dataset.autoKey = '';   // 失敗時は同じ内容でもう一度書き直せる
      showToast(`考査「${name}」の期間を自動登録できませんでした（${err.message}）`, 'error');
    }
    writing = false;
    if (writeQueue.length) flushQueue();
  };
  const queueRow = (tr) => {
    const v = rowVals(tr);
    const key = JSON.stringify(v);
    if (tr.dataset.autoKey === key) return;   // 内容が変わっていなければ書き込まない
    tr.dataset.autoKey = key;
    if (!v.start_date || !v.end_date) return;   // 期間が揃っていない行（未入力の行）は書き込まない
    if (daysBetween(v.start_date, v.end_date) < 1) {
      showToast('③ の日程が不正です（開始日 ≦ 終了日）。書き込んでいません。', 'warning');
      return;
    }
    if (v.daily_slots < 1 || v.daily_slots > 8) {
      showToast('③ の 1日の時限数は 1〜8 で入力してください。書き込んでいません。', 'warning');
      return;
    }
    writeQueue.push({ tr, v });
    flushQueue();
  };
  panel.addEventListener('change', (e) => {
    const tr = e.target.closest?.('tr[data-plan-row-id]');
    if (tr && e.target.dataset && e.target.dataset.pf) paintRow(tr);
  }, sig);
  panel.addEventListener('focusout', (e) => {
    const tr = e.target?.closest?.('tr[data-plan-row-id]');
    if (!tr) return;
    const next = e.relatedTarget;
    if (next && next.closest?.('tr[data-plan-row-id]') === tr) return;   // 行内の次の入力欄へ移った間は書き込まない
    queueRow(tr);
  }, sig);
  // 各行の初期内容をキーとして控える（入力していない行は焦点が外れても書き込まない）
  panel.querySelectorAll('tr[data-plan-row-id]').forEach((tr) => {
    tr.dataset.autoKey = JSON.stringify(rowVals(tr));
  });

  refreshLucideIcons();
}

export default renderPlanTab;

