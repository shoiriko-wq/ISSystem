/**
 * ISSystem 定期考査 教室割の作成タブ
 * 使用教室マスタ → 学年別特別教室ルール → 科目別標準教室 → 自動割当 → 手動編集 → 公表／終了
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
import { dayDateLabel, examDayList, isBlockedFor, isGlobalBlocked } from './exam.timetable.ui.js';

const ROOM_TYPES = ['CLASS', 'SP1', 'SP2', 'PREP1'];
const ROOM_TYPE_LABEL = { CLASS: '普通教室', SP1: '別室1', SP2: '別室2', PREP1: '予備教室' };

/** 教室割当編集状態 `${grade}|${day}|${slot}` → {room_name, unit_id, subject_name} */
let roomPos = new Map();
let lastSolve = null;
let phase = 'DRAFT';
let roomRows = [];
let cfgRows = [];
let rulesGrade = {};
let rulesSubject = {};
let lastExamId = null;

/** サーバ板から作業コピーを初期化（教務の編集は作業コピーに行い、保存で PUT/POST する） */
function syncWorking() {
  const board = examStore.board;
  roomRows = (board.rooms || []).map((r) => ({ ...r, grades: [...(r.grades || [])] }));
  cfgRows = (board.room_config || []).map((c) => ({ ...c, alt_rooms: [...(c.alt_rooms || [])] }));
  rulesGrade = {};
  rulesSubject = {};
  lastExamId = board.master.id;
  syncRoomPos();
}

function syncRoomPos() {
  roomPos = new Map();
  for (const a of examStore.board?.room_assignments || []) {
    roomPos.set(`${Number(a.grade)}|${Number(a.day_number)}|${Number(a.slot_number)}`, {
      room_name: a.room_name,
      unit_id: a.unit_id || null,
      subject_name: a.subject_name || null,
    });
  }
}

function roomTypeOptions(selected) {
  const t = String(selected || 'CLASS').toUpperCase();
  return ROOM_TYPES.map((x) => `<option value="${x}" ${x === t ? 'selected' : ''}>${ROOM_TYPE_LABEL[x]}</option>`).join('');
}

function roomRowHtml(r, editable) {
  const dis = editable ? '' : 'disabled';
  const grades = (r.grades || []).join(',');
  return `<tr data-room-id="${r.id || ''}">
    <td class="border border-divider p-1.5"><input data-room="name" value="${escapeHTML(r.name || '')}" ${dis} class="input-field w-full py-1 text-[11px]" /></td>
    <td class="border border-divider p-1.5"><select data-room="type" ${dis} class="input-field w-full py-1 text-[11px]">${roomTypeOptions(r.room_type)}</select></td>
    <td class="border border-divider p-1.5"><input data-room="cap" type="number" min="0" value="${r.capacity ?? ''}" ${dis} class="input-field w-16 py-1 text-[11px] text-center" /></td>
    <td class="border border-divider p-1.5"><input data-room="grades" value="${escapeHTML(grades)}" ${dis} class="input-field w-20 py-1 text-[11px]" placeholder="1,2,3" /></td>
    <td class="border border-divider p-1.5 text-center"><input data-room="alt" type="checkbox" ${r.is_alternate ? 'checked' : ''} ${dis} class="rounded" /></td>
    <td class="border border-divider p-1.5 text-center">${
      r.id ? '<span class="text-[10px] text-muted">更新</span>' : '<button data-room-remove class="text-[10px] text-danger-strong">削除</button>'
    }</td>
  </tr>`;
}

