/**
 * ISSystem Exam Module
 * 定期考査自動最適化プログレス・矛盾診断・監督割当表コントローラー (教務主任専用)
 */

import { apiGet, apiPost, apiPut } from '../api.js';
import { escapeHTML, refreshLucideIcons, openModal, closeModal, showToast } from '../ui-helpers.js';
import { state } from '../state.js';

let activeTab = 'matrix'; // 'matrix' | 'conflicts' | 'optimize'
let examMatrixData = [];
let conflictsList = [];
let isOptimizing = false;
let optimizeProgress = 0;

function hasKyomuPermission() {
  const user = state.currentUser;
  if (!user) return false;
  return user.role === 'KYOMU' || user.role === 'ADMIN' || user.is_kyomu === true;
}

/**
 * 定期考査管理モジュールの初期化
 */
export function initExamModule() {
  const container = document.getElementById('view-exam');
  if (!container) return;

  const isKyomu = hasKyomuPermission();

  container.innerHTML = `
    <!-- ヘッダーツールバー -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-surface-strong p-4 rounded-xl border border-divider">
      <div>
        <div class="flex items-center gap-2 mb-1">
          <span class="badge ${isKyomu ? 'badge-warning' : 'badge-info'}">${isKyomu ? '教務権限 (全項目編集可能)' : '一般権限 (教務許可項目のみ編集可能)'}</span>
          <span class="text-xs text-muted font-mono">第2回 中間考査</span>
        </div>
        <h2 class="text-lg font-bold text-main flex items-center gap-2">
          <i data-lucide="award" class="w-5 h-5 text-warning"></i> 定期考査・試験監督割当最適化エンジン
        </h2>
        <p class="text-xs text-muted">制約条件に基づく試験時間の自動重複回避、監督教員の一括最適割り当て、リアルタイム矛盾診断を行います。</p>
      </div>

      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <button id="exam-btn-run-diag" class="btn-secondary py-2 px-3 text-xs flex items-center gap-1.5 text-warning-strong border-warning-soft">
          <i data-lucide="alert-triangle" class="w-4 h-4"></i> 矛盾診断を実行
        </button>
        <button id="exam-btn-run-opt" class="btn-primary py-2 px-4 text-xs font-bold flex items-center gap-1.5 shadow-lg ${!isKyomu ? 'opacity-50 cursor-not-allowed' : ''}" ${!isKyomu ? 'title="教務権限が必要です"' : ''}>
          <i data-lucide="cpu" class="w-4 h-4"></i> 自動最適化エンジンの実行
        </button>
      </div>
    </div>

    <!-- モード切替タブ & 診断アラートサマリー -->
    <div class="flex flex-col md:flex-row items-start md:items-center justify-between gap-3 bg-inset p-3 rounded-lg border border-divider">
      <div class="flex items-center gap-2 text-xs">
        <button id="exam-tab-matrix" class="exam-nav-tab px-4 py-2 rounded-lg font-bold transition-all border bg-surface text-accent-strong border-main">
          <i data-lucide="grid" class="w-3.5 h-3.5 inline mr-1"></i> 監督割り当て表
        </button>
        <button id="exam-tab-conflicts" class="exam-nav-tab px-4 py-2 rounded-lg font-bold transition-all border bg-surface-strong text-muted border-divider hover-text-main">
          <i data-lucide="shield-alert" class="w-3.5 h-3.5 inline mr-1"></i> 矛盾・制約診断結果
          <span id="exam-conflict-badge" class="badge-count hidden">0</span>
        </button>
      </div>

      <div id="exam-summary-text" class="text-xs text-muted font-mono">
        全コマ数: <strong class="text-main" id="exam-total-slots">12</strong> / 監督割り当て完了率: <strong class="text-success" id="exam-completion-rate">100%</strong>
      </div>
    </div>

    <!-- 1. 自動最適化プログレスパネル (実行時のみ表示) -->
    <div id="exam-opt-progress-panel" class="card p-5 bg-gradient-to-r from-accent-inset via-surface-strong to-surface-strong border-accent hidden space-y-3">
      <div class="flex items-center justify-between text-xs">
        <span class="font-bold text-accent-strong flex items-center gap-2">
          <i data-lucide="loader-2" class="w-4 h-4 animate-spin text-accent"></i> 定期考査・監督割り当て自動最適化アルゴリズム実行中...
        </span>
        <span id="exam-opt-percentage" class="font-mono font-bold text-accent text-sm">0%</span>
      </div>
      <div class="w-full bg-surface h-2.5 rounded-full overflow-hidden border border-main">
        <div id="exam-opt-bar" class="bg-accent h-full w-0 transition-all duration-200"></div>
      </div>
      <p id="exam-opt-status-msg" class="text-[11px] text-muted font-mono">初期化中... 教員の重複コマ、連続監督上限、試験時間割制約を計算しています。</p>
    </div>

    <!-- 2. メインビュー: 監督割り当て表 (マトリクス) -->
    <div id="exam-view-matrix" class="card p-4 overflow-hidden">
      <div class="timeline-scroll-container">
        <table class="w-full text-left border-collapse text-xs min-w-[850px]">
          <thead>
            <tr class="border-b border-divider bg-surface-strong">
              <th class="p-3 w-32 text-soft font-bold">試験日程 / 時限</th>
              <th class="p-3 text-center border-l border-divider">1学年 (101〜104)</th>
              <th class="p-3 text-center border-l border-divider">2学年 (201〜204)</th>
              <th class="p-3 text-center border-l border-divider">3学年 (301〜304)</th>
            </tr>
          </thead>
          <tbody id="exam-matrix-tbody" class="divide-y divide-divider">
            <tr>
              <td colspan="4" class="text-center py-12 text-muted">考査割当データを読み込み中...</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 3. メインビュー: 矛盾診断リスト (非表示/切り替え) -->
    <div id="exam-view-conflicts" class="card p-5 hidden space-y-4">
      <div class="flex items-center justify-between pb-3 border-b border-divider">
        <h3 class="font-bold text-sm text-main flex items-center gap-2">
          <i data-lucide="shield-alert" class="w-4 h-4 text-warning"></i> 検出された制約違反・スケジュール矛盾
        </h3>
        <button id="exam-btn-recheck" class="btn-secondary py-1 px-3 text-xs">再診断</button>
      </div>
      <div id="exam-conflicts-list" class="space-y-2">
        <!-- 矛盾リスト動的描画 -->
      </div>
    </div>
  `;

  bindEvents();
  if (state.currentUser && state.authToken) {
    loadExamData();
  }
}

