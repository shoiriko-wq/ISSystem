/**
 * ISSystem Chat Module
 * 職員チャット・カスタムグループ作成・グループ非表示・メンバー一覧・コメント取り消し・既読/未読表示・改行送信最適化
 */

import { apiGet, apiPost, apiPut, apiDelete } from '../api.js';
import { formatDate, escapeHTML, refreshLucideIcons, showToast, openModal, closeModal, userAvatarHtml } from '../ui-helpers.js';
import { state, setUnreadCount } from '../state.js';
import { socketClient } from '../socket.js';

let currentChannelId = 'general';
let chatChannels = [
  { id: 'general', name: '📢 職員全体', icon: 'globe', unread: 0, type: 'PUBLIC' },
  { id: 'grade1', name: '🏫 1年学年部', icon: 'users', unread: 0, type: 'GROUP' },
  { id: 'kyomu', name: '📋 教務部連絡', icon: 'users', unread: 0, type: 'GROUP' }
];

let messagesCache = {};

// グループ「非表示」状態（ユーザー個別設定・localStorage 永続化）※削除機能は廃止
const HIDDEN_STORAGE_PREFIX = 'iss_chat_hidden_groups:';
let hiddenChannels = new Map(); // channelId -> channel
let showHiddenSection = false;

function hiddenStorageKey() {
  const uid = (state.currentUser && (state.currentUser.id || state.currentUser.staff_code)) || 'anonymous';
  return `${HIDDEN_STORAGE_PREFIX}${uid}`;
}

function loadHiddenChannels() {
  try {
    const raw = localStorage.getItem(hiddenStorageKey());
    hiddenChannels = raw ? new Map(JSON.parse(raw)) : new Map();
  } catch (e) {
    hiddenChannels = new Map();
  }
}

function saveHiddenChannels() {
  try {
    localStorage.setItem(hiddenStorageKey(), JSON.stringify(Array.from(hiddenChannels.entries())));
  } catch (e) {
    console.warn('[Chat] 非表示グループの保存に失敗:', e.message);
  }
}

/**
 * 未読総数の更新
 */
function updateTotalUnread() {
  const total = chatChannels
    .filter((c) => !hiddenChannels.has(c.id))
    .reduce((sum, c) => sum + (c.unread || 0), 0);
  setUnreadCount('chat', total);
}

/**
 * メッセージ表示用メンバー名簿（user_id -> { name, avatar_url }）。未読者名簿の再計算に使う。
 */
const memberById = new Map();

/**
 * 現在ログイン中のユーザーID (staff_code も許容)
 */
function currentUserId() {
  if (!state.currentUser) return null;
  const id = state.currentUser.id || state.currentUser.staff_code || null;
  return id ? String(id) : null;
}

/**
 * 既読者名簿から指定ユーザーを除く。返り値は変更があったかどうか。
 * unreadIds (ID名簿) があればIDで判定し、無ければ名前/unreadersで判定するフォールバック。
 * @param {Object} msg
 * @param {string} readerId
 * @param {string} [readerName]
 */
function removeReaderFrom(msg, readerId, readerName = null) {
  if (!readerId) return false;

  if (Array.isArray(msg.unreadIds)) {
    const filtered = msg.unreadIds.filter((id) => String(id) !== String(readerId));
    if (filtered.length === msg.unreadIds.length) return false;
    msg.unreadIds = filtered;
    msg.unreaders = filtered.map((id) => memberById.get(String(id))?.name || String(id));
    return true;
  }

  if (!Array.isArray(msg.unreaders)) return false;
  const nameToRemove = readerName || memberById.get(String(readerId))?.name;
  const filtered = msg.unreaders.filter((n) => String(n) !== String(readerId) && n !== nameToRemove);
  if (filtered.length === msg.unreaders.length) return false;
  msg.unreaders = filtered;
  return true;
}

/**
 * 自分の閲覧位置までをローカル未読名簿から除外し、既読badgeを差分更新する
 * @param {string} channelId
 * @param {string|null} uptoMessageId
 */
function applySelfRead(channelId, uptoMessageId = null) {
  const list = messagesCache[channelId];
  if (!Array.isArray(list)) return;
  const myId = currentUserId();
  if (!myId) return;

  const uptoIdx = uptoMessageId
    ? list.findIndex((m) => String(m.id) === String(uptoMessageId))
    : list.length - 1;
  const endIdx = uptoIdx === -1 ? list.length - 1 : uptoIdx;

  const changed = [];
  for (let i = 0; i <= endIdx; i++) {
    if (removeReaderFrom(list[i], myId)) changed.push(list[i]);
  }

  if (changed.length > 0 && String(channelId) === String(currentChannelId)) {
    changed.forEach((m) => patchReadFooter(m));
  }
}

/**
 * チャンネルの閲覧位置（既読ログ）をサーバーに記録する
 * @param {string} channelId
 * @param {string|null} lastReadMessageId
 */
async function markChannelRead(channelId, lastReadMessageId = null) {
  // 閲覧した範囲は即座に自分の未読扱いを解除して表示を一致させる
  applySelfRead(channelId, lastReadMessageId);

  try {
    const res = await apiPut(`/chat/channels/${channelId}/read`, { lastReadMessageId });
    const ch = chatChannels.find((c) => c.id === channelId);
    if (ch) {
      ch.unread = typeof res.unreadCount === 'number' ? res.unreadCount : 0;
    }
    updateTotalUnread();
    renderChannels();
    return res;
  } catch (e) {
    console.warn('[Chat] 既読状態の更新に失敗:', e.message);
    return null;
  }
}

