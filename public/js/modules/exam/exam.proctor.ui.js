/**
 * ISSystem 定期考査 監督割の作成タブ
 * 監督ルール・非常勤条件・個別配慮・監督免除 → 自動作成 → 手動編集（検証）→ 公表／終了
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
  diagnosticsHtml,
} from './exam.shared.js';
import { dayDateLabel, examDayList, isBlockedFor, isGlobalBlocked } from './exam.timetable.ui.js';

const PROCTOR_DEFAULTS = {
  solo_subject_self: true,
  special_room_rotation: [],
  avoid_setter: true,
  enforce_parttime_availability: true,
  trips_block: true,
  balance_groups: true,
  considerations: [],
  kyomu_priority: 4,
  parttime_prefer: 6,
  weights: { load: 40, fairness: 10, special_extra: 40, parttime_late: 6, unassigned: 1000, rotation_outside: 25, spread: 30 },
};

const SPECIAL_TYPES = ['SP1', 'SP2', 'PREP1'];

let board = null;
let phase = 'DRAFT';
let cells = [];
let rules = { ...PROCTOR_DEFAULTS };
let parttime = [];
let avail = new Map();
let constraints = [];
let exemptions = [];
let lastExamId = null;
let loadedFlag = false;
const bound = new WeakSet();

const aKey = (staffId, day, slot) => `${staffId}|${Number(day)}|${Number(slot)}`;

function syncWorking() {
  const b = board;
  cells = (b.cells || []).map((c) => ({ ...c }));
  const src = b.rules || {};
  rules = { ...PROCTOR_DEFAULTS, ...src, weights: { ...PROCTOR_DEFAULTS.weights, ...(src.weights || {}) } };
  rules.special_room_rotation = (rules.special_room_rotation || []).map((r) => ({
    type: String(r.type || 'SP1').toUpperCase(),
    teacher_ids: (r.teacher_ids || []).map(String),
    pattern: String(r.pattern || 'ALL').toUpperCase(),
  }));
  rules.considerations = (rules.considerations || []).map((c) => ({
    teacher_id: String(c.teacher_id),
    max_slots_per_day: Number(c.max_slots_per_day) || null,
  }));
  parttime = (b.parttime_staff || []).map((p) => ({
    id: p.id,
    staff_id: p.staff_id || p.teacher_id,
    staff_name: p.staff_name,
    max_slots_per_day: Number(p.daily_limit ?? p.slot_condition?.max_slots_per_day) || 1,
    max_consecutive_slots: Number(p.max_consecutive ?? p.slot_condition?.max_consecutive_slots) || 1,
    consecutive_rule: p.consecutive_rule || 'MAX1',
    notes: p.notes || '',
  }));
  avail = new Map();
  for (const a of b.availability || []) avail.set(aKey(a.staff_id, a.day_number, a.slot_number), a.available !== false);
  constraints = (board.constraints || examStore.board?.teacher_constraints || []).map((c) => ({
    teacher_id: c.teacher_id,
    teacher_name: c.teacher_name,
    max_slots_per_day: Number(c.max_slots_per_day ?? c.constraint_type?.max_slots_per_day) || null,
    max_consecutive_slots: Number(c.max_consecutive_slots ?? c.constraint_type?.max_consecutive_slots) || null,
    notes: c.notes || '',
  }));
  exemptions = (b.exemptions || []).map((e) => ({
    teacher_id: e.teacher_id,
    teacher_name: e.teacher_name,
    reason: e.reason || '',
  }));
  lastExamId = examStore.examId;
}

function staffList() {
  const base = (board.staff || []).map((s) => ({ id: s.id, name: s.name, parttime: !!s.is_parttime }));
  for (const p of parttime) {
    if (!base.some((s) => String(s.id) === String(p.staff_id))) base.push({ id: p.staff_id, name: p.staff_name, parttime: true });
  }
  return base;
}

function staffOptions(sel, includeEmpty = false) {
  const head = includeEmpty ? '<option value="">（未割当）</option>' : '';
  return head + staffList().map((s) => `<option value="${s.id}" ${String(s.id) === String(sel) ? 'selected' : ''}>${escapeHTML(s.name)}${s.parttime ? '（非常勤）' : ''}</option>`).join('');
}

function days() {
  return examDayList(board.master);
}
function slots() {
  return Array.from({ length: Number(board.master.daily_slots) || 0 }, (_, i) => i + 1);
}

/** 当該コマ（実施日 × 時限）で試験が行われているか（全学年） */
function examAt(day, slot) {
  const d = Number(day);
  const s = Number(slot);
  return cells.some((c) => Number(c.day_number) === d && Number(c.slot_number) === s);
}

