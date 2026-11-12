/**
 * ISSystem 定期考査 基本情報マスタ UI (教務部 KYOMU)
 * 登録順：1. クラス・コース 2. 教科 3. 科目（教科・科目名・略称 × 実施クラス・コース） 4. 教室
 * クラスとコースは分離せず「1-1」「1-3理」「1-6看」「1-6保育」のような学校固有の名称を直接入力する。
 * 「行を追加」は未入力の行を表の最上部に足す（長い表で下までスクロールする必要がない）。何件でも連続して追加できる。
 * 「行を追加」ボタンは常に使える（未入力の行の件数で無効にならない）。登録済み行は通常の順（学年順・教科順）で並ぶ。
 * 各項目（クラス・コース／教科／科目／教室）の編集はセクションタイトル部の編集ロックトグルで開く。
 * 既定は読み取り専用で、ロック中は入力欄・行追加・削除・実施クラス・コースチップが操作不能。
 * ロックは server の editing_locks（座席表と同一の仕組み）。他教員が編集中はトグルに「他: 名前」が出、書き込みは 423 で守られる。
 * 行の「保存」ボタンは無い。入力欄を書き終えて焦点が行の外へ移った瞬間・実施クラス/コースの選択を終えた瞬間に自動登録する
 * （焦点が行内の次の入力欄へ移った間は書き込まない。内容が変わっていない行も書き込まない）。
 * 科目は登録済み教科を選択し、教科順にソートして表示する（学年・表示順・標準試験時間・標準教室の項目は持たない）。
 * 実施クラス・コースはクリック・長押しドラッグ（Shift+クリックで範囲）で連続選択する。
 * 変更は socket の basicinfo:changed / subjects:changed で考査計画・時間割・教室割・監督割へ cascade される。
 */

import { escapeHTML, refreshLucideIcons, showToast } from '../../ui-helpers.js';
import { examStore, examApi, sectionCard, isKyomuUser, sectionLockState } from './exam.shared.js';

const GRADE_OPTS = [[1, '1年'], [2, '2年'], [3, '3年']];
const KIND_LABELS = { class: 'クラス・コース', group: '教科', subject: '科目', room: '教室' };
const API_BASE = {
  class: '/basic-info/class',
  group: '/subjects',
  subject: '/basic-info/subject',
  room: '/basic-info/room',
};
/** セクション単位の編集ロック（座席表の編集排他ロックと同一のサーバー仕組み editing_locks を使う）。
 *  状態は server が返す board.basic_info.locks が真。トグルは POST / DELETE /api/exam/basic-lock/:kind を叩く。
 *  既定は誰もロックしていない＝読み取り専用。トグルで編集可能（ロック取得）⇔ 編集ロック（解放）。 */

/** 指定セクションが編集ロック中か（教務権限の有無にかかわらず、既定は編集ロック） */
function isLocked(kind) {
  return sectionLockState(kind) !== 'mine';
}

/** セクションタイトル部の編集ロックトグル（教務権限者にだけ出す） */
function lockButtonHtml(kind, kyomu) {
  if (!kyomu) return '';
  const locked = isLocked(kind);
  const st = sectionLockState(kind);
  const holder = examStore.board?.basic_info?.locks?.[kind]?.user_name || '';
  const label = KIND_LABELS[kind];
  return `<button id="basic-lock-${kind}" data-act="lock" data-lock-kind="${kind}" type="button"
    class="${locked ? 'btn-secondary' : 'btn-primary'} py-1 px-3 text-[11px] font-bold flex items-center gap-1 shrink-0"
    title="${st === 'mine' ? 'クリックで編集ロック（読み取り専用）へ戻します' : st === 'other' ? '他の教員（' + holder + '）が編集中' : 'クリックで編集可能モードへ'}"
    aria-label="${label}の編集ロック切り替え">
    <i data-lucide="${locked ? 'lock' : 'lock-open'}" class="w-3.5 h-3.5"></i>
    <span>${locked ? '編集ロック' : '編集可能'}</span>
    ${st === 'other' ? `<span class="text-[10px] text-warning-strong">他: ${escapeHTML(holder)}</span>` : ''}
  </button>`;
}

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

