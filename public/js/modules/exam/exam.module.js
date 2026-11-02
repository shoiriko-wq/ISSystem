/**
 * ISSystem 定期考査 モジュールシェル
 * サイドメニュー「定期考査」の画面骨格・サブタブ・考査ボード読み込み・権限表示
 * メニュー順（教務）: 基本情報の登録 → 年間考査計画 → 実施科目の決定 →
 * 時間割の作成 → 教室割の作成 → 出張等の登録 → 監督割の作成（+ 公表ビュー）
 * 考査の登録は年間考査計画タブへ統合済み（独立タブを持たない）
 */

import { state } from '../../state.js';
import { escapeHTML, refreshLucideIcons, showToast } from '../../ui-helpers.js';
import { socketClient } from '../../socket.js';
import { examStore, examApi, loadBoard, resolveActiveExamId, phaseBadge, isKyomuUser, syncRoleKyomu } from './exam.shared.js';
import { renderPlanTab, bindPlanTab } from './exam.plan.ui.js';
import { renderBasicTab, bindBasicTab } from './exam.basic.ui.js';
import { renderDecisionTab, bindDecisionTab } from './exam.decision.ui.js';
import { renderTimetableTab, bindTimetableTab, resetTimetableState } from './exam.timetable.ui.js';
import { renderRoomTab, bindRoomTab } from './exam.room.ui.js';
import { renderTripTab, bindTripTab } from './exam.trip.ui.js';
import { renderProctorTab, bindProctorTab } from './exam.proctor.ui.js';
import { renderPublishedTab, bindPublishedTab } from './exam.view.ui.js';

const SUB_TABS = [
  { id: 'basic', label: '基本情報の登録', icon: 'library' },
  { id: 'plan', label: '年間考査計画', icon: 'calendar-range' },
  { id: 'decision', label: '実施科目の決定', icon: 'stamp', openToAll: true },
  { id: 'timetable', label: '時間割の作成', icon: 'grid-3x3' },
  { id: 'room', label: '教室割の作成', icon: 'layout-grid' },
  { id: 'trip', label: '出張等の登録', icon: 'plane' },
  { id: 'proctor', label: '監督割の作成', icon: 'shield-check' },
  { id: 'view', label: '公表・自分の担当', icon: 'eye', openToAll: true },
];

/**
 * 現在ロールで表示可能なサブタブ
 * 教務権限者: 7つの作成メニュー + 公表ビュー、一般教員: 公表ビューのみ
 */
function visibleSubTabs() {
  const kyomu = isKyomuUser();
  return SUB_TABS.filter((t) => kyomu || t.openToAll);
}

/** examStore.sub を表示可能なサブタブに正規化する（教務=先頭メニュー、教員=公表ビュー） */
function ensureSubTab() {
  const kyomu = isKyomuUser();
  if (!visibleSubTabs().some((t) => t.id === examStore.sub)) {
    examStore.sub = kyomu ? visibleSubTabs()[0].id : 'view';
  }
}

const PHASE_KEYS = [
  ['plan_phase', '計画'],
  ['subject_phase', '実施科目'],
  ['decision_phase', '決定'],
  ['timetable_phase', '時間割'],
  ['room_phase', '教室割'],
  ['trip_phase', '出張等'],
  ['proctor_phase', '監督割'],
];

const RENDERERS = {
  plan: { render: renderPlanTab, bind: bindPlanTab },
  basic: { render: renderBasicTab, bind: bindBasicTab },
  decision: { render: renderDecisionTab, bind: bindDecisionTab },
  timetable: { render: renderTimetableTab, bind: bindTimetableTab },
  room: { render: renderRoomTab, bind: bindRoomTab },
  trip: { render: renderTripTab, bind: bindTripTab },
  proctor: { render: renderProctorTab, bind: bindProctorTab },
  view: { render: renderPublishedTab, bind: bindPublishedTab },
};

let panels = {};

/** 考査ボードの再取得＋ヘッダ/パネル再描画 */
async function reload() {
  const board = await loadBoard(examStore.examId);
  renderHeader();
  renderActivePanel();
  return board;
}

function renderActivePanel() {
  ensureSubTab();
  const sub = examStore.sub;
  for (const t of SUB_TABS) {
    const p = panels[t.id];
    if (p) p.classList.toggle('hidden', t.id !== sub);
  }
  const panel = panels[sub];
  const r = RENDERERS[sub];
  if (!panel || !r) return;
  r.render(panel);
  r.bind(panel, reload);
  refreshLucideIcons();
}

function renderHeader() {
  const bar = document.getElementById('exam-header-bar');
  if (!bar) return;
  const board = examStore.board;
  const masters = examStore.masters || [];
  const options = masters
    .map((m) => `<option value="${m.id}" ${m.id === examStore.examId ? 'selected' : ''}>${escapeHTML(m.title)}</option>`)
    .join('');
  const phaseStrip = board
    ? PHASE_KEYS.map(([k, label]) => `<span class="flex items-center gap-1">${label} ${phaseBadge(board.phases[k])}</span>`).join('')
    : '';
  bar.innerHTML = `
    <div class="flex flex-col lg:flex-row items-start lg:items-center justify-between gap-3">
      <div>
        <h2 class="text-lg font-bold text-main flex items-center gap-2">
          <i data-lucide="file-spreadsheet" class="w-5 h-5 text-warning"></i> 定期考査
        </h2>
        <p class="text-[11px] text-muted">教務権限者は 7 つの作成メニュー（考査の登録は年間考査計画に統合）、教員は公表ビューと自分の担当コマを確認できます。</p>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-[11px] text-muted">対象考査</label>
        <select id="exam-select" class="input-field py-1.5 px-2 text-xs w-56">${options || '<option value="">（考査未登録）</option>'}</select>
        <button id="exam-refresh" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1">
          <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> 更新
        </button>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-3 text-[10px] text-muted pt-1">${phaseStrip}</div>
  `;
  refreshLucideIcons();
}