/**
 * チャットモジュールの初期化と画面構造の生成
 */
export async function initChatModule() {
  const container = document.getElementById('view-chat');
  if (!container) return;

  container.innerHTML = `
    <div class="chat-layout shadow-xl border border-divider">
      <!-- 1. チャンネル選択サイドバー -->
      <div class="chat-sidebar-channels flex flex-col justify-between">
        <div>
          <div class="p-3 border-b border-divider flex items-center justify-between">
            <h3 class="font-bold text-xs text-main flex items-center gap-1.5">
              <i data-lucide="message-square" class="w-4 h-4 text-accent"></i> 職員チャット
            </h3>
            <button id="chat-btn-create-group" class="btn-primary py-1 px-2 text-[10px] flex items-center gap-1 bg-accent hover-primary text-main font-bold rounded">
              <i data-lucide="plus" class="w-3 h-3"></i> グループ作成
            </button>
          </div>
          <nav id="chat-channels-list" class="p-2 space-y-1">
            <!-- 動的チャンネルリスト -->
          </nav>
        </div>

        <!-- サイドバーフッター -->
        <div class="p-3 border-t border-divider text-[11px] text-muted bg-surface-strong">
          <div class="flex items-center justify-between">
            <span>接続状態:</span>
            <span class="text-success font-bold flex items-center gap-1" id="chat-socket-status">
              <span class="w-2 h-2 rounded-full bg-success animate-ping"></span> オンライン
            </span>
          </div>
        </div>
      </div>

      <!-- 2. チャットメインエリア -->
      <div class="chat-main-area">
        <!-- チャンネルヘッダー -->
        <div class="p-3 border-b border-divider bg-surface-strong flex items-center justify-between">
          <div class="flex items-center gap-2">
            <i id="chat-active-icon" data-lucide="globe" class="w-4 h-4 text-accent"></i>
            <h3 id="chat-active-title" class="font-bold text-sm text-main">全体職員連絡</h3>
            <span id="chat-active-desc" class="text-xs text-muted hidden md:inline">| 全教職員宛ての連絡・協議チャット</span>
          </div>
          <div class="flex items-center gap-2" id="chat-header-actions">
            <button id="chat-btn-members" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-main border-main bg-surface hover-surface-strong">
              <i data-lucide="users" class="w-3.5 h-3.5 text-accent"></i> メンバー (<span id="chat-member-count">0</span>名)
            </button>
            <button id="chat-btn-renotify-all" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-warning border-warning-soft">
              <i data-lucide="bell-ring" class="w-3.5 h-3.5"></i> 未読者へ再通知
            </button>
          </div>
        </div>

        <!-- メッセージタイムライン表示領域 -->
        <div id="chat-messages-container" class="flex-1 overflow-y-auto p-4 space-y-4 bg-inset">
          <div class="text-center py-10 text-xs text-muted">メッセージを読み込み中...</div>
        </div>

        <!-- 入力フォームエリア -->
        <div class="p-3 border-t border-divider bg-overlay space-y-2">
          <!-- 簡易オプション -->
          <div class="flex items-center justify-between text-xs">
            <label class="flex items-center gap-1.5 cursor-pointer text-muted hover-text-main">
              <input type="checkbox" id="chat-attach-approval" class="rounded border-main bg-surface text-accent focus-ring-accent">
              <span class="text-[11px]">承認リクエストボタンを付与</span>
            </label>
            <span class="text-[10px] text-muted">Enterで送信 / Shift + Enterで改行</span>
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
    <div id="chat-group-modal" class="modal-overlay hidden">
      <div class="modal-card">
        <div class="modal-header">
          <h3 class="modal-title"><i data-lucide="users" class="w-5 h-5 text-accent"></i> 新規チャットグループ作成</h3>
          <button type="button" class="modal-close modal-close-x" aria-label="閉じる" title="閉じる"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <form id="chat-group-form" class="modal-form">
          <div class="modal-body">
            <div>
              <label class="block text-xs font-semibold text-soft mb-1">グループ名 <span class="text-danger">*</span></label>
              <input type="text" id="new-group-name" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main" placeholder="例: 修学旅行実行委員会" required>
            </div>
            <div class="mt-3">
              <label class="block text-xs font-semibold text-soft mb-1">参加メンバーの選択 (複数選択可能)</label>
              <div id="new-group-members-list" class="bg-surface border border-main rounded-lg p-3 max-h-48 overflow-y-auto space-y-2 text-xs">
                <div class="text-muted text-center py-2">メンバー一覧を読み込み中...</div>
              </div>
            </div>
          </div>
          <div class="modal-footer">
            <button type="button" class="modal-close btn-secondary px-4 py-2 text-xs rounded bg-surface text-soft hover-surface-strong">閉じる</button>
            <button type="submit" class="btn-primary px-4 py-2 text-xs rounded bg-accent text-main font-bold hover-primary">グループを作成</button>
          </div>
        </form>
      </div>
    </div>

    <!-- メンバー一覧モーダル -->
    <div id="chat-members-modal" class="modal-overlay hidden">
      <div class="modal-card">
        <div class="modal-header">
          <h3 class="modal-title"><i data-lucide="users" class="w-5 h-5 text-success"></i> チャンネル参加メンバー</h3>
          <button type="button" class="modal-close modal-close-x" aria-label="閉じる" title="閉じる"><i data-lucide="x" class="w-5 h-5"></i></button>
        </div>
        <div class="modal-body">
          <div id="chat-members-container" class="space-y-2 text-xs divide-y divide-divider">
            <div class="text-muted text-center py-4">メンバー情報を読み込み中...</div>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="modal-close btn-primary px-4 py-2 text-xs rounded bg-accent text-main font-bold hover-primary">閉じる</button>
        </div>
      </div>
    </div>
  `;

  loadHiddenChannels();
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
          senderAvatar: rawMsg.sender_avatar || rawMsg.senderAvatar || rawMsg.avatar_url || null,
          text: text,
          hasApprovalCard: rawMsg.has_approval_card || rawMsg.hasApprovalCard || false,
          approved: rawMsg.is_approved || rawMsg.approved || false,
          createdAt: rawMsg.created_at || rawMsg.createdAt || new Date().toISOString(),
          unreaders: rawMsg.unreaders || [],
          unreadIds: rawMsg.unreadIds || rawMsg.unread_ids || null
        };

        const list = messagesCache[channelId];
        const exactExists = msgId && list.some(m => String(m.id || m._id) === String(msgId));
        if (exactExists) {
          return;
        }

        // 閲覧中かどうか（チャットタブ且在職チャンネル）
        const isViewing = String(channelId).trim() === String(currentChannelId).trim() && state.currentTab === 'chat';

        // テンポラリ（楽観的更新）メッセージが存在する場合は置き換え、重複表示を防止
        const tempIndex = list.findIndex(m => 
          String(m.id).startsWith('msg-') && 
          String(m.text).trim() === String(text).trim() &&
          String(m.senderId) === String(senderId)
        );

        if (tempIndex !== -1) {
          const tempId = list[tempIndex].id;
          list[tempIndex] = msgObj;
          // 該当行のみ差し替え（リスト全体の描き直しない）
          if (isViewing) replaceMessageRow(tempId, msgObj);
        } else {
          list.push(msgObj);
          // 新着行のみ追記（リスト全体の描き直しない）
          if (isViewing) appendMessageRow(msgObj);
        }

        if (isViewing) {
          // 画面に表示済みの新着は既読位置に含む（未読残留を防ぐ）
          const newest = list[list.length - 1];
          if (newest && !String(newest.id).startsWith('msg-')) {
            markChannelRead(channelId, newest.id);
          }
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

    // グループ作成のリアルタイム反映（グループ列表への即時追加）
    const handleChannelCreated = (data) => {
      const ch = data.channel || data;
      const newId = ch.id || ch.channelId;
      if (!newId) return;

      if (!chatChannels.some((c) => c.id === newId)) {
        chatChannels.push({
          id: newId,
          name: ch.name || ch.channelName || '新規グループ',
          icon: ch.type === 'PUBLIC' ? 'globe' : 'users',
          unread: 0,
          type: ch.type || 'GROUP',
        });
        renderChannels();
        showToast(`新しいグループ「${ch.name || newId}」が作成されました`, 'info');
      }
    };

    socketClient.socket.off('chat:channel_created');
    socketClient.socket.on('chat:channel_created', handleChannelCreated);
    socketClient.socket.off('channel_created');
    socketClient.socket.on('channel_created', handleChannelCreated);

    // サーバーからのチャンネルリスト同期（他ユーザーによるグループ作成の反映）
    socketClient.socket.off('channels:synced');
    socketClient.socket.on('channels:synced', (data) => {
      const list = data.channels || [];
      if (!Array.isArray(list) || list.length === 0) return;

      list.forEach((serverCh) => {
        const existing = chatChannels.find((c) => c.id === serverCh.id);
        if (existing) {
          existing.name = serverCh.name;
          existing.icon = serverCh.type === 'PUBLIC' ? 'globe' : 'users';
          existing.type = serverCh.type || existing.type;
        } else {
          chatChannels.push({
            id: serverCh.id,
            name: serverCh.name,
            icon: serverCh.type === 'PUBLIC' ? 'globe' : 'users',
            unread: serverCh.unread || 0,
            type: serverCh.type || 'GROUP',
          });
        }
      });

      renderChannels();
      updateTotalUnread();
    });

    // 未読件数のリアルタイム更新（コメント取り消し・既読更新時）
    socketClient.socket.off('chat:unread_count_updated');
    socketClient.socket.on('chat:unread_count_updated', (data) => {
      const ch = chatChannels.find((c) => c.id === data.channelId);
      if (ch) {
        ch.unread = data.unreadCount || 0;
        updateTotalUnread();
        renderChannels();
      }
    });

    // 既読回执（メンバーの既読完了表示：userId で判定し、badge だけ差分更新する）
    socketClient.socket.off('chat:read_receipt');
    socketClient.socket.on('chat:read_receipt', (data) => {
      const list = messagesCache[data.channelId];
      if (!Array.isArray(list)) return;

      const readerId = data.userId || data.readerName;
      if (!readerId) return;

      const readerName = data.userName || data.readerName;
      const idx = data.lastReadMessageId
        ? list.findIndex((m) => String(m.id) === String(data.lastReadMessageId))
        : -1;

      // 既読位置が特定できない場合はチャンネル内全メッセージを対象にする
      const uptoIdx = idx === -1 ? list.length - 1 : idx;
      const changed = [];
      for (let i = 0; i <= uptoIdx; i++) {
        if (removeReaderFrom(list[i], readerId, readerName)) changed.push(list[i]);
      }

      if (changed.length === 0) return;

      if (String(data.channelId) === String(currentChannelId)) {
        // 該当行の既読badgeのみ更新（チャットエリアの再読み込みは行わない）
        changed.forEach((m) => patchReadFooter(m));
      }
    });

    // コメント取り消しのリアルタイム反映（グループ削除機能は廃止済み）
    socketClient.socket.off('chat:message_deleted');
    socketClient.socket.on('chat:message_deleted', (data) => {
      const channelId = data.channelId;
      const list = messagesCache[channelId];
      if (Array.isArray(list)) {
        messagesCache[channelId] = list.filter((m) => String(m.id) !== String(data.messageId));
        if (String(channelId) === String(currentChannelId)) {
          // 削除行のみ除去する（全体再描画しない）
          removeMessageRow(data.messageId);
        }
      }
    });

    // オンライン/オフライン状態のリアルタイム更新
    socketClient.socket.off('user:presence');
    socketClient.socket.on('user:presence', (data) => {
      const indicator = document.getElementById(`presence-dot-${data.userId}`);
      const textEl = document.getElementById(`presence-text-${data.userId}`);
      if (indicator && textEl) {
        if (data.isOnline) {
          indicator.className = 'w-2.5 h-2.5 rounded-full bg-success animate-pulse';
          textEl.textContent = 'オンライン';
          textEl.className = 'text-[10px] text-success font-medium';
        } else {
          indicator.className = 'w-2.5 h-2.5 rounded-full bg-muted';
          textEl.textContent = 'オフライン';
          textEl.className = 'text-[10px] text-muted font-medium';
        }
      }
    });
  }
}

