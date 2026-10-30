/**
 * ISSystem 定期考査 公表・自分の担当タブ
 * 教員: 公表された試験時間割・教室割・自分の監督担当・自分の出張等を表示
 * 教務: 公表状況サマリー・全監督割当・全出張等を閲覧
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
} from './exam.shared.js';
import { dayDateLabel, examDayList, isBlockedFor, isGlobalBlocked } from './exam.timetable.ui.js';

let view = null;
let allProctors = null;
let allTrips = null;
let lastExamId = null;
let loadedFlag = false;
const bound = new WeakSet();

const PHASE_KEYS = [
  ['timetable_phase', '時間割'],
  ['room_phase', '教室割'],
  ['proctor_phase', '監督割'],
  ['trip_phase', '出張等'],
];

function myProctorKeys() {
  const set = new Set();
  for (const p of view?.my_proctor || []) set.add(`${Number(p.grade)}|${Number(p.day)}|${Number(p.slot)}`);
  return set;
}

function roomKeyMap() {
  const map = new Map();
  for (const r of view?.rooms || []) map.set(`${Number(r.grade)}|${Number(r.day)}|${Number(r.slot)}`, r.room_name);
  return map;
}

function gridTablesHtml(grades) {
  const master = view.master;
  const days = examDayList(master);
  const slots = Array.from({ length: Number(master.daily_slots) || 0 }, (_, i) => i + 1);
  const mySet = myProctorKeys();
  const roomMap = roomKeyMap();
  const tGrid = view.timetable || [];

  return grades
    .map((g) => {
      const header =
        `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset">日</th>` +
        slots.map((s) => `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset text-center">${s}限</th>`).join('');
      const rows = days
        .map((d) => {
          const tds = slots
            .map((s) => {
              if (isBlockedFor(g, d, s)) {
                return `<td class="border border-divider p-1 align-top bg-inset">
                    <span class="text-[12px] font-bold text-muted block">×</span>
                    <span class="badge bg-surface text-muted text-[9px] px-1 block">${isGlobalBlocked(d, s) ? '共通' : `${g}年`}</span>
                  </td>`;
              }
              const key = `${Number(g)}|${d}|${s}`;
              const cell = tGrid.find((t) => Number(t.grade) === Number(g) && Number(t.day) === d && Number(t.slot) === s);
              if (!cell) return `<td class="border border-divider p-1 align-top bg-inset"><span class="text-[10px] text-muted">実施なし</span></td>`;
              const room = roomMap.get(key);
              const mine = mySet.has(key);
              const body =
                `<span class="text-[10px] font-bold text-main block">${escapeHTML(cell.subject_name || '')}</span>` +
                `<span class="text-[10px] text-muted block">${escapeHTML(cell.setter || '')}</span>` +
                `<span class="text-[10px] font-bold ${room ? 'text-accent-strong' : 'text-muted'} block">${room ? escapeHTML(room) : '教室未定'}</span>` +
                (mine ? `<span class="badge bg-success-soft text-success-strong border border-success-soft text-[10px] mt-0.5 inline-block">監督: 自分</span>` : '');
              return `<td class="border border-divider p-1 align-top">${body}</td>`;
            })
            .join('');
          const dateLabel = dayDateLabel(d);
          return `<tr class="border-t border-divider"><th class="px-2 py-1.5 text-[10px] font-bold text-main bg-inset">${d}日目${dateLabel ? `<span class="text-[9px] font-normal text-muted block">${dateLabel}</span>` : ''}</th>${tds}</tr>`;
        })
        .join('');
      return `<div class="mt-2"><h4 class="text-xs font-bold text-main mb-1">${escapeHTML(String(g))}学年 の試験時間割・教室</h4>
        <div class="overflow-x-auto"><table class="w-full text-left border-collapse min-w-[620px]"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
    })
    .join('');
}

function listTableHtml(list, cols, emptyText) {
  if (!list || list.length === 0) return `<p class="text-[11px] text-muted">${emptyText}</p>`;
  const header = cols.map((c) => `<th class="px-2 py-1.5 text-[10px] text-muted font-bold bg-inset ${c.center ? 'text-center' : ''}">${c.label}</th>`).join('');
  const body = list
    .map((r) => `<tr>${cols.map((c) => `<td class="border border-divider p-1.5 text-[11px] ${c.center ? 'text-center' : ''}">${escapeHTML(String(r[c.key] ?? ''))}</td>`).join('')}</tr>`)
    .join('');
  return `<div class="overflow-x-auto"><table class="w-full text-left border-collapse min-w-[520px]"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
}

export function renderPublishedTab(container) {
  if (!view) {
    container.innerHTML = `<div class="card p-6 text-center text-xs text-muted">公表データを読み込み中…</div>`;
    return;
  }
  const kyomu = isKyomuUser();
  const master = view.master;
  const grades = (master.grades || []).map(Number);

  const overview = sectionCard(
    'eye',
    '公表状況サマリー',
    `${escapeHTML(master.name)}（${escapeHTML(master.start_date)}〜${escapeHTML(master.end_date)} / ${master.days_count}日間・${master.daily_slots}限）`,
    `<div class="flex flex-wrap items-center gap-2">
       ${PHASE_KEYS.map(([k, label]) => `<span class="text-xs text-soft">${label} ${phaseBadge(view.phases[k])}</span>`).join('')}
       <span class="text-[10px] text-muted ml-auto">
         時間割 ${view.timetable.length} コマ / 教室割 ${view.rooms.length} 件 /
         自分の監督 ${view.my_proctor.length} 件 / 自分の出張 ${view.my_trips.length} 件
       </span>
     </div>`
  );

  const myGrades = kyomu ? grades : grades.filter((g) => g === (Number(state.currentUser.grade) || 0));
  const gridCard = sectionCard(
    'layout-grid',
    kyomu ? '公表された試験時間割・教室（全学年）' : '公表された試験時間割・教室（自分の学年）',
    '公表済みの時間割に教室割と自分の監督担当を重ねて表示します。',
    gridTablesHtml(myGrades.length ? myGrades : grades)
  );

  const dutyCard = sectionCard(
    'shield-check',
    '自分の監督担当（公表済み）',
    '公表された監督割のうち、自分が監督として割当られたコマです。',
    listTableHtml(
      view.my_proctor.map((p) => ({ day: `${p.day}日目`, slot: `${p.slot}限`, grade: `${p.grade}学年`, subject_name: p.subject_name, room_name: p.room_name || '' })),
      [
        { key: 'day', label: '日', center: true },
        { key: 'slot', label: '時限', center: true },
        { key: 'grade', label: '学年', center: true },
        { key: 'subject_name', label: '科目' },
        { key: 'room_name', label: '教室' },
      ],
      '公表後に自分の監督担当が表示されます。'
    )
  );

  const tripCard = sectionCard(
    'plane',
    '自分の出張等（公表済み）',
    '公表された出張・外出・私用・欠席のうち、自分の登録分です。',
    listTableHtml(
      view.my_trips.map((t) => ({ day: `${t.day_number}日目`, slot: `${t.slot_number}限`, reason: t.reason, from: t.from_absence ? '出欠由来' : '手動' })),
      [
        { key: 'day', label: '日', center: true },
        { key: 'slot', label: '時限', center: true },
        { key: 'reason', label: '区分' },
        { key: 'from', label: '出欠', center: true },
      ],
      '登録された出張等はありません。'
    )
  );

  container.innerHTML = overview + gridCard + dutyCard + tripCard + kyomuAllCard();
  refreshLucideIcons();
}

function kyomuAllCard() {
  if (!isKyomuUser()) return '';
  return sectionCard(
    'users',
    '全監督割当・全出張等（教務閲覧）',
    '公表後の全教員の監督担当と全出張等を一覧表示します。',
    listTableHtml(
      (allProctors || []).map((p) => ({
        day: `${p.day_number}日目`,
        slot: `${p.slot_number}限`,
        grade: `${p.grade}学年`,
        proctor_name: p.proctor_name || p.proctor_teacher_id || '',
        subject_name: p.subject_name || '',
        room_name: p.room_name || '',
      })),
      [
        { key: 'day', label: '日', center: true },
        { key: 'slot', label: '時限', center: true },
        { key: 'grade', label: '学年', center: true },
        { key: 'proctor_name', label: '監督' },
        { key: 'subject_name', label: '科目' },
        { key: 'room_name', label: '教室' },
      ],
      '監督割がまだ作成されていません。'
    ) +
      `<div class="pt-2">` +
      listTableHtml(
        (allTrips || []).map((t) => ({
          teacher_name: t.teacher_name || t.teacher_id || '',
          day: `${t.day_number}日目`,
          slot: `${t.slot_number}限`,
          reason: t.reason || '',
          from: t.from_absence ? '出欠由来' : '手動',
        })),
        [
          { key: 'teacher_name', label: '教員' },
          { key: 'day', label: '日', center: true },
          { key: 'slot', label: '時限', center: true },
          { key: 'reason', label: '区分' },
          { key: 'from', label: '出欠', center: true },
        ],
        '出張等が登録されていません。'
      ) +
      `</div>`
  );
}


export async function bindPublishedTab(container, reload) {
  const id = examStore.examId;
  if (!loadedFlag || lastExamId !== id) {
    loadedFlag = true;
    lastExamId = id;
    try {
      view = await examApi.get(`/exam/${id}/view`);
      if (view.is_kyomu) {
        allProctors = (await examApi.get(`/exam/${id}/view/proctors`)).proctors;
        allTrips = (await examApi.get(`/exam/${id}/view/trips`)).trips;
      }
      renderPublishedTab(container);
    } catch (e) {
      console.warn('[View] load', e);
      showToast('公表データを読み込めませんでした', 'error');
    }
  }
  if (bound.has(container)) return;
  bound.add(container);
}