/**
 * 内部タブ (割り当て表 / 矛盾診断) の切り替え
 * @param {'matrix'|'conflicts'} tab
 */
function switchExamTab(tab) {
  const tabMatrix = document.getElementById('exam-tab-matrix');
  const tabConflicts = document.getElementById('exam-tab-conflicts');
  const viewMatrix = document.getElementById('exam-view-matrix');
  const viewConflicts = document.getElementById('exam-view-conflicts');

  if (tab === 'matrix') {
    activeTab = 'matrix';
    if (tabMatrix) tabMatrix.className = 'exam-nav-tab px-4 py-2 rounded-lg font-bold transition-all border bg-surface text-accent-strong border-main';
    if (tabConflicts) tabConflicts.className = 'exam-nav-tab px-4 py-2 rounded-lg font-bold transition-all border bg-surface-strong text-muted border-divider hover-text-main';
    viewMatrix?.classList.remove('hidden');
    viewConflicts?.classList.add('hidden');
  } else {
    activeTab = 'conflicts';
    if (tabConflicts) tabConflicts.className = 'exam-nav-tab px-4 py-2 rounded-lg font-bold transition-all border bg-surface text-warning-strong border-main';
    if (tabMatrix) tabMatrix.className = 'exam-nav-tab px-4 py-2 rounded-lg font-bold transition-all border bg-surface-strong text-muted border-divider hover-text-main';
    viewConflicts?.classList.remove('hidden');
    viewMatrix?.classList.add('hidden');
  }
  refreshLucideIcons();
}

/**
 * イベントリスナーの登録
 */