/**
 * チャンネルリスト描画
 */
function channelRowHtml(ch, { hidden }) {
  const isActive = ch.id === currentChannelId;
  return `
    <div class="flex items-center gap-1">
      <button data-channel-id="${ch.id}" class="flex-1 min-w-0 text-left nav-item ${isActive ? 'active' : ''} ${hidden ? 'opacity-60' : ''}">
        <span class="flex items-center gap-2 truncate">
          <i data-lucide="${ch.icon || 'users'}"></i>
          <span class="truncate">${escapeHTML(ch.name)}</span>
        </span>
        ${ch.unread > 0 ? `<span class="badge-count">${ch.unread}</span>` : ''}
      </button>
      ${hidden
        ? `<button class="chat-unhide-btn text-success hover-text-success-strong p-1.5 rounded hover-surface" data-unhide-id="${ch.id}" title="このグループをリストに再表示する"><i data-lucide="eye" class="w-3.5 h-3.5"></i></button>`
        : (ch.type !== 'PUBLIC'
          ? `<button class="chat-hide-btn text-muted hover-text-warning-strong p-1.5 rounded hover-surface" data-hide-id="${ch.id}" title="グループを非表示にする（削除はされません）"><i data-lucide="eye-off" class="w-3.5 h-3.5"></i></button>`
          : '')}
    </div>
  `;
}

