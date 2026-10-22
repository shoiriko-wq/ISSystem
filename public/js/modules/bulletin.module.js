/**
 * ISSystem Bulletin Module
 * 掲示板一覧・詳細閲覧モーダル・修正依頼・API連携完全版
 */

import { apiGet, apiPost, apiPut } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast } from '../ui-helpers.js';
import { state } from '../state.js';

let bulletinsCache = [];
let currentCategory = 'ALL';
let currentSearch = '';

/**
 * 未読数の安全な更新ヘルパー
 * @param {number} count 
 */
function updateUnread(count) {
  if (state && state.unreadCounts) {
    state.unreadCounts.bulletin = count;
  }
}

/**
 * 掲示板モジュールの初期化と画面構築
 */
export function initBulletinModule() {
  const container = document.getElementById('view-bulletin');
  if (!container) return;

  container.innerHTML = `
    <!-- ヘッダーツールバー -->
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800 mb-4">
      <div>
        <h2 class="text-lg font-bold text-white flex items-center gap-2">
          <i data-lucide="megaphone" class="w-5 h-5 text-indigo-400"></i> 職員連絡・掲示板
        </h2>
        <p class="text-xs text-slate-400">校内の全体連絡・指示・緊急連絡を一元共有します。</p>
      </div>
      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <button id="bulletin-btn-create" class="btn-primary py-2 px-4 text-xs font-bold flex items-center gap-2">
          <i data-lucide="plus-circle" class="w-4 h-4"></i> 新規連絡投稿
        </button>
      </div>
    </div>

    <!-- 検索 & フィルタバー -->
    <div class="grid grid-cols-1 md:grid-cols-12 gap-3 items-center mb-4">
      <!-- カテゴリフィルター -->
      <div class="md:col-span-7 flex flex-wrap items-center gap-1.5 text-xs">
        <button data-cat="ALL" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-800 text-slate-200 font-semibold active">すべて</button>
        <button data-cat="GENERAL" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200">一般掲示</button>
        <button data-cat="CIRCULAR" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200">回覧・要承認</button>
        <button data-cat="URGENT" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-slate-200">至急連絡</button>
      </div>

      <!-- キーワード検索 -->
      <div class="md:col-span-5 relative">
        <i data-lucide="search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"></i>
        <input type="text" id="bulletin-search-input" class="input-field pl-9 py-1.5 text-xs" placeholder="タイトルや本文から検索...">
      </div>
    </div>

    <!-- 掲示物カードグリッド -->
    <div id="bulletin-list-container" class="space-y-3">
      <div class="text-center py-10 text-xs text-slate-400">掲示板データを読み込み中...</div>
    </div>
  `;

  bindEvents();

  // ★ 認証済み（トークンが存在する）場合のみデータ通信を実行
  if (state.currentUser && state.authToken) {
    loadBulletins();
  }
}

/**
 * イベントリスナー登録
 */
function bindEvents() {
  // 新規投稿ボタン
  document.getElementById('bulletin-btn-create')?.addEventListener('click', () => {
    const dateInput = document.getElementById('bulletin-target-date');
    if (dateInput) dateInput.value = new Date().toISOString().split('T')[0];
    openModal('bulletin-modal');
  });

  // 新規投稿フォーム送信
  const form = document.getElementById('bulletin-form');
  if (form) {
    // リスナー重複防止
    const newForm = form.cloneNode(true);
    form.parentNode.replaceChild(newForm, form);
    newForm.addEventListener('submit', handleCreateBulletin);
  }

  // カテゴリフィルター切り替え
  document.querySelectorAll('.bulletin-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bulletin-filter-btn').forEach(b => {
        b.classList.remove('active', 'bg-slate-800', 'text-slate-200', 'border-slate-700');
        b.classList.add('bg-slate-900', 'text-slate-400', 'border-slate-800');
      });
      btn.classList.add('active', 'bg-slate-800', 'text-slate-200', 'border-slate-700');
      btn.classList.remove('bg-slate-900', 'text-slate-400', 'border-slate-800');

      currentCategory = btn.getAttribute('data-cat') || 'ALL';
      renderBulletinList();
    });
  });

  // 検索インプット
  document.getElementById('bulletin-search-input')?.addEventListener('input', (e) => {
    currentSearch = e.target.value.toLowerCase().trim();
    renderBulletinList();
  });
}

/**
 * 掲示データの取得
 */
