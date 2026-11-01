/**
 * ISSystem 定期考査 基本情報マスタ UI (教務部 KYOMU)
 * 登録順：1. クラス・コース 2. 教科 3. 科目（教科・科目名・略称 × 実施クラス・コース） 4. 教室
 * クラスとコースは分離せず「1-1」「1-3理」「1-6看」「1-6保育」のような学校固有の名称を直接入力する。
 * 科目は登録済み教科を選択し、教科順にソートして表示する（学年・表示順・標準試験時間・標準教室の項目は持たない）。
 * 実施クラス・コースはクリック・長押しドラッグ（Shift+クリックで範囲）で連続選択する。
 * 変更は socket の basicinfo:changed / subjects:changed で考査計画・時間割・教室割・監督割へ cascade される。
 */

import { escapeHTML, refreshLucideIcons, showToast } from '../../ui-helpers.js';
import { examStore, examApi, sectionCard, isKyomuUser } from './exam.shared.js';

const GRADE_OPTS = [[1, '1年'], [2, '2年'], [3, '3年']];
const KIND_LABELS = { class: 'クラス・コース', group: '教科', subject: '科目', room: '教室' };
const API_BASE = {
  class: '/basic-info/class',
  group: '/subjects',
  subject: '/basic-info/subject',
  room: '/basic-info/room',
};
const USAGE_LABELS = {
  plans: '実施科目',
  offerings: '開講科目',
  slots: '時間割',
  proctors: '監督割',
  plan: '実施科目',
  room_config: '教室設定',
  room_assignments: '教室割',
  subject_defaults: '科目の標準教室',
  exam_rooms: '考査教室',
  plan_rows: '実施科目',
  room_assign_names: '教室割',
};

function masterData() {
  const d = examStore.board?.basic_info || {};
  const groups = (d.subject_groups || []).slice();
  const groupOrder = new Map(groups.map((g, i) => [String(g.id), i]));
  const subjects = (d.subjects || [])
    .slice()
    .sort((a, b) => {
      const ga = a.subject_id ? groupOrder.get(String(a.subject_id)) ?? 999 : 999;
      const gb = b.subject_id ? groupOrder.get(String(b.subject_id)) ?? 999 : 999;
      if (ga !== gb) return ga - gb;
      return String(a.name).localeCompare(String(b.name), 'ja');
    });
  const classes = (d.classes || [])
    .slice()
    .sort((a, b) => Number(a.grade) - Number(b.grade) || String(a.name).localeCompare(String(b.name), 'ja'));
  return { classes, groups, rooms: (d.rooms || []).slice(), subjects };
}

/** 選択ボックス生成（data-f キーで payload に収集） */
function sel(name, options, value, cls = '') {
  return `<select data-f="${name}" class="input-field py-1 px-1.5 text-[11px] ${cls}">${options
    .map(([v, l]) => `<option value="${v}" ${String(v) === String(value) ? 'selected' : ''}>${escapeHTML(l)}</option>`)
    .join('')}</select>`;
}

/** クラス・コース選択リスト（data-cc・選択状態は bg-accent-soft クラス、クリック/長押しドラッグで連続選択） */
function classCoursePicker(d, selectedIds) {
  const selSet = new Set((selectedIds || []).map(String));
  const byGrade = {};
  for (const cl of d.classes) (byGrade[Number(cl.grade)] ||= []).push(cl);
  const groups = Object.keys(byGrade)
    .sort((a, b) => Number(a) - Number(b))
    .map((g) => {
      const chips = byGrade[g]
        .map((cl) => {
          const on = selSet.has(String(cl.id));
          return `<span data-cc="${escapeHTML(String(cl.id))}" class="cc-chip inline-block px-2 py-1 rounded border text-[10px] cursor-pointer select-none ${
            on ? 'bg-accent-soft border-accent-strong text-accent-strong font-bold' : 'bg-surface border-main text-soft'
          }">${escapeHTML(cl.name)}</span>`;
        })
        .join('');
      return `<div class="flex flex-wrap items-center gap-1 py-0.5"><span class="text-[10px] font-semibold text-muted w-7">${g}年</span>${chips}</div>`;
    })
    .join('');
  return `<div class="cc-list border border-main rounded bg-surface p-1.5 select-none">${groups || '<span class="text-[10px] text-muted">クラス・コース未登録</span>'}</div>`;
}

