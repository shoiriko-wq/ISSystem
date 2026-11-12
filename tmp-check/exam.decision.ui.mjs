/**
 * ISSystem 定期考査 実施科目の決定タブ（教務部 KYOMU）
 * ② 実施科目調査（年間考査計画タブで入力する）の値を「デフォルト値（計画値）」として、
 * 対象考査 1 件分の実施科目を決定する。決定行は exam_subject_decisions に保存され、
 * 試験時間割・教室割・監督割・公表ビューの正式データ（conductSubjects）として使われる。
 * 決定行を編集すると変更項目がデフォルト値との差分として表示され、行単位で計画値へ戻せる。
 * 決定調査中は教員も自分の出題コマの決定行を編集・提出できる。
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
import {
  subjectRowHtml,
  payloadFromRow,
  applySubjectDefaults,
  ensureStaffPool,
  staffNameOf,
} from './exam.subject.ui.js';
import { state } from '../../state.js';

/** デフォルト値（計画値）との差分項目（exam.model.js の DECISION_FIELDS に対応） */
const FIELD_LABELS = {
  subject_short: '略称',
  subject_id: '科目ID',
  stream: '系',
  scope: '対象',
  setter_teacher_id: '出題者',
  patrol_teacher_id: '巡回者',
  duration_slots: '時限数',
  duration_minutes: '実施時間',
  fixed_slot: '固定時限',
  shared_slot: '全学年同一時限',
  broadcast_slot: '放送',
  solo_subject: '単独実施',
  class_ids: '実施クラス・コース',
  room_id: '教室',
  room_name: '教室名',
  request_note: '要望',
};

const STREAM_LABEL = { SCIENCE: '理系', ARTS: '文系', OTHER: 'その他' };

/** 決定タブ独自の科目・学年絞り込み（② と同じ条件式、タブ独自の状態） */
const decFilter = { subject: '', grade: '' };

function classNameOf(id) {
  const c = (examStore.board?.basic_info?.classes || []).find((x) => String(x.id) === String(id));
  return c ? String(c.name) : String(id);
}

function roomNameOf(id) {
  const r = [...(examStore.board?.rooms || []), ...(examStore.board?.basic_info?.rooms || [])]
    .find((x) => String(x.id) === String(id));
  return r ? String(r.name) : String(id);
}

/** 項目の値を表示用文字列化（変更差分の表示に使用） */
function valueLabel(field, value) {
  if (field === 'setter_teacher_id' || field === 'patrol_teacher_id') {
    return staffNameOf(value) || (value ? `ID:${value}` : '（未設定）');
  }
  if (field === 'class_ids') return (value || []).map(classNameOf).join(', ') || '（なし）';
  if (field === 'room_id') return value ? roomNameOf(value) : '（未設定）';
  if (field === 'shared_slot' || field === 'broadcast_slot' || field === 'solo_subject') return value ? 'する' : 'しない';
  if (field === 'duration_minutes') return `${Number(value) || 0}分`;
  if (field === 'stream') return STREAM_LABEL[String(value)] || 'その他';
  return value === null || value === undefined || value === '' ? '（未設定）' : String(value);
}

/** 計画値（デフォルト値＝② の調査値）の表示 */
function defaultCellHtml(d) {
  const base = d.defaults || {};
  if (!Object.keys(base).length) {
    return '<span class="text-[10px] text-muted">計画値なし（教務が追加した行）</span>';
  }
  const lines = [
    `出題者: ${valueLabel('setter_teacher_id', base.setter_teacher_id)}`,
    `巡回者: ${valueLabel('patrol_teacher_id', base.patrol_teacher_id)}`,
    `実施時間: ${valueLabel('duration_minutes', base.duration_minutes)} × ${Number(base.duration_slots) || 1}時限`,
    `教室: ${valueLabel('room_id', base.room_id)}`,
    `クラス: ${valueLabel('class_ids', base.class_ids)}`,
  ];
  if (base.request_note) lines.push(`要望: ${String(base.request_note)}`);
  return `<div class="text-[10px] text-soft space-y-0.5">${lines.map((l) => `<div>${escapeHTML(l)}</div>`).join('')}</div>`;
}