function roomMasterHtml(rooms, kyomu) {
  const rows = rooms.map((r) => roomRowHtml(r, kyomu)).join('');
  return sectionCard(
    'layout-grid',
    '使用教室マスタ',
    '考査に使用する教室を登録します（普通教室・別室・予備教室）。削除の API は未提供です。',
    `<div class="overflow-x-auto">
       <table class="w-full text-left border-collapse min-w-[560px]">
         <thead><tr>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">教室名</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">種別</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">収容</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">対応学年</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">予備</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">状態</th>
         </tr></thead>
         <tbody id="exam-room-body">${rows || '<tr><td colspan="6" class="p-2 text-[11px] text-muted border border-divider">教室が登録されていません。</td></tr>'}</tbody>
       </table>
     </div>
     <div class="flex flex-wrap items-center gap-2">
       <button id="exam-room-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="plus" class="w-3.5 h-3.5"></i> 教室を追加
       </button>
       <button id="exam-room-save" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="save" class="w-3.5 h-3.5"></i> 教室マスタを保存
       </button>
     </div>`
  );
}

function ruleTypeOptions(selected) {
  const t = String(selected || '').toUpperCase();
  return `<option value="">指定なし</option>` + ROOM_TYPES.map((x) => `<option value="${x}" ${x === t ? 'selected' : ''}>${ROOM_TYPE_LABEL[x]}</option>`).join('');
}

function rulesHtml(byGrade, bySubject, kyomu, grades) {
  const gradeRows = (grades.length ? grades : [1, 2, 3])
    .map(
      (g) => `<div class="flex items-center gap-2 text-[11px] text-soft">
        <span class="w-14 font-bold text-main">${g}学年</span>
        <select data-rg="${g}" class="input-field w-40 py-1 text-[11px]" ${kyomu ? '' : 'disabled'}>${ruleTypeOptions(byGrade[g])}</select>
      </div>`
    )
    .join('');
  const subjectRows = Object.entries(bySubject)
    .map(([key, val]) => {
      const [g, s] = key.split('|');
      return `<tr data-rs="${escapeHTML(key)}">
        <td class="border border-divider p-1.5 text-[11px] text-main font-bold">${escapeHTML(g)}年</td>
        <td class="border border-divider p-1.5 text-[11px]">${escapeHTML(s)}</td>
        <td class="border border-divider p-1.5"><select data-rs-type class="input-field w-full py-1 text-[11px]" ${kyomu ? '' : 'disabled'}>${ruleTypeOptions(val)}</select></td>
      </tr>`;
    })
    .join('');
  return sectionCard(
    'sliders',
    '学年別・科目別の特別教室ルール',
    '学年単位の指定と、学年+科目の個別指定（例: 3年|化学 → 別室2）を教務が設定します。',
    `<div class="grid grid-cols-1 md:grid-cols-3 gap-2">${gradeRows}</div>
     <div class="overflow-x-auto pt-2">
       <table class="w-full text-left border-collapse min-w-[360px]">
         <thead><tr>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">学年</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">科目</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">特別教室</th>
         </tr></thead>
         <tbody id="exam-room-rules-body">${subjectRows || '<tr><td colspan="3" class="p-2 text-[11px] text-muted border border-divider">科目別指定はありません。</td></tr>'}</tbody>
       </table>
     </div>
     <div class="flex flex-wrap items-center gap-2">
       <button id="exam-rr-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="plus" class="w-3.5 h-3.5"></i> 科目別ルールを追加
       </button>
       <button id="exam-rr-save" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="save" class="w-3.5 h-3.5"></i> ルールを保存
       </button>
     </div>`
  );
}

