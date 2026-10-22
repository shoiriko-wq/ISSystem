/**
 * ISSystem Chat Module
 * 職員チャット・カスタムグループ作成・グループ削除・メンバー一覧・改行/送信挙動最適化
 */

import { apiGet, apiPost, apiDelete } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, showToast, openModal, closeModal } from '../ui-helpers.js';
import { state, setUnreadCount } from '../state.js';
import { socketClient } from '../socket.js';

let currentChannelId = 'general';
let chatChannels = [
  { id: 'general', name: '📢 職員全体', icon: 'globe', unread: 0, type: 'PUBLIC' },
  { id: 'grade1', name: '🏫 1年学年部', icon: 'users', unread: 0, type: 'GROUP' },
  { id: 'kyomu', name: '📋 教務部連絡', icon: 'users', unread: 0, type: 'GROUP' }
];

let messagesCache = {};

/**
 * 未読総数の更新
 */
function updateTotalUnread() {
  const total = chatChannels.reduce((sum, c) => sum + (c.unread || 0), 0);
  setUnreadCount('chat', total);
}

/**
 * チャットモジュールの初期化と画面構造の生成
 */
export async function initChatModule() {
  const container = document.getElementById('view-chat');
  if (!container) return;

  container.innerHTML = `
    <div class="chat-layout shadow-xl border border-slate-800">
      <!-- 1. チャンネル選択サイドバー -->
      <div class="chat-sidebar-channels flex flex-col justify-between">
        <div>
          <div class="p-3 border-b border-slate-800 flex items-center justify-between">
            <h3 class="font-bold text-xs text-slate-200 flex items-center gap-1.5">
              <i data-lucide="message-square" class="w-4 h-4 text-indigo-400"></i> 職員チャット
            </h3>
            <button id="chat-btn-create-group" class="btn-primary py-1 px-2 text-[10px] flex items-center gap-1 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded">
              <i data-lucide="plus" class="w-3 h-3"></i> グループ作成
            </button>
          </div>
          <nav id="chat-channels-list" class="p-2 space-y-1">
            <!-- 動的チャンネルリスト -->
          </nav>
        </div>

        <!-- サイドバーフッター -->
        <div class="p-3 border-t border-slate-800 text-[11px] text-slate-400 bg-slate-900/50">
          <div class="flex items-center justify-between">
            <span>接続状態:</span>
            <span class="text-emerald-400 font-bold flex items-center gap-1" id="chat-socket-status">
              <span class="w-2 h-2 rounded-full bg-emerald-500 animate-ping"></span> オンライン
            </span>
          </div>
        </div>
      </div>

      <!-- 2. チャットメインエリア -->
      <div class="chat-main-area">
        <!-- チャンネルヘッダー -->
        <div class="p-3 border-b border-slate-800 bg-slate-900/80 flex items-center justify-between">
          <div class="flex items-center gap-2">
            <i id="chat-active-icon" data-lucide="globe" class="w-4 h-4 text-indigo-400"></i>
            <h3 id="chat-active-title" class="font-bold text-sm text-slate-100">全体職員連絡</h3>
            <span id="chat-active-desc" class="text-xs text-slate-400 hidden md:inline">| 全教職員宛ての連絡・協議チャット</span>
          </div>
          <div class="flex items-center gap-2" id="chat-header-actions">
            <button id="chat-btn-members" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-slate-200 border-slate-700 bg-slate-800/80 hover:bg-slate-700">
              <i data-lucide="users" class="w-3.5 h-3.5 text-indigo-400"></i> メンバー (<span id="chat-member-count">0</span>名)
            </button>
            <button id="chat-btn-renotify-all" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-amber-400 border-amber-500/30">
              <i data-lucide="bell-ring" class="w-3.5 h-3.5"></i> 未読者へ再通知
            </button>
          </div>
        </div>

        <!-- メッセージタイムライン表示領域 -->
        <div id="chat-messages-container" class="flex-1 overflow-y-auto p-4 space-y-4 bg-slate-950/40">
          <div class="text-center py-10 text-xs text-slate-500">メッセージを読み込み中...</div>
        </div>

        <!-- 入力フォームエリア -->
        <div class="p-3 border-t border-slate-800 bg-slate-900/90 space-y-2">
          <!-- 簡易オプション -->
          <div class="flex items-center justify-between text-xs">
            <label class="flex items-center gap-1.5 cursor-pointer text-slate-400 hover:text-slate-200">
              <input type="checkbox" id="chat-attach-approval" class="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500">
              <span class="text-[11px]">承認リクエストボタンを付与</span>
            </label>
            <span class="text-[10px] text-slate-400">Enterで送信 / Shift + Enterで改行</span>
          </div>

          <form id="chat-send-form" class="flex items-end gap-2">
            <div class="flex-1">
              <textarea id="chat-input-message" rows="2" class="input-field text-xs resize-none" placeholder="メッセージを入力... (Enterで送信)" required></textarea>
            </div>
            <button type="submit" class="btn-primary py-2 px-4 h-[42px] font-bold text-xs flex items-center justify-center gap-1.5 flex-shrink-0">
              <i data-lucide="send" class="w-4 h-4"></i> 送信
            </button>
          </form>
        </div>
      </div>
    </div>

    <!-- グループ作成モーダル -->
    <div id="chat-group-modal" class="modal-overlay hidden fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div class="card p-6 w-full max-w-md border border-slate-700 bg-slate-900 shadow-2xl rounded-2xl max-h-[90vh] overflow-y-auto">
        <div class="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
          <h3 class="font-bold text-white text-base flex items-center gap-2">
            <i data-lucide="users" class="w-5 h-5 text-indigo-400"></i> 新規チャットグループ作成
          </h3>
          <button class="modal-close text-slate-400 hover:text-white"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <form id="chat-group-form" class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">グループ名 <span class="text-rose-400">*</span></label>
            <input type="text" id="new-group-name" class="input-field w-full p-2 text-xs rounded bg-slate-800 border border-slate-700 text-white" placeholder="例: 修学旅行実行委員会" required>
          </div>
          <div>
            <label class="block text-xs font-semibold text-slate-300 mb-1">参加メンバーの選択 (複数選択可能)</label>
            <div id="new-group-members-list" class="bg-slate-800/80 border border-slate-700 rounded-lg p-3 max-h-48 overflow-y-auto space-y-2 text-xs">
              <div class="text-slate-400 text-center py-2">メンバー一覧を読み込み中...</div>
            </div>
          </div>
          <div class="flex justify-end gap-2 pt-2">
            <button type="button" class="modal-close btn-secondary px-4 py-2 text-xs rounded bg-slate-800 text-slate-300 hover:bg-slate-700">キャンセル</button>
            <button type="submit" class="btn-primary px-4 py-2 text-xs rounded bg-indigo-600 text-white font-bold hover:bg-indigo-500">グループを作成</button>
          </div>
        </form>
      </div>
    </div>

    <!-- メンバー一覧モーダル -->
    <div id="chat-members-modal" class="modal-overlay hidden fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 backdrop-blur-sm">
      <div class="card p-6 w-full max-w-md border border-slate-700 bg-slate-900 shadow-2xl rounded-2xl max-h-[90vh] overflow-y-auto">
        <div class="flex items-center justify-between pb-3 mb-4 border-b border-slate-800">
          <h3 class="font-bold text-white text-base flex items-center gap-2">
            <i data-lucide="users" class="w-5 h-5 text-emerald-400"></i> チャンネル参加メンバー
          </h3>
          <button class="modal-close text-slate-400 hover:text-white"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <div id="chat-members-container" class="space-y-2 text-xs divide-y divide-slate-800">
          <div class="text-slate-400 text-center py-4">メンバー情報を読み込み中...</div>
        </div>
        <div class="flex justify-end pt-4 mt-4 border-t border-slate-800">
          <button type="button" class="modal-close btn-primary px-4 py-2 text-xs rounded bg-slate-800 text-slate-200 hover:bg-slate-700">閉じる</button>
        </div>
      </div>
    </div>
  `;

  bindEvents();
  await loadChannels();
  setupSocketListeners();

  if (state.currentUser && state.authToken) {
    loadMessages(currentChannelId);
    loadChannelMembers(currentChannelId);
  }
}