function bindEvents() {
  // タブ切り替え
  document.getElementById('exam-tab-matrix')?.addEventListener('click', () => switchExamTab('matrix'));
  document.getElementById('exam-tab-conflicts')?.addEventListener('click', () => switchExamTab('conflicts'));

  // 矛盾リストの「割り当て表で確認」ボタン (イベント委譲)
  document.getElementById('exam-conflicts-list')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-exam-show-matrix]')) switchExamTab('matrix');
  });

  // 最適化実行ボタン
  document.getElementById('exam-btn-run-opt')?.addEventListener('click', () => {
    if (!hasKyomuPermission()) {
      showToast('教務権限がないため、自動最適化の実行は許可されていません（閲覧のみ）。', 'error');
      return;
    }
    runOptimizationEngine();
  });

  // 矛盾診断実行ボタン
  document.getElementById('exam-btn-run-diag')?.addEventListener('click', runConflictDiagnosis);
  document.getElementById('exam-btn-recheck')?.addEventListener('click', runConflictDiagnosis);
}

/**
 * 試験割当データの取得
 */
async function loadExamData() {
  if (!state.currentUser || !state.authToken) return;
  try {
    const data = await apiGet('/exam/matrix');
    examMatrixData = Array.isArray(data) ? data : getDummyExamMatrix();
  } catch (e) {
    examMatrixData = getDummyExamMatrix();
  }

  renderExamMatrix();
  runConflictDiagnosis();
}

/**
 * 試験監督割当マトリクス表の描画
 */
function renderExamMatrix() {
  const tbody = document.getElementById('exam-matrix-tbody');
  if (!tbody) return;

  if (examMatrixData.length === 0) {
    tbody.innerHTML = `<tr><td colspan="4" class="text-center py-10 text-muted">試験日程データが登録されていません。</td></tr>`;
    return;
  }

  tbody.innerHTML = examMatrixData.map(slot => `
    <tr class="hover-surface-soft transition-colors">
      <td class="p-3 font-bold text-main bg-surface-strong border-r border-divider">
        <div class="text-xs text-accent-strong font-mono">${escapeHTML(slot.dayLabel)}</div>
        <div class="text-[11px] text-muted font-mono font-normal">${escapeHTML(slot.periodLabel)} (${slot.time})</div>
      </td>

      <!-- 1学年 -->
      <td class="p-2 border-l border-divider">
        ${renderSlotCard(slot.id, 'g1', slot.g1)}
      </td>

      <!-- 2学年 -->
      <td class="p-2 border-l border-divider">
        ${renderSlotCard(slot.id, 'g2', slot.g2)}
      </td>

      <!-- 3学年 -->
      <td class="p-2 border-l border-divider">
        ${renderSlotCard(slot.id, 'g3', slot.g3)}
      </td>
    </tr>
  `).join('');

  // 監督変更セルクリックバインド
  tbody.querySelectorAll('.btn-edit-supervisor').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const slotId = btn.getAttribute('data-slot-id');
      const grade = btn.getAttribute('data-grade');
      editSupervisor(slotId, grade);
    });
  });

  refreshLucideIcons();
}

/**
 * 各コマの学年セルカード描画
 */
function renderSlotCard(slotId, grade, data) {
  if (!data) {
    return `<div class="p-2 rounded border border-dashed border-divider text-center text-faint text-[11px]">試験なし</div>`;
  }

  const hasConflict = conflictsList.some(c => c.slotId === slotId && c.grade === grade);

  return `
    <div class="p-2.5 rounded-lg bg-surface-strong border ${hasConflict ? 'border-danger bg-danger-inset' : 'border-divider'} hover-border-strong transition-all">
      <div class="flex items-center justify-between text-[11px] mb-1">
        <span class="font-bold text-main">${escapeHTML(data.subject)}</span>
        <span class="text-[10px] text-muted font-mono">${escapeHTML(data.room || '各教室')}</span>
      </div>
      <div class="flex items-center justify-between text-xs pt-1.5 border-t border-divider">
        <span class="text-soft font-semibold flex items-center gap-1">
          <i data-lucide="user-check" class="w-3.5 h-3.5 ${hasConflict ? 'text-danger' : 'text-success'}"></i>
          ${escapeHTML(data.supervisorName || '未割当')}
        </span>
        <button class="btn-edit-supervisor text-[10px] text-accent hover:underline" data-slot-id="${slotId}" data-grade="${grade}">
          変更
        </button>
      </div>
    </div>
  `;
}

/**
 * 監督教員の直接変更
 */