function tripsSet() {
  const set = new Set();
  for (const t of board.trips || []) set.add(aKey(t.teacher_id, t.day_number, t.slot_number));
  return set;
}

function cellAt(grade, day, slot) {
  return cells.find((c) => Number(c.grade) === grade && Number(c.day_number) === day && Number(c.slot_number) === slot);
}

function phaseCardHtml(kyomu, editable) {
  const b = [];
  if (kyomu && phase !== 'ENDED') {
    b.push('<button id="exam-proctor-solve" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1"><i data-lucide="wand-2" class="w-3.5 h-3.5"></i> 監督割を自動作成</button>');
    b.push('<button id="exam-proctor-validate" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1"><i data-lucide="shield-check" class="w-3.5 h-3.5"></i> 手動編集を検証</button>');
    b.push('<button id="exam-proctor-save" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1"><i data-lucide="save" class="w-3.5 h-3.5"></i> 手動編集を保存</button>');
  }
  if (kyomu && phase !== 'ENDED' && phase !== 'PUBLISHED') {
    b.push('<button id="exam-proctor-publish" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1"><i data-lucide="megaphone" class="w-3.5 h-3.5"></i> 公表</button>');
  }
  if (kyomu && phase === 'PUBLISHED') {
    b.push('<button id="exam-proctor-end" class="btn-danger py-1.5 px-3 text-xs flex items-center gap-1"><i data-lucide="lock" class="w-3.5 h-3.5"></i> 公表終了</button>');
  }
  return sectionCard(
    'shield-check',
    '監督割フェーズ',
    '教務が自動作成→手動編集（検証）→公表→公表終了 の順で進行します。教員は公表中の自分の担当を確認できます。',
    `<div class="flex flex-wrap items-center gap-2">
       <span class="text-xs text-soft">監督割 ${phaseBadge(phase)}</span>
       ${b.join('')}
       <span class="text-[10px] text-muted ml-auto">${kyomu ? `未割当 ${cells.filter((c) => !c.proctor_teacher_id).length} 件 / 全 ${cells.length} コマ` : '教員：公表後の自分の担当を表示'}</span>
     </div>`
  );
}

const RULE_TOGGLES = [
  ['solo_subject_self', 'ソロ科目は出題者が監督'],
  ['avoid_setter', '出題者を監督から避ける'],
  ['enforce_parttime_availability', '非常勤の出勤可能コマを厳格化'],
  ['trips_block', '出張等を監督からブロック'],
  ['balance_groups', '監督負荷を均等化'],
];