/** デフォルト値との変更項目（計画値 → 決定値）の表示 */
function changedCellHtml(d) {
  const changed = d.changed || [];
  if (!changed.length) return '<span class="text-[10px] text-success-strong">計画値と同值</span>';
  const items = changed.map((f) => {
    const label = FIELD_LABELS[f] || f;
    return `<div class="text-[10px] leading-4"><span class="font-bold text-warning-strong">${escapeHTML(label)}</span><br />${escapeHTML(valueLabel(f, (d.defaults || {})[f]))} → ${escapeHTML(valueLabel(f, d[f]))}</div>`;
  });
  return `<div class="space-y-1">${items.join('')}</div>`;
}

/** 決定行（② の行部品 + 計画値・変更項目・確定状態・計画値戻し） */
function decisionRowHtml(d, kyomu) {
  const base = subjectRowHtml(d, kyomu);
  const changed = d.changed || [];
  const rowClass = changed.length ? 'bg-warning-soft' : 'bg-surface';
  const confirmed = d.decision_status === 'CONFIRMED'
    ? '<span class="badge bg-success-soft text-success-strong text-[9px] px-1.5 py-0.5 rounded font-bold">確定済</span>'
    : '<span class="badge bg-surface-strong text-muted border border-main text-[9px] px-1.5 py-0.5 rounded font-bold">未確定</span>';
  const extra = `<td class="border border-divider p-1.5 align-top">${defaultCellHtml(d)}</td>
    <td class="border border-divider p-1.5 align-top">${changedCellHtml(d)}</td>
    <td class="border border-divider p-1.5 align-top text-center">${confirmed}</td>
    <td class="border border-divider p-1.5 align-top text-center">
      <button data-act="reset" ${kyomu ? '' : 'disabled'} class="btn-secondary py-1 px-2 text-[10px] flex items-center gap-1 mx-auto" title="計画値（② の調査値）へ戻す">
        <i data-lucide="rotate-ccw" class="w-3 h-3"></i>計画値へ
      </button>
    </td>`;
  return base.replace('<tr data-row-id=', `<tr class="${rowClass}" data-row-id=`).replace('</tr>', `${extra}</tr>`);
}

/** 科目・学年絞り込みバー（② と同じ条件式） */
function filterBarHtml(rows) {
  const subjects = [...new Set(rows.map((r) => String(r.subject_name || '').trim()).filter((s) => s))].sort((a, b) => a.localeCompare(b, 'ja'));
  const grades = [...new Set(rows.map((r) => Number(r.grade)).filter((g) => g > 0))].sort((a, b) => a - b);
  const subjectSel = `
    <select id="dec-filter-subject" class="input text-xs p-1.5">
      <option value="">試験実施科目で絞り込み（すべて）</option>
      ${subjects.map((s) => `<option value="${escapeHTML(s)}" ${decFilter.subject === s ? 'selected' : ''}>${escapeHTML(s)}</option>`).join('')}
    </select>`;
  const gradeSel = `
    <select id="dec-filter-grade" class="input text-xs p-1.5 w-24">
      <option value="">学年（すべて）</option>
      ${grades.map((g) => `<option value="${g}" ${decFilter.grade === String(g) ? 'selected' : ''}>${g}年</option>`).join('')}
    </select>`;
  const clear = `<button id="dec-filter-clear" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1"><i data-lucide="filter" class="w-3.5 h-3.5"></i>全件表示</button>`;
  return `<div class="flex flex-wrap items-center gap-2">${subjectSel}${gradeSel}${clear}
    <span class="text-[10px] text-muted">※ 絞り込んでも列表の下に全件を表示します</span></div>`;
}

