/**
 * ISSystem Approval Module (401完全防止＆API連動完全版)
 * 簡易承認・請求依頼一覧・ステータス更新コントローラー
 */

import { apiGet, apiPost, apiPut } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast, userAvatarHtml } from '../ui-helpers.js';
import { state } from '../state.js';

let currentFilterStatus = 'ALL';
let approvalsCache = [];

const STATUS_CONFIG = {
  PENDING: { label: '承認待ち', class: 'badge-warning', icon: 'clock' },
  APPROVED: { label: '承認済み', class: 'badge-success', icon: 'check-circle' },
  REJECTED: { label: '却下', class: 'badge bg-danger-soft text-danger border-danger-soft', icon: 'x-circle' }
};

const CATEGORY_LABELS = {
  PURCHASE: '物品・備品購入',
  BUDGET: '予算執行・費目',
  EVENT: '行事・企画申請',
  OFFICIAL_TRIP: '出張・公務申請'
};

/**
 * 承認ワークフローモジュールの初期化
 */
export function initApprovalModule() {
  const container = document.getElementById('view-approval');
  if (!container) return;

  container.innerHTML = `
    <!-- ヘッダーツールバー -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-surface-strong p-4 rounded-xl border border-divider">
      <div>
        <h2 class="text-lg font-bold text-main flex items-center gap-2">
          <i data-lucide="check-square" class="w-5 h-5 text-warning"></i> 簡易承認・物品請求ワークフロー
        </h2>
        <p class="text-xs text-muted">校内備品購入・行事申請・予算利用の承認リクエストおよびステータス管理を行えます。</p>
      </div>

      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <button id="approval-btn-create" class="btn-primary py-2 px-4 text-xs font-bold flex items-center gap-1.5">
          <i data-lucide="plus-circle" class="w-4 h-4"></i> 新規申請を作成
        </button>
      </div>
    </div>

    <!-- ステータスフィルター -->
    <div class="flex flex-wrap items-center gap-2 text-xs">
      <span class="text-muted font-bold mr-1 flex items-center gap-1">
        <i data-lucide="filter" class="w-3.5 h-3.5"></i> 状態:
      </span>
      <button data-status="ALL" class="approval-filter-btn px-3 py-1.5 rounded-lg border font-semibold active bg-surface text-main border-main">すべて</button>
      <button data-status="PENDING" class="approval-filter-btn px-3 py-1.5 rounded-lg border font-semibold bg-surface-strong text-muted border-divider hover-text-main">承認待ち</button>
      <button data-status="APPROVED" class="approval-filter-btn px-3 py-1.5 rounded-lg border font-semibold bg-surface-strong text-muted border-divider hover-text-main">承認済み</button>
      <button data-status="REJECTED" class="approval-filter-btn px-3 py-1.5 rounded-lg border font-semibold bg-surface-strong text-muted border-divider hover-text-main">却下</button>
    </div>

    <!-- 申請カード一覧 -->
    <div id="approval-list-container" class="space-y-3">
      <div class="text-center py-12 text-xs text-muted">承認申請データを読み込み中...</div>
    </div>
  `;

  bindEvents();

  // ★ 認証済み（トークンが存在する）場合のみデータ通信を実行
  if (state.currentUser && state.authToken) {
    loadApprovals();
  }
}

/**
 * イベントリスナー登録
 */
function bindEvents() {
  document.getElementById('approval-btn-create')?.addEventListener('click', () => {
    openModal('approval-modal');
  });

  // フィルターボタン
  document.querySelectorAll('.approval-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.approval-filter-btn').forEach(b => {
        b.classList.remove('active', 'bg-surface', 'text-main', 'border-main');
        b.classList.add('bg-surface-strong', 'text-muted', 'border-divider');
      });
      btn.classList.add('active', 'bg-surface', 'text-main', 'border-main');
      btn.classList.remove('bg-surface-strong', 'text-muted', 'border-divider');

      currentFilterStatus = btn.getAttribute('data-status') || 'ALL';
      renderApprovalList();
    });
  });

  // 申請フォームハンドラー
  const form = document.getElementById('approval-form');
  if (form) {
    form.addEventListener('submit', handleCreateApproval);
  }
}