/** クリック・長押しドラッグでクラス・コースを連続選択（Shift+クリックで範囲選択） */
function bindClassCourseSelection(panel) {
  let painting = false;
  let paintOn = true;
  let anchor = null;

  const chipsIn = (listEl) => [...listEl.querySelectorAll('[data-cc]')];

  const setSel = (chip, on) => {
    if (on) {
      chip.classList.add('bg-accent-soft', 'border-accent-strong', 'text-accent-strong', 'font-bold');
      chip.classList.remove('bg-surface', 'border-main', 'text-soft');
    } else {
      chip.classList.remove('bg-accent-soft', 'border-accent-strong', 'text-accent-strong', 'font-bold');
      chip.classList.add('bg-surface', 'border-main', 'text-soft');
    }
  };

  panel.addEventListener('pointerdown', (e) => {
    const chip = e.target.closest('[data-cc]');
    if (!chip) return;
    e.preventDefault();
    const list = chip.closest('.cc-list');
    if (e.shiftKey && anchor && list === anchor.closest('.cc-list')) {
      const items = chipsIn(list);
      const a = items.indexOf(anchor);
      const b = items.indexOf(chip);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (const el of items.slice(lo, hi + 1)) setSel(el, true);
      anchor = chip;
      return;
    }
    paintOn = !chip.classList.contains('bg-accent-soft');
    setSel(chip, paintOn);
    anchor = chip;
    painting = true;
  });

  // 長押しまま.drag（ポインタが chip を踏む度）で連続選択
  panel.addEventListener('pointerover', (e) => {
    if (!painting) return;
    const chip = e.target.closest('[data-cc]');
    if (chip) setSel(chip, paintOn);
  });

  const stop = () => {
    painting = false;
  };
  panel.addEventListener('pointerup', stop);
  panel.addEventListener('pointercancel', stop);
  window.addEventListener('pointerup', stop);
}

/** 入力欄生成 */
function inp(name, value, cls = '', extra = '') {
  return `<input data-f="${name}" value="${escapeHTML(String(value ?? ''))}" class="input-field py-1 px-1.5 text-[11px] ${cls}" ${extra} />`;
}

/** 保存・削除ボタン */
function actionCell(id) {
  return `<div class="flex items-center gap-1">
    <button data-act="save" class="btn-primary py-1 px-2 text-[11px]"><i data-lucide="save" class="w-3 h-3"></i> 保存</button>
    ${id ? `<button data-act="delete" class="btn-warning border border-warning-soft py-1 px-2 text-[11px] text-warning-strong"><i data-lucide="trash-2" class="w-3 h-3"></i> 削除</button>` : ''}
  </div>`;
}

// ==========================================================
// 行テンプレート (kind で payload キーを収集)
// ==========================================================

function classRow(cl, d, kyomu) {
  const opening = d.subjects.filter((s) => (s.offerings || []).some((o) => String(o.class_course_id) === String(cl.id))).length;
  return `<tr data-kind="class" data-id="${escapeHTML(String(cl.id ?? ''))}">
    <td>${sel('grade', GRADE_OPTS, cl.grade ?? 1)}</td>
    <td>${inp('name', cl.name, 'w-28', 'placeholder="1-3理 / 1-6看 / 1-6保育"')}</td>
    <td class="text-[10px] text-muted">${opening} 科目</td>
    ${kyomu ? `<td>${actionCell(cl.id)}</td>` : '<td class="text-[10px] text-muted">（閲覧のみ）</td>'}
  </tr>`;
}

function groupRow(g, d, kyomu) {
  const count = d.subjects.filter((s) => String(s.subject_id) === String(g.id)).length;
  return `<tr data-kind="group" data-id="${escapeHTML(String(g.id ?? ''))}">
    <td>${inp('name', g.name, 'w-28', 'placeholder="国語 / 数学"')}</td>
    <td class="text-[10px] text-muted">${count} 科目</td>
    ${kyomu ? `<td>${actionCell(g.id)}</td>` : '<td class="text-[10px] text-muted">（閲覧のみ）</td>'}
  </tr>`;
}