function configHtml(config, rooms, kyomu, subjectNames) {
  const roomOpts = (sel) => `<option value="">（指定なし）</option>` + rooms.map((r) => `<option value="${escapeHTML(r.name)}" ${r.name === sel ? 'selected' : ''}>${escapeHTML(r.name)}</option>`).join('');
  const rows = config
    .map(
      (c) => `<tr data-cfg-id="${c.id || ''}">
        <td class="border border-divider p-1.5"><input data-cfg="subject" value="${escapeHTML(c.subject_name || '')}" ${kyomu ? '' : 'disabled'} class="input-field w-full py-1 text-[11px]" /></td>
        <td class="border border-divider p-1.5 text-center">
          <select data-cfg="grade" ${kyomu ? '' : 'disabled'} class="input-field w-14 py-1 text-[11px] text-center">
            ${[0, 1, 2, 3].map((g) => `<option value="${g}" ${Number(c.grade) === g ? 'selected' : ''}>${g === 0 ? '全' : g}</option>`).join('')}
          </select>
        </td>
        <td class="border border-divider p-1.5"><select data-cfg="standard_room" ${kyomu ? '' : 'disabled'} class="input-field w-full py-1 text-[11px]">${roomOpts(c.standard_room)}</select></td>
        <td class="border border-divider p-1.5"><input data-cfg="alt_rooms" value="${escapeHTML((c.alt_rooms || []).join(','))}" ${kyomu ? '' : 'disabled'} class="input-field w-full py-1 text-[11px]" placeholder="予備1,予備2" /></td>
        <td class="border border-divider p-1.5 text-center">
          ${c.id ? '<button data-cfg-save class="btn-secondary py-1 px-2 text-[10px]">保存</button>' : '<button data-cfg-save class="btn-primary py-1 px-2 text-[10px]">登録</button>'}
        </td>
      </tr>`
    )
    .join('');
  return sectionCard(
    'settings-2',
    '科目別 標準教室・予備教室',
    '各科目（学年）の標準教室と予備教室の優先順を登録します。自動割当は標準教室最大化を優先します。',
    `<div class="overflow-x-auto">
       <table class="w-full text-left border-collapse min-w-[560px]">
         <thead><tr>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">科目</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">学年</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">標準教室</th>
           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">予備教室（順）</th>

           <th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">操作</th>
         </tr></thead>
         <tbody id="exam-rcfg-body">${rows || '<tr><td colspan="5" class="p-2 text-[11px] text-muted border border-divider">標準教室設定がありません。行を追加してください。</td></tr>'}</tbody>
       </table>
     </div>
     <div class="flex flex-wrap items-center gap-2">
       <button id="exam-rcfg-add" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="plus" class="w-3.5 h-3.5"></i> 行を追加（科目: ${subjectNames.slice(0, 6).map(escapeHTML).join(' / ')}）
       </button>
     </div>`
  );
}


/** 時間割スパンを各コマに展開（教室割グリッドの科目情報参照用） */
function slotCellMap(slots) {
  const map = new Map();
  for (const s of slots || []) {
    const span = Number(s.slot_span) || Number(s.duration_slots) || 1;
    const g = Number(s.grade);
    const d = Number(s.day_number);
    for (let k = 0; k < span; k++) {
      map.set(`${g}|${d}|${Number(s.slot_number) + k}`, {
        unit_id: s.subject_id || null,
        subject_name: s.subject_name,
        isStart: k === 0,
      });
    }
  }
  return map;
}