/** クラス・コース選択リスト（data-cc・選択状態は bg-accent-soft クラス、クリック/長押しドラッグで連続選択）
 *  チップは詰めた（px-0.5 py-0.5・10px・gap-x-0.5）——実施クラス・コース列はチップ内容分の幅で足るようにする。
 *  学年のチップは1行に並べる（折り返しを作らない）。 */
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
          return `<span data-cc="${escapeHTML(String(cl.id))}" class="cc-chip inline-block px-0.5 py-0.5 rounded border text-[10px] leading-tight cursor-pointer select-none ${
            on ? 'bg-accent-soft border-accent-strong text-accent-strong font-bold' : 'bg-surface border-main text-soft'
          }">${escapeHTML(cl.name)}</span>`;
        })
        .join('');
      return `<div class="flex flex-wrap items-center gap-x-0.5 gap-y-1 py-0.5"><span class="text-[10px] font-semibold text-muted w-6 shrink-0">${g}年</span>${chips}</div>`;
    })
    .join('');
  return `<div class="cc-list min-w-0 border border-main rounded bg-surface p-1.5 select-none">${groups || '<span class="text-[10px] text-muted">クラス・コース未登録</span>'}</div>`;
}

/** クリック・長押しドラッグでクラス・コースを連続選択（Shift+クリックで範囲選択）
 *  選択を終えた（ポインタを離した）瞬間に onSelectionEnd(その行) を呼ぶ = 書き終えたのでその行を自動登録する */
function bindClassCourseSelection(panel, sig, onSelectionEnd) {
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
    const chipRow = chip.closest('tr[data-kind]');
    if (chipRow && isLocked(chipRow.dataset.kind)) return;   // 編集ロック中はクラス・コース選択を変えない
    e.preventDefault();
    const list = chip.closest('.cc-list');
    if (e.shiftKey && anchor && list === anchor.closest('.cc-list')) {
      const items = chipsIn(list);
      const a = items.indexOf(anchor);
      const b = items.indexOf(chip);
      const [lo, hi] = a <= b ? [a, b] : [b, a];
      for (const el of items.slice(lo, hi + 1)) setSel(el, true);
      anchor = chip;
      painting = true;   // 範囲選択も選択終了（ポインタを離す）で自動登録する
      return;
    }
    paintOn = !chip.classList.contains('bg-accent-soft');
    setSel(chip, paintOn);
    anchor = chip;
    painting = true;
  }, sig);

  // 長押しまま.drag（ポインタが chip を踏む度）で連続選択
  panel.addEventListener('pointerover', (e) => {
    if (!painting) return;
    const chip = e.target.closest('[data-cc]');
    if (chip) setSel(chip, paintOn);
  }, sig);

  const stop = (e) => {
    if (!painting) return;
    painting = false;
    const row = e.target?.closest?.('tr[data-kind]');
    if (row) onSelectionEnd(row);
  };
  panel.addEventListener('pointerup', stop, sig);
  panel.addEventListener('pointercancel', stop, sig);
  window.addEventListener('pointerup', stop, sig);
}

/** 入力欄生成 */
function inp(name, value, cls = '', extra = '') {
  return `<input data-f="${name}" value="${escapeHTML(String(value ?? ''))}" class="input-field py-1 px-1.5 text-[11px] ${cls}" ${extra} />`;
}

/** 操作列のボタン（「保存」ボタンは無い = 行の編集は焦点が別へ移った瞬間に自動登録される。
 *  削除ボタンはすべての行に出す：「行を追加」で作った未登録行は行の破棄、登録済み行は DELETE API。
 *  列幅が狭い幅では折り返して実枠が操作列からはみ出さない） */