/**
 * チャンネル切り替え
 * @param {string} channelId
 */
function selectChannel(channelId) {
  if (!channelId || String(channelId) === String(currentChannelId)) return;
  currentChannelId = channelId;

  const target = chatChannels.find(c => c.id === channelId);
  if (target) target.unread = 0;

  updateTotalUnread();
  renderChannels();
  loadMessages(currentChannelId);
  loadChannelMembers(currentChannelId);
}

/**
 * 非表示ではない最初のチャンネルID
 */
function visibleFallbackId() {
  const first = chatChannels.find(c => !hiddenChannels.has(c.id));
  return first ? first.id : 'general';
}

/**
 * グループを非表示にする（削除はしない）
 * @param {string} channelId
 */
async function hideChannel(channelId) {
  const ch = chatChannels.find(c => c.id === channelId);
  const name = ch ? ch.name : channelId;

  try {
    await apiPut(`/chat/channels/${channelId}/hide`, { isHidden: true });
  } catch (e) {
    console.warn('[Chat] 非表示設定のサーバー保存に失敗:', e.message);
  }

  if (ch) hiddenChannels.set(channelId, ch);

  if (String(currentChannelId) === String(channelId)) {
    currentChannelId = visibleFallbackId();
    loadMessages(currentChannelId);
    loadChannelMembers(currentChannelId);
  }

  saveHiddenChannels();
  updateTotalUnread();
  renderChannels();
  showToast(`グループ「${name}」を非表示にしました（データは残っています）`, 'info');
}

/**
 * 非表示グループを再表示する
 * @param {string} channelId
 */
async function unhideChannel(channelId) {
  const ch = hiddenChannels.get(channelId);
  const name = ch ? ch.name : channelId;

  try {
    await apiPut(`/chat/channels/${channelId}/hide`, { isHidden: false });
  } catch (e) {
    console.warn('[Chat] 表示設定のサーバー保存に失敗:', e.message);
  }

  if (ch && !chatChannels.some((c) => c.id === ch.id)) {
    chatChannels.push(ch);
  }
  hiddenChannels.delete(channelId);

  saveHiddenChannels();
  updateTotalUnread();
  renderChannels();
  showToast(`グループ「${name}」をリストに再表示しました`, 'success');
}