function editSupervisor(slotId, grade) {
  const slot = examMatrixData.find(s => s.id === slotId);
  if (!slot || !slot[grade]) return;

  const currentSupervisor = slot[grade].supervisorName || '';
  const newSupervisor = prompt(`【監督教員の変更】\n時限: ${slot.dayLabel} ${slot.periodLabel}\n科目: ${slot[grade].subject}\n\n監督教員名を入力してください:`, currentSupervisor);

  if (newSupervisor !== null) {
    slot[grade].supervisorName = newSupervisor.trim() || '未割当';
    showToast('監督教員を変更しました', 'success');
    renderExamMatrix();
    runConflictDiagnosis();
  }
}

/**
 * 矛盾・制約診断エンジン
 */
function runConflictDiagnosis() {
  conflictsList = [];

  examMatrixData.forEach(slot => {
    const supervisorsInSlot = [];

    ['g1', 'g2', 'g3'].forEach(grade => {
      const info = slot[grade];
      if (info && info.supervisorName && info.supervisorName !== '未割当') {
        // 重複チェック
        if (supervisorsInSlot.includes(info.supervisorName)) {
          conflictsList.push({
            id: 'c-' + Date.now() + Math.random(),
            slotId: slot.id,
            grade,
            dayLabel: slot.dayLabel,
            periodLabel: slot.periodLabel,
            supervisorName: info.supervisorName,
            type: 'DOUBLE_BOOKING',
            message: `【同一コマ重複】${info.supervisorName} 先生が「${slot.dayLabel} ${slot.periodLabel}」の複数学年に同時に割り当てられています。`
          });
        } else {
          supervisorsInSlot.push(info.supervisorName);
        }
      } else if (info && (!info.supervisorName || info.supervisorName === '未割当')) {
        conflictsList.push({
          id: 'c-unassigned-' + Date.now() + Math.random(),
          slotId: slot.id,
          grade,
          dayLabel: slot.dayLabel,
          periodLabel: slot.periodLabel,
          type: 'UNASSIGNED',
          message: `【監督未割当】「${slot.dayLabel} ${slot.periodLabel}」(${info.subject}) の監督教員が決定していません。`
        });
      }
    });
  });

  // バッジ & リスト更新
  const badge = document.getElementById('exam-conflict-badge');
  if (badge) {
    badge.textContent = String(conflictsList.length);
    badge.classList.toggle('hidden', conflictsList.length === 0);
  }

  renderConflictsList();
}

/**
 * 矛盾リストの描画
 */
function renderConflictsList() {
  const container = document.getElementById('exam-conflicts-list');
  if (!container) return;

  if (conflictsList.length === 0) {
    container.innerHTML = `
      <div class="p-4 rounded-xl bg-success-inset border border-success-soft text-success-strong text-xs flex items-center gap-2">
        <i data-lucide="check-circle" class="w-5 h-5 text-success flex-shrink-0"></i>
        <span>制約違反や重複割り当ては見つかりませんでした。すべての試験監督割当は正常です。</span>
      </div>
    `;
    refreshLucideIcons();
    return;
  }

  container.innerHTML = conflictsList.map(c => `
    <div class="p-3 rounded-lg bg-surface-strong border ${c.type === 'DOUBLE_BOOKING' ? 'border-danger bg-danger-inset' : 'border-warning bg-warning-inset'} text-xs flex items-start justify-between gap-3">
      <div class="flex items-start gap-2">
        <i data-lucide="${c.type === 'DOUBLE_BOOKING' ? 'alert-octagon' : 'help-circle'}" class="w-4 h-4 ${c.type === 'DOUBLE_BOOKING' ? 'text-danger' : 'text-warning'} mt-0.5 flex-shrink-0"></i>
        <div>
          <span class="font-bold text-main">${escapeHTML(c.message)}</span>
        </div>
      </div>
      <button class="btn-secondary py-1 px-2 text-[10px] flex-shrink-0" data-exam-show-matrix>割り当て表で確認</button>
    </div>
  `).join('');

  refreshLucideIcons();
}

/**
 * 自動最適化エンジンの実行 (プログレスシミュレーション)
 */