function renderSubTabs() {
  const bar = document.getElementById('exam-subtabs');
  if (!bar) return;
  bar.innerHTML = visibleSubTabs().map(
    (t) => `<button data-subtab="${t.id}" class="nav-item flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-semibold text-soft hover-surface transition-all border border-transparent ${
      t.id === examStore.sub ? 'border-accent bg-accent-soft text-accent-strong' : ''
    }">
        <i data-lucide="${t.icon}" class="w-4 h-4 ${t.id === 'view' ? 'text-info' : 'text-warning'}"></i>
        <span>${t.label}</span>
      </button>`
  ).join('') + (isKyomuUser()
    ? ''
    : '<span class="px-3 py-2 text-[10px] text-muted">作成メニューは教務権限者のみ</span>');
  refreshLucideIcons();
}


export function initExamModule() {
  const container = document.getElementById('view-exam');
  if (!container) return;

  // ロールで教務権限を判定し、初期サブタブを選ぶ（教務=基本情報の登録、教員=公表ビュー）
  syncRoleKyomu();
  examStore.sub = isKyomuUser() ? 'basic' : 'view';

  container.innerHTML = `
    <div id="exam-header-bar" class="bg-surface-strong p-4 rounded-xl border border-divider space-y-1"></div>
    <div id="exam-subtabs" class="flex flex-wrap gap-2 bg-inset p-2 rounded-lg border border-divider"></div>
    <div id="exam-panels" class="space-y-3">
      ${SUB_TABS.map((t) => `<div id="exam-panel-${t.id}" class="exam-panel hidden space-y-3"></div>`).join('')}
    </div>
  `;

  panels = {};
  for (const t of SUB_TABS) panels[t.id] = document.getElementById(`exam-panel-${t.id}`);

  document.getElementById('exam-subtabs')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-subtab]');
    if (!btn) return;
    examStore.sub = btn.dataset.subtab;
    if (examStore.sub === 'timetable') resetTimetableState();
    renderSubTabs();
    renderActivePanel();
  });

  document.getElementById('exam-header-bar')?.addEventListener('change', async (e) => {
    if (e.target.id !== 'exam-select') return;
    examStore.examId = e.target.value;
    resetTimetableState();
    showToast('対象考査を切り替えました', 'info');
    await reload();
  });
  document.getElementById('exam-header-bar')?.addEventListener('click', async (e) => {
    if (e.target.closest('#exam-refresh')) await reload();
  });

  // 教科マスタの改名/削除は考査計画の教科名へ cascade するため、変更時に板を再読み込みする
  socketClient.on('subjects:changed', () => {
    const view = document.getElementById('view-exam');
    if (state.currentUser && view && !view.classList.contains('hidden')) {
      reload();
    }
  });

  // 基本情報（コース・クラス・科目・教室）の変更も計画・板の表示へ cascade される
  socketClient.on('basicinfo:changed', () => {
    const view = document.getElementById('view-exam');
    if (state.currentUser && view && !view.classList.contains('hidden')) {
      reload();
    }
  });

  renderHeader();
  renderSubTabs();
}

/** タブ表示時の実データ読み込み（main.js から呼ばれる） */
export async function loadExamData() {
  if (!state.currentUser || !state.authToken) return;
  try {
    const examId = await resolveActiveExamId();
    if (!examId) {
      examStore.board = null;
      examStore.examId = null;
      renderHeader();
      renderSubTabs();
      const noExamText = isKyomuUser()
        ? 'active な考査がありません。「年間考査計画」の ① で1年間に実施する考査名をすべて登録してください（期間・1日の時限数・標準試験時間は ③ で登録します）。'
        : '現在閲覧できる公開中の考査がありません。教務による公表を待ちください。';
      // 教員は公表ビューのみ、教務は年間考査計画（考査の登録を含む）から作成できる
      const targetSub = isKyomuUser() ? 'plan' : 'view';
      for (const t of SUB_TABS) panels[t.id]?.classList.toggle('hidden', t.id !== targetSub);
      examStore.sub = targetSub;
      const p = panels[targetSub];
      if (p) {
        p.classList.remove('hidden');
        if (isKyomuUser()) {
          renderPlanTab(p, noExamText);
          bindPlanTab(p, reload);
        } else {
          p.innerHTML = `<div class="card p-6 text-center text-xs text-muted">${noExamText}</div>`;
        }
      }
      renderSubTabs();
      refreshLucideIcons();
      return;
    }
    await loadBoard(examId);
    renderHeader();
    renderActivePanel();
  } catch (err) {
    console.error('[Exam] board load failed', err);
    showToast(err.message || '考査データの取得に失敗しました', 'error');
  }
}

export default { initExamModule, loadExamData };