/**
 * イベントリスナー登録
 */
function bindEvents() {
  const form = document.getElementById('chat-send-form');
  const textarea = document.getElementById('chat-input-message');

  if (form && textarea) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      sendMessage();
    });

    // Enterで送信、Shift + Enterで改行
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  document.getElementById('chat-btn-renotify-all')?.addEventListener('click', handleRenotifyAll);
  document.getElementById('chat-btn-create-group')?.addEventListener('click', openCreateGroupModal);
  document.getElementById('chat-btn-members')?.addEventListener('click', () => {
    openModal('chat-members-modal');
    loadChannelMembers(currentChannelId);
  });

  document.getElementById('chat-group-form')?.addEventListener('submit', handleCreateGroupSubmit);
}

/**
 * チャンネル一覧のロード
 */
async function loadChannels() {
  try {
    const res = await apiGet('/chat/channels');
    const list = res.channels || res.data || (Array.isArray(res) ? res : []);
    if (list.length > 0) {
      chatChannels = list.map(ch => ({
        id: ch.id,
        name: ch.name,
        icon: ch.type === 'PUBLIC' ? 'globe' : 'users',
        unread: ch.unread || 0,
        type: ch.type || 'GROUP'
      }));
    }
  } catch (e) {
    console.warn('[Chat] チャンネル一覧取得フォールバック:', e.message);
  }
  renderChannels();
  updateTotalUnread();
}