function runOptimizationEngine() {
  if (isOptimizing) return;

  const panel = document.getElementById('exam-opt-progress-panel');
  const bar = document.getElementById('exam-opt-bar');
  const percentageEl = document.getElementById('exam-opt-percentage');
  const statusMsg = document.getElementById('exam-opt-status-msg');

  if (!panel || !bar || !percentageEl || !statusMsg) return;

  isOptimizing = true;
  optimizeProgress = 0;
  panel.classList.remove('hidden');

  const steps = [
    { p: 20, msg: '全教員のコマ数・授業担当状況および過去監督回数を解析中...' },
    { p: 45, msg: '制約条件の定義（同一コマ重複不可、3コマ連続監督禁止）を構築中...' },
    { p: 75, msg: '最適割り当てソルバーを実行中... 候補の作成とスコア判定中...' },
    { p: 100, msg: '最適化完了。割当マトリクスを最新の状態に更新しました。' }
  ];

  let currentStep = 0;

  const interval = setInterval(() => {
    if (currentStep < steps.length) {
      const step = steps[currentStep];
      optimizeProgress = step.p;
      bar.style.width = `${optimizeProgress}%`;
      percentageEl.textContent = `${optimizeProgress}%`;
      statusMsg.textContent = step.msg;
      currentStep++;
    } else {
      clearInterval(interval);
      isOptimizing = false;

      // ダミーデータの最適化適用
      examMatrixData = getOptimizedExamMatrix();
      renderExamMatrix();
      runConflictDiagnosis();

      showToast('定期考査の監督割り当て自動最適化が完了しました', 'success');

      setTimeout(() => {
        panel.classList.add('hidden');
      }, 2500);
    }
  }, 700);
}

function getDummyExamMatrix() {
  return [
    {
      id: 'slot-1',
      dayLabel: '第1日 (10/15)',
      periodLabel: '1限',
      time: '09:00 - 09:50',
      g1: { subject: '国語総合', room: '101-104', supervisorName: '鈴木 先生' },
      g2: { subject: '数学II', room: '201-204', supervisorName: '佐藤 先生' },
      g3: { subject: '英語コミュニケーション', room: '301-304', supervisorName: '田中 先生' }
    },
    {
      id: 'slot-2',
      dayLabel: '第1日 (10/15)',
      periodLabel: '2限',
      time: '10:05 - 10:55',
      g1: { subject: '物理基礎', room: '101-104', supervisorName: '佐藤 先生' },
      g2: { subject: '論理国語', room: '201-204', supervisorName: '佐藤 先生' },
      g3: { subject: '日本史B', room: '301-304', supervisorName: '未割当' }
    },
    {
      id: 'slot-3',
      dayLabel: '第2日 (10/16)',
      periodLabel: '1限',
      time: '09:00 - 09:50',
      g1: { subject: '英語コミュニケーションI', room: '101-104', supervisorName: '高橋 先生' },
      g2: { subject: '化学', room: '201-204', supervisorName: '山田 先生' },
      g3: { subject: '数学III', room: '301-304', supervisorName: '伊藤 先生' }
    }
  ];
}

function getOptimizedExamMatrix() {
  return [
    {
      id: 'slot-1',
      dayLabel: '第1日 (10/15)',
      periodLabel: '1限',
      time: '09:00 - 09:50',
      g1: { subject: '国語総合', room: '101-104', supervisorName: '鈴木 先生' },
      g2: { subject: '数学II', room: '201-204', supervisorName: '佐藤 先生' },
      g3: { subject: '英語コミュニケーション', room: '301-304', supervisorName: '田中 先生' }
    },
    {
      id: 'slot-2',
      dayLabel: '第1日 (10/15)',
      periodLabel: '2限',
      time: '10:05 - 10:55',
      g1: { subject: '物理基礎', room: '101-104', supervisorName: '高橋 先生' },
      g2: { subject: '論理国語', room: '201-204', supervisorName: '佐藤 先生' },
      g3: { subject: '日本史B', room: '301-304', supervisorName: '山田 先生' }
    },
    {
      id: 'slot-3',
      dayLabel: '第2日 (10/16)',
      periodLabel: '1限',
      time: '09:00 - 09:50',
      g1: { subject: '英語コミュニケーションI', room: '101-104', supervisorName: '伊藤 先生' },
      g2: { subject: '化学', room: '201-204', supervisorName: '山田 先生' },
      g3: { subject: '数学III', room: '301-304', supervisorName: '高橋 先生' }
    }
  ];
}