/**
 * チャンネルリスト描画
 */
function renderChannels() {
  const container = document.getElementById('chat-channels-list');
  if (!container) return;

  const visible = chatChannels.filter((c) => !hiddenChannels.has(c.id));
  const hiddenList = Array.from(hiddenChannels.values());

  let html = visible.map((ch) => channelRowHtml(ch, { hidden: false })).join('');

  if (hiddenList.length > 0) {
    html += `
      <div class="mt-2 pt-2 border-t border-divider">
        <button id="chat-toggle-hidden" class="w-full flex items-center justify-between px-2 py-1.5 text-[10px] text-muted hover-text-main rounded">
          <span class="flex items-center gap-1.5"><i data-lucide="eye-off" class="w-3.5 h-3.5"></i> 非表示グループ</span>
          <span class="flex items-center gap-1">
            <span class="badge-count">${hiddenList.length}</span>
            <i data-lucide="${showHiddenSection ? 'chevron-up' : 'chevron-down'}" class="w-3.5 h-3.5"></i>
          </span>
        </button>
        ${showHiddenSection ? hiddenList.map((ch) => channelRowHtml(ch, { hidden: true })).join('') : ''}
      </div>
    `;
  }

  container.innerHTML = html;

  container.querySelectorAll('[data-channel-id]').forEach(btn => {
    btn.addEventListener('click', () => selectChannel(btn.getAttribute('data-channel-id')));
  });

  container.querySelectorAll('.chat-hide-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      hideChannel(btn.getAttribute('data-hide-id'));
    });
  });

  container.querySelectorAll('.chat-unhide-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      unhideChannel(btn.getAttribute('data-unhide-id'));
    });
  });

  const toggleBtn = document.getElementById('chat-toggle-hidden');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      showHiddenSection = !showHiddenSection;
      renderChannels();
    });
  }

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

  // カスタムグループの「非表示 / 再表示」トグル（グループ削除機能は廃止済み）
  const isHidden = hiddenChannels.has(channelId);

  const headerActionsEl = document.getElementById('chat-header-actions');
  if (headerActionsEl) {
    headerActionsEl.innerHTML = `
      <button id="chat-btn-members" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-main border-main bg-surface hover-surface-strong">
        <i data-lucide="users" class="w-3.5 h-3.5 text-accent"></i> メンバー (<span id="chat-member-count">0</span>名)
      </button>
      ${channelInfo && channelInfo.type !== 'PUBLIC' ? `
        <button id="chat-btn-toggle-visibility" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-warning-strong border-warning-soft hover-warning-soft">
          <i data-lucide="${isHidden ? 'eye' : 'eye-off'}" class="w-3.5 h-3.5"></i> ${isHidden ? 'リストに再表示' : 'リストから非表示'}
        </button>
      ` : ''}
      <button id="chat-btn-mark-read" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-success border-success-soft">
        <i data-lucide="check-check" class="w-3.5 h-3.5"></i> 既読にする
      </button>
      <button id="chat-btn-renotify-all" class="btn-secondary py-1 px-2.5 text-[11px] flex items-center gap-1 text-warning border-warning-soft">
        <i data-lucide="bell-ring" class="w-3.5 h-3.5"></i> 未読者へ再通知
      </button>
    `;

    document.getElementById('chat-btn-members')?.addEventListener('click', () => {
      openModal('chat-members-modal');
      loadChannelMembers(currentChannelId);
    });
    document.getElementById('chat-btn-renotify-all')?.addEventListener('click', handleRenotifyAll);
    document.getElementById('chat-btn-mark-read')?.addEventListener('click', () => {
      const msgs = messagesCache[channelId] || [];
      // 既読位置は最新メッセージまで（先頭では既読が-progress しない）
      const newestId = msgs.length > 0 ? msgs[msgs.length - 1].id : null;
      markChannelRead(channelId, newestId);
    });
    document.getElementById('chat-btn-toggle-visibility')?.addEventListener('click', () => {
      if (isHidden) {
        unhideChannel(channelId);
      } else {
        hideChannel(channelId);
      }
    });
  }

  try {
    const res = await apiGet(`/chat/channels/${channelId}/messages`);
    const rawList = res.messages || (Array.isArray(res) ? res : []);
    
    messagesCache[channelId] = rawList.map(m => ({
      id: m.id,
      senderId: m.sender_id || m.senderId,
      senderName: m.sender_name || m.senderName || '教員',
      senderAvatar: m.sender_avatar || m.senderAvatar || m.avatar_url || null,
      text: m.message_text || m.text || m.content || '',
      hasApprovalCard: m.has_approval_card || m.hasApprovalCard || false,
      approved: m.is_approved || m.approved || false,
      createdAt: m.created_at || m.createdAt,
      unreaders: m.unreaders || [],
      unreadIds: m.unreadIds || m.unread_ids || null
    }));

    // 表示した範囲（最新メッセージまで）を既読としてサーバーの閲覧ログに記録する
    const cached = messagesCache[channelId];
    const lastReadId = cached.length > 0 ? cached[cached.length - 1].id : null;
    if (lastReadId && !hiddenChannels.has(channelId)) {
      markChannelRead(channelId, lastReadId);
    }

  } catch (e) {
    if (!messagesCache[channelId]) {
      messagesCache[channelId] = getDummyMessages(channelId);
    }
  }

  renderMessagesList();
  loadChannelMembers(channelId);
}