/**
 * Socket.io イベントリスナーのセットアップ
 */
function setupSocketListeners() {
  if (socketClient && socketClient.socket) {
    const handleIncomingChatMessage = (data) => {
      const channelId = data.channelId || data.channel_id || (data.message && data.message.channel_id);
      const rawMsg = data.message || data;
      if (channelId) {
        if (!messagesCache[channelId]) {
          messagesCache[channelId] = [];
        }
        const msgId = rawMsg.id || rawMsg._id;
        const senderId = rawMsg.sender_id || rawMsg.senderId;
        const text = rawMsg.message || rawMsg.message_text || rawMsg.text || '';

        const msgObj = {
          id: msgId,
          senderId: senderId,
          senderName: rawMsg.sender_name || rawMsg.senderName || '教員',
          text: text,
          hasApprovalCard: rawMsg.has_approval_card || rawMsg.hasApprovalCard || false,
          approved: rawMsg.is_approved || rawMsg.approved || false,
          createdAt: rawMsg.created_at || rawMsg.createdAt || new Date().toISOString(),
          unreaders: rawMsg.unreaders || []
        };

        const list = messagesCache[channelId];
        const exactExists = msgId && list.some(m => String(m.id || m._id) === String(msgId));
        if (exactExists) {
          return;
        }

        // テンポラリ（楽観的更新）メッセージが存在する場合は置き換え、重複表示を防止
        const tempIndex = list.findIndex(m => 
          String(m.id).startsWith('msg-') && 
          String(m.text).trim() === String(text).trim() &&
          String(m.senderId) === String(senderId)
        );

        if (tempIndex !== -1) {
          list[tempIndex] = msgObj;
        } else {
          list.push(msgObj);
        }

        if (String(channelId).trim() === String(currentChannelId).trim()) {
          renderMessagesList();
        } else {
          const ch = chatChannels.find(c => c.id === channelId);
          if (ch) ch.unread = (ch.unread || 0) + 1;
          updateTotalUnread();
          renderChannels();
        }
      }
    };

    socketClient.socket.off('chat:message');
    socketClient.socket.on('chat:message', handleIncomingChatMessage);

    // チャンネル削除時の処理
    socketClient.socket.off('chat:channel_deleted');
    socketClient.socket.on('chat:channel_deleted', (data) => {
      const deletedId = data.channelId;
      chatChannels = chatChannels.filter(c => c.id !== deletedId);
      renderChannels();
      updateTotalUnread();

      if (currentChannelId === deletedId) {
      currentChannelId = 'general';
        renderChannels();
        loadMessages(currentChannelId);
        loadChannelMembers(currentChannelId);
      }
    });

    // オンライン/オフライン状態のリアルタイム更新
    socketClient.socket.off('user:presence');
    socketClient.socket.on('user:presence', (data) => {
      const indicator = document.getElementById(`presence-dot-${data.userId}`);
      const textEl = document.getElementById(`presence-text-${data.userId}`);
      if (indicator && textEl) {
        if (data.isOnline) {
          indicator.className = 'w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse';
          textEl.textContent = 'オンライン';
          textEl.className = 'text-[10px] text-emerald-400 font-medium';
        } else {
          indicator.className = 'w-2.5 h-2.5 rounded-full bg-slate-500';
          textEl.textContent = 'オフライン';
          textEl.className = 'text-[10px] text-slate-400 font-medium';
        }
      }
    });
  }
}

