/**
 * ISSystem Bulletin Module
 * 掲示板一覧・詳細閲覧モーダル・修正依頼・API連携完全版
 */

import { apiGet, apiPost, apiPut, apiPostForm, apiDelete } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, openModal, closeModal, showToast } from '../ui-helpers.js';
import { state } from '../state.js';
import { API_BASE_URL } from '../config.js';

let bulletinsCache = [];
let currentCategory = 'ALL';
let currentSearch = '';
// ★ 投稿日による日ごと表示モード ('ALL' | 'TODAY' | 'YESTERDAY' | 'WEEK' | 'SPECIFIC')
let currentDayMode = 'ALL';
let currentDayDate = '';

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
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-surface-strong p-4 rounded-xl border border-divider mb-4">
      <div>
        <h2 class="text-lg font-bold text-main flex items-center gap-2">
          <i data-lucide="megaphone" class="w-5 h-5 text-accent"></i> 職員連絡・掲示板
        </h2>
        <p class="text-xs text-muted">校内の全体連絡・指示・緊急連絡を一元共有します。</p>
      </div>
      <div class="flex items-center gap-2 w-full sm:w-auto justify-end">
        <button id="bulletin-btn-create" class="btn-primary py-2 px-4 text-xs font-bold flex items-center gap-2">
          <i data-lucide="plus-circle" class="w-4 h-4"></i> 新規連絡投稿
        </button>
      </div>
    </div>

    <!-- ★ 投稿日（日ごと表示）フィルター -->
    <div class="flex flex-wrap items-center gap-2 text-xs mb-3 bg-surface-strong border border-divider rounded-xl p-2.5">
      <span class="text-muted font-semibold flex items-center gap-1.5"><i data-lucide="calendar-days" class="w-3.5 h-3.5 text-accent"></i> 投稿日表示</span>
      <button data-day="ALL" class="bulletin-day-btn px-2.5 py-1 rounded-lg border border-main bg-surface text-main font-semibold">すべて</button>
      <button data-day="TODAY" class="bulletin-day-btn px-2.5 py-1 rounded-lg border border-divider bg-surface-strong text-muted hover-text-main">本日</button>
      <button data-day="YESTERDAY" class="bulletin-day-btn px-2.5 py-1 rounded-lg border border-divider bg-surface-strong text-muted hover-text-main">昨日</button>
      <button data-day="WEEK" class="bulletin-day-btn px-2.5 py-1 rounded-lg border border-divider bg-surface-strong text-muted hover-text-main">直近7日</button>
      <label class="flex items-center gap-1.5 ml-auto text-muted">
        特定の日付:
        <input type="date" id="bulletin-day-date" class="py-1 px-2 rounded-lg border border-main bg-surface-strong text-main text-xs">
      </label>
      <button id="bulletin-day-clear" class="btn-secondary px-2.5 py-1 rounded-lg text-[11px] text-soft border-main">リセット</button>
    </div>

    <!-- 検索 & フィルタバー -->
    <div class="grid grid-cols-1 md:grid-cols-12 gap-3 items-center mb-4">
      <!-- カテゴリフィルター -->
      <div class="md:col-span-7 flex flex-wrap items-center gap-1.5 text-xs">
        <button data-cat="ALL" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-main bg-surface text-main font-semibold active">すべて</button>
        <button data-cat="GENERAL" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-divider bg-surface-strong text-muted hover-text-main">一般掲示</button>
        <button data-cat="CIRCULAR" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-divider bg-surface-strong text-muted hover-text-main">回覧・要承認</button>
        <button data-cat="URGENT" class="bulletin-filter-btn px-3 py-1.5 rounded-lg border border-divider bg-surface-strong text-muted hover-text-main">至急連絡</button>
      </div>

      <!-- キーワード検索 -->
      <div class="md:col-span-5 relative">
        <i data-lucide="search" class="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted"></i>
        <input type="text" id="bulletin-search-input" class="input-field pl-9 py-1.5 text-xs" placeholder="タイトルや本文から検索...">
      </div>
    </div>

    <!-- 掲示物カードグリッド -->
    <div id="bulletin-list-container" class="space-y-3">
      <div class="text-center py-10 text-xs text-muted">掲示板データを読み込み中...</div>
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
        b.classList.remove('active', 'bg-surface', 'text-main', 'border-main');
        b.classList.add('bg-surface-strong', 'text-muted', 'border-divider');
      });
      btn.classList.add('active', 'bg-surface', 'text-main', 'border-main');
      btn.classList.remove('bg-surface-strong', 'text-muted', 'border-divider');

      currentCategory = btn.getAttribute('data-cat') || 'ALL';
      renderBulletinList();
    });
  });

  // 検索インプット
  document.getElementById('bulletin-search-input')?.addEventListener('input', (e) => {
    currentSearch = e.target.value.toLowerCase().trim();
    renderBulletinList();
  });

  // ★ 添付ファイル選択プレビュー
  const fileInput = document.getElementById('bulletin-files');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      renderSelectedFiles(Array.from(fileInput.files || []));
    });
  }

  // ★ 投稿日（日ごと）フィルター
  document.querySelectorAll('.bulletin-day-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.bulletin-day-btn').forEach(b => {
        b.classList.remove('bg-surface', 'text-main', 'border-main', 'font-semibold');
        b.classList.add('bg-surface-strong', 'text-muted', 'border-divider');
      });
      btn.classList.add('bg-surface', 'text-main', 'border-main', 'font-semibold');
      btn.classList.remove('bg-surface-strong', 'text-muted', 'border-divider');

      currentDayMode = btn.getAttribute('data-day') || 'ALL';
      currentDayDate = '';
      const dateInput = document.getElementById('bulletin-day-date');
      if (dateInput) dateInput.value = '';
      loadBulletins();
    });
  });

  document.getElementById('bulletin-day-date')?.addEventListener('change', (e) => {
    currentDayMode = e.target.value ? 'SPECIFIC' : 'ALL';
    currentDayDate = e.target.value;
    loadBulletins();
  });

  document.getElementById('bulletin-day-clear')?.addEventListener('click', () => {
    currentDayMode = 'ALL';
    currentDayDate = '';
    const dateInput = document.getElementById('bulletin-day-date');
    if (dateInput) dateInput.value = '';
    loadBulletins();
  });
}

