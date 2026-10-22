/**
 * ISSystem Simultaneous Editing Lock & Realtime Notification Socket Handlers
 * 画面別同時編集ロック状態・ハートビート更新・無操作3分自動解放・全クライアントリアルタイム同期
 */

import auditModel from '../models/audit.model.js';

/**
 * 編集ロック関連WebSocketイベントハンドラーのバインド
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export function registerLockSocketHandlers(io, socket) {
  const user = socket.user;

  /**
   * 画面編集ロックの取得・延長リクエスト (ハートビート)
   * event: 'lock:acquire'
   */
  socket.on('lock:acquire', async (data, callback) => {
    try {
      const { resourceType, resourceId } = data; // 例: ('seating', 'layout-123'), ('exam', 'matrix-2026')

      if (!resourceType || !resourceId) {
        if (callback) callback({ success: false, error: 'リソース情報が不正です。' });
        return;
      }

      // 現在のロック状態を確認
      const currentLock = await auditModel.getEditingLock(resourceType, resourceId);

      // 他のユーザーがアクティブなロックを保持しているか確認 (3分以内の操作)
      if (currentLock && currentLock.locked_by !== user.id) {
        const lockAge = Date.now() - new Date(currentLock.last_active_at).getTime();
        const isExpired = lockAge >= 3 * 60 * 1000;

        if (!isExpired) {
          if (callback) {
            callback({
              success: false,
              isLockedByOther: true,
              lockedBy: {
                id: currentLock.locked_by,
                name: currentLock.user_name || '別の教員',
              },
              lockedAt: currentLock.locked_at,
            });
          }
          return;
        }
      }

      // ロックの新規取得または更新（ハートビート）
      await auditModel.acquireEditingLock({
        resourceType,
        resourceId,
        userId: user.id,
      });

      // 他の閲覧中クライアントへ該当リソースがロックされたことを即時一斉通知
      socket.broadcast.emit('lock:status_changed', {
        resourceType,
        resourceId,
        isLocked: true,
        lockedBy: {
          id: user.id,
          name: user.name,
        },
        lockedAt: new Date().toISOString(),
      });

      if (callback) {
        callback({
          success: true,
          isLockedByOther: false,
          expiresInSeconds: 180,
        });
      }
    } catch (error) {
      console.error('[Socket.io Lock Acquire Error]:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * 編集作業終了・画面離脱時の編集ロック明示的解放
   * event: 'lock:release'
   */
  socket.on('lock:release', async (data, callback) => {
    try {
      const { resourceType, resourceId } = data;

      if (!resourceType || !resourceId) {
        if (callback) callback({ success: false, error: 'リソース情報が不正です。' });
        return;
      }

      // DB上の編集ロックを削除
      await auditModel.releaseEditingLock(resourceType, resourceId);

      // 全クライアントへロック解放イベントを通知
      io.emit('lock:status_changed', {
        resourceType,
        resourceId,
        isLocked: false,
        releasedBy: {
          id: user.id,
          name: user.name,
        },
      });

      if (callback) callback({ success: true });
    } catch (error) {
      console.error('[Socket.io Lock Release Error]:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * 無操作タイムアウト (3分経過) による自動ロック解放通知
   * event: 'lock:timeout_released'
   */
  socket.on('lock:timeout_released', async (data) => {
    try {
      const { resourceType, resourceId } = data;
      if (!resourceType || !resourceId) return;

      await auditModel.releaseEditingLock(resourceType, resourceId);

      // 該当画面を開いている全ユーザーへ自動解放を通知
      io.emit('lock:status_changed', {
        resourceType,
        resourceId,
        isLocked: false,
        isTimeout: true,
        message: '3分間無操作のため編集ロックが自動解放されました。',
      });
    } catch (error) {
      console.error('[Socket.io Lock Timeout Error]:', error);
    }
  });
}

export default registerLockSocketHandlers;