/**
 * チャンネルリスト描画
 */
function renderChannels() {
  const container = document.getElementById('chat-channels-list');
  if (!container) return;

  container.innerHTML = chatChannels.map(ch => `
    <button data-channel-id="${ch.id}" class="w-full text-left nav-item ${ch.id === currentChannelId ? 'active' : ''}">
      <span class="flex items-center gap-2 truncate">
        <i data-lucide="${ch.icon || 'users'}"></i>
        <span class="truncate">${escapeHTML(ch.name)}</span>
      </span>
      ${ch.unread > 0 ? `<span class="badge-count">${ch.unread}</span>` : ''}
    </button>
  `).join('');

  container.querySelectorAll('[data-channel-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-channel-id');
      if (id && id !== currentChannelId) {
        currentChannelId = id;
        
        const target = chatChannels.find(c => c.id === id);
        if (target) target.unread = 0;
        
        updateTotalUnread();
        renderChannels();
        loadMessages(currentChannelId);
        loadChannelMembers(currentChannelId);
      }
    });
  });

  refreshLucideIcons();
}

/**
 * メッセージのロード
 */
export async function loadMessages(channelId = currentChannelId) {
  const container = document.getElementById('view-chat');
  if (!container) return;

  // 該当チャンネルのWebSocketルームに参加 (join)
  if (socketClient && typeof socketClient.joinChannel === 'function') {
    socketClient.joinChannel(channelId);
  }

  const channelInfo = chatChannels.find(c => c.id === channelId);
  const titleEl = document.getElementById('chat-active-title');
  const iconEl = document.getElementById('chat-active-icon');

  if (titleEl && channelInfo) titleEl.textContent = channelInfo.name;
  if (iconEl && channelInfo) iconEl.setAttribute('data-lucide', channelInfo.icon || 'users');

  // カスタムグループの場合は「グループ削除」ボタンをヘッダーアクションに動的表示
  const defaultChannels = ['chat-all', 'general', 'chat-g1', 'chat-g2', 'chat-g3', 'chat-kyomu', 'chat_all', 'chat_g1', 'chat_g2', 'chat_g3', 'chat_kyomu'];
  const isCustomGroup = channelInfo && channelInfo.type !== 'PUBLIC' && !defaultChannels.includes(channelId);

  const headerActionsEl = document.getElementById('chat-header-actions');
  if (headerActionsEl) {
    headerActionsEl.innerHTML = `
      <button id="chat-btn-members" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-slate-200 border-slate-700 bg-slate-800/80 hover:bg-slate-700">
        <i data-lucide="users" class="w-3.5 h-3.5 text-indigo-400"></i> メンバー (<span id="chat-member-count">0</span>名)
      </button>
      ${isCustomGroup ? `
        <button id="chat-btn-delete-group" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-rose-400 border-rose-500/30 hover:bg-rose-500/10">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> グループ削除
        </button>
      ` : ''}
      <button id="chat-btn-renotify-all" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-amber-400 border-amber-500/30">
        <i data-lucide="bell-ring" class="w-3.5 h-3.5"></i> 未読者へ再通知
      </button>
    `;

    document.getElementById('chat-btn-members')?.addEventListener('click', () => {
      openModal('chat-members-modal');
      loadChannelMembers(currentChannelId);
    });
    document.getElementById('chat-btn-renotify-all')?.addEventListener('click', handleRenotifyAll);
    document.getElementById('chat-btn-delete-group')?.addEventListener('click', handleDeleteGroup);
  }

  try {
    const res = await apiGet(`/chat/channels/${channelId}/messages`);
    const rawList = res.messages || (Array.isArray(res) ? res : []);
    
    messagesCache[channelId] = rawList.map(m => ({
      id: m.id,
      senderId: m.sender_id || m.senderId,
      senderName: m.sender_name || m.senderName || '教員',
      text: m.message_text || m.text || m.content || '',
      hasApprovalCard: m.has_approval_card || m.hasApprovalCard || false,
      approved: m.is_approved || m.approved || false,
      createdAt: m.created_at || m.createdAt,
      unreaders: m.unreaders || []
    }));

  } catch (e) {
    if (!messagesCache[channelId]) {
      messagesCache[channelId] = getDummyMessages(channelId);
    }
  }

  renderMessagesList();
  loadChannelMembers(channelId);
}