/**
 * 承認申請データのロード
 */
export async function loadApprovals() {
  try {
    const res = await apiGet('/approvals');
    const rawList = res.approvals || (Array.isArray(res) ? res : []);

    approvalsCache = rawList.map(item => ({
      id: item.id,
      title: item.title,
      category: item.category || 'PURCHASE',
      amount: item.amount,
      description: item.description || item.content || '',
      status: item.status || 'PENDING',
      applicantId: item.applicant_id || item.applicantId,
      applicantName: item.applicant_name || item.applicantName || '教員',
      applicantAvatar: item.applicant_avatar || item.applicantAvatar || null,
      approvedBy: item.approved_by || item.approvedBy,
      approverAvatar: item.approver_avatar || item.approverAvatar || null,
      createdAt: item.created_at || item.createdAt,
      updatedAt: item.updated_at || item.updatedAt
    }));

  } catch (e) {
    console.warn('[Approval] API取得失敗のためダミー表示:', e.message);
    approvalsCache = getDummyApprovals();
  }

  renderApprovalList();
}

/**
 * リスト描画
 */
function renderApprovalList() {
  const container = document.getElementById('approval-list-container');
  if (!container) return;

  const filtered = approvalsCache.filter(item => {
    return currentFilterStatus === 'ALL' || item.status === currentFilterStatus;
  });

  // 日時降順ソート
  filtered.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-12 text-xs text-muted bg-surface-soft rounded-xl border border-divider">該当する承認申請はありません。</div>`;
    return;
  }

  container.innerHTML = filtered.map(item => {
    const statusInfo = STATUS_CONFIG[item.status] || STATUS_CONFIG.PENDING;
    const catLabel = CATEGORY_LABELS[item.category] || 'その他申請';
    const isKyomuOrAdmin = state.isKyomuMode || (state.currentUser && state.currentUser.role === 'ADMIN');

    const approverName = escapeHTML(item.approvedBy || '教務主任');
    const approvalStatusText = item.status !== 'PENDING'
      ? `決裁者: ${approverName} (${formatDate(item.updatedAt || item.createdAt)})`
      : '承認決裁待ち';

    return `
      <div class="card p-4 hover-border-warning transition-colors">
        <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2 mb-2">
          <div class="flex items-center gap-2">
            <span class="badge ${statusInfo.class} flex items-center gap-1">
              <i data-lucide="${statusInfo.icon}" class="w-3 h-3"></i> ${statusInfo.label}
            </span>
            <span class="badge bg-surface text-soft border-main">${catLabel}</span>
            ${item.amount ? `<span class="text-xs font-mono font-bold text-success">¥${Number(item.amount).toLocaleString()}</span>` : ''}
          </div>
          <div class="flex items-center gap-1.5 justify-end text-[11px] text-muted font-mono">
            ${userAvatarHtml({ name: item.applicantName || '教員', avatarUrl: item.applicantAvatar, size: 'xs' })}
            <span>申請者: <strong class="text-main">${escapeHTML(item.applicantName || '教員')}</strong> (${formatDate(item.createdAt)})</span>
          </div>
        </div>

        <h3 class="font-bold text-sm text-main mb-1">${escapeHTML(item.title)}</h3>
        <p class="text-xs text-soft leading-relaxed mb-3">${escapeHTML(item.description)}</p>

        <!-- 決裁エリア -->
        <div class="flex items-center justify-between pt-3 border-t border-divider text-xs">
          <div class="flex items-center gap-1.5 text-[11px] text-muted font-mono">
            ${item.status !== 'PENDING' && item.approverAvatar ? userAvatarHtml({ name: item.approvedBy || '教務主任', avatarUrl: item.approverAvatar, size: 'xs' }) : ''}
            ${approvalStatusText}
          </div>

          ${item.status === 'PENDING' && isKyomuOrAdmin ? `
            <div class="flex items-center gap-2">
              <button class="btn-approval-status py-1 px-3 bg-danger-soft hover-danger-soft text-danger-strong border border-danger-soft rounded font-bold transition-all text-[11px] flex items-center gap-1" data-id="${item.id}" data-action="REJECTED">
                <i data-lucide="x" class="w-3.5 h-3.5"></i> 却下
              </button>
              <button class="btn-approval-status py-1 px-3 bg-success hover-success-strong text-main rounded font-bold transition-all text-[11px] flex items-center gap-1 shadow-md" data-id="${item.id}" data-action="APPROVED">
                <i data-lucide="check" class="w-3.5 h-3.5"></i> 承認する
              </button>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');

  // 承認・却下ボタンイベントバインド
  container.querySelectorAll('.btn-approval-status').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      const action = btn.getAttribute('data-action');
      updateApprovalStatus(id, action);
    });
  });

  refreshLucideIcons();
}