function rulesCardHtml(kyomu) {
  const toggles = RULE_TOGGLES.map(
    ([k, label]) => `<label class="flex items-center gap-1.5 text-[11px] text-soft"><input data-rule="${k}" type="checkbox" ${rules[k] ? 'checked' : ''} ${kyomu ? '' : 'disabled'} class="rounded" /> ${label}</label>`
  ).join('');
  const nums = `<label class="flex items-center gap-1 text-[11px] text-soft">教務の監督コマへの優先度 <input data-rule="kyomu_priority" type="number" min="0" value="${rules.kyomu_priority}" ${kyomu ? '' : 'disabled'} class="input-field w-14 py-1 text-[11px] text-center" /></label>
     <label class="flex items-center gap-1 text-[11px] text-soft">非常勤の優先加算 <input data-rule="parttime_prefer" type="number" min="0" value="${rules.parttime_prefer}" ${kyomu ? '' : 'disabled'} class="input-field w-14 py-1 text-[11px] text-center" /></label>`;

  const rotRows = (rules.special_room_rotation || [])
    .map(
      (r, i) => `<tr data-rot="${i}">
        <td class="border border-divider p-1.5"><select data-rot="type" class="input-field w-20 py-1 text-[11px]" ${kyomu ? '' : 'disabled'}>${SPECIAL_TYPES.map((t) => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td class="border border-divider p-1.5"><input data-rot="teachers" value="${escapeHTML(r.teacher_ids.join(','))}" ${kyomu ? '' : 'disabled'} class="input-field w-full py-1 text-[11px]" placeholder="教員ID" /></td>
        <td class="border border-divider p-1.5"><select data-rot="pattern" class="input-field w-20 py-1 text-[11px]" ${kyomu ? '' : 'disabled'}>${['ALL', 'ALT', 'DAY'].map((p) => `<option value="${p}" ${p === r.pattern ? 'selected' : ''}>${p}</option>`).join('')}</select></td>
        <td class="border border-divider p-1.5 text-center"><button data-rot-del="${i}" class="text-[10px] text-danger-strong" ${kyomu ? '' : 'disabled'}>削除</button></td>
      </tr>`
    )
    .join('');

  const consRows = (rules.considerations || [])
    .map(
      (c, i) => `<tr data-cons="${i}">
        <td class="border border-divider p-1.5"><select data-cons="teacher_id" class="input-field w-full py-1 text-[11px]" ${kyomu ? '' : 'disabled'}>${staffOptions(c.teacher_id)}</select></td>
        <td class="border border-divider p-1.5"><input data-cons="max_slots_per_day" type="number" min="0" value="${c.max_slots_per_day ?? ''}" ${kyomu ? '' : 'disabled'} class="input-field w-16 py-1 text-[11px] text-center" /></td>
        <td class="border border-divider p-1.5 text-center"><button data-cons-del="${i}" class="text-[10px] text-danger-strong" ${kyomu ? '' : 'disabled'}>削除</button></td>
      </tr>`
    )
    .join('');

  return sectionCard(
    'settings-2',
    '監督ルール',
    '特別教室ローテーション・配慮（日上限）・出題者回避などのルールを保存します。',
    `<div class="flex flex-wrap items-center gap-3">${toggles}</div>
     <div class="flex flex-wrap items-center gap-3 pt-1">${nums}</div>
     <div class="overflow-x-auto pt-2">
       <table class="w-full text-left border-collapse min-w-[480px]">
         <thead><tr>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">特別教室</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">ローテーション教員ID</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">パターン</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">操作</th>
         </tr></thead>
         <tbody>${rotRows || '<tr><td colspan="4" class="p-2 text-[11px] text-muted border border-divider">特別教室ローテーションはありません。</td></tr>'}</tbody>
       </table>
     </div>
     <div class="overflow-x-auto pt-2">
       <table class="w-full text-left border-collapse min-w-[400px]">
         <thead><tr>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">配慮教員</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">1日上限</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">操作</th>
         </tr></thead>
         <tbody>${consRows || '<tr><td colspan="3" class="p-2 text-[11px] text-muted border border-divider">配慮設定はありません。</td></tr>'}</tbody>
       </table>
     </div>
     <div class="flex flex-wrap items-center gap-2 pt-1">
       <button id="exam-pr-rot-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}><i data-lucide="plus" class="w-3.5 h-3.5"></i> ロテーション追加</button>
       <button id="exam-pr-cons-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}><i data-lucide="plus" class="w-3.5 h-3.5"></i> 配慮追加</button>
       <button id="exam-pr-rules-save" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}><i data-lucide="save" class="w-3.5 h-3.5"></i> ルールを保存</button>
     </div>`
  );
}