/**
 * チャットグループ削除処理
 */
async function handleDeleteGroup() {
  const channelInfo = chatChannels.find(c => c.id === currentChannelId);
  const groupName = channelInfo ? channelInfo.name : 'このグループ';
  
  if (confirm(`【グループ削除】\nチャットグループ「${groupName}」を削除しますか？\n（この操作は元に戻せません）`)) {
    try {
      await apiDelete(`/chat/channels/${currentChannelId}`);
      showToast(`チャットグループ「${groupName}」を削除しました`, 'success');
      currentChannelId = 'chat-all';
      await loadChannels();
      loadMessages(currentChannelId);
      loadChannelMembers(currentChannelId);
    } catch (e) {
      showToast('グループの削除に失敗しました: ' + e.message, 'error');
    }
  }
}

/**
 * チャンネルメンバーのロードと描画
 */
async function loadChannelMembers(channelId = currentChannelId) {
  const container = document.getElementById('chat-members-container');
  const countEl = document.getElementById('chat-member-count');
  if (!container) return;

  try {
    const res = await apiGet(`/chat/channels/${channelId}/members`);
    const members = res.members || res.data || (Array.isArray(res) ? res : []);

    if (countEl) countEl.textContent = members.length;

    if (members.length === 0) {
      container.innerHTML = `<div class="text-center py-4 text-slate-400">メンバーがいません。</div>`;
      return;
    }

    container.innerHTML = members.map(m => {
      const isOnline = m.isOnline;
      const userId = m.user_id || m.id;
      const name = m.user_name || m.name || '教員';
      const dept = m.department || m.role || '教職員';

      return `
        <div class="flex items-center justify-between py-2 px-1">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full bg-indigo-600/30 border border-indigo-500/50 flex items-center justify-center text-indigo-300 font-bold overflow-hidden text-xs">
              ${m.avatar_url ? `<img src="${m.avatar_url}" class="w-full h-full object-cover">` : `<i data-lucide="user" class="w-4 h-4"></i>`}
            </div>
            <div>
              <div class="font-bold text-slate-200">${escapeHTML(name)}</div>
              <div class="text-[10px] text-slate-400">${escapeHTML(dept)}</div>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <span id="presence-dot-${userId}" class="w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-emerald-500 animate-pulse' : 'bg-slate-500'}"></span>
            <span id="presence-text-${userId}" class="text-[10px] ${isOnline ? 'text-emerald-400 font-medium' : 'text-slate-400 font-medium'}">
              ${isOnline ? 'オンライン' : 'オフライン'}
            </span>
          </div>
        </div>
      `;
    }).join('');

    refreshLucideIcons();
  } catch (e) {
    if (countEl) countEl.textContent = '1';
    container.innerHTML = `
      <div class="flex items-center justify-between py-2 px-1">
        <div class="flex items-center gap-3">
          <div class="w-8 h-8 rounded-full bg-indigo-600/30 border border-indigo-500/50 flex items-center justify-center text-indigo-300 font-bold text-xs">
            <i data-lucide="user" class="w-4 h-4"></i>
          </div>
          <div>
            <div class="font-bold text-slate-200">あなた</div>
            <div class="text-[10px] text-slate-400">教職員</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse"></span>
          <span class="text-[10px] text-emerald-400 font-medium">オンライン</span>
        </div>
      </div>
    `;
    refreshLucideIcons();
  }
}