/**
 * コメント（メッセージ）取り消し処理 ※送信者本人のみ削除可能
 * @param {string} messageId
 */
async function handleCancelMessage(messageId) {
  if (!confirm('【コメント取り消し】\n送信したコメントを削除しますか？\n（この操作は元に戻せません）')) return;

  try {
    const res = await apiDelete(`/chat/messages/${messageId}`);
    const list = messagesCache[currentChannelId] || [];
    messagesCache[currentChannelId] = list.filter((m) => String(m.id) !== String(messageId));
    renderMessagesList();
    showToast(res.message || 'コメントを取り消しました', 'success');
  } catch (e) {
    showToast('コメントの取り消しに失敗しました: ' + e.message, 'error');
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

    // 既読者名簿の再計算用ユーザー名簿を構築する
    memberById.clear();
    members.forEach((m) => {
      const uid = String(m.user_id || m.id || '');
      if (uid) {
        memberById.set(uid, {
          name: m.user_name || m.name || '教員',
          avatar_url: m.avatar_url || m.avatarUrl || null
        });
      }
    });

    if (countEl) countEl.textContent = members.length;

    if (members.length === 0) {
      container.innerHTML = `<div class="text-center py-4 text-muted">メンバーがいません。</div>`;
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
            <div class="w-8 h-8 rounded-full bg-accent-soft border border-accent flex items-center justify-center text-accent-strong font-bold overflow-hidden text-xs">
              ${m.avatar_url ? `<img src="${m.avatar_url}" class="w-full h-full object-cover">` : `<i data-lucide="user" class="w-4 h-4"></i>`}
            </div>
            <div>
              <div class="font-bold text-main">${escapeHTML(name)}</div>
              <div class="text-[10px] text-muted">${escapeHTML(dept)}</div>
            </div>
          </div>
          <div class="flex items-center gap-1.5">
            <span id="presence-dot-${userId}" class="w-2.5 h-2.5 rounded-full ${isOnline ? 'bg-success animate-pulse' : 'bg-muted'}"></span>
            <span id="presence-text-${userId}" class="text-[10px] ${isOnline ? 'text-success font-medium' : 'text-muted font-medium'}">
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
          <div class="w-8 h-8 rounded-full bg-accent-soft border border-accent flex items-center justify-center text-accent-strong font-bold text-xs">
            <i data-lucide="user" class="w-4 h-4"></i>
          </div>
          <div>
            <div class="font-bold text-main">あなた</div>
            <div class="text-[10px] text-muted">教職員</div>
          </div>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="w-2.5 h-2.5 rounded-full bg-success animate-pulse"></span>
          <span class="text-[10px] text-success font-medium">オンライン</span>
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
    membersListContainer.innerHTML = `<div class="text-muted text-center py-2">メンバー一覧を読み込み中...</div>`;
  }

  openModal('chat-group-modal');

  try {
    const res = await apiGet('/users');
    const users = res.users || res.data || (Array.isArray(res) ? res : []);

    if (membersListContainer) {
      if (users.length === 0) {
        membersListContainer.innerHTML = `<div class="text-muted text-center py-2">ユーザーがいません</div>`;
        return;
      }

      const currentUserId = state.currentUser ? state.currentUser.id : '';

      membersListContainer.innerHTML = users.map(u => `
        <label class="flex items-center justify-between p-1.5 hover-surface rounded cursor-pointer">
          <div class="flex items-center gap-2">
            <input type="checkbox" name="group-member" value="${u.id}" class="rounded border-main bg-surface text-accent focus-ring-accent" ${u.id === currentUserId ? 'checked' : ''}>
            ${userAvatarHtml({ name: u.name, avatarUrl: u.avatar_url, size: 'xs' })}
            <span class="text-main">${escapeHTML(u.name)}</span>
          </div>
          <span class="text-[10px] text-muted">${escapeHTML(u.department || u.role || '')}</span>
        </label>
      `).join('');
    }
  } catch (e) {
    if (membersListContainer) {
      membersListContainer.innerHTML = `<div class="text-danger text-center py-2">ユーザー一覧の取得に失敗しました</div>`;
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
  const prevTop = container.scrollTop;
  const stickToBottom = isNearBottom(container);

  if (msgs.length === 0) {
    container.innerHTML = `<div data-empty-chat="1" class="text-center py-12 text-xs text-muted">このチャンネルにはまだメッセージがありません。</div>`;
    refreshLucideIcons();
    return;
  }

  container.innerHTML = msgs.map(messageRowHtml).join('');

  bindMessageAreaEvents(container);

  refreshLucideIcons();

  // スクロールアンカー: 最下部を閲覧中の時だけ自動スクロールし、他メンバーの追記で位置が飛ばない
  if (stickToBottom) {
    container.scrollTop = container.scrollHeight;
  } else {
    container.scrollTop = prevTop;
  }
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
    senderAvatar: state.currentUser ? (state.currentUser.avatar_url || null) : null,
    text,
    hasApprovalCard,
    approved: false,
    createdAt: new Date().toISOString(),
    unreaders: [],
    unreadIds: []
  };

  // 楽観的UI更新：送信メッセージを即座にキャッシュへ追加し、該当行だけ追記する（全体再描画しない）
  if (!messagesCache[currentChannelId]) messagesCache[currentChannelId] = [];
  messagesCache[currentChannelId].push(newMsg);
  appendMessageRow(newMsg);

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
          senderAvatar: serverMsg.sender_avatar || serverMsg.senderAvatar || newMsg.senderAvatar || null,
          text: serverMsg.message || serverMsg.message_text || serverMsg.text || text,
          hasApprovalCard: serverMsg.has_approval_card || serverMsg.hasApprovalCard || hasApprovalCard,
          approved: serverMsg.is_approved || serverMsg.approved || false,
          createdAt: serverMsg.created_at || serverMsg.createdAt || newMsg.createdAt,
          unreaders: serverMsg.unreaders || [],
          unreadIds: serverMsg.unreadIds || serverMsg.unread_ids || null
        };
        // 楽観行を実データへ差し替える（该行のみ更新）
        replaceMessageRow(tempId, list[idx]);
      }
    }

    const successMsg = (res && res.message) ? res.message : 'メッセージを送信しました';
    showToast(successMsg, 'success');
  } catch (e) {
    showToast('メッセージの送信に失敗しました: ' + (e.message || ''), 'error');
    const list = messagesCache[currentChannelId];
    if (list) {
      messagesCache[currentChannelId] = list.filter(m => m.id !== tempId);
      // 失敗した楽観行のみ除去する
      removeMessageRow(tempId);
    }
  }
}