/** 列表表示＋下部全件表示（② と同じ書式） */
function applyDecFilter(container) {
  const body = container.querySelector('#dec-body');
  if (!body) return;
  const trs = [...body.querySelectorAll('tr[data-row-id]')];
  trs.forEach((tr) => {
    const ok = (!decFilter.subject || (tr.dataset.subject || '') === decFilter.subject)
      && (!decFilter.grade || (tr.dataset.grade || '') === decFilter.grade);
    tr.classList.toggle('hidden', !ok);
  });
  const old = body.querySelector('tr[data-filter-fulllist]');
  if (old) old.remove();
  const full = trs.filter((tr) => tr.dataset.full);
  if (!full.length) return;
  const sep = document.createElement('tr');
  sep.dataset.filterFulllist = '1';
  sep.innerHTML = `<td colspan="16" class="pt-2 pb-1 border-b-2 border-dashed border-divider"><div class="flex items-center gap-2 text-[10px] text-muted"><span class="border-t border-divider flex-1"></span>全件（列表の下に全件を表示）<span class="border-t border-divider flex-1"></span></div></td>`;
  body.appendChild(sep);
  full.forEach((tr) => tr.classList.remove('hidden'));
}

/** 決定タブのヘッダカード（フェーズ・サマリー・操作ボタン） */
function headHtml(board, kyomu) {
  const summary = board.decision_summary || { total: 0, plan_total: 0, changed: 0, submitted: 0, confirmed: 0, requests: 0, per_grade: [] };
  const phase = board.phases?.decision_phase || 'DRAFT';
  const surveyPhase = board.phases?.subject_phase || 'DRAFT';
  const startable = kyomu && phase !== 'SURVEY' && summary.total > 0;
  const endable = kyomu && phase === 'SURVEY';
  const canAdd = kyomu && phase !== 'ENDED';
  const decidable = kyomu && summary.total > 0 && (summary.submitted + summary.confirmed) >= summary.total;
  const chips = [
    `<span class="badge bg-accent-soft text-accent-strong text-xs px-2 py-1 rounded font-bold">決定 ${summary.total} / 計画（②） ${summary.plan_total} コマ</span>`,
    `<span class="badge bg-surface-strong text-soft border border-main text-xs px-2 py-1 rounded font-bold">デフォルト値から変更 ${summary.changed} 行</span>`,
    `<span class="badge bg-surface-strong text-soft border border-main text-xs px-2 py-1 rounded font-bold">提出 ${summary.submitted} / 確定 ${summary.confirmed}</span>`,
    summary.requests ? `<span class="badge bg-warning-soft text-warning-strong text-xs px-2 py-1 rounded font-bold">要望 ${summary.requests} 件</span>` : '',
    (summary.per_grade || []).map((g) => `<span class="badge bg-surface text-soft border border-main text-[10px] px-1.5 py-0.5 rounded font-bold">${g.grade}年: 決定 ${g.subjects} / 変更 ${g.changed} / 提出 ${g.submitted}</span>`).join(' '),
  ].filter((s) => s).join(' ');
  const surveyHint = surveyPhase === 'SURVEY'
    ? '<div class="text-[10px] text-warning-strong font-bold">② 実施科目調査が進行中です。② の調査値がデフォルト値（計画値）になります（入力は年間考査計画タブ）。</div>'
    : '<div class="text-[10px] text-muted">② の調査値（計画値）は年間考査計画タブで入力します。このタブでは 1 考査分の決定行を編集します。</div>';
  return sectionCard('fa', '実施科目の決定（教務部）', 'info',
    `<div class="space-y-2">${surveyHint}<div class="flex flex-wrap items-center gap-2">${chips}</div></div>`,
    phaseBadge(phase));
}