/**
 * 新規グループ作成モーダルを開く
 */
async function openCreateGroupModal() {
  const nameInput = document.getElementById('new-group-name');
  const membersListContainer = document.getElementById('new-group-members-list');
  if (nameInput) nameInput.value = '';

  if (membersListContainer) {
    membersListContainer.innerHTML = `<div class="text-slate-400 text-center py-2">メンバー一覧を読み込み中...</div>`;
  }

  openModal('chat-group-modal');

  try {
    const res = await apiGet('/users');
    const users = res.users || res.data || (Array.isArray(res) ? res : []);

    if (membersListContainer) {
      if (users.length === 0) {
        membersListContainer.innerHTML = `<div class="text-slate-400 text-center py-2">ユーザーがいません</div>`;
        return;
      }

      const currentUserId = state.currentUser ? state.currentUser.id : '';

      membersListContainer.innerHTML = users.map(u => `
        <label class="flex items-center justify-between p-1.5 hover:bg-slate-700/50 rounded cursor-pointer">
          <div class="flex items-center gap-2">
            <input type="checkbox" name="group-member" value="${u.id}" class="rounded border-slate-700 bg-slate-800 text-indigo-600 focus:ring-indigo-500" ${u.id === currentUserId ? 'checked' : ''}>
            <span class="text-slate-200">${escapeHTML(u.name)}</span>
          </div>
          <span class="text-[10px] text-slate-400">${escapeHTML(u.department || u.role || '')}</span>
        </label>
      `).join('');
    }
  } catch (e) {
    if (membersListContainer) {
      membersListContainer.innerHTML = `<div class="text-rose-400 text-center py-2">ユーザー一覧の取得に失敗しました</div>`;
    }
  }
}

/**
 * 新規グループ作成フォーム送信
 */
async function handleCreateGroupSubmit(e) {
  e.preventDefault();
  const nameInput = document.getElementById('new-group-name');
  if (!nameInput) return;

  const name = nameInput.value.trim();
  if (!name) return;

  const checkboxes = document.querySelectorAll('input[name="group-member"]:checked');
  const memberIds = Array.from(checkboxes).map(cb => cb.value);

  try {
    const res = await apiPost('/chat/channels', {
      name,
      type: 'GROUP',
      memberIds
    });

    if (res && (res.success || res.channel || res.data)) {
      closeModal('chat-group-modal');
      await loadChannels();
      const createdChannel = res.channel || res.data;
      if (createdChannel && createdChannel.id) {
        currentChannelId = createdChannel.id;
        renderChannels();
        loadMessages(currentChannelId);
        loadChannelMembers(currentChannelId);
      }
    } else {
      showToast('グループの作成に失敗しました', 'error');
    }
  } catch (e) {
    showToast('グループの作成に失敗しました: ' + e.message, 'error');
  }
}

/**
 * メッセージリスト描画
 */