function showUnreadersModal(msgId) {
  const msgs = messagesCache[currentChannelId] || [];
  const msg = msgs.find(m => String(m.id) === String(msgId));
  if (!msg) return;

  const ids = Array.isArray(msg.unreadIds) ? msg.unreadIds.map((id) => String(id)) : [];
  const names = (msg.unreaders || []).filter((n) => n);
  const displayList = names.length > 0 ? names : ids.map((id) => memberById.get(id)?.name || id);

  if (displayList.length === 0) {
    showToast('このメッセージは全員既読です', 'success');
    return;
  }

  const listStr = displayList.join(', ');
  const confirmRenotify = confirm(`【未読者リスト】\n${listStr}\n\n対象教員にリアルタイム再通知を送信しますか？`);

  if (confirmRenotify) {
    // 対象はユーザーID名簿で特定する（表示名と実体の不一致を防ぐ）
    const targetUserIds = ids.length > 0 ? ids : displayList;
    apiPost('/chat/renotify', { messageId: msgId, targetUsers: targetUserIds })
      .then(() => showToast(`${displayList.length}名の未読教員へ再通知を送信しました`, 'success'))
      .catch(() => showToast(`未読教員へ再通知を送信しました`, 'info'));
  }
}

async function handleRenotifyAll() {
  const list = messagesCache[currentChannelId] || [];
  const ids = new Set();
  list.forEach((m) => {
    (m.unreadIds || []).forEach((id) => ids.add(String(id)));
  });

  if (ids.size === 0) {
    showToast('未読者はいません（全員既読です）', 'success');
    return;
  }

  try {
    await apiPost('/chat/renotify', { channelId: currentChannelId, targetUsers: Array.from(ids) });
    showToast(`${ids.size}名の未読教員へ再通知を送信しました`, 'success');
  } catch (e) {
    showToast(`${ids.size}名の未読教員へ再通知を送信しました`, 'info');
  }
}

/**
 * メッセージ表示領域が最下部（新着が見えている状態）かどうか
 * @param {HTMLElement} el
 * @param {number} [threshold]
 */
function isNearBottom(el, threshold = 160) {
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}

/**
 * メッセージクリックを一元委譲する（描画ごとの再バインド・全体再描画を避ける）
 * @param {HTMLElement} container
 */
function bindMessageAreaEvents(container) {
  if (!container || container.dataset.msgDelegated === '1') return;
  container.dataset.msgDelegated = '1';

  container.addEventListener('click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-msg-id]') : null;
    if (!btn) return;
    const msgId = btn.getAttribute('data-msg-id');

    if (btn.classList.contains('btn-approval-action')) {
      const statusEl = document.getElementById(`approval-status-${msgId}`);
      if (statusEl) {
        statusEl.textContent = '✓ 承認完了';
        statusEl.className = 'text-[10px] text-success-strong font-bold';
        btn.classList.add('hidden');
        showToast('承認処理を行いました', 'success');
      }
      apiPut(`/chat/messages/${msgId}/approve`, { approved: true }).catch(() => {});
      const msg = (messagesCache[currentChannelId] || []).find((m) => String(m.id) === String(msgId));
      if (msg) msg.approved = true;
    } else if (btn.classList.contains('chat-cancel-btn')) {
      handleCancelMessage(msgId);
    } else if (btn.classList.contains('btn-show-unreaders')) {
      showUnreadersModal(msgId);
    }
  });
}

/**
 * 自分自身の発言かどうか（id / staff_code の両方で判定）
 * @param {Object} m
 */
function isMyMessage(m) {
  const myId = currentUserId();
  const myStaff = state.currentUser ? state.currentUser.staff_code : null;
  return String(m.senderId) === String(myId) || String(m.senderId) === String(myStaff);
}

/**
 * 既読badge部分のHTML（未読名 / 全員既読 / 取り消しボタン）
 * @param {Object} m
 */