/** 決定タブの操作バー（教務の決定操作） */
function actionBarHtml(board, kyomu) {
  const summary = board.decision_summary || { total: 0 };
  const phase = board.phases?.decision_phase || 'DRAFT';
  const startable = kyomu && phase !== 'SURVEY' && summary.total > 0;
  const endable = kyomu && phase === 'SURVEY';
  const canAdd = kyomu && phase !== 'ENDED';
  const decidable = kyomu && summary.total > 0 && (summary.submitted + summary.confirmed) >= summary.total;
  return `<div class="flex flex-wrap items-center gap-2">
    <button id="dec-seed" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'} title="② の調査値をデフォルト値（計画値）として決定行を作成／更新する">
      <i data-lucide="copy" class="w-3.5 h-3.5"></i>計画値から決定を作成／更新
    </button>
    <button id="dec-start" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${startable ? '' : 'disabled'}>
      <i data-lucide="play" class="w-3.5 h-3.5"></i>決定調査開始
    </button>
    <button id="dec-end" class="btn-danger py-1.5 px-3 text-xs flex items-center gap-1" ${endable ? '' : 'disabled'}>
      <i data-lucide="stop-circle" class="w-3.5 h-3.5"></i>決定調査終了
    </button>
    <button id="dec-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${canAdd ? '' : 'disabled'}>
      <i data-lucide="plus" class="w-3.5 h-3.5"></i>行を追加
    </button>
    <button id="dec-decide" class="btn-secondary border border-success-soft text-success-strong py-1.5 px-3 text-xs flex items-center gap-1" ${decidable ? '' : 'disabled'}>
      <i data-lucide="stamp" class="w-3.5 h-3.5"></i>実施科目を確定
    </button>
    <span class="text-[10px] text-muted ml-auto">決定行が時間割・教室割・監督割・公表の正式データになります（確定後は編集不可）</span>
  </div>`;
}

/** 決定グリッドの表ヘッダ（② の 12 列 + 計画値・変更項目・確定・計画値戻し） */
const DEC_HEAD_HTML = `<thead>
  <tr class="bg-surface-strong text-soft">
    <th class="border border-divider p-2 text-xs font-bold">試験実施科目<span class="text-danger">＊</span></th>
    <th class="border border-divider p-2 text-xs font-bold">学年<span class="text-danger">＊</span></th>
    <th class="border border-divider p-2 text-xs font-bold">出題者<span class="text-danger">＊</span></th>
    <th class="border border-divider p-2 text-xs font-bold">巡回者</th>
    <th class="border border-divider p-2 text-xs font-bold">実施時間<span class="text-danger">＊</span></th>
    <th class="border border-divider p-2 text-xs font-bold">時限数<span class="text-danger">＊</span></th>
    <th class="border border-divider p-2 text-xs font-bold">実施クラス・コース<span class="text-danger">＊</span></th>
    <th class="border border-divider p-2 text-xs font-bold">教室<span class="text-danger">＊</span></th>
    <th class="border border-divider p-2 text-xs font-bold">要望</th>
    <th class="border border-divider p-2 text-xs font-bold">条件</th>
    <th class="border border-divider p-2 text-xs font-bold text-center">状態</th>
    <th class="border border-divider p-2 text-xs font-bold text-center">操作</th>
    <th class="border border-divider p-2 text-xs font-bold bg-accent-soft text-accent-strong">計画値（デフォルト値＝② の調査値）</th>
    <th class="border border-divider p-2 text-xs font-bold bg-accent-soft text-accent-strong">変更項目（デフォルト値との差分）</th>
    <th class="border border-divider p-2 text-xs font-bold text-center">確定</th>
    <th class="border border-divider p-2 text-xs font-bold text-center">計画値戻し</th>
  </tr>
</thead>`;

/** 実施科目の決定タブ（決定グリッド＋計画値・変更差分表示） */
export function renderDecisionTab(container) {
  const board = examStore.board;
  const kyomu = isKyomuUser();
  if (!board) {
    container.innerHTML = `<div class="card p-6 text-center text-xs text-muted">考査データを読み込み中…</div>`;
    return;
  }
  const decisions = (board.decisions || []).slice().sort((a, b) =>
    Number(a.grade) - Number(b.grade) || String(a.subject_name).localeCompare(String(b.subject_name), 'ja'));
  const rows = decisions.map((d) => decisionRowHtml(d, kyomu)).join('');
  const placeholder = `<tr><td colspan="16" class="border border-divider p-4 text-center text-[10px] text-muted">決定行がありません。年間考査計画タブで ② の実施科目調査を入力し、「計画値から決定を作成／更新」を実行してください。</td></tr>`;
  container.innerHTML = `
    ${headHtml(board, kyomu)}
    ${actionBarHtml(board, kyomu)}
    <div class="card p-4 space-y-2">
      ${filterBarHtml(decisions)}
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse min-w-[1560px]">
          ${DEC_HEAD_HTML}
          <tbody id="dec-body">${rows || placeholder}</tbody>
        </table>
      </div>
    </div>`;
  applyDecFilter(container);
  refreshLucideIcons();
}