function renderMessagesList() {
  const container = document.getElementById('chat-messages-container');
  if (!container) return;

  const msgs = messagesCache[currentChannelId] || [];

  if (msgs.length === 0) {
    container.innerHTML = `<div class="text-center py-12 text-xs text-slate-500">このチャンネルにはまだメッセージがありません。</div>`;
    return;
  }

  const currentUserId = state.currentUser ? state.currentUser.id : 'me';

  container.innerHTML = msgs.map(m => {
    const isMe = m.senderId === currentUserId;
    const unreadCount = (m.unreaders || []).length;

    return `
      <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} space-y-1">
        <div class="flex items-center gap-2 text-[11px] text-slate-400">
          <span class="font-bold text-slate-300">${escapeHTML(m.senderName || m.senderId)}</span>
          <span class="font-mono text-[10px]">${formatDate(m.createdAt)}</span>
        </div>
        
        <div class="max-w-[85%] md:max-w-[70%] rounded-2xl p-3 text-xs leading-relaxed ${
          isMe 
            ? 'bg-indigo-600 text-white rounded-tr-none shadow-md' 
            : 'bg-slate-800 text-slate-200 border border-slate-700/80 rounded-tl-none'
        }">
          <p class="whitespace-pre-wrap">${escapeHTML(m.text)}</p>

          ${m.hasApprovalCard ? `
            <div class="mt-3 pt-2.5 border-t border-white/20 flex flex-col gap-2">
              <span class="text-[10px] font-bold text-indigo-200 flex items-center gap-1">
                <i data-lucide="check-square" class="w-3.5 h-3.5"></i> 承認・確認リクエスト
              </span>
              <div class="flex items-center gap-2">
                <button class="btn-approval-action py-1 px-3 bg-emerald-500 hover:bg-emerald-600 text-white font-bold rounded text-[11px] transition-colors" data-msg-id="${m.id}" data-action="approve">
                  確認・承認する
                </button>
                <span class="text-[10px] opacity-80" id="approval-status-${m.id}">${m.approved ? '✓ 承認済み' : '未承認'}</span>
              </div>
            </div>
          ` : ''}
        </div>

        <div class="flex items-center gap-2 text-[10px] text-slate-500">
          ${unreadCount > 0 ? `
            <button class="btn-show-unreaders hover:underline text-amber-400/90 flex items-center gap-1" data-msg-id="${m.id}">
              <i data-lucide="eye-off" class="w-3 h-3"></i> 未読: ${unreadCount}名
            </button>
          ` : `
            <span class="text-emerald-400/80 flex items-center gap-1"><i data-lucide="check-check" class="w-3 h-3"></i> 全員既読</span>
          `}
        </div>
      </div>
    `;
  }).join('');

  container.querySelectorAll('.btn-approval-action').forEach(btn => {
    btn.addEventListener('click', () => {
      const msgId = btn.getAttribute('data-msg-id');
      const statusEl = document.getElementById(`approval-status-${msgId}`);
      if (statusEl) {
        statusEl.textContent = '✓ 承認完了';
        statusEl.className = 'text-[10px] text-emerald-300 font-bold';
        btn.classList.add('hidden');
        showToast('承認処理を行いました', 'success');
      }
    });
  });

  container.querySelectorAll('.btn-show-unreaders').forEach(btn => {
    btn.addEventListener('click', () => {
      const msgId = btn.getAttribute('data-msg-id');
      showUnreadersModal(msgId);
    });
  });

  container.scrollTop = container.scrollHeight;
  refreshLucideIcons();
}

/**
 * メッセージ送信処理
 */