function readFooterInner(m) {
  const unreadCount = (m.unreaders || []).length;
  const isMe = isMyMessage(m);

  const unreadPart = unreadCount > 0
    ? `<button class="btn-show-unreaders hover:underline text-warning flex items-center gap-1" data-msg-id="${m.id}">
        <i data-lucide="eye-off" class="w-3 h-3"></i> 未読: ${unreadCount}名
      </button>`
    : `<span class="text-success flex items-center gap-1"><i data-lucide="check-check" class="w-3 h-3"></i> 全員既読</span>`;

  const cancelPart = isMe
    ? `<button class="chat-cancel-btn text-danger hover-text-danger-strong flex items-center gap-1" data-msg-id="${m.id}" title="このコメントを取り消す（自分の発言のみ取り消し可能）">
        <i data-lucide="undo-2" class="w-3 h-3"></i> 取り消す
      </button>`
    : '';

  return `${unreadPart}${cancelPart}`;
}

/**
 * 該当メッセージのDOM行を取得（data-msg-id で特定）
 * @param {string} msgId
 */
function findMessageRow(msgId) {
  const container = document.getElementById('chat-messages-container');
  if (!container || msgId === undefined || msgId === null) return null;
  const safe = String(msgId).replace(/"/g, '');
  return container.querySelector(`[data-msg-id="${safe}"]`);
}

/**
 * メッセージ行HTML（アバター + 発言者 + 本文 + 既読badge + 取り消しボタン）
 * @param {Object} m
 */
function messageRowHtml(m) {
  const isMe = isMyMessage(m);
  const senderAvatarUrl = m.senderAvatar || m.sender_avatar || m.avatar_url || null;

  return `
    <div class="flex flex-col ${isMe ? 'items-end' : 'items-start'} space-y-1" data-msg-id="${m.id}">
      <div class="flex items-center gap-2 text-[11px] text-muted">
        ${isMe ? '' : userAvatarHtml({ name: m.senderName || m.senderId, avatarUrl: senderAvatarUrl, size: 'xs' })}
        <span class="font-bold text-soft">${escapeHTML(m.senderName || m.senderId)}</span>
        <span class="font-mono text-[10px]">${formatDate(m.createdAt)}</span>
        ${isMe ? userAvatarHtml({ name: state.currentUser?.name || '自分', avatarUrl: state.currentUser?.avatar_url || null, size: 'xs' }) : ''}
      </div>

      <div class="max-w-[85%] md:max-w-[70%] rounded-2xl p-3 text-xs leading-relaxed ${
        isMe
          ? 'bg-accent text-main rounded-tr-none shadow-md'
          : 'bg-surface text-main border border-main rounded-tl-none'
      }">
        <p class="whitespace-pre-wrap">${escapeHTML(m.text)}</p>

        ${m.hasApprovalCard ? `
          <div class="mt-3 pt-2.5 border-t border-divider flex flex-col gap-2">
            <span class="text-[10px] font-bold text-accent-strong flex items-center gap-1">
              <i data-lucide="check-square" class="w-3.5 h-3.5"></i> 承認・確認リクエスト
            </span>
            <div class="flex items-center gap-2">
              <button class="btn-approval-action py-1 px-3 bg-success hover-success-strong text-main font-bold rounded text-[11px] transition-colors" data-msg-id="${m.id}" data-action="approve">
                確認・承認する
              </button>
              <span class="text-[10px] opacity-80" id="approval-status-${m.id}">${m.approved ? '✓ 承認済み' : '未承認'}</span>
            </div>
          </div>
        ` : ''}
      </div>

      <div class="flex items-center gap-2 text-[10px] text-muted" data-read-footer>
        ${readFooterInner(m)}
      </div>
    </div>
  `;
}

/**
 * 新着メッセージ行を追記する（リスト全体を描き直さない差分更新）
 * @param {Object} m
 */
function appendMessageRow(m) {
  const container = document.getElementById('chat-messages-container');
  if (!container) return;
  const stickToBottom = isNearBottom(container);

  if (container.querySelector('[data-empty-chat]')) container.innerHTML = '';

  const temp = document.createElement('div');
  temp.innerHTML = messageRowHtml(m);
  const row = temp.firstElementChild;
  if (!row) return;

  container.appendChild(row);
  refreshLucideIcons();

  if (stickToBottom) container.scrollTop = container.scrollHeight;
}

/**
 * 楽観更新（テンポラリID）を実メッセージへ差し替える
 * @param {string} oldId
 * @param {Object} m
 */
function replaceMessageRow(oldId, m) {
  const row = findMessageRow(oldId);
  const container = document.getElementById('chat-messages-container');
  if (!row || !container) {
    appendMessageRow(m);
    return;
  }

  const temp = document.createElement('div');
  temp.innerHTML = messageRowHtml(m);
  const newRow = temp.firstElementChild;
  if (!newRow) return;

  const stickToBottom = isNearBottom(container);
  row.replaceWith(newRow);
  refreshLucideIcons();
  if (stickToBottom) container.scrollTop = container.scrollHeight;
}

/**
 * 削除されたメッセージ行を取り除く（再描画なし）
 * @param {string} msgId
 */
function removeMessageRow(msgId) {
  const row = findMessageRow(msgId);
  if (row) row.remove();
}

/**
 * 既読badgeのみを差分更新する
 * @param {Object} m
 */
function patchReadFooter(m) {
  const row = findMessageRow(m.id);
  if (!row) return;
  const footer = row.querySelector('[data-read-footer]');
  if (!footer) return;
  footer.innerHTML = readFooterInner(m);
  refreshLucideIcons();
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