function parttimeCardHtml(kyomu) {
  const rows = parttime
    .map(
      (p) => `<tr data-pt="${p.staff_id}">
        <td class="border border-divider p-1.5"><select data-pt="staff_id" class="input-field w-full py-1 text-[11px]" ${kyomu ? '' : 'disabled'}>${staffOptions(p.staff_id)}</select></td>
        <td class="border border-divider p-1.5"><input data-pt="max_slots_per_day" type="number" min="0" value="${p.max_slots_per_day}" ${kyomu ? '' : 'disabled'} class="input-field w-14 py-1 text-[11px] text-center" /></td>
        <td class="border border-divider p-1.5"><input data-pt="max_consecutive_slots" type="number" min="0" value="${p.max_consecutive_slots}" ${kyomu ? '' : 'disabled'} class="input-field w-14 py-1 text-[11px] text-center" /></td>
        <td class="border border-divider p-1.5"><select data-pt="consecutive_rule" class="input-field w-20 py-1 text-[11px]" ${kyomu ? '' : 'disabled'}>${['MAX1', 'MAXN', 'NONE'].map((r) => `<option value="${r}" ${r === p.consecutive_rule ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
        <td class="border border-divider p-1.5"><input data-pt="notes" value="${escapeHTML(p.notes)}" ${kyomu ? '' : 'disabled'} class="input-field w-full py-1 text-[11px]" /></td>
        <td class="border border-divider p-1.5 text-center">
          <button data-pt-save="${p.staff_id}" class="btn-secondary py-1 px-2 text-[10px]" ${kyomu ? '' : 'disabled'}>保存</button>
          <button data-pt-del="${p.staff_id}" class="text-[10px] text-danger-strong" ${kyomu ? '' : 'disabled'}>削除</button>
        </td>
      </tr>`
    )
    .join('');
  return sectionCard(
    'user-plus',
    '非常勤教員の監督条件',
    '非常勤教員は「日上限・連続上限・連続ルール」の条件付きで監督割の候補になります。',
    `<div class="overflow-x-auto">
       <table class="w-full text-left border-collapse min-w-[600px]">
         <thead><tr>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">教員</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">日上限</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">連続上限</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">連続ルール</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">メモ</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">操作</th>
         </tr></thead>
         <tbody>${rows || '<tr><td colspan="6" class="p-2 text-[11px] text-muted border border-divider">非常勤教員の条件登録はありません。</td></tr>'}</tbody>
       </table>
     </div>
     <div class="flex flex-wrap items-center gap-2 pt-1">
       <button id="exam-pt-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}><i data-lucide="plus" class="w-3.5 h-3.5"></i> 非常勤条件を追加</button>
     </div>`
  );
}

function availabilityCardHtml(kyomu) {
  if (!parttime.length) return '';
  const ss = slots();
  const header =
    `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">非常勤教員 / 日</th>` +
    ss.map((s) => `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">${s}限</th>`).join('');
  const body = parttime
    .map((p) =>
      days()
        .map(
          (d) => `<tr>
            <td class="border border-divider p-1.5 text-[11px] font-bold text-main">${escapeHTML(p.staff_name)}<span class="text-[10px] text-muted font-normal"> ${d}日目${dayDateLabel(d) ? `（${dayDateLabel(d)}）` : ''}</span></td>
            ${ss.map((s) => {
              if (isGlobalBlocked(d, s) || !examAt(d, s)) {
                return `<td class="border border-divider p-1 text-center bg-inset"><span class="text-[11px] font-bold text-muted">×</span></td>`;
              }
              const on = avail.get(aKey(p.staff_id, d, s)) === true;
              return `<td class="border border-divider p-1 text-center"><input data-avail="${p.staff_id}|${d}|${s}" type="checkbox" ${on ? 'checked' : ''} ${kyomu ? '' : 'disabled'} class="rounded" /></td>`;
            }).join('')}
          </tr>`
        )
        .join('')
    )
    .join('');
  return sectionCard(
    'calendar-check',
    '非常勤の出勤可能コマ（教員 × 日 × 時限）',
    'チェックしたコマのみ非常勤教員の監督割対象になります。',
    `<div class="overflow-x-auto">
       <table class="w-full text-left border-collapse min-w-[520px]">
         <thead><tr>${header}</tr></thead>
         <tbody>${body}</tbody>
       </table>
     </div>
     <div class="flex flex-wrap items-center gap-2 pt-1">
       <button id="exam-avail-save" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}><i data-lucide="save" class="w-3.5 h-3.5"></i> 出勤可能コマを保存</button>
     </div>`
  );
}


function constraintsCardHtml(kyomu) {
  const rows = constraints
    .map(
      (c) => `<tr data-con="${c.teacher_id}">
        <td class="border border-divider p-1.5"><select data-con="teacher_id" class="input-field w-full py-1 text-[11px]" ${kyomu ? '' : 'disabled'}>${staffOptions(c.teacher_id)}</select></td>
        <td class="border border-divider p-1.5"><input data-con="max_slots_per_day" type="number" min="0" value="${c.max_slots_per_day ?? ''}" ${kyomu ? '' : 'disabled'} class="input-field w-14 py-1 text-[11px] text-center" /></td>
        <td class="border border-divider p-1.5"><input data-con="max_consecutive_slots" type="number" min="0" value="${c.max_consecutive_slots ?? ''}" ${kyomu ? '' : 'disabled'} class="input-field w-14 py-1 text-[11px] text-center" /></td>
        <td class="border border-divider p-1.5"><input data-con="notes" value="${escapeHTML(c.notes)}" ${kyomu ? '' : 'disabled'} class="input-field w-full py-1 text-[11px]" /></td>
        <td class="border border-divider p-1.5 text-center"><button data-con-save="${c.teacher_id}" class="btn-secondary py-1 px-2 text-[10px]" ${kyomu ? '' : 'disabled'}>保存</button></td>
      </tr>`
    )
    .join('');
  return sectionCard(
    'user-check',
    '教員個別の監督条件（配慮）',
    '特定教員の1日上限・連続上限・メモを教員単位で保存します。',
    `<div class="overflow-x-auto">
       <table class="w-full text-left border-collapse min-w-[520px]">
         <thead><tr>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">教員</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">日上限</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">連続上限</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">メモ</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">操作</th>
         </tr></thead>
         <tbody>${rows || '<tr><td colspan="5" class="p-2 text-[11px] text-muted border border-divider">個別条件はありません。</td></tr>'}</tbody>
       </table>
     </div>
     <div class="flex flex-wrap items-center gap-2 pt-1">
       <button id="exam-con-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}><i data-lucide="plus" class="w-3.5 h-3.5"></i> 個別条件を追加</button>
     </div>`
  );
}

function exemptionsCardHtml(kyomu) {
  const rows = exemptions
    .map(
      (e) => `<tr>
        <td class="border border-divider p-1.5 text-[11px] font-bold text-main">${escapeHTML(e.teacher_name)}</td>
        <td class="border border-divider p-1.5 text-[11px] text-soft">${escapeHTML(e.reason)}</td>
        <td class="border border-divider p-1.5 text-center"><button data-exempt-del="${e.teacher_id}" class="text-[10px] text-danger-strong" ${kyomu ? '' : 'disabled'}>解除</button></td>
      </tr>`
    )
    .join('');
  return sectionCard(
    'shield-off',
    '監督免除教員',
    '教務が免除を登録した教員は監督割の候補外になります。',
    `<div class="overflow-x-auto">
       <table class="w-full text-left border-collapse min-w-[420px]">
         <thead><tr>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">教員</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">免除の理由</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">操作</th>
         </tr></thead>
         <tbody>${rows || '<tr><td colspan="3" class="p-2 text-[11px] text-muted border border-divider">免除教員はありません。</td></tr>'}</tbody>
       </table>
     </div>
     <div class="flex flex-wrap items-center gap-2 pt-1">
       <select id="exam-exempt-teacher" class="input-field w-40 py-1 text-[11px]" ${kyomu ? '' : 'disabled'}>${staffOptions(null)}</select>
       <input id="exam-exempt-reason" value="教務による監督免除" class="input-field w-48 py-1 text-[11px]" ${kyomu ? '' : 'disabled'} />
       <button id="exam-exempt-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}><i data-lucide="plus" class="w-3.5 h-3.5"></i> 免除を登録</button>
     </div>`
  );
}

function nameOf(id) {
  const s = staffList().find((x) => String(x.id) === String(id));
  return s ? s.name : String(id);
}

function proctorGridHtml(kyomu, editable) {
  const grades = [...new Set([...(board.master.grades || []).map(Number), ...cells.map((c) => Number(c.grade))])].filter((g) => Number.isFinite(g));
  const ss = slots();
  const tables = grades
    .map((g) => {
      const header =
        `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">日</th>` +
        ss.map((s) => `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">${s}限</th>`).join('');
      const rows = days()
        .map((d) => {
          const tds = ss
            .map((s) => {
              if (isBlockedFor(g, d, s)) {
                return `<td class="border border-divider p-1 align-top bg-inset">
                    <span class="text-[12px] font-bold text-muted block">×</span>
                    <span class="badge bg-surface text-muted text-[9px] px-1 block">${isGlobalBlocked(d, s) ? '共通' : `${g}年`}</span>
                  </td>`;
              }
              const c = cellAt(g, d, s);
              if (!c) return `<td class="border border-divider p-1 align-top bg-inset"><span class="text-[10px] text-muted">実施なし</span></td>`;
              const room = c.room_type ? `<span class="text-[10px] text-info ml-1">${c.room_type}</span>` : '';
              const subj = `<span class="text-[10px] font-bold text-main block">${escapeHTML(c.subject_name || '')}${room}</span>`;
              const inner = editable
                ? `${subj}<select data-cell="proctor" data-grade="${g}" data-day="${d}" data-slot="${s}" class="input-field w-full py-1 text-[10px]">${staffOptions(c.proctor_teacher_id, true)}</select>`
                : `${subj}<span class="text-[11px] font-bold ${c.is_mine ? 'text-accent-strong' : 'text-soft'}">${escapeHTML(c.proctor_name || '未割当')}</span>`;
              return `<td class="border border-divider p-1 align-top">${inner}</td>`;
            })
            .join('');
          const dateLabel = dayDateLabel(d);
          return `<tr class="border-t border-divider"><th class="px-2 py-1.5 text-[10px] font-bold text-main bg-inset">${d}日目${dateLabel ? `<span class="text-[9px] font-normal text-muted block">${dateLabel}</span>` : ''}</th>${tds}</tr>`;
        })
        .join('');
      return `<div class="mt-2"><h4 class="text-xs font-bold text-main mb-1">${g}学年 の監督割</h4>
        <div class="overflow-x-auto"><table class="w-full text-left border-collapse min-w-[640px]"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
    })
    .join('');

  const loadChips = (board.loads || [])
    .map((l) => `<span class="badge bg-surface text-soft border border-main text-[10px] px-1.5 py-0.5">${escapeHTML(nameOf(l.id))} : ${l.load}</span>`)
    .join(' ');

  return sectionCard(
    'layout-grid',
    '監督割グリッド（日 × 時限 × 学年）',
    '自動作成後、教務は監督教員を差し替えられます（保存後に検証を推奨）。教員は自分の担当が強調表示されます。',
    `<div>${tables}</div>
     <div class="flex flex-wrap items-center gap-1 pt-2">${loadChips || '<span class="text-[10px] text-muted">監督負荷：割当なし</span>'}</div>`
  );
}

function diagnosticsCardHtml() {
  return sectionCard('list-checks', '検証（出欠・非常勤出勤・日上限・特別教室ローテーション）', '公表前・保存後に検証して HARD 違反を確認します。', diagnosticsHtml(board.diagnostics || []));
}

export function renderProctorTab(container) {
  if (!board || !examStore.board) {
    container.innerHTML = `<div class="card p-6 text-center text-xs text-muted">考査データを読み込み中…</div>`;
    return;
  }
  const kyomu = isKyomuUser();
  phase = board.phases.proctor_phase;
  const editable = examStore.board.editable.proctor;
  if (lastExamId !== examStore.examId) syncWorking();

  container.innerHTML =
    phaseCardHtml(kyomu, editable) +
    rulesCardHtml(kyomu) +
    parttimeCardHtml(kyomu) +
    availabilityCardHtml(kyomu) +
    constraintsCardHtml(kyomu) +
    exemptionsCardHtml(kyomu) +
    proctorGridHtml(kyomu, editable) +
    diagnosticsCardHtml();
  refreshLucideIcons();
}



async function refreshProctor(id, container) {
  board = await examApi.get(`/exam/${id}/proctor-board`);
  syncWorking();
  renderProctorTab(container);
}

export async function bindProctorTab(container, reload) {
  const id = examStore.examId;
  if (!board || lastExamId !== id) {
    try {
      board = await examApi.get(`/exam/${id}/proctor-board`);
      syncWorking();
      loadedFlag = true;
      renderProctorTab(container);
    } catch (e) {
      console.warn('[Proctor] load', e);
    }
  }
  if (bound.has(container)) return;
  bound.add(container);
  container.addEventListener('change', (e) => bindProctorChange(e));
  container.addEventListener('click', (e) => bindProctorClick(e, container, id, reload));
}

function bindProctorChange(e) {
  const t = e.target;
  if (!isKyomuUser()) return;

  if (t.dataset.rule) {
    const k = t.dataset.rule;
    rules[k] = t.type === 'checkbox' ? t.checked : Number(t.value) || 0;
    return;
  }
  if (t.dataset.avail) {
    const [sid, d, s] = t.dataset.avail.split('|');
    avail.set(`${sid}|${d}|${s}`, t.checked);
    return;
  }
  if (t.dataset.cell === 'proctor') {
    const c = cellAt(Number(t.dataset.grade), Number(t.dataset.day), Number(t.dataset.slot));
    if (c) {
      c.proctor_teacher_id = t.value || null;
      c.proctor_name = t.value ? nameOf(t.value) : null;
      c.is_mine = String(t.value) === String(state.currentUser.id);
    }
    return;
  }

  const tr = t.closest('tr');
  if (t.dataset.rot && tr) {
    const r = rules.special_room_rotation[Number(tr.dataset.rot)];
    if (!r) return;
    if (t.dataset.rot === 'type') r.type = t.value;
    if (t.dataset.rot === 'teachers') r.teacher_ids = t.value.split(',').map((x) => x.trim()).filter(Boolean);
    if (t.dataset.rot === 'pattern') r.pattern = t.value;
    return;
  }
  if (t.dataset.cons && tr) {
    const c = rules.considerations[Number(tr.dataset.cons)];
    if (!c) return;
    if (t.dataset.cons === 'teacher_id') c.teacher_id = t.value;
    if (t.dataset.cons === 'max_slots_per_day') c.max_slots_per_day = Number(t.value) || null;
    return;
  }
  if (t.dataset.pt && tr) {
    const p = parttime.find((x) => String(x.staff_id) === String(tr.dataset.pt));
    if (!p) return;
    if (t.dataset.pt === 'staff_id') {
      p.staff_id = t.value;
      p.staff_name = nameOf(t.value);
    }
    if (t.dataset.pt === 'max_slots_per_day') p.max_slots_per_day = Number(t.value) || 1;
    if (t.dataset.pt === 'max_consecutive_slots') p.max_consecutive_slots = Number(t.value) || 1;
    if (t.dataset.pt === 'consecutive_rule') p.consecutive_rule = t.value;
    if (t.dataset.pt === 'notes') p.notes = t.value;
    return;
  }
  if (t.dataset.con && tr) {
    const c = constraints.find((x) => String(x.teacher_id) === String(tr.dataset.con));
    if (!c) return;
    if (t.dataset.con === 'teacher_id') c.teacher_id = t.value;
    if (t.dataset.con === 'max_slots_per_day') c.max_slots_per_day = Number(t.value) || null;
    if (t.dataset.con === 'max_consecutive_slots') c.max_consecutive_slots = Number(t.value) || null;
    if (t.dataset.con === 'notes') c.notes = t.value;
  }
}


async function bindProctorClick(e, container, id, reload) {
  const btn = e.target.closest('button');
  if (!btn) return;
  try {
    if (btn.dataset.rotDel !== undefined) {
      rules.special_room_rotation.splice(Number(btn.dataset.rotDel), 1);
      renderProctorTab(container);
      return;
    }
    if (btn.dataset.consDel !== undefined) {
      rules.considerations.splice(Number(btn.dataset.consDel), 1);
      renderProctorTab(container);
      return;
    }
    if (btn.dataset.ptDel) {
      await examApi.del(`/exam/${id}/parttime-staff/${btn.dataset.ptDel}`);
      showToast('非常勤教員条件を削除しました', 'success');
      await refreshProctor(id, container);
      return;
    }
    if (btn.dataset.ptSave) {
      const p = parttime.find((x) => String(x.staff_id) === String(btn.dataset.ptSave));
      if (!p) return;
      await examApi.post(`/exam/${id}/parttime-staff`, {
        staff_id: p.staff_id,
        max_slots_per_day: p.max_slots_per_day,
        max_consecutive_slots: p.max_consecutive_slots,
        consecutive_rule: p.consecutive_rule,
        notes: p.notes,
      });
      showToast('非常勤教員条件を保存しました', 'success');
      await refreshProctor(id, container);
      return;
    }
    if (btn.dataset.conSave) {
      const c = constraints.find((x) => String(x.teacher_id) === String(btn.dataset.conSave));
      if (!c) return;
      await examApi.post(`/exam/${id}/teacher-constraint`, {
        teacher_id: c.teacher_id,
        max_slots_per_day: c.max_slots_per_day,
        max_consecutive_slots: c.max_consecutive_slots,
        notes: c.notes,
      });
      showToast('教員個別条件を保存しました', 'success');
      return;
    }
    if (btn.dataset.exemptDel) {
      await examApi.del(`/exam/${id}/exemption/${btn.dataset.exemptDel}`);
      showToast('監督免除を解除しました', 'success');
      await refreshProctor(id, container);
      return;
    }

    if (btn.id === 'exam-pr-rot-add') {
      rules.special_room_rotation.push({ type: 'SP1', teacher_ids: [], pattern: 'ALL' });
      renderProctorTab(container);
      return;
    }
    if (btn.id === 'exam-pr-cons-add') {
      const s = staffList()[0];
      rules.considerations.push({ teacher_id: s ? s.id : '', max_slots_per_day: 1 });
      renderProctorTab(container);
      return;
    }
    if (btn.id === 'exam-pr-rules-save') {
      await examApi.post(`/exam/${id}/proctor-rules`, rules);
      showToast('監督ルールを保存しました', 'success');
      await refreshProctor(id, container);
      return;
    }
    if (btn.id === 'exam-avail-save') {
      const rows = [];
      for (const p of parttime) {
        for (const d of days()) {
          for (const s of slots()) {
            rows.push({ staff_id: p.staff_id, day_number: d, slot_number: s, available: avail.get(aKey(p.staff_id, d, s)) === true });
          }
        }
      }
      const r = await examApi.post(`/exam/${id}/parttime-availability`, rows);
      showToast(`出勤可能コマを ${r.saved}件 保存しました`, 'success');
      await refreshProctor(id, container);
      return;
    }
    if (btn.id === 'exam-pt-add') {
      const s = staffList().find((x) => x.parttime) || staffList()[0];
      if (!s) return;
      parttime.push({ staff_id: s.id, staff_name: s.name, max_slots_per_day: 1, max_consecutive_slots: 1, consecutive_rule: 'MAX1', notes: '' });
      renderProctorTab(container);
      return;
    }
    if (btn.id === 'exam-con-add') {
      const s = staffList()[0];
      if (!s) return;
      constraints.push({ teacher_id: s.id, teacher_name: s.name, max_slots_per_day: 1, max_consecutive_slots: 1, notes: '' });
      renderProctorTab(container);
      return;
    }
    if (btn.id === 'exam-exempt-add') {
      const sel = container.querySelector('#exam-exempt-teacher');
      const reason = container.querySelector('#exam-exempt-reason');
      if (!sel.value) {
        showToast('免除する教員を選択してください', 'error');
        return;
      }
      await examApi.post(`/exam/${id}/exemption`, { teacher_id: sel.value, reason: reason.value });
      showToast('監督免除教員を登録しました', 'success');
      await refreshProctor(id, container);
      return;
    }

    if (btn.id === 'exam-proctor-solve') {
      const res = await examApi.post(`/exam/${id}/proctor-assign`, {});
      const st = res.stats || {};
      showToast(`監督割を作成しました（割当 ${st.assigned ?? 0} / ${st.cells ?? 0}、未割当 ${st.unassigned ?? 0}）`, 'success');
      await refreshProctor(id, container);
      await reload();
      return;
    }
    if (btn.id === 'exam-proctor-save') {
      const rows = cells.map((c) => ({
        grade: Number(c.grade),
        class_id: c.class_id || `G${Number(c.grade)}`,
        day_number: Number(c.day_number),
        slot_number: Number(c.slot_number),
        subject_name: c.subject_name,
        proctor_teacher_id: c.proctor_teacher_id || null,
        setter_teacher_id: c.setter_teacher_id || null,
        setter_teacher_name: c.setter_teacher_name || null,
        room_name: c.room_name || null,
        notes: c.notes || null,
      }));
      const r = await examApi.put(`/exam/${id}/proctor-assign`, rows);
      showToast(`監督割当を ${r.saved}件 保存しました`, 'success');
      await refreshProctor(id, container);
      await reload();
      return;
    }
    if (btn.id === 'exam-proctor-validate') {
      const v = await examApi.post(`/exam/${id}/proctor-assign/validate`, { rows: cells });
      board.diagnostics = v.diagnostics;
      showToast(v.ok ? '検証: HARD 違反なし' : `検証: HARD 違反 ${v.hard_count} 件`, v.ok ? 'success' : 'error');
      renderProctorTab(container);
      return;
    }
    if (btn.id === 'exam-proctor-publish') {
      await examApi.post(`/exam/${id}/proctor-assign/publish`, {});
      showToast('監督割を公表しました', 'success');
      await refreshProctor(id, container);
      await reload();
      return;
    }
    if (btn.id === 'exam-proctor-end') {
      await examApi.post(`/exam/${id}/proctor-assign/end`, {});
      showToast('監督割の公表を終了しました', 'success');
      await refreshProctor(id, container);
      await reload();
      return;
    }
  } catch (err) {
    showToast(err.message || '監督割の処理に失敗しました', 'error');
  }
}