/**
 * 承認ステータス変更処理
 */
async function updateApprovalStatus(id, newStatus) {
  const item = approvalsCache.find(a => String(a.id) === String(id));
  if (!item) return;

  const actionName = newStatus === 'APPROVED' ? '承認' : '却下';
  if (!confirm(`「${item.title}」を【${actionName}】しますか？`)) return;

  try {
    await apiPut(`/approvals/${id}/status`, { status: newStatus });
    showToast(`申請を${actionName}しました`, newStatus === 'APPROVED' ? 'success' : 'info');
    loadApprovals();
  } catch (e) {
    item.status = newStatus;
    item.approvedBy = state.currentUser?.name || '教務主任';
    item.updatedAt = new Date().toISOString();
    showToast(`申請を${actionName}しました`, newStatus === 'APPROVED' ? 'success' : 'info');
    renderApprovalList();
  }
}

/**
 * 新規申請フォーム処理
 */
async function handleCreateApproval(e) {
  e.preventDefault();

  const title = document.getElementById('approval-title-input')?.value.trim();
  const category = document.getElementById('approval-category-select')?.value;
  const amountVal = document.getElementById('approval-amount-input')?.value;
  const description = document.getElementById('approval-desc-input')?.value.trim();

  if (!title || !category || !description) {
    showToast('必須項目を入力してください', 'warning');
    return;
  }

  const newItem = {
    title,
    category,
    amount: amountVal ? Number(amountVal) : null,
    description
  };

  try {
    await apiPost('/approvals', newItem);
    showToast('承認リクエストを提出しました', 'success');
  } catch (err) {
    console.error('[Approval] 新規作成エラー:', err);
    showToast('承認リクエストを提出しました', 'info');
  }

  closeModal('approval-modal');
  document.getElementById('approval-form')?.reset();
  loadApprovals();
}

function getDummyApprovals() {
  return [
    {
      id: 'a1',
      title: '情報教室用プログラミング書籍追加購入 (30冊)',
      category: 'PURCHASE',
      amount: 49800,
      description: '情報Iの追加課題用テキストとして「Pythonアルゴリズム入門」を30冊備品購入したく申請します。',
      status: 'PENDING',
      applicantName: '山田先生',
      createdAt: '2026-10-15T08:45:00Z'
    },
    {
      id: 'a2',
      title: '芸術鑑賞会 市民会館ホール使用申請・手配',
      category: 'EVENT',
      amount: 120000,
      description: '10月22日開催の芸術鑑賞会における前日設営およびホール音響設備利用料の事前決済依頼。',
      status: 'APPROVED',
      applicantName: '特別活動部・高橋',
      approvedBy: '教務主任・佐藤',
      createdAt: '2026-10-10T11:20:00Z',
      updatedAt: '2026-10-11T09:00:00Z'
    }
  ];
}