function actionCell(id) {
  return `<div class="flex flex-wrap items-center gap-1">
    <button data-act="delete" class="btn-warning border border-warning-soft py-1 px-2 text-[11px] text-warning-strong"><i data-lucide="trash-2" class="w-3 h-3"></i> 削除</button>
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
  return `<tr data-kind="subject" data-id="${escapeHTML(String(sub.id ?? ''))}">
    <td>${sel('subject_id', groupOpts, sub.subject_id ?? '', 'w-full min-w-0')}</td>
    <td>${inp('name', sub.name, 'w-full min-w-0', 'placeholder="生物2年3単位"')}</td>
    <td>${inp('short_name', sub.short_name ?? sub.name, 'w-full min-w-0')}</td>
    <td>${classCoursePicker(d, picked)}</td>
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

/** payload の内容キー（焦点が外れるたびに内容を比較し、変化がなければ自動登録しない） */
function payloadKey(p) {
  return JSON.stringify(p);
}

/** 各行の初期内容をキーとして控える（入力していない行は焦点が外れても書き込まない） */
function markInitialKeys(panel, kind) {
  const tbody = panel.querySelector(`#basic-body-${kind}`);
  if (!tbody) return;
  for (const tr of tbody.querySelectorAll(`tr[data-kind="${kind}"]`)) {
    tr.dataset.autoKey = payloadKey(collectPayload(kind, tr));
  }
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

/** 「行を追加」ボタンの状態を整える（編集ロック中は無効、編集可能モードなら未入力の行の件数にかかわらず使える） */
function syncAddButton(panel, kind) {
  const btn = panel.querySelector(`#basic-add-${kind}`);
  if (!btn) return;
  const locked = isLocked(kind);
  btn.disabled = locked;
  btn.setAttribute('aria-disabled', String(locked));
  btn.title = locked
    ? '編集ロック中（タイトル部の「編集可能」で編集できます）'
    : '未入力の行を表の最上部に追加します（何件でも連続して追加できます）';
}

/** ロック状態をセクション実枠へ反映する（入力欄・選択欄・削除ボタン・クラス・コースチップ・行追加ボタン） */
function applyLockState(panel, kind) {
  const locked = isLocked(kind);

  const lockBtn = panel.querySelector(`#basic-lock-${kind}`);
  if (lockBtn) {
    lockBtn.classList.toggle('btn-primary', !locked);
    lockBtn.classList.toggle('btn-secondary', locked);
    const icon = lockBtn.querySelector('i[data-lucide]');
    if (icon) icon.setAttribute('data-lucide', locked ? 'lock' : 'lock-open');
    const label = lockBtn.querySelector('span');
    if (label) label.textContent = locked ? '編集可能' : '編集ロック';   // ラベルは押せる動作（読み取り専用なら「編集可能」）
    lockBtn.title = locked ? 'クリックで編集可能モードへ' : 'クリックで編集ロック（読み取り専用）へ';
  }

  for (const tr of panel.querySelectorAll(`#basic-body-${kind} tr[data-kind="${kind}"]`)) {
    tr.querySelectorAll('input, select').forEach((el) => {
      el.disabled = locked;
    });
    tr.querySelectorAll('button[data-act="delete"]').forEach((b) => {
      b.disabled = locked;
    });
    const list = tr.querySelector('.cc-list');
    if (list) {
      list.classList.toggle('is-locked', locked);
      list.setAttribute('aria-disabled', String(locked));
    }
  }

  syncAddButton(panel, kind);
  refreshLucideIcons();
}

const ROW_BUILDERS = {
  class: (d) => classRow({ grade: 1, name: '', short_name: '' }, d, true),
  group: (d) => groupRow({ name: '' }, d, true),
  room: () => roomRow({ name: '', seats: 40, notes: '' }, true),
  subject: (d) => subjectRow({ name: '', short_name: '', subject_id: '', offerings: [] }, d, true),
};

function tableHtml(kind, title, headCells, items, renderRow, kyomu, d, hint = '', colWidths = null) {
  const rows = items.length
    ? items.map(renderRow).join('')
    : `<tr><td colspan="${headCells.length}" class="px-2 py-3 text-center text-[11px] text-muted">登録がありません（「行を追加」から作成）</td></tr>`;
  const icon = kind === 'group' ? 'layers' : kind === 'class' ? 'users' : kind === 'subject' ? 'book-open' : 'door-open';
  // colWidths を渡すと table-layout:fixed になり、列幅が百分比で確定する（入力は w-full で列を満たす）
  const thHtml = headCells
    .map((h, i) => {
      const w = colWidths?.[i];
      return `<th class="px-1 pb-1 font-semibold text-left${w ? ' whitespace-nowrap' : ''}"${w ? ` style="width:${w}"` : ''}>${h}</th>`;
    })
    .join('');
  return sectionCard(
    icon,
    title,
    kyomu
      ? `${hint} 行の編集は入力欄を書き終えて焦点が別へ移った瞬間に自動登録されます。改名は考査計画・時間割・教室割・監督割へ cascade され、使用中の項目は削除できません。`
      : hint || '教務部の登録を読み出しています。',
    `<div class="overflow-x-auto"><table class="${colWidths ? 'table-fixed ' : ''}w-full text-[11px]">
      <thead><tr class="text-muted text-[10px]">${thHtml}</tr></thead>
      <tbody id="basic-body-${kind}">${rows}</tbody>
    </table></div>`,
    `<button id="basic-add-${kind}" class="btn-warning border border-warning-soft py-1 px-3 text-[11px] text-warning-strong flex items-center gap-1"><i data-lucide="plus" class="w-3.5 h-3.5"></i> 行を追加</button>`,
    lockButtonHtml(kind, kyomu),
  );
}

export function renderBasicTab(container) {
  const d = masterData();
  const kyomu = isKyomuUser();

  container.innerHTML = `
    <div id="exam-basic-panel" class="space-y-4">
      ${tableHtml('class', '1. クラス・コース', ['学年', 'クラス・コース名', '開講科目数', ''], d.classes, (cl) => classRow(cl, d, kyomu), kyomu, d, '「1-1」「1-3理」「1-6看」「1-6保育」のように学校固有の名称を直接入力します（クラスとコースは分離しません）。')}
      ${tableHtml('group', '2. 教科', ['教科名', '使用科目数', ''], d.groups, (g) => groupRow(g, d, kyomu), kyomu, d, '科目で参照する教科を先に登録します。改名は教員の担当教科へ cascade されます。')}
      ${tableHtml(
        'subject',
        '3. 科目（教科・科目名・略称）× 実施クラス・コース',
        ['教科', '科目名', '略称', '実施クラス・コース（クリック / 長押しドラッグで選択）', ''],
        d.subjects,
        (s) => subjectRow(s, d, kyomu),
        kyomu,
        d,
        '科目名は「公共1年」「生物2年3単位」のように学年・単位数を含め、教科順に並べます。実施しているクラス・コースを選択します（標準試験時間・標準教室の設定はありません）。',
        // 実施数列は廃止（実施クラス・コースのチップ選択そのものが実施数を示す）。
        // 科目名・略称を広くし、実施クラス・コースはチップ内容（最も広い学年行）分の幅に寄せる。
        // 7+14+8+63+8 = 100% で固定レイアウト（列が余りを分散しない）。
        ['7%', '14%', '8%', '63%', '8%'],
      )}
      ${tableHtml('room', '4. 教室・座席数', ['教室名', '座席数', '備考', ''], d.rooms, (r) => roomRow(r, kyomu), kyomu, d, '教室名と座席数のみ登録します（種別・使用学年はありません）。')}
    </div>
  `;
  refreshLucideIcons();
}

// ==========================================================
// イベント登録 (行の追加 / 自動登録 / 削除)
// ==========================================================

/** 画面を離れるときに自分の編集ロックをすべて返す（他教員の編集を直ちに解放する） */
export function releaseBasicLocks() {
  Object.keys(ROW_BUILDERS).forEach((kind) => {
    if (sectionLockState(kind) === 'mine') examApi.del(`/exam/basic-lock/${kind}`).catch(() => {});
  });
}

export function bindBasicTab(container, reload) {
  const panel = container.querySelector('#exam-basic-panel');
  if (!panel) return;

  // 自動登録の制御（行の「保存」ボタンは無い。書き終えた瞬間 = 焦点が行の外へ移った瞬間・チップ選択を終えた瞬間に API へ書く）
  // reload で再描画されたら古い制御ごと捨てる（window の listener が積み上がらない）
  if (container.__basicAutoCtl) container.__basicAutoCtl.abort();
  const autoCtl = new AbortController();
  container.__basicAutoCtl = autoCtl;
  const sig = { signal: autoCtl.signal };

  // ロックの寿命（TTL 180秒）を生かす心跳：編集可能モードのセクションを 90 秒ごとに再取得し、
  // 自分の編集を他教員へ渡さない（パネル unbind で心跳は止まる）
  const heartbeat = setInterval(() => {
    Object.keys(ROW_BUILDERS).forEach((kind) => {
      if (sectionLockState(kind) === 'mine') examApi.post(`/exam/basic-lock/${kind}`, {}).catch(() => {});
    });
  }, 90000);
  autoCtl.signal.addEventListener('abort', () => clearInterval(heartbeat));

  const queue = [];
  let writing = false;

  /** キューの1件を API へ書き、成功したら一覧を再描画する（連続した焦点移動は1件の書き込みにまとまる） */
  const writeQueue = async () => {
    if (writing) return;
    const job = queue.shift();
    if (!job) return;
    writing = true;
    const { kind, tr, p } = job;
    const id = tr.dataset.id || '';
    const label = KIND_LABELS[kind] || kind;
    try {
      const res = id
        ? await examApi.put(`${API_BASE[kind]}/${id}`, p)
        : await examApi.post(API_BASE[kind], p);
      showToast(res?.message || (id ? `${label}を更新しました。` : `${label}を登録しました。`), 'success');
      await reload();
    } catch (err) {
      tr.dataset.autoKey = '';   // 失敗時は同じ内容でもう一度書き直せる
      showToast(`${label}「${p.name}」を自動登録できませんでした（${err.message}）`, 'error');
    }
    writing = false;
    if (queue.length) writeQueue();
  };

  /** 行の現在の内容を自動登録キューへ入れる（焦点が行の外へ移った瞬間・チップ選択を終えた瞬間に呼ぶ） */
  const queueRow = (tr) => {
    if (!tr || tr.dataset.autosaveOff === '1') return;   // 削除操作の行は書き込まない
    const kind = tr.dataset.kind;
    if (!kind || !API_BASE[kind]) return;
    if (isLocked(kind)) return;                          // 編集ロック中は自動登録しない（読み取り専用）
    const p = collectPayload(kind, tr);
    if (!p.name) return;         // 名前が空の行（「行を追加」直後の未入力行）はまだ書き込まない
    const key = payloadKey(p);
    if (tr.dataset.autoKey === key) return;   // 内容が変わっていなければ書き込まない（行内の入力欄移動で書き込まない）
    tr.dataset.autoKey = key;
    queue.push({ kind, tr, p });
    writeQueue();
  };

  panel.addEventListener('focusout', (e) => {
    const row = e.target?.closest?.('tr[data-kind]');
    if (!row) return;
    const next = e.relatedTarget;
    if (next && next.closest('tr[data-kind]') === row) return;   // 行内の次の入力欄へ移っている間は書き終えていない
    queueRow(row);
  }, sig);

  // 削除ボタンへ焦点が移った行は自動登録しない（行の破棄・DELETE が目的なので入力内容の書き込みは走らせない）
  panel.addEventListener('focusin', (e) => {
    const row = e.target?.closest?.('tr[data-kind]');
    if (!row) return;
    row.dataset.autosaveOff = e.target?.dataset?.act === 'delete' ? '1' : '';
  }, sig);

  Object.keys(ROW_BUILDERS).forEach((kind) => {
    const tbody = panel.querySelector(`#basic-body-${kind}`);
    const addBtn = panel.querySelector(`#basic-add-${kind}`);
    if (!tbody || !addBtn) return;
    markInitialKeys(panel, kind);
    syncAddButton(panel, kind);
    addBtn.addEventListener('click', () => {
      if (isLocked(kind)) return;   // 編集ロック中は行を追加しない（ボタンは disabled、DOM クリックにも防御）
      const d = masterData();
      // tr の innerHTML に <tr> 文字列を入れると属性が落ちる（tr[data-kind] が無くなり自動登録・削除が効かない）
      // → tbody でパースして <tr> をそのまま受け取る
      const frag = document.createElement('tbody');
      frag.innerHTML = ROW_BUILDERS[kind](d);
      const tr = frag.firstElementChild;
      // 未入力の行は最上部に足す（何件でも連続して追加でき、長い表で下までスクロールする手間をなくす）
      const mainEl = document.querySelector('main');
      const scrollYBefore = mainEl ? mainEl.scrollTop : 0;
      tbody.prepend(tr);
      tr.dataset.autoKey = payloadKey(collectPayload(kind, tr));   // 未入力の行の初期内容（焦点が外れても書き込まない）
      refreshLucideIcons();
      syncAddButton(panel, kind);
      // 画面常時スクロール禁止（UI十条7）: 新行が最上部に来たことで見出しや表の位置が動かないよう、見かけのスクロール位置を元へ戻す
      if (mainEl) mainEl.scrollTop = scrollYBefore;
    }, sig);
  });

  panel.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const tr = btn.closest('tr[data-kind]');
    if (!tr) return;

    const kind = tr.dataset.kind;
    if (isLocked(kind)) return;   // 編集ロック中は削除しない（読み取り専用）
    const id = tr.dataset.id;
    const p = collectPayload(kind, tr);
    const label = KIND_LABELS[kind] || kind;

    try {
      if (btn.dataset.act === 'delete') {
        // 「行を追加」直後の未登録行（data-id 空）はサーバーに存在しない → DOM の行だけを破棄する
        if (!id) {
          tr.remove();
          showToast(`${label}の未登録行を破棄しました。`, 'info');
          syncAddButton(panel, kind);   // 行の追加は常時使える（ボタン状態を念のため整える）
          return;
        }
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
  }, sig);

  // セクションタイトル部の編集ロックトグル（既定は編集ロック＝読み取り専用。トグルで編集可能 ⇔ 編集ロック）
  Object.keys(ROW_BUILDERS).forEach((kind) => {
    const lockBtn = panel.querySelector(`#basic-lock-${kind}`);
    if (lockBtn) {
      lockBtn.addEventListener('click', async () => {
        const st = sectionLockState(kind);
        lockBtn.disabled = true;
        try {
          if (st === 'mine') {
            await examApi.del(`/exam/basic-lock/${kind}`);
            showToast(`${KIND_LABELS[kind]}を編集ロック（読み取り専用）へ戻しました。`, 'info');
          } else {
            await examApi.post(`/exam/basic-lock/${kind}`, {});
            showToast(`${KIND_LABELS[kind]}を編集可能モードへ切り替えました（今この自分だけが入力できます）。`, 'success');
          }
        } catch (err) {
          showToast(err.message, 'error');
        }
        lockBtn.disabled = false;
        await reload();
        applyLockState(panel, kind);
      }, sig);
    }
    applyLockState(panel, kind);   // 描画直後のロック状態（既定は編集ロック）を実枠へ反映する
  });

  refreshLucideIcons();
  bindClassCourseSelection(panel, sig, queueRow);
}

export default renderBasicTab;