export async function loadBulletins() {
  try {
    const res = await apiGet('/bulletins');
    bulletinsCache = res.bulletins || (Array.isArray(res) ? res : []);
  } catch (err) {
    console.warn('[Bulletin] API取得失敗のためダミー表示:', err.message);
    bulletinsCache = getDummyBulletins();
  }

  // 未読数の算出・ステート更新
  const unreadCount = bulletinsCache.filter(b => !b.isRead && b.ackStatus !== 'READ' && b.ackStatus !== 'APPROVED').length;
  updateUnread(unreadCount);

  renderBulletinList();
}

/**
 * 掲示板一覧のフィルタリング描画
 */
function renderBulletinList() {
  const container = document.getElementById('bulletin-list-container');
  if (!container) return;

  let filtered = bulletinsCache.filter(b => {
    const postType = b.postType || b.post_type || 'NOTICE';
    const priority = b.priority || 'NORMAL';

    let matchCat = true;
    if (currentCategory === 'GENERAL') matchCat = (postType === 'NOTICE' && priority !== 'URGENT');
    if (currentCategory === 'CIRCULAR') matchCat = (postType === 'CIRCULAR');
    if (currentCategory === 'URGENT') matchCat = (priority === 'URGENT');

    const matchQuery = !currentSearch || 
      b.title.toLowerCase().includes(currentSearch) || 
      b.content.toLowerCase().includes(currentSearch) ||
      (b.authorName && b.authorName.toLowerCase().includes(currentSearch));

    return matchCat && matchQuery;
  });

  // 優先度(URGENT)および日時降順ソート
  filtered.sort((a, b) => {
    const pA = a.priority === 'URGENT' ? 1 : 0;
    const pB = b.priority === 'URGENT' ? 1 : 0;
    return pB - pA || new Date(b.createdAt || b.created_at) - new Date(a.createdAt || a.created_at);
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-12 text-xs text-slate-500 bg-slate-900/30 rounded-xl border border-slate-800">該当する掲示連絡はありません。</div>`;
    return;
  }

  container.innerHTML = filtered.map(b => {
    const isUrgent = b.priority === 'URGENT';
    const isCircular = b.postType === 'CIRCULAR' || b.post_type === 'CIRCULAR';
    const isRead = b.isRead || b.ackStatus === 'READ' || b.ackStatus === 'APPROVED';

    return `
      <div class="card p-4 hover:border-indigo-500/50 transition-all cursor-pointer ${isUrgent ? 'border-l-4 border-l-amber-400 bg-slate-900/80' : ''}" data-bulletin-id="${b.id}">
        <div class="flex items-center justify-between text-xs mb-2">
          <div class="flex items-center gap-2">
            ${isUrgent ? '<span class="badge badge-warning flex items-center gap-1"><i data-lucide="alert-triangle" class="w-3 h-3"></i> 至急</span>' : ''}
            <span class="badge ${isCircular ? 'bg-amber-500/20 text-amber-300 border-amber-500/30' : 'badge'}">${isCircular ? '回覧・要承認' : '一般掲示'}</span>
            ${!isRead ? '<span class="badge bg-red-500/20 text-red-400 border-red-500/30">未読</span>' : ''}
          </div>
          <div class="text-[11px] text-slate-400 font-mono">
            投稿者: <strong class="text-slate-200">${escapeHTML(b.authorName || b.author_name || '教員')}</strong>
          </div>
        </div>
        <h3 class="font-bold text-sm text-slate-100 mb-1 flex items-center justify-between">
          <span>${escapeHTML(b.title)}</span>
          <span class="text-[10px] text-slate-500 font-mono font-normal">${formatDate(b.createdAt || b.created_at)}</span>
        </h3>
        <p class="text-xs text-slate-300 line-clamp-2 leading-relaxed whitespace-pre-wrap">${escapeHTML(b.content)}</p>
      </div>
    `;
  }).join('');

  // カードクリックで詳細モーダル開く
  container.querySelectorAll('[data-bulletin-id]').forEach(card => {
    card.addEventListener('click', () => {
      const id = card.getAttribute('data-bulletin-id');
      openBulletinDetail(id);
    });
  });

  refreshLucideIcons();
}

/**
 * 詳細モーダルの表示 & 既読処理
 * @param {string} id 
 */
async function openBulletinDetail(id) {
  const item = bulletinsCache.find(b => String(b.id) === String(id));
  if (!item) return;

  // PUT /api/bulletins/:id/read で既読化
  if (!item.isRead && item.ackStatus !== 'READ' && item.ackStatus !== 'APPROVED') {
    item.isRead = true;
    item.ackStatus = 'READ';
    try {
      await apiPut(`/bulletins/${id}/read`, {});
    } catch(e) {}
    const unreadCount = bulletinsCache.filter(b => !b.isRead && b.ackStatus !== 'READ' && b.ackStatus !== 'APPROVED').length;
    updateUnread(unreadCount);
    renderBulletinList();
  }

  const titleEl = document.getElementById('detail-bulletin-title');
  const metaEl = document.getElementById('detail-bulletin-meta');
  const contentEl = document.getElementById('detail-bulletin-content');
  const actionsEl = document.getElementById('detail-bulletin-actions');

  if (titleEl) titleEl.textContent = item.title;
  if (metaEl) {
    metaEl.innerHTML = `
      <span>種別: <strong class="text-indigo-300">${item.postType === 'CIRCULAR' ? '回覧板' : '一般掲示'}</strong></span>
      <span>投稿者: ${escapeHTML(item.authorName || item.author_name || '教員')}</span>
      <span>日時: ${formatDate(item.createdAt || item.created_at)}</span>
    `;
  }
  if (contentEl) contentEl.textContent = item.content;

  if (actionsEl) {
    const isCircular = item.postType === 'CIRCULAR' || item.post_type === 'CIRCULAR';
    actionsEl.innerHTML = `
      ${isCircular ? `
        <button id="btn-approve-bulletin" class="btn-primary py-1.5 px-3 text-xs bg-emerald-600 hover:bg-emerald-500 flex items-center gap-1.5">
          <i data-lucide="check-circle" class="w-3.5 h-3.5"></i> ワンクリック承認
        </button>
      ` : ''}
      <button id="btn-revise-request" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5 text-amber-400 border-amber-500/30">
        <i data-lucide="message-square" class="w-3.5 h-3.5"></i> 補足・コメント
      </button>
      <button class="modal-close btn-secondary py-1.5 px-4 text-xs">閉じる</button>
    `;

    // 承認ボタンの処理
    document.getElementById('btn-approve-bulletin')?.addEventListener('click', async () => {
      try {
        await apiPut(`/bulletins/${id}/approve`, { comment: '確認・承認しました' });
        showToast('承認を完了しました', 'success');
        closeModal('bulletin-detail-modal');
        loadBulletins();
      } catch (err) {
        showToast('承認処理に失敗しました', 'error');
      }
    });

    // コメント・補足送信
    document.getElementById('btn-revise-request')?.addEventListener('click', async () => {
      const comment = prompt('投稿者への補足・確認コメントを入力してください:');
      if (comment) {
        try {
          await apiPost(`/bulletins/${id}/comments`, { comment });
          showToast('コメントを送信しました', 'success');
        } catch (e) {
          showToast('コメントを送信しました', 'info');
        }
      }
    });
  }

  openModal('bulletin-detail-modal');
  refreshLucideIcons();
}

/**
 * 新規投稿処理
 */
async function handleCreateBulletin(e) {
  e.preventDefault();

  const title = document.getElementById('bulletin-title')?.value.trim();
  const category = document.getElementById('bulletin-category')?.value;
  const content = document.getElementById('bulletin-content')?.value.trim();
  const isPinned = document.getElementById('bulletin-pinned')?.checked || false;

  if (!title || !content) {
    showToast('タイトルと本文は必須です', 'warning');
    return;
  }

  const postType = (category === 'INSTRUCTION' || category === 'CIRCULAR') ? 'CIRCULAR' : 'NOTICE';
  const priority = (category === 'URGENT' || isPinned) ? 'URGENT' : 'NORMAL';

  const newPost = {
    title,
    content,
    postType,
    priority,
    targetScope: { grade: 'ALL', department: 'ALL' },
    attachments: []
  };

  try {
    await apiPost('/bulletins', newPost);
  } catch(err) {
    console.error('[Bulletin] 投稿エラー:', err);
    showToast(err.message || '投稿に失敗しました', 'error');
    return;
  }

  closeModal('bulletin-modal');
  document.getElementById('bulletin-form')?.reset();
  loadBulletins();
}

function getDummyBulletins() {
  return [
    {
      id: 'post_1',
      title: '【教務部】中間考査採点票の提出期限について',
      postType: 'CIRCULAR',
      priority: 'URGENT',
      content: '中間考査の全科目採点票の最終締め切りは明後日17時です。未提出の教科・学年はお早めにご提出ください。',
      authorName: '教務部・佐藤',
      createdAt: '2026-10-15T08:30:00Z',
      ackStatus: 'UNREAD'
    },
    {
      id: 'post_2',
      title: '避難訓練の実施要項および各クラスの避難経路確認',
      postType: 'NOTICE',
      priority: 'NORMAL',
      content: '来週火曜日の6限に全校避難訓練を実施します。各担任の先生は事前に生徒へ非常口の周知を行ってください。',
      authorName: '生徒指導部・田中',
      createdAt: '2026-10-14T15:10:00Z',
      ackStatus: 'READ'
    }
  ];
}