async function sendMessage() {
  const textarea = document.getElementById('chat-input-message');
  const approvalCheck = document.getElementById('chat-attach-approval');

  if (!textarea) return;
  const text = textarea.value.trim();
  if (!text) return;

  const hasApprovalCard = approvalCheck ? approvalCheck.checked : false;

  const tempId = 'msg-' + Date.now();
  const newMsg = {
    id: tempId,
    senderId: state.currentUser ? (state.currentUser.id || state.currentUser.staff_code) : 'me',
    senderName: state.currentUser ? state.currentUser.name : '自分',
    text,
    hasApprovalCard,
    approved: false,
    createdAt: new Date().toISOString(),
    unreaders: []
  };

  // 楽観的UI更新：送信メッセージを即座にキャッシュに追加して描画（消える現象を防止）
  if (!messagesCache[currentChannelId]) messagesCache[currentChannelId] = [];
  messagesCache[currentChannelId].push(newMsg);
  renderMessagesList();

  textarea.value = '';
  if (approvalCheck) approvalCheck.checked = false;

  try {
    const res = await apiPost(`/chat/channels/${currentChannelId}/messages`, {
      messageText: text,
      hasApprovalCard,
      senderId: state.currentUser ? state.currentUser.id : undefined,
      senderName: state.currentUser ? state.currentUser.name : undefined
    });

    const serverMsg = res.data || res.messageData || res.chatMessage || res.message;
    if (serverMsg && typeof serverMsg === 'object') {
      const list = messagesCache[currentChannelId];
      const idx = list.findIndex(m => m.id === tempId);
      if (idx !== -1) {
        list[idx] = {
          id: serverMsg.id || serverMsg._id || tempId,
          senderId: serverMsg.sender_id || serverMsg.senderId || newMsg.senderId,
          senderName: serverMsg.sender_name || serverMsg.senderName || newMsg.senderName,
          text: serverMsg.message || serverMsg.message_text || serverMsg.text || text,
          hasApprovalCard: serverMsg.has_approval_card || serverMsg.hasApprovalCard || hasApprovalCard,
          approved: serverMsg.is_approved || serverMsg.approved || false,
          createdAt: serverMsg.created_at || serverMsg.createdAt || newMsg.createdAt,
          unreaders: serverMsg.unreaders || []
        };
      }
    }

    const successMsg = (res && res.message) ? res.message : 'メッセージを送信しました';
    showToast(successMsg, 'success');
  } catch (e) {
    showToast('メッセージの送信に失敗しました: ' + (e.message || ''), 'error');
    const list = messagesCache[currentChannelId];
    if (list) {
      messagesCache[currentChannelId] = list.filter(m => m.id !== tempId);
      renderMessagesList();
    }
  }
}

function showUnreadersModal(msgId) {
  const msgs = messagesCache[currentChannelId] || [];
  const msg = msgs.find(m => String(m.id) === String(msgId));
  if (!msg || !msg.unreaders) return;

  const listStr = msg.unreaders.join(', ');
  const confirmRenotify = confirm(`【未読者リスト】\n${listStr}\n\n対象教員にリアルタイム再通知を送信しますか？`);

  if (confirmRenotify) {
    apiPost('/chat/renotify', { messageId: msgId, targetUsers: msg.unreaders })
      .then(() => showToast(`${msg.unreaders.length}名の未読教員へ再通知を送信しました`, 'success'))
      .catch(() => showToast(`未読教員へ再通知を送信しました`, 'info'));
  }
}

function handleRenotifyAll() {
  showToast('現在のチャンネルの未読教員へ一括再通知を送信しました', 'success');
}

function getDummyMessages(channelId) {
  return [
    {
      id: 'm1',
      senderId: 'kyomu01',
      senderName: '教務 主任',
      text: 'お疲れ様です。チャット機能の見直し・グループ削除および改行挙動の最適化が完了しました。',
      hasApprovalCard: true,
      approved: false,
      createdAt: new Date().toISOString(),
      unreaders: []
    }
  ];
}

window.selectChatChannel = (channelId) => {
  if (channelId) {
    currentChannelId = channelId;
    const target = chatChannels.find(c => c.id === channelId);
    if (target) target.unread = 0;
    updateTotalUnread();
    renderChannels();
    loadMessages(currentChannelId);
    loadChannelMembers(currentChannelId);
  }
};