/**
 * 日付文字列を JST キー (YYYY-MM-DD) に正規化
 * @param {string} iso
 */
function toJstDay(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 9 * 3600000).toISOString().split('T')[0];
}

/**
 * JST 基準の今日キーから offset 日分のキー
 * @param {number} offset
 */
function dayKey(offset = 0) {
  const d = new Date(Date.now() + 9 * 3600000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split('T')[0];
}

/**
 * 投稿日が現在の「日ごと」表示モードに一致するか
 * @param {Object} b
 */
function matchesDay(b) {
  const posted = toJstDay(b.postedAt || b.posted_at || b.createdAt || b.created_at);
  if (currentDayMode === 'ALL') return true;
  if (!posted) return false;
  if (currentDayMode === 'TODAY') return posted === dayKey(0);
  if (currentDayMode === 'YESTERDAY') return posted === dayKey(-1);
  if (currentDayMode === 'WEEK') return posted >= dayKey(-7) && posted <= dayKey(0);
  if (currentDayMode === 'SPECIFIC') return posted === currentDayDate;
  return true;
}

/**
 * 掲示データの取得
 */
export async function loadBulletins() {
  // 日ごと表示モードに応じたサーバー側フィルタパラメータ
  const params = {};
  if (currentDayMode === 'TODAY') params.postedDay = dayKey(0);
  if (currentDayMode === 'YESTERDAY') params.postedDay = dayKey(-1);
  if (currentDayMode === 'SPECIFIC' && currentDayDate) params.postedDay = currentDayDate;
  if (currentDayMode === 'WEEK') {
    params.startDate = dayKey(-7);
    params.endDate = dayKey(0);
  }

  try {
    const res = await apiGet('/bulletins', params);
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

    return matchCat && matchQuery && matchesDay(b);
  });

  // 優先度(URGENT)および投稿日時降順ソート
  filtered.sort((a, b) => {
    const pA = a.priority === 'URGENT' ? 1 : 0;
    const pB = b.priority === 'URGENT' ? 1 : 0;
    const dateA = new Date(a.postedAt || a.posted_at || a.createdAt || a.created_at);
    const dateB = new Date(b.postedAt || b.posted_at || b.createdAt || b.created_at);
    return pB - pA || dateB - dateA;
  });

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-center py-12 text-xs text-muted bg-surface-soft rounded-xl border border-divider">
      ${currentDayMode === 'ALL' ? '該当する掲示連絡はありません。' : '選択した投稿日に掲示連絡はありません。'}
    </div>`;
    return;
  }

  container.innerHTML = filtered.map(b => {
    const isUrgent = b.priority === 'URGENT';
    const isCircular = b.postType === 'CIRCULAR' || b.post_type === 'CIRCULAR';
    const isRead = b.isRead || b.ackStatus === 'READ' || b.ackStatus === 'APPROVED';
    const attachments = b.attachments || [];
    const postedLabel = formatDate(b.postedAt || b.posted_at || b.createdAt || b.created_at);

    return `
      <div class="card p-4 hover-border-accent transition-all cursor-pointer ${isUrgent ? 'border-l-4 border-l-warning bg-surface-strong' : ''}" data-bulletin-id="${b.id}">
        <div class="flex items-center justify-between text-xs mb-2">
          <div class="flex items-center gap-2">
            ${isUrgent ? '<span class="badge badge-warning flex items-center gap-1"><i data-lucide="alert-triangle" class="w-3 h-3"></i> 至急</span>' : ''}
            <span class="badge ${isCircular ? 'bg-warning-soft text-warning-strong border-warning-soft' : 'badge'}">${isCircular ? '回覧・要承認' : '一般掲示'}</span>
            ${!isRead ? '<span class="badge bg-danger-soft text-danger border-danger-soft">未読</span>' : ''}
            ${attachments.length > 0 ? `<span class="badge bg-accent-soft text-accent-strong border-accent-soft flex items-center gap-1"><i data-lucide="paperclip" class="w-3 h-3"></i> 添付 ${attachments.length}</span>` : ''}
          </div>
          <div class="text-[11px] text-muted font-mono">
            投稿者: <strong class="text-main">${escapeHTML(b.authorName || b.author_name || '教員')}</strong>
          </div>
        </div>
        <h3 class="font-bold text-sm text-main mb-1 flex items-center justify-between">
          <span>${escapeHTML(b.title)}</span>
          <span class="text-[10px] text-muted font-mono font-normal">投稿日: ${postedLabel}</span>
        </h3>
        <p class="text-xs text-soft line-clamp-2 leading-relaxed whitespace-pre-wrap">${escapeHTML(b.content)}</p>
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
  const attachEl = document.getElementById('detail-bulletin-attachments');

  if (titleEl) titleEl.textContent = item.title;
  if (metaEl) {
    metaEl.innerHTML = `
      <span>種別: <strong class="text-accent-strong">${item.postType === 'CIRCULAR' ? '回覧板' : '一般掲示'}</strong></span>
      <span>投稿者: ${escapeHTML(item.authorName || item.author_name || '教員')}</span>
      <span>投稿日: <strong class="text-main">${formatDate(item.postedAt || item.posted_at || item.createdAt || item.created_at)}</strong></span>
    `;
  }
  if (contentEl) contentEl.textContent = item.content;

  // ★ 添付ファイル一覧
  if (attachEl) {
    const atts = item.attachments || [];
    if (atts.length === 0) {
      attachEl.innerHTML = '';
    } else {
      attachEl.innerHTML = `
        <p class="text-[11px] font-semibold text-soft mb-1.5 flex items-center gap-1">
          <i data-lucide="paperclip" class="w-3.5 h-3.5 text-accent"></i> 添付ファイル (${atts.length})
        </p>
        <ul class="space-y-1.5">
          ${atts.map(a => `
            <li class="flex items-center gap-2 text-[11px] bg-surface-strong border border-divider rounded-lg px-2.5 py-1.5">
              <span class="truncate text-main">${escapeHTML(a.name)}</span>
              <span class="text-muted shrink-0">${formatBytes(a.size)}</span>
              ${a.kgs ? '<span class="badge bg-warning-soft text-warning-strong border border-warning-soft shrink-0">KAGOSHIMA EDU</span>' : ''}
              <a href="${API_BASE_URL}/bulletins/attachments/${a.id}" target="_blank" rel="noopener"
                 class="ml-auto text-accent-strong hover-text-accent-strong shrink-0 flex items-center gap-1">
                <i data-lucide="download" class="w-3.5 h-3.5"></i> ダウンロード
              </a>
            </li>
          `).join('')}
        </ul>
      `;
    }
  }

  if (actionsEl) {
    const isCircular = item.postType === 'CIRCULAR' || item.post_type === 'CIRCULAR';
    actionsEl.innerHTML = `
      ${isCircular ? `
        <button id="btn-approve-bulletin" class="btn-primary py-1.5 px-3 text-xs bg-success hover-success-strong flex items-center gap-1.5">
          <i data-lucide="check-circle" class="w-3.5 h-3.5"></i> ワンクリック承認
        </button>
      ` : ''}
      <button id="btn-revise-request" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5 text-warning border-warning-soft">
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
  const targetDate = document.getElementById('bulletin-target-date')?.value || '';

  if (!title || !content) {
    showToast('タイトルと本文は必須です', 'warning');
    return;
  }

  const postType = (category === 'INSTRUCTION' || category === 'CIRCULAR') ? 'CIRCULAR' : 'NOTICE';
  const priority = (category === 'URGENT' || isPinned) ? 'URGENT' : 'NORMAL';

  // 投稿日時（JST 現在時刻・日ごと表示の基準）
  const postedAt = new Date(Date.now() + 9 * 3600000).toISOString().replace('Z', '+09:00');

  const fileInput = document.getElementById('bulletin-files');
  const files = fileInput ? Array.from(fileInput.files || []) : [];

  if (files.length > 10) {
    showToast('添付ファイルは1回につき10件までです', 'warning');
    return;
  }

  const maxBytes = 10 * 1024 * 1024;
  const oversize = files.find(f => f.size > maxBytes);
  if (oversize) {
    showToast(`「${oversize.name}」は10MBを超えています`, 'warning');
    return;
  }

  const targetScope = { grade: 'ALL', department: 'ALL' };

  try {
    if (files.length > 0) {
      const fd = new FormData();
      fd.append('title', title);
      fd.append('content', content);
      fd.append('postType', postType);
      fd.append('priority', priority);
      fd.append('postedAt', postedAt);
      fd.append('targetDate', targetDate);
      fd.append('targetScope', JSON.stringify(targetScope));
      files.forEach((f) => fd.append('files', f, f.name));
      await apiPostForm('/bulletins/upload', fd);
      showToast(`投稿しました（添付 ${files.length} 件）`, 'success');
    } else {
      await apiPost('/bulletins', {
        title,
        content,
        postType,
        priority,
        postedAt,
        targetDate,
        targetScope,
        attachments: []
      });
      showToast('投稿しました', 'success');
    }
  } catch(err) {
    console.error('[Bulletin] 投稿エラー:', err);
    showToast(err.message || '投稿に失敗しました', 'error');
    return;
  }

  closeModal('bulletin-modal');
  const form = document.getElementById('bulletin-form');
  form?.reset();
  if (fileInput) fileInput.value = '';
  renderSelectedFiles([]);
  loadBulletins();
}

/**
 * 選択ファイル一覧の表示（投稿モーダル内）
 * @param {Array<File>} files
 */
function renderSelectedFiles(files = []) {
  const listEl = document.getElementById('bulletin-files-list');
  if (!listEl) return;

  if (files.length === 0) {
    listEl.innerHTML = '';
    return;
  }

  listEl.innerHTML = files.map(f => `
    <li class="flex items-center gap-2 text-[11px] text-soft">
      <i data-lucide="paperclip" class="w-3 h-3 text-accent shrink-0"></i>
      <span class="truncate">${escapeHTML(f.name)}</span>
      <span class="text-muted shrink-0">${formatBytes(f.size)}</span>
    </li>
  `).join('');
  refreshLucideIcons();
}

/**
 * バイト数表示の整形
 * @param {number} bytes
 */
function formatBytes(bytes = 0) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
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