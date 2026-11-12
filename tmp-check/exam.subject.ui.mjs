/**
 * ISSystem 定期考査 実施科目調査（出題者・試験時間・教室）の行部品とグリッド
 * 調査開始 → 実施科目・出題者の表が全員に表示され編集可能（教員は自分の出題コマのみ）
 * 調査終了 → 教務権限者のみ以後も編集可能
 * 表示絞り込み（教科・学年）で表示件数を減らして編集できる
 * ※ グリッド（renderSurveySection / bindSurveySection）は年間考査計画タブの ② に埋め込む
 * ※ 行部品 subjectRowHtml と payloadFromRow は「実施科目の決定」タブでも使う
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
  sectionLockState,
} from './exam.shared.js';
import { state } from '../../state.js';

/** 教職員プール（出題者セレクト用・bind 時にキャッシュ） */
let staffPool = null;

export async function ensureStaffPool() {
  if (staffPool && staffPool.length) return staffPool;
  const res = await examApi.get('/staff/pool');
  staffPool = res.staff || [];
  return staffPool;
}

/** 教職員名（決定タブでデフォルト値との差分表示に使う、取得後はキャッシュから引く） */
export function staffNameOf(id) {
  const s = (staffPool || []).find((x) => String(x.id) === String(id));
  return s ? String(s.name) : null;
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

/** 行の編集可否（教務は常時、教員は調査期間中の自分の出題コマのみ） */
function rowEditable(p, kyomu) {
  return !!(kyomu || p.can_edit);
}

/** 標準試験時間（教務のみ変更可・デフォルト50分）の選択肢 */
function minuteOptions(master) {
  const base = Number(master?.default_duration) || 50;
  const set = new Set([50, 100, base, base * 2]);
  return [...set].sort((a, b) => a - b);
}

/** 考査で使用する教室のオプション（考査教室マスタ + 基本情報教室 + 現在の設定） */
function roomOptions(p) {
  const board = examStore.board || {};
  const rooms = (board.rooms || []).slice();
  for (const r of board.basic_info?.rooms || []) {
    if (!rooms.some((x) => String(x.id) === String(r.id))) rooms.push(r);
  }
  if (p.room_id && !rooms.some((r) => String(r.id) === String(p.room_id))) {
    rooms.push({ id: p.room_id, name: p.room_name || p.room_id });
  }
  const opts = rooms
    .map((r) => `<option value="${r.id}" ${String(r.id) === String(p.room_id) ? 'selected' : ''}>${escapeHTML(r.name || r.id)}</option>`)
    .join('');
  return `<option value="">（未設定）</option>${opts}`;
}

/** 実施するコースチップ（基本情報をデフォルト表示、クリックで選択） */
function classChips(p, editable) {
  const classes = (examStore.board?.basic_info?.classes || [])
    .slice()
    .sort((a, b) => Number(a.grade) - Number(b.grade) || String(a.name).localeCompare(String(b.name), 'ja'));
  const grade = Number(p.grade) || 0;
  const pool = grade === 0 ? classes.filter((c) => Number(c.grade) > 0) : classes.filter((c) => Number(c.grade) === grade);
  const selSet = new Set((p.class_ids || []).map(String));
  const byGrade = new Map();
  for (const c of pool) {
    const g = Number(c.grade);
    if (!byGrade.has(g)) byGrade.set(g, []);
    byGrade.get(g).push(c);
  }
  const groups = [...byGrade.keys()]
    .sort((a, b) => a - b)
    .map(
      (g) =>
        `<div class="flex flex-wrap items-center gap-1 py-0.5"><span class="text-[10px] font-semibold text-muted w-7">${g}年</span>` +
        byGrade.get(g)
          .map((c) => {
            const on = selSet.has(String(c.id));
            const style = on ? 'bg-accent-soft border-accent-strong text-accent-strong font-bold' : 'bg-surface border-main text-soft';
            return `<span data-cc="${escapeHTML(String(c.id))}" data-cc-on="${on ? 1 : 0}" data-cc-edit="${editable ? 1 : 0}" class="cc-chip inline-block px-1.5 py-0.5 rounded border text-[10px] ${editable ? 'cursor-pointer select-none' : ''} ${style}">${escapeHTML(c.name)}</span>`;
          })
          .join('') +
        '</div>'
    )
    .join('');
  return `<div class="cc-list max-w-[280px] space-y-0.5">${groups || '<span class="text-[10px] text-muted">クラス・コース未登録</span>'}</div>`;
}

/** 基本情報科目カタログ（curriculum_subjects）を名前で引く索引 */
function subjectIndex() {
  const map = new Map();
  for (const s of examStore.board?.basic_info?.subjects || []) {
    if (s.is_active) map.set(String(s.name), s);
  }
  return map;
}

function roomNameFor(roomId) {
  const rooms = [...(examStore.board?.rooms || []), ...(examStore.board?.basic_info?.rooms || [])];
  const r = rooms.find((x) => String(x.id) === String(roomId));
  return r ? String(r.name) : null;
}

/** 実施科目調査の表示絞り込み（教科・学年で表示件数を減らして編集する） */
const subjectFilter = { subject: '', grade: '' };

function filterBarHtml(plan) {
  const rows = plan || [];
  const names = [...new Set(rows.map((p) => String(p.subject_name || '').trim()))].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ja'));
  const grades = [...new Set(rows.map((p) => Number(p.grade) || 0))].filter((g) => g > 0).sort((a, b) => a - b);
  const subjectOpts = names
    .map((n) => `<option value="${escapeHTML(n)}" ${subjectFilter.subject === n ? 'selected' : ''}>${escapeHTML(n)}（${rows.filter((p) => String(p.subject_name) === n).length}）</option>`)
    .join('');
  const gradeOpts = grades
    .map((g) => `<option value="${g}" ${String(subjectFilter.grade) === String(g) ? 'selected' : ''}>${g}年（${rows.filter((p) => Number(p.grade) === g).length}）</option>`)
    .join('');
  return `<div class="flex flex-wrap items-center gap-2 text-[11px]">
    <label class="text-[10px] text-muted font-semibold">表示絞り込み</label>
    <select id="exam-sub-filter-subject" class="input-field py-1 px-2 text-xs w-40">
      <option value="">全教科（${rows.length}件）</option>${subjectOpts}
    </select>
    <select id="exam-sub-filter-grade" class="input-field py-1 px-2 text-xs w-32">
      <option value="">全学年</option>
      <option value="0" ${subjectFilter.grade === '0' ? 'selected' : ''}>全学年共通（${rows.filter((p) => Number(p.grade) === 0).length}）</option>${gradeOpts}
    </select>
    <span id="exam-sub-filter-count" class="text-[10px] text-muted font-semibold"></span>
    <button id="exam-sub-filter-clear" class="btn-secondary py-1 px-2 text-[10px] flex items-center gap-1">
      <i data-lucide="filter-off" class="w-3 h-3"></i> 全件表示
    </button>
    <span class="text-[10px] text-muted">選択した教科・学年だけを表示します（非表示の行も登録済みで、表示行のみ編集します）</span>
  </div>`;
}

function applySubjectFilter(container) {
  const body = container.querySelector('#exam-sub-body');
  if (!body) return;
  const fSubject = subjectFilter.subject;
  const fGrade = subjectFilter.grade;
  let shown = 0;
  let total = 0;
  for (const tr of body.querySelectorAll('tr[data-row-id]')) {
    total += 1;
    const okSubject = !fSubject || String(tr.dataset.subject) === fSubject;
    const okGrade = fGrade === '' || String(tr.dataset.grade) === String(fGrade);
    const show = okSubject && okGrade;
    tr.classList.toggle('hidden', !show);
    tr.style.display = show ? '' : 'none';
    if (show) shown += 1;
  }
  const count = container.querySelector('#exam-sub-filter-count');
  if (count) count.textContent = `表示 ${shown} / ${total} 件`;
}

/** 試験を実施する科目を基本情報から選択する（その学年の科目＋全学年科目、既存プランの科目は保持） */
function subjectSelectHtml(p, can) {
  const g = Number(p.grade) || 0;
  const catalog = (examStore.board?.basic_info?.subjects || []).filter(
    (s) => s.is_active && (Number(s.grade) === 0 || Number(s.grade) === g)
  );
  const name = String(p.subject_name || '');
  const options = catalog.map(
    (s) => `<option value="${escapeHTML(String(s.name))}" ${name === String(s.name) ? 'selected' : ''}>${escapeHTML(String(s.short_name || s.name))}</option>`
  );
  if (name && !catalog.some((s) => String(s.name) === name)) {
    options.unshift(`<option value="${escapeHTML(name)}" selected>${escapeHTML(name)}</option>`);
  }
  if (!options.length) options.push('<option value="">（基本情報に科目未登録）</option>');
  return `<select data-f="subject_name" ${can ? '' : 'disabled'} class="input-field w-24 py-1 text-[11px]">${options.join('')}</select>`;
}

/** 科目・学年の選択時に基本情報の開講設定を反映する（実施クラス・教室・試験時間） */
export function applySubjectDefaults(p) {
  const s = subjectIndex().get(String(p.subject_name));
  if (!s) return;
  p.subject_id = s.subject_id || s.id || null;
  p.subject_short = s.short_name || p.subject_short;
  const g = Number(p.grade) || 0;
  const offers = (s.offerings || []).filter((o) => Number(o?.grade) === g && String(o?.class_course_id ?? o?.course_id));
  const ids = offers.map((o) => String(o.class_course_id ?? o.course_id));
  if (ids.length) p.class_ids = ids;
  const offerRoom = (offers.find((o) => o.room_id) || {}).room_id || s.default_room_id || null;
  if (offerRoom) {
    p.room_id = offerRoom;
    p.room_name = roomNameFor(offerRoom) || p.room_name;
  }
  p.duration_minutes = Number(s.default_duration) || Number(p.duration_minutes) || 50;
  p.duration_slots = Math.max(1, Math.ceil(Number(p.duration_minutes) / 50));
}

export function subjectRowHtml(p, kyomu) {
  // クラス・コース編集ロックが他教員なら chips を操作不能にする（server も書き込みを 423 で守る）
  const can = rowEditable(p, kyomu) && sectionLockState('class') !== 'other';
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
  // 実施時間（標準試験時間＝50分）は教務のみ変更可能。時限数は 50分単位で導出する。
  const master = examStore.board?.master || {};
  const minutes = Number(p.duration_minutes) || Number(master.default_duration) || 50;
  const minSel = `<select data-f="duration_minutes" ${kyomu ? '' : 'disabled'} class="input-field w-16 py-1 text-[11px] text-center">
      ${minuteOptions(master)
        .map((m) => `<option value="${m}" ${minutes === m ? 'selected' : ''}>${m}分</option>`)
        .join('')}
    </select>`;
  const durSel = `<select data-f="duration_slots" ${kyomu ? '' : 'disabled'} class="input-field w-14 py-1 text-[11px] text-center">
      ${[1, 2, 3].map((d) => `<option value="${d}" ${(Number(p.duration_slots) || Math.max(1, Math.ceil(minutes / (Number(master.default_duration) || 50))) ) === d ? 'selected' : ''}>${d}</option>`).join('')}
    </select>`;
  const status =
    p.submit_status === 'SUBMITTED'
      ? '<span class="badge bg-success-soft text-success-strong text-[9px] px-1.5 py-0.5 rounded font-bold">提出済</span>'
      : '<span class="badge bg-surface text-muted border border-main text-[9px] px-1.5 py-0.5 rounded font-bold">未提出</span>';
  return `<tr data-row-id="${p.id || ''}" data-grade="${Number(p.grade) || 0}" data-subject="${escapeHTML(String(p.subject_name || '').trim())}">
    <td class="border border-divider p-1.5">${subjectSelectHtml(p, can)}</td>
    <td class="border border-divider p-1.5 text-center">${gradeSel}</td>
    <td class="border border-divider p-1.5"><select data-f="setter_teacher_id" ${dis} class="input-field w-full py-1 text-[11px]">${staffOptions(p.setter_teacher_id)}</select></td>
    <td class="border border-divider p-1.5"><select data-f="patrol_teacher_id" ${dis} class="input-field w-full py-1 text-[11px]">${staffOptions(p.patrol_teacher_id)}</select></td>
    <td class="border border-divider p-1.5 text-center space-y-1">${minSel}${kyomu ? '' : `<div class="text-[10px] text-muted">${minutes}分</div>`}</td>
    <td class="border border-divider p-1.5 text-center">${durSel}</td>
    <td class="border border-divider p-1.5">${classChips(p, can)}</td>
    <td class="border border-divider p-1.5"><select data-f="room_id" ${dis} class="input-field w-full py-1 text-[11px]">${roomOptions(p)}</select></td>
    <td class="border border-divider p-1.5"><input data-f="request_note" value="${escapeHTML(p.request_note || '')}" ${dis} class="input-field w-full py-1 text-[11px]" placeholder="要望（試験時間・教室等）" /></td>
    <td class="border border-divider p-1.5 space-y-1">${flags}</td>
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
    ? master.start_date && master.end_date
      ? `<span>期間 ${escapeHTML(String(master.start_date).slice(0, 10))} 〜 ${escapeHTML(String(master.end_date).slice(0, 10))} ／ ${master.days_count}日間 × ${master.daily_slots}時限</span>`
      : '<span class="text-warning-strong">③ の期間登録待ち（期間・コマ数未設定）</span>'
    : '';
  // 基本情報から実施教科数（実施科目数）を集計して表示する（考査期間決定の材料）
  const byGrade = new Map();
  for (const s of examStore.board?.basic_info?.subjects || []) {
    if (!s.is_active) continue;
    const g = Number(s.grade) || 0;
    byGrade.set(g, (byGrade.get(g) || 0) + 1);
  }
  const countsHtml = [...byGrade.keys()]
    .sort((a, b) => a - b)
    .map(
      (g) =>
        `<span class="badge bg-surface border border-main text-muted text-[10px] px-1.5 py-0.5 rounded font-bold">${g === 0 ? '全' : `${g}年`}: ${byGrade.get(g)}科目</span>`
    )
    .join(' ');
  return sectionCard(
    'list-checks',
    '実施科目の決定（出題者・巡回者・実施時間・コース・教室・要望）',
    '調査開始で全項目が全教員に表示され編集可能になります（実施時間のデフォルト値は教務のみ変更）。教員は自分の出題コマのみ編集・提出できます。教科・学年で表示を絞って編集できます。',
    `<div class="flex flex-wrap items-center gap-3 text-[11px] text-muted">
       ${phaseBadge(phase)} ${period} ${countsHtml}
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

/** 行からペイロードを収集する（baseRows: 基準行配列、調査プランにも決定行にも使う） */
export function payloadFromRow(tr, baseRows) {
  const orig = (baseRows || []).find((r) => String(r.id) === String(tr.dataset.rowId)) || {};
  const out = { ...orig };
  tr.querySelectorAll('[data-f]').forEach((el) => {
    const key = el.dataset.f;
    out[key] = el.type === 'checkbox' ? el.checked : el.value;
  });
  // 実施クラス・コースはチップ選択から収集する
  out.class_ids = [...tr.querySelectorAll('[data-cc]')].filter((el) => el.dataset.ccOn === '1').map((el) => String(el.dataset.cc));
  out.subject_name = String(out.subject_name || '').trim();
  out.subject_id = out.subject_id || null;
  // 基本情報カタログの科目情報（subject_id・略称）を補う
  const cat = subjectIndex().get(String(out.subject_name));
  if (cat) {
    out.subject_id = out.subject_id || cat.subject_id || cat.id || null;
    out.subject_short = cat.short_name || out.subject_short;
  }
  out.grade = Number(out.grade) || 0;
  out.duration_minutes = Number(out.duration_minutes) || 50;
  out.duration_slots = Number(out.duration_slots) || Math.max(1, Math.ceil(out.duration_minutes / (Number(examStore.board?.master?.default_duration) || 50)));
  out.fixed_slot = out.fixed_slot ? Number(out.fixed_slot) : null;
  out.student_count = out.student_count ? Number(out.student_count) : null;
  out.setter_teacher_id = out.setter_teacher_id || null;
  out.patrol_teacher_id = out.patrol_teacher_id || null;
  out.request_note = String(out.request_note || '').trim() || null;
  out.room_id = out.room_id || null;
  out.room_name = out.room_id ? (examStore.board?.rooms || []).concat(examStore.board?.basic_info?.rooms || []).find((r) => String(r.id) === String(out.room_id))?.name || out.room_name || null : null;
  out.courses = out.courses || [];
  out.class_ids = out.class_ids.length ? out.class_ids : (orig.class_ids || []);
  out.stream = out.stream || 'OTHER';
  out.scope = out.scope || 'GRADE';
  out.submit_status = out.submit_status || 'PENDING';
  if (tr.dataset.rowId) out.id = tr.dataset.rowId;
  return out;
}

/** 実施科目調査グリッド（② のカード下に埋め込む。調査開始／終了ボタンは ② カード側にある） */
export function renderSurveySection(container) {
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
    <div class="card p-4 space-y-2">
      ${filterBarHtml(plan)}
      <div class="flex flex-wrap items-center gap-2 text-[10px] text-muted">
        <button id="exam-sub-add" class="btn-secondary py-1 px-2 text-[10px] flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
          <i data-lucide="plus" class="w-3.5 h-3.5"></i> 行を追加
        </button>
        <span>行追加後は「保存」→「提出」で登録します（教務は常時編集可、教員は調査期間中の自分の出題コマのみ編集可）</span>
      </div>
      <div class="overflow-x-auto">
        <table class="w-full text-left border-collapse min-w-[1200px]">
          <thead><tr>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">試験実施科目<br /><span class="font-normal">(基本情報から選択)</span></th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">学年</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">出題者（仮登録）</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">巡回者（仮登録）</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">実施時間<br /><span class="font-normal">（教務のみ変更）</span></th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">時限数</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">実施クラス・コース<br /><span class="font-normal">（基本情報デフォルト）</span></th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">考査教室<br /><span class="font-normal">（ここで初設定）</span></th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">要望</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">条件</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">状態</th>
            <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">操作</th>
          </tr></thead>
          <tbody id="exam-sub-body">${rows || '<tr><td colspan="12" class="p-2 text-[11px] text-muted border border-divider">実施科目が登録されていません。教務が「調査開始」を押すと全科目分の表が作成されます。</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
  applySubjectFilter(container);
  refreshLucideIcons();
}

/** 実施科目調査タブ（②）: ヘッダカード + グリッド（グリッドは年間考査計画タブの ② にも埋め込む） */
export function renderSubjectTab(container) {
  const board = examStore.board;
  const kyomu = isKyomuUser();
  if (!board) {
    container.innerHTML = `<div class="card p-6 text-center text-xs text-muted">考査データを読み込み中…</div>`;
    return;
  }
  container.innerHTML = `${surveyHeadHtml(board.master, board.phases, kyomu)}<div id="exam-survey-grid"></div>`;
  renderSurveySection(container.querySelector('#exam-survey-grid'));
}



/** グリッドのバインド（renderFn はグリッド描画関数、plan タブ埋め込み時は renderSurveySection） */
export function bindSurveySection(container, reload, renderFn = renderSubjectTab) {
  if (!container) return;
  if (container.dataset.bound === 'survey') return;
  container.dataset.bound = 'survey';

  // 教員プールを取得して出題者セレクトを反映（イベント委譲のため再描画安全）
  ensureStaffPool()
    .then(() => renderFn(container))
    .catch(() => {});

  const readRow = (tr) => payloadFromRow(tr, examStore.board.subject_plan || []);

  container.addEventListener('click', async (e) => {
    // 表示絞り込みの解除（全件表示）
    if (e.target.closest('#exam-sub-filter-clear')) {
      subjectFilter.subject = '';
      subjectFilter.grade = '';
      const sSel = container.querySelector('#exam-sub-filter-subject');
      const gSel = container.querySelector('#exam-sub-filter-grade');
      if (sSel) sSel.value = '';
      if (gSel) gSel.value = '';
      applySubjectFilter(container);
      return;
    }

    // クラス・コースチップの選択トグル（編集可能な行のみ反映）
    const chip = e.target.closest('[data-cc]');
    if (chip) {
      if (chip.dataset.ccEdit === '1') {
        const on = chip.dataset.ccOn !== '1';
        chip.dataset.ccOn = on ? '1' : '0';
        chip.classList.toggle('bg-accent-soft', on);
        chip.classList.toggle('border-accent-strong', on);
        chip.classList.toggle('text-accent-strong', on);
        chip.classList.toggle('font-bold', on);
        chip.classList.toggle('bg-surface', !on);
        chip.classList.toggle('border-main', !on);
        chip.classList.toggle('text-soft', !on);
      }
      return;
    }
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
        subject_name: '',
        grade: 0,
        stream: 'OTHER',
        scope: 'GRADE',
        duration_minutes: Number(examStore.board?.master?.default_duration) || 50,
        duration_slots: 1,
        shared_slot: false,
        broadcast_slot: false,
        solo_subject: false,
        courses: [],
        class_ids: [],
        room_id: null,
        request_note: '',
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

    const payload = readRow(tr);
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

  // 科目・学年の選択時は基本情報（curriculum_subjects）の開講設定を反映して行を描き直す
  container.addEventListener('change', (e) => {
    const el = e.target;
    // 表示絞り込み（教科・学年）で表示件数を減らす
    if (el.id === 'exam-sub-filter-subject') {
      subjectFilter.subject = el.value || '';
      applySubjectFilter(container);
      return;
    }
    if (el.id === 'exam-sub-filter-grade') {
      subjectFilter.grade = el.value === '' ? '' : String(el.value);
      applySubjectFilter(container);
      return;
    }
    const f = el.getAttribute && el.getAttribute('data-f');
    if (f !== 'subject_name' && f !== 'grade') return;
    const tr = el.closest('tr[data-row-id]');
    if (!tr) return;
    const orig = (examStore.board.subject_plan || []).find((r) => String(r.id) === String(tr.dataset.rowId)) || {};
    const draft = { ...orig, ...readRow(tr) };
    applySubjectDefaults(draft);
    tr.innerHTML = subjectRowHtml(draft, isKyomuUser()).replace(/^<tr[^>]*>/, '');
  });
}

/** 実施科目調査タブのバインド（タブシェル用、グリッドバインドの薄い wrapper） */
export function bindSubjectTab(container, reload) {
  bindSurveySection(container, reload, renderSubjectTab);
}

export default {
  renderSubjectTab,
  bindSubjectTab,
  renderSurveySection,
  bindSurveySection,
  subjectRowHtml,
  payloadFromRow,
  ensureStaffPool,
  staffNameOf,
};