function roomGridHtml(master, slots, rooms, kyomu, editable, phase) {
  const slotN = Number(master.daily_slots) || 0;
  const dayList = examDayList(master);
  const cellMap = slotCellMap(slots);
  const roomOptions = (selected) =>
    `<option value="">（空）</option>` +
    rooms
      .map((r) => `<option value="${escapeHTML(r.name)}" ${r.name === selected ? 'selected' : ''}>${escapeHTML(r.name)}</option>`)
      .join('');

  const tables = (master.grades || [])
    .map((g) => {
      const header =
        `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">日</th>` +
        Array.from({ length: slotN }, (_, i) => i + 1)
          .map((s) => `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">${s}限</th>`)
          .join('');
      const rows = dayList
        .map((d) => {
          const cells = Array.from({ length: slotN }, (_, si) => si + 1)
            .map((s) => {
              if (isBlockedFor(g, d, s)) {
                return `<td class="border border-divider p-1 align-top bg-inset">
                    <span class="text-[12px] font-bold text-muted block">×</span>
                    <span class="badge bg-surface text-muted text-[9px] px-1 block">${isGlobalBlocked(d, s) ? '共通' : `${g}年`}</span>
                  </td>`;
              }
              const key = `${Number(g)}|${d}|${s}`;
              const unit = cellMap.get(key);
              if (!unit) {
                return `<td class="border border-divider p-1 align-top bg-inset"><span class="text-[10px] text-muted">実施なし</span></td>`;
              }
              const pos = roomPos.get(key);
              const roomName = pos ? pos.room_name : '';
              const subject = `<span class="text-[10px] font-bold text-main block">${escapeHTML(unit.subject_name || '')}</span>`;
              const inner = editable
                ? `${subject}<select data-cell-room="${key}" data-unit="${unit.unit_id || ''}" data-subject="${escapeHTML(unit.subject_name || '')}" class="input-field w-full py-1 text-[10px]">${roomOptions(roomName)}</select>`
                : `${subject}<span class="text-[11px] font-bold text-accent-strong">${escapeHTML(roomName || '未割当')}</span>`;
              return `<td class="border border-divider p-1 align-top">${inner}</td>`;
            })
            .join('');
          const dateLabel = dayDateLabel(d);
          return `<tr class="border-t border-divider"><th class="px-2 py-1.5 text-[10px] font-bold text-main bg-inset">${d}日目${dateLabel ? `<span class="text-[9px] font-normal text-muted block">${dateLabel}</span>` : ''}</th>${cells}</tr>`;
        })
        .join('');
      return `<div class="mt-2"><h4 class="text-xs font-bold text-main mb-1">${g}学年 の教室割</h4>
        <div class="overflow-x-auto"><table class="w-full text-left border-collapse min-w-[640px]"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
    })
    .join('');

  return sectionCard(
    'layout-grid',
    '教室割グリッド（日 × 時限 × 学年）',
    '自動作成は標準教室の最大化・予備教室順・特殊教室の予約順を考慮します。教務はセルの教室を手動で差し替えられます。',
    `<div>${tables}</div>
     <div class="flex flex-wrap items-center gap-2">
       <button id="exam-room-solve" class="btn-primary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu && editable ? '' : 'disabled'}>
         <i data-lucide="wand-2" class="w-3.5 h-3.5"></i> 教室割を作成
       </button>
       <button id="exam-room-save-assign" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu && editable ? '' : 'disabled'}>
         <i data-lucide="save" class="w-3.5 h-3.5"></i> 手動編集を保存
       </button>
       <button id="exam-room-publish" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu && phase !== 'ENDED' ? '' : 'disabled'}>
         <i data-lucide="megaphone" class="w-3.5 h-3.5"></i> 公表
       </button>
       <button id="exam-room-end" class="btn-danger py-1.5 px-3 text-xs flex items-center gap-1" ${kyomu ? '' : 'disabled'}>
         <i data-lucide="lock" class="w-3.5 h-3.5"></i> 公表終了
       </button>
       <span class="text-[10px] text-muted ml-auto">${kyomu ? '教務：全セル編集可（公表中も編集可）' : '教員：公表中は閲覧のみ'}</span>
     </div>`
  );
}


export function renderRoomTab(container) {
  const board = examStore.board;
  if (!board) {
    container.innerHTML = `<div class="card p-6 text-center text-xs text-muted">考査データを読み込み中…</div>`;
    return;
  }
  phase = board.phases.room_phase;
  if (lastExamId !== examStore.examId) syncWorking();

  const kyomu = isKyomuUser();
  const editable = board.editable.room;
  const subjectNames = [...new Set((board.subject_plan || []).map((p) => p.subject_name))];
  const roomList = roomRows.length ? roomRows : board.rooms || [];
  const cfgList = cfgRows.length ? cfgRows : board.room_config || [];
  container.innerHTML =
    roomMasterHtml(roomList, kyomu) +
    rulesHtml(rulesGrade, rulesSubject, kyomu, board.master.grades) +
    configHtml(cfgList, board.rooms, kyomu, subjectNames) +
    roomGridHtml(board.master, board.slots, board.rooms, kyomu, editable, phase);
  refreshLucideIcons();
}


const bound = new WeakSet();
let rulesLoaded = false;

/** グリッドの select 変更を roomPos に反映（同一スパンの継続セルも追随） */
function applyCellChange(sel) {
  const [g, d, s] = sel.dataset.cellRoom.split('|').map(Number);
  const roomName = sel.value;
  const room = (examStore.board.rooms || []).find((r) => r.name === roomName);
  roomPos.set(sel.dataset.cellRoom, {
    room_name: roomName,
    unit_id: sel.dataset.unit || null,
    subject_name: sel.dataset.subject || '',
    room_id: room ? room.id : null,
    grade: g,
    day_number: d,
    slot_number: s,
    is_standard: false,
  });
  const span = Number(examStore.board.master.daily_slots) || 0;
  if (roomName) {
    for (let k = s + 1; k <= span; k++) {
      const key = `${g}|${d}|${k}`;
      const cur = roomPos.get(key);
      if (cur && cur.unit_id === sel.dataset.unit && cur.subject_name === sel.dataset.subject) {
        roomPos.set(key, { ...cur, room_name: roomName, room_id: room ? room.id : null });
      }
    }
  }
}

/** 保存用 rows（スパン開始セルのみ。継続セルは同一教室に追随済み） */
function buildAssignRows(container) {
  const rows = [];
  container.querySelectorAll('select[data-cell-room]').forEach((sel) => {
    const pos = roomPos.get(sel.dataset.cellRoom);
    if (pos && pos.room_name) {
      rows.push({
        unit_id: pos.unit_id,
        subject_name: pos.subject_name,
        grade: pos.grade,
        day_number: pos.day_number,
        slot_number: pos.slot_number,
        room_id: pos.room_id,
        room_name: pos.room_name,
        is_standard: pos.is_standard,
      });
    }
  });
  return rows;
}

export async function bindRoomTab(container, reload) {
  const id = examStore.examId;
  const kyomu = isKyomuUser();
  if (lastExamId !== id) syncWorking();

  if (kyomu && !rulesLoaded) {
    rulesLoaded = true;
    try {
      const r = await examApi.get(`/exam/${id}/room-rules`);
      rulesGrade = r.rules_by_grade || {};
      rulesSubject = r.rules_by_subject || {};
      renderRoomTab(container);
    } catch (e) {

function bindRoomChange(e, container, id) {
  const t = e.target;
  const tr = t.closest('tr');
  if (t.dataset.room && tr) {
    const row = roomRows.find((r) => String(r.id) === tr.dataset.roomId);
    if (row) {
      if (t.dataset.room === 'name') row.name = t.value;
      if (t.dataset.room === 'type') row.room_type = t.value;
      if (t.dataset.room === 'cap') row.capacity = t.value === '' ? null : Number(t.value);
      if (t.dataset.room === 'grades') row.grades = t.value.split(',').map((x) => Number(x.trim())).filter((n) => n > 0);
      if (t.dataset.room === 'alt') row.is_alternate = t.checked;
    }
  }
  if (t.dataset.cfg && tr) {
    const row = cfgRows.find((c) => String(c.id) === tr.dataset.cfgId);
    if (row) {
      if (t.dataset.cfg === 'subject') row.subject_name = t.value;
      if (t.dataset.cfg === 'grade') row.grade = Number(t.value);
      if (t.dataset.cfg === 'standard_room') row.standard_room = t.value;
      if (t.dataset.cfg === 'alt_rooms') row.alt_rooms = t.value.split(',').map((x) => x.trim()).filter(Boolean);
    }
  }
  if (t.dataset.rg) rulesGrade[t.dataset.rg] = t.value;
  if (t.dataset.rsType && tr) rulesSubject[tr.dataset.rs] = t.value;
  if (t.dataset.cellRoom) applyCellChange(t);
}

      showToast(e.message || '教室ルールの取得に失敗しました', 'error');
    }
  }

  if (bound.has(container)) return;
  bound.add(container);
  container.addEventListener('change', (e) => bindRoomChange(e, container, id));
  container.addEventListener('click', (e) => bindRoomClick(e, container, id, reload));
}


async function bindRoomClick(e, container, id, reload) {
  const btn = e.target.closest('button');
  if (!btn) return;
  try {
    const rmId = btn.dataset.roomRemove;
    if (rmId) {
      roomRows = roomRows.filter((r) => String(r.id) !== rmId);
      await examApi.post(`/exam/${id}/rooms`, roomRows.filter((r) => r.name));
      showToast('教室を削除しました', 'success');
      await reload();
      return;
    }
    const cfgSave = btn.dataset.cfgSave;
    if (cfgSave) {
      const row = cfgRows.find((c) => String(c.id) === cfgSave);
      if (!row || !row.subject_name) {
        showToast('科目名を入力してください', 'error');
        return;
      }
      await examApi.post(`/exam/${id}/room-config`, row);
      showToast('標準教室設定を保存しました', 'success');
      await reload();
      return;
    }
    if (btn.id === 'exam-room-add') {
      roomRows.push({ id: `tmp-${Date.now()}`, name: '', room_type: 'CLASS', capacity: null, grades: [], is_alternate: false });
      renderRoomTab(container);
      return;
    }
    if (btn.id === 'exam-room-save') {
      const list = roomRows.filter((r) => r.name.trim());
      await examApi.post(`/exam/${id}/rooms`, list);
      showToast('教室マスタを保存しました', 'success');
      await reload();
      return;
    }
    if (btn.id === 'exam-rr-add') {
      const g = (examStore.board.master.grades || [1])[0];
      const subj = [...new Set((examStore.board.subject_plan || []).map((p) => p.subject_name))][0] || '';
      rulesSubject[`${g}|${subj}`] = 'SP1';
      renderRoomTab(container);
      return;
    }
    if (btn.id === 'exam-rr-save') {
      await examApi.post(`/exam/${id}/room-rules`, { rules_by_grade: rulesGrade, rules_by_subject: rulesSubject });
      showToast('特別教室ルールを保存しました', 'success');
      await reload();
      return;
    }
    if (btn.id === 'exam-rcfg-add') {
      const subj = [...new Set((examStore.board.subject_plan || []).map((p) => p.subject_name))][0] || '';
      cfgRows.push({ id: `tmp-${Date.now()}`, subject_name: subj, grade: 0, standard_room: null, alt_rooms: [] });
      renderRoomTab(container);
      return;
    }
    if (btn.id === 'exam-room-solve') {
      const res = await examApi.post(`/exam/${id}/room-assign`, {});
      const st = res.stats || {};
      showToast(`教室割を作成しました（${st.standard_count ?? 0} 標準 / ${st.alternate_count ?? 0} 予備 / ${st.unassigned_count ?? 0} 未割当）`, 'success');
      await reload();
      return;
    }
    if (btn.id === 'exam-room-save-assign') {
      const rows = buildAssignRows(container);
      await examApi.put(`/exam/${id}/room-assign`, rows);
      showToast('手動編集した教室割を保存しました', 'success');
      await reload();
      return;
    }
    if (btn.id === 'exam-room-publish') {
      await examApi.post(`/exam/${id}/room-assign/publish`, {});
      showToast('教室割を公表しました', 'success');
      await reload();
      return;
    }
    if (btn.id === 'exam-room-end') {
      await examApi.post(`/exam/${id}/room-assign/end`, {});
      showToast('教室割の公表を終了しました', 'success');
      await reload();
      return;
    }
  } catch (err) {
    showToast(err.message || '教室割の処理に失敗しました', 'error');
  }
}

