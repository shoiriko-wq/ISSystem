/**
 * ISSystem Frontend Real-Time WebSocket Client (Socket.io)
 */

import { WS_BASE_URL, APP_CONFIG } from './config.js';
import { state, setUserSession } from './state.js';
import { showToast, openModal } from './ui-helpers.js';
import { switchTab } from './main.js';
import { loadReservations } from './modules/facility.module.js';
import { loadSchedules } from './modules/schedule.module.js';
import { loadMessages } from './modules/chat.module.js';
import { loadSeatingData } from './modules/seating.module.js';
import { fetchWeatherData } from './modules/dashboard.module.js';
import { loadAbsenceSummary } from './modules/absence.module.js';
import { loadBulletins } from './modules/bulletin.module.js';
import { loadSubjects } from './modules/subjects.module.js';


let socket = null;
let hasDisconnected = false;

export const socketClient = {
  socket: null,

  /**
   * WebSocket サーバー接続の初期化 (JWTトークン付与)
   */
  init() {
    const storageKey = APP_CONFIG?.STORAGE_KEYS?.AUTH_TOKEN || 'is_system_jwt_token';
    const token = state.authToken || localStorage.getItem(storageKey) || localStorage.getItem('token');
    
    if (!token) {
      console.warn('[Socket] トークンがないため Socket 接続をスキップします。');
      return;
    }

    if (socket && socket.connected) return;

    if (typeof io === 'undefined') {
      console.warn('[Socket] Socket.io クライアントライブラリ(CDN)が読み込まれていません。');
      return;
    }

    const socketUrl = WS_BASE_URL || window.location.origin;
    
    socket = io(socketUrl, {
      auth: (cb) => {
        const currentToken = state.authToken || localStorage.getItem(storageKey) || localStorage.getItem('token');
        cb({ token: currentToken });
      },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
    });

    this.socket = socket;

    // 既存のリスナー重複登録を防ぐため、一度クリアする
    socket.removeAllListeners();

    socket.on('connect', () => {
      console.log('[Socket] リアルタイム通信レイヤーに接続成功:', socket.id);
      const banner = document.getElementById('connection-status-banner');
      if (banner) banner.classList.add('hidden');

      if (hasDisconnected) {
        showToast('サーバーに再接続しました', 'success');
        hasDisconnected = false;
      }
      if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
    });

    socket.on('connect_error', (err) => {
      console.error('[Socket] 接続エラー:', err.message);
      const banner = document.getElementById('connection-status-banner');
      if (banner) banner.classList.remove('hidden');
      if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
    });

    socket.on('disconnect', (reason) => {
      console.warn('[Socket] 切断されました:', reason);
      hasDisconnected = true;
      const banner = document.getElementById('connection-status-banner');
      if (banner) banner.classList.remove('hidden');
      if (typeof window.refreshLucideIcons === 'function') window.refreshLucideIcons();
    });

    // 0-a. 教科マスタ変更受信 (教務部の追加・改名・削除で教科マスタキャッシュを再取得)
    socket.on('subjects:changed', (payload) => {
      loadSubjects(true);
    });

    // 0-b. 教員の担当教科変更受信 (自分の担当教科が変わった場合はセッションへ反映)
    socket.on('subjects:user_changed', (payload) => {
      loadSubjects(true);
      const currentUserId = state.currentUser?.id;
      if (payload && currentUserId && String(payload.user_id) === String(currentUserId)) {
        state.currentUser.subjects = payload.subjects || [];
      }
    });

    // 1. リアルタイムチャットメッセージ受信 (他人からのメッセージ受信時にトースト通知表示)
    socket.on('chat:message', (payload) => {
      const msg = payload.message || payload;
      const senderId = msg.senderId || msg.sender_id;
      const sender = msg.senderName || msg.sender_name || '教員';
      const chId = payload.channelId || msg.channelId || msg.channel_id;
      const channelName = payload.channelName || msg.channelName || 'チャットグループ';
      const messageText = msg.text || msg.message || msg.message_text || '';

      const currentUserId = state.currentUser?.id || state.currentUser?._id || state.currentUser?.staff_code;
      const currentUserName = state.currentUser?.name;
      const isMyMessage = (currentUserId && senderId && String(currentUserId).trim() === String(senderId).trim()) ||
                          (currentUserName && sender && currentUserName.trim() === sender.trim()) ||
                          (sender === '自分');

      // 自分以外のメッセージ受信時に、グループ名と発信者名を含むトースト通知を表示し、クリックで当該グループのチャット画面へジャンプ
      if (!isMyMessage) {
        const snippet = messageText.length > 25 ? messageText.substring(0, 25) + '...' : messageText;
        showToast(`💬 [${channelName}] ${sender} さん: ${snippet}`, 'info', () => {
          switchTab('chat');
          if (chId && typeof window.selectChatChannel === 'function') {
            window.selectChatChannel(chId);
          }
        });
      }
    });

    // 1-b. 専用トースト通知イベント（チャット画面外・未joinチャンネルのメンバー宛て）
    socket.on('chat:toast', (payload) => {
      const chId = payload.channelId;
      const channelName = payload.channelName || 'チャットグループ';
      const sender = payload.senderName || '教員';
      const preview = payload.preview || '';

      const currentUserId = state.currentUser?.id || state.currentUser?._id || state.currentUser?.staff_code;
      if (currentUserId && payload.senderId && String(currentUserId).trim() === String(payload.senderId).trim()) {
        return; // 自分自身の送信分はトーストしない
      }

      const snippet = preview.length > 25 ? preview.substring(0, 25) + '...' : preview;
      showToast(`💬 [${channelName}] ${sender} さん: ${snippet}`, 'info', () => {
        switchTab('chat');
        if (chId && typeof window.selectChatChannel === 'function') {
          window.selectChatChannel(chId);
        }
      });
    });

    // 1-c. 参加チャンネルルームの自動同期通知
    socket.on('chat:channels_synced', (payload) => {
      const channels = payload.channels || [];
      if (state.currentUser) {
        state.currentUser.joinedChannels = channels.map((c) => c.id);
      }
    });



    // 2. 在席ステータス変更受信 (自分も含めて確認用トースト表示)
    socket.on('seating:status_changed', (data) => {
      const name = data.userName || data.name || '先生';
      showToast(`👤 ${name} が在席ステータスを更新しました`, 'info', () => {
        switchTab('seating');
      });
      if (state.currentTab === 'seating' && typeof loadSeatingData === 'function') {
        loadSeatingData();
      }
      if (window.seatingModule && typeof window.seatingModule.handleStatusChange === 'function') {
        window.seatingModule.handleStatusChange(data);
      }
    });

    // 3. 排他編集ロック状態の通知
    socket.on('lock:status_changed', (data) => {
      if (data.isTimeout) {
        showToast(`⚠️ ${data.message || '無操作のため編集ロックが自動解放されました。'}`, 'warning');
      }
    });

    // 4. ユーザープロフィール・情報更新の受信
    socket.on('user:updated', (updatedUser) => {
      const currentUserId = state.currentUser?.id || state.currentUser?._id;
      const name = updatedUser.name || '先生';

      if (currentUserId && (String(currentUserId) === String(updatedUser.id) || String(currentUserId) === String(updatedUser._id))) {
        setUserSession(updatedUser, state.authToken);
        showToast('✨ プロフィール情報を更新しました', 'success', () => {
          switchTab('dashboard');
        });
      } else {
        showToast(`👤 ${name} 先生がプロフィールを更新しました`, 'info', () => {
          switchTab('dashboard');
        });
      }
    });

    // 4.5. チャットグループ・チャンネル新規作成の通知
    socket.on('chat:channel_created', (data) => {
      const channel = data.channel || data;
      const creatorName = data.creator?.name || '教員';
      showToast(`💬 新しいチャットグループ「${channel.name}」が作成されました (${creatorName})`, 'success', () => {
        switchTab('chat');
        if (typeof window.selectChatChannel === 'function') {
          window.selectChatChannel(channel.id);
        }
      });
      if (state.currentTab === 'chat' && typeof window.selectChatChannel === 'function') {
        window.selectChatChannel(channel.id);
      }
    });

    // 5. カレンダー行事・スケジュールのリアルタイム変更通知 (自分も含めて確認用トースト表示)
    socket.on('schedule:changed', (data) => {
      const name = data.userName || '教員';
      const actionText = data.action === 'create' ? '追加' : data.action === 'update' ? '変更' : '削除';
      const title = data.schedule?.title || '行事';
      showToast(`📅 ${name} がカレンダーに「${title}」を${actionText}しました`, 'info', () => {
        switchTab('schedule');
      });
      if (state.currentTab === 'schedule' && typeof loadSchedules === 'function') {
        loadSchedules();
      }
    });

    // 6. 施設・備品予約のリアルタイム変更通知
    socket.on('facility:reservation_changed', (data) => {
      const currentUserId = state.currentUser?.id || state.currentUser?._id;
      const isSelf = currentUserId && data.userId && String(currentUserId) === String(data.userId);
      const name = data.userName || '教員';

      if (isSelf) {
        if (data.action === 'create') {
          showToast('施設予約を完了しました', 'success', () => { switchTab('facility'); });
        } else {
          showToast('予約をキャンセルしました', 'info', () => { switchTab('facility'); });
        }
      } else {
        const actionText = data.action === 'create' ? '施設を新規予約' : '施設予約をキャンセル';
        showToast(`🏢 ${name} が${actionText}しました`, 'info', () => {
          switchTab('facility');
        });
      }

      if (state.currentTab === 'facility' && typeof loadReservations === 'function') {
        loadReservations();
      }
    });

    // 7. 掲示板投稿・コメントのリアルタイム通知
    socket.on('bulletin:posted', (data) => {
      const currentUserId = state.currentUser?.id || state.currentUser?._id;
      const isSelf = currentUserId && data.userId && String(currentUserId) === String(data.userId);
      const name = data.userName || '教員';
      const title = data.bulletin?.title || 'お知らせ';

      if (isSelf) {
        showToast('掲示板に投稿しました', 'success', () => { switchTab('bulletin'); });
      } else {
        showToast(`📢 ${name} が掲示板に「${title}」を投稿しました`, 'info', () => {
          switchTab('bulletin');
        });
      }

      if (state.currentTab === 'bulletin' && typeof loadBulletins === 'function') {
        loadBulletins();
      }
    });

    socket.on('bulletin:commented', (data) => {
      const name = data.userName || '教員';
      showToast(`💬 ${name} が回覧・掲示板にコメントを追加しました`, 'info', () => {
        switchTab('bulletin');
      });
    });

    // 8. ユーザー追加・削除のリアルタイム通知
    socket.on('user:added', (payload) => {
      const operator = payload.operatorName || '管理者';
      const newUser = payload.user || payload;
      showToast(`👤 ${operator} が新しい教職員「${newUser.name || newUser.staff_code}」を登録しました`, 'success', () => {
        openModal('users-manage-modal');
      });
    });

    socket.on('user:deleted', (data) => {
      const operator = data.operatorName || '管理者';
      showToast(`👤 ${operator} が教職員アカウントを削除しました`, 'warning', () => {
        openModal('users-manage-modal');
      });
    });

    // 9. 天気情報の自動更新受信
    socket.on('weather:updated', (data) => {
      // ★ モーダルを強制的に開かない (cron 更新ごとにモーダルが開きちらつき・表示崩れの原因になっていた)
      showToast('🌤️ 天気情報を自動更新しました', 'info');

      if (state.currentTab === 'dashboard' && typeof fetchWeatherData === 'function') {
        fetchWeatherData();
      }
    });

    // 10. 年休等・出張登録の更新受信 (ダッシュボード人数の即時更新)
    socket.on('absence:updated', (data) => {
      const operator = data.operatorName || '教務';
      const label = data.record_type_label || (data.record_type === 'TRIP' ? '出張' : '年休等');
      const actionText = data.action === 'remove' ? '取消' : '登録';

      showToast(`🗓️ ${operator} が ${data.userName || data.user_id} 教員の${label}を${actionText}しました`, 'info');

      if (state.currentTab === 'dashboard' && typeof loadAbsenceSummary === 'function') {
        loadAbsenceSummary(data.date);
      }
    });

  },

  joinChannel(channelId) {
    if (socket && socket.connected) {
      socket.emit('chat:join_channel', { channelId });
    }
  },

  emitStatusChange(status, note = '') {
    if (socket && socket.connected) {
      socket.emit('seating:update_status', { status, note });
    }
  },

  disconnect() {
    if (socket) {
      socket.disconnect();
      socket = null;
      this.socket = null;
    }
  }
};

export default socketClient;