/** 教務が追加する決定行の初期値（計画値なし＝教務決定のみで成り立つ追加行） */
function blankDecisionRow(examId) {
  return {
    id: null,
    exam_master_id: examId,
    subject_name: '',
    subject_short: '',
    subject_id: null,
    grade: 1,
    stream: 'OTHER',
    scope: 'ALL',
    setter_teacher_id: isKyomuUser() ? null : (state.currentUser?.id ?? null),
    patrol_teacher_id: null,
    duration_slots: 1,
    duration_minutes: 60,
    fixed_slot: null,
    shared_slot: false,
    broadcast_slot: false,
    solo_subject: true,
    courses: [],
    class_ids: [],
    room_id: null,
    room_name: '',
    request_note: '',
    notes: '',
    student_count: 0,
    submit_status: 'SUBMITTED',
    decision_status: 'CONFIRMED',
    defaults: {},
    changed: [],
  };
}

/** 実施科目の決定タブのバインド（操作ボタン・行の保存/提出/削除/計画値戻し） */
export function bindDecisionTab(container, reload) {
  if (container.dataset.bound === 'decision') return;
  container.dataset.bound = 'decision';

  ensureStaffPool().then(() => renderDecisionTab(container)).catch(() => {});

  const post = async (path, body, message) => {
    const res = await examApi.post(path, body);
    showToast(res?.message || message, 'success');
    await reload();
    return res;
  };

  container.addEventListener('click', async (e) => {
    const examId = examStore.examId;

    if (e.target.closest('#dec-filter-clear')) {
      decFilter.subject = '';
      decFilter.grade = '';
      const sel = container.querySelector('#dec-filter-subject');
      const gradeSel = container.querySelector('#dec-filter-grade');
      if (sel) sel.value = '';
      if (gradeSel) gradeSel.value = '';
      applyDecFilter(container);
      return;
    }

    // クラス・コースチップのトグル（② と同じ挙動）
    const chip = e.target.closest('[data-cc]');
    if (chip) {
      const tr = chip.closest('tr[data-row-id]');
      if (!tr) return;
      const idx = tr.querySelectorAll('[data-cc]').length + Number(chip.dataset.pos);
      const course = chip.dataset.course;
      const clsId = Number(chip.dataset.cls);
      const list = tr.dataset.courses.split(',').filter((s) => s);
      const key = `${clsId}#${course}`;
      const found = list.indexOf(key);
      if (found >= 0) {
        list.splice(found, 1);
        chip.classList.remove('bg-accent-soft', 'text-accent-strong');
        chip.classList.add('bg-surface', 'text-soft');
      } else {
        list.push(key);
        chip.classList.remove('bg-surface', 'text-soft');
        chip.classList.add('bg-accent-soft', 'text-accent-strong');
      }
      tr.dataset.courses = list.join(',');
      const posByCls = {};
      tr.querySelectorAll('[data-cc]').forEach((el) => {
        const cid = Number(el.dataset.cls);
        posByCls[cid] = (posByCls[cid] || 0) + 1;
        el.dataset.pos = String(posByCls[cid] - idx);
      });
      return;
    }

    const btn = e.target.closest('button');
    if (!btn) return;

    const confirmText = {
      'dec-seed': '② の調査値（計画値）をデフォルト値として決定行を作成／更新します（既存の決定行の編集値は維持されます）。よろしいですか？',
      'dec-start': '決定調査を開始します（教員は自分の出題コマの決定行を編集・提出できます）。よろしいですか？',
      'dec-end': '決定調査を終了します（以後は教務のみ編集できます）。よろしいですか？',
      'dec-decide': '全決定行の提出を確認し、実施科目を確定します（時間割・教室割・監督割の正式データになり、以降は編集できません）。よろしいですか？',
    };
    if (btn.id && confirmText[btn.id]) {
      if (!window.confirm(confirmText[btn.id])) return;
      const path = {
        'dec-seed': `/exam/${examId}/decisions/seed`,
        'dec-start': `/exam/${examId}/decisions/survey/start`,
        'dec-end': `/exam/${examId}/decisions/survey/end`,
        'dec-decide': `/exam/${examId}/decisions/decide`,
      }[btn.id];
      btn.disabled = true;
      try {
        await post(path, {}, '処理を完了しました');
      } catch (err) {
        showToast(err.message, 'error');
        btn.disabled = false;
      }
      return;
    }

    if (btn.id === 'dec-add') {
      const body = container.querySelector('#dec-body');
      const ph = body.querySelector('td[colspan="16"]');
      if (ph) ph.closest('tr').remove();
      body.insertAdjacentHTML('beforeend', decisionRowHtml(blankDecisionRow(examId), isKyomuUser()));
      refreshLucideIcons();
      return;
    }

    const tr = btn.closest('tr[data-row-id]');
    if (!tr) return;

    if (btn.dataset.act === 'reset') {
      if (!tr.dataset.rowId) { showToast('未保存の行は計画値へ戻せません。先に保存してください。', 'warning'); return; }
      if (!window.confirm('この決定行を計画値（② の調査値）へ戻します。よろしいですか？')) return;
      try {
        await post(`/exam/decision/${tr.dataset.rowId}/reset-default`, {}, '計画値（デフォルト値）へ戻しました');
      } catch (err) { showToast(err.message, 'error'); }
      return;
    }

    if (btn.dataset.act === 'delete') {
      if (!tr.dataset.rowId) { showToast('未保存の行は削除できません。', 'warning'); return; }
      if (!window.confirm('この決定行を削除します。よろしいですか？')) return;
      try {
        await examApi.del(`/exam/decision/${tr.dataset.rowId}`);
        showToast('決定行を削除しました', 'info');
        await reload();
      } catch (err) { showToast(err.message || '削除に失敗しました', 'error'); }
      return;
    }

    const payload = payloadFromRow(tr, examStore.board?.decisions || []);
    payload.exam_master_id = examId;
    if (!payload.subject_name) { showToast('試験実施科目名を選択してください。', 'warning'); return; }
    btn.disabled = true;
    try {
      if (btn.dataset.act === 'submit') {
        if (!tr.dataset.rowId) { showToast('先に「保存」で決定行を登録してください。', 'warning'); btn.disabled = false; return; }
        await post(`/exam/decision/${tr.dataset.rowId}/submit`, {}, '決定行の提出を完了しました');
      } else if (tr.dataset.rowId) {
        await post(`/exam/${examId}/decision-rows`, payload, '実施科目の決定を保存しました');
      } else {
        await post(`/exam/${examId}/decisions`, payload, '実施科目の決定行を追加しました');
      }
    } catch (err) {
      showToast(err.message || '決定の保存に失敗しました', 'error');
      btn.disabled = false;
    }
  });

  // 科目・学年選択で基本情報の開講設定を反映し、計画値との差分表示も再計算する（② と同じ挙動）
  container.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'dec-filter-subject') {
      decFilter.subject = el.value || '';
      applyDecFilter(container);
      return;
    }
    if (el.id === 'dec-filter-grade') {
      decFilter.grade = el.value === '' ? '' : String(el.value);
      applyDecFilter(container);
      return;
    }
    const f = el.getAttribute && el.getAttribute('data-f');
    if (f !== 'subject_name' && f !== 'grade') return;
    const tr = el.closest('tr[data-row-id]');
    if (!tr) return;
    const decisions = examStore.board?.decisions || [];
    const orig = decisions.find((r) => String(r.id) === String(tr.dataset.rowId)) || {};
    const draft = { ...orig, ...payloadFromRow(tr, decisions) };
    applySubjectDefaults(draft);
    tr.innerHTML = decisionRowHtml(draft, isKyomuUser()).replace(/^<tr[^>]*>/, '');
    refreshLucideIcons();
  });
}

export default { renderDecisionTab, bindDecisionTab };