function subjectRow(sub, d, kyomu) {
  const groupOpts = [['', '（未設定）'], ...d.groups.map((g) => [g.id, g.name])];
  const picked = (sub.offerings || []).map((o) => o.class_course_id);
  const implemented = (sub.offerings || []).length;
  return `<tr data-kind="subject" data-id="${escapeHTML(String(sub.id ?? ''))}">
    <td>${inp('name', sub.name, 'w-28', 'placeholder="生物2年3単位"')}</td>
    <td>${inp('short_name', sub.short_name ?? sub.name, 'w-16')}</td>
    <td>${sel('subject_id', groupOpts, sub.subject_id ?? '', 'w-24')}</td>
    <td>${classCoursePicker(d, picked)}</td>
    <td class="text-[10px] text-muted text-center">${implemented} クラス・コース</td>
    ${kyomu ? `<td>${actionCell(sub.id)}</td>` : '<td class="text-[10px] text-muted">（閲覧のみ）</td>'}
  </tr>`;
}

function roomRow(r, kyomu) {
  return `<tr data-kind="room" data-id="${escapeHTML(String(r.id ?? ''))}">
    <td>${inp('name', r.name, 'w-28', 'placeholder="普通教室101"')}</td>
    <td>${inp('seats', r.seats ?? 40, 'w-14', 'type="number" min="1" max="200"')}</td>
    <td>${inp('notes', r.notes ?? '', 'w-32', 'placeholder="備考"')}</td>
    ${kyomu ? `<td>${actionCell(r.id)}</td>` : '<td class="text-[10px] text-muted">（閲覧のみ）</td>'}
  </tr>`;
}

/** 行の data-f / data-cc 入力から payload を収集 */
function collectPayload(kind, tr) {
  const p = {};
  tr.querySelectorAll('[data-f]').forEach((el) => {
    p[el.dataset.f] = el.value;
  });

  if (kind === 'class') {
    p.grade = Number(p.grade) || 1;
    p.name = String(p.name || '').trim();
    p.short_name = p.name;
  }
  if (kind === 'group') {
    p.name = String(p.name || '').trim();
  }
  if (kind === 'subject') {
    p.subject_id = p.subject_id ? String(p.subject_id) : null;
    p.short_name = p.short_name ? String(p.short_name).trim() : p.name;
    // 実施しているクラス・コース（クリック・長押しドラッグで選択）
    p.class_course_ids = [...tr.querySelectorAll('[data-cc].cc-chip.bg-accent-soft')].map((el) => String(el.dataset.cc));
  }
  if (kind === 'room') {
    p.seats = parseInt(p.seats, 10) || 40;
    p.notes = p.notes ? String(p.notes).trim() : null;
  }
  return p;
}

/** 使用中件数の表示文 */
function usageNote(counts) {
  const parts = [];
  Object.entries(counts || {}).forEach(([k, v]) => {
    const n = Array.isArray(v) ? v.length : Number(v) || 0;
    if (k !== 'total' && n > 0) parts.push(`${USAGE_LABELS[k] || k} ${n}件`);
  });
  return parts.join(' / ');
}

const ROW_BUILDERS = {
  class: (d) => classRow({ grade: 1, name: '', short_name: '' }, d, true),
  group: (d) => groupRow({ name: '' }, d, true),
  room: () => roomRow({ name: '', seats: 40, notes: '' }, true),
  subject: (d) => subjectRow({ name: '', short_name: '', subject_id: '', offerings: [] }, d, true),
};

function tableHtml(kind, title, headCells, items, renderRow, kyomu, d, hint = '') {
  const rows = items.length
    ? items.map(renderRow).join('')
    : `<tr><td colspan="${headCells.length}" class="px-2 py-3 text-center text-[11px] text-muted">登録がありません（「行を追加」から作成）</td></tr>`;
  const icon = kind === 'group' ? 'layers' : kind === 'class' ? 'users' : kind === 'subject' ? 'book-open' : 'door-open';
  return sectionCard(
    icon,
    title,
    kyomu
      ? `${hint} 右の「＋ 行を追加」→ 入力して「保存」。改名は考査計画・時間割・教室割・監督割へ cascade され、使用中の項目は削除できません。`
      : hint || '教務部の登録を読み出しています。',
    `<div class="overflow-x-auto"><table class="w-full text-[11px]">
      <thead><tr class="text-muted text-[10px]">${headCells.map((h) => `<th class="px-1 pb-1 font-semibold text-left">${h}</th>`).join('')}</tr></thead>
      <tbody id="basic-body-${kind}">${rows}</tbody>
    </table></div>`,
    `<button id="basic-add-${kind}" class="btn-warning border border-warning-soft py-1 px-3 text-[11px] text-warning-strong flex items-center gap-1"><i data-lucide="plus" class="w-3.5 h-3.5"></i> 行を追加</button>`,
  );
}

export function renderBasicTab(container) {
  const d = masterData();
  const kyomu = isKyomuUser();

  container.innerHTML = `
    <div id="exam-basic-panel" class="space-y-4">
      ${tableHtml('class', '1. クラス・コース', ['学年', 'クラス・コース名', '開講科目数', ''], d.classes, (cl) => classRow(cl, d, kyomu), kyomu, d, '「1-1」「1-3理」「1-6看」「1-6保育」のように学校固有の名称を直接入力します（クラスとコースは分離しません）。')}
      ${tableHtml('group', '2. 教科', ['教科名', '使用科目数', ''], d.groups, (g) => groupRow(g, d, kyomu), kyomu, d, '科目で参照する教科を先に登録します。改名は教員の担当教科へ cascade されます。')}
      ${tableHtml('subject', '3. 科目（教科・科目名・略称）× 実施クラス・コース', ['科目名', '略称', '教科', '実施クラス・コース（クリック / 長押しドラッグで選択）', '実施数', ''], d.subjects, (s) => subjectRow(s, d, kyomu), kyomu, d, '科目名は「公共1年」「生物2年3単位」のように学年・単位数を含め、教科順に並べます。実施しているクラス・コースを選択します（標準試験時間・標準教室の設定はありません）。')}
      ${tableHtml('room', '4. 教室・座席数', ['教室名', '座席数', '備考', ''], d.rooms, (r) => roomRow(r, kyomu), kyomu, d, '教室名と座席数のみ登録します（種別・使用学年はありません）。')}
    </div>
  `;
  refreshLucideIcons();
}

// ==========================================================
// イベント登録 (add row / save / delete)
// ==========================================================

export function bindBasicTab(container, reload) {
  const panel = container.querySelector('#exam-basic-panel');
  if (!panel) return;

  Object.keys(ROW_BUILDERS).forEach((kind) => {
    panel.querySelector(`#basic-add-${kind}`)?.addEventListener('click', () => {
      const d = masterData();
      const tr = document.createElement('tr');
      tr.innerHTML = ROW_BUILDERS[kind](d);
      panel.querySelector(`#basic-body-${kind}`)?.appendChild(tr);
      refreshLucideIcons();
    });
  });

  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr[data-kind]');
    if (!tr) return;

    const kind = tr.dataset.kind;
    const id = tr.dataset.id;
    const p = collectPayload(kind, tr);
    const label = KIND_LABELS[kind] || kind;

    try {
      if (btn.dataset.act === 'save') {
        if (!p.name) {
          showToast(`${label}名を入力してください。`, 'warning');
          return;
        }
        if (id) {
          const res = await examApi.put(`${API_BASE[kind]}/${id}`, p);
          showToast(res?.message || '変更を反映しました。', 'success');
        } else {
          const res = await examApi.post(API_BASE[kind], p);
          showToast(res?.message || `${label}を登録しました。`, 'success');
        }
        await reload();
      } else if (btn.dataset.act === 'delete') {
        if (kind !== 'group') {
          const usageRes = await examApi.get(`/basic-info/usage/${kind}/${id}`);
          const counts = usageRes?.usage || usageRes;
          const total = Number(counts?.total) || 0;
          const note = usageNote(counts);
          if (total) {
            showToast(`${label}「${p.name || id}」は使用中（${note}）のため削除できません。`, 'warning');
            return;
          }
        }
        if (!window.confirm(`${label}「${p.name || id}」を削除しますか？`)) return;
        const res = await examApi.del(`${API_BASE[kind]}/${id}`);
        showToast(res?.message || '削除しました。', 'success');
        await reload();
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  refreshLucideIcons();
  bindClassCourseSelection(panel);
}

export default renderBasicTab;
