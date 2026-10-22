import { getSocket } from './socketClient.js';

export const socketEvents = {
  // ==========================================
  // 1. チャット機能 (Chat)
  // ==========================================

  /** チャットルーム（チャンネル）に参加 */
  joinChatChannel(channelId) {
    const socket = getSocket();
    if (socket) socket.emit('chat:join_channel', { channelId });
  },

  /** チャットルームから退出 */
  leaveChatChannel(channelId) {
    const socket = getSocket();
    if (socket) socket.emit('chat:leave_channel', { channelId });
  },

  /** リアルタイムメッセージの受信登録 */
  onNewChatMessage(callback) {
    const socket = getSocket();
    if (!socket) return;
    socket.on('chat:new_message', (message) => {
      console.log('[Socket Chat] 新着メッセージ受信:', message);
      callback(message);
    });
  },

  /** 未読カウント更新通知の受信 */
  onUnreadBadgeUpdate(callback) {
    const socket = getSocket();
    if (!socket) return;
    socket.on('chat:unread_update', (data) => {
      callback(data); // { channelId, unreadCount }
    });
  },

  // ==========================================
  // 2. 在席ステータス & 座席表機能 (Seating)
  // ==========================================

  /** 在席ステータス更新を自ら発行 (在席/離席/授業中/出張 等) */
  emitStatusChange(status, note = '') {
    const socket = getSocket();
    if (socket) socket.emit('seating:update_status', { status, note });
  },

  /** 他の教員の在席ステータス変更を受信 */
  onTeacherStatusChanged(callback) {
    const socket = getSocket();
    if (!socket) return;
    socket.on('seating:status_changed', (data) => {
      console.log('[Socket Seating] 在席ステータス変更受信:', data);
      callback(data); // { userId, userName, status, note, updatedAt }
    });
  },

  /** 生徒検索ハイライト通知の受信 */
  onStudentSearchHighlight(callback) {
    const socket = getSocket();
    if (!socket) return;
    socket.on('seating:student_highlight', (data) => {
      callback(data); // { studentCode, deskId }
    });
  },

  // ==========================================
  // 3. 排他編集ロック機能 (Locking)
  // ==========================================

  /** 編集ロックの要求 / ハートビート延長送信 */
  requestEditLock(resourceType, resourceId) {
    const socket = getSocket();
    if (socket) socket.emit('lock:acquire', { resourceType, resourceId });
  },

  /** 編集完了に伴うロック手動解放 */
  releaseEditLock(resourceType, resourceId) {
    const socket = getSocket();
    if (socket) socket.emit('lock:release', { resourceType, resourceId });
  },

  /** ロック状態の全社リアルタイム変更通知（Cron 3分無操作タイムアウト含む）を受信 */
  onLockStatusChanged(callback) {
    const socket = getSocket();
    if (!socket) return;

    socket.on('lock:status_changed', (data) => {
      console.log('[Socket Lock] ロック状態変更受信:', data);
      // data: { resourceType, resourceId, isLocked, lockedByUserId, lockedByUserName, isTimeout, message }
      callback(data);
    });
  },

  // ==========================================
  // クリーンアップ
  // ==========================================

  /** イベントリスナーを一括解除 */
  removeAllListeners() {
    const socket = getSocket();
    if (socket) {
      socket.off('chat:new_message');
      socket.off('chat:unread_update');
      socket.off('seating:status_changed');
      socket.off('seating:student_highlight');
      socket.off('lock:status_changed');
    }
  },
};