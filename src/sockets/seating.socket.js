/**
 * ISSystem Staff Room Seating & Teacher Presence Socket Handlers
 * 教員在席ステータス (在席/離席/授業中/出張) 即時一斉同期 & 座席検索ハイライト配信
 */

import authService from '../services/auth.service.js';

/**
 * 座席表・在席ステータス関連WebSocketイベントハンドラーのバインド
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export function registerSeatingSocketHandlers(io, socket) {
  const user = socket.user;

  /**
   * 教員の在席ステータス即時変更 & 全クライアントブロードキャスト
   * event: 'seating:update_status'
   */
  socket.on('seating:update_status', async (data, callback) => {
    try {
      const { status } = data; // 'IN' | 'OUT' | 'CLASS' | 'BUSINESS_TRIP'

      if (!status) {
        if (callback) callback({ success: false, error: 'ステータス値は必須です。' });
        return;
      }

      // DB/サービス層で在席ステータスを更新
      const updatedUser = await authService.updateStatus(user.id, status);

      // 全接続クライアントへ在席ステータス変更イベントを一斉配信 (座席表・教員一覧の表示更新)
      io.emit('seating:status_changed', {
        userId: updatedUser.id,
        userName: updatedUser.name,
        status: updatedUser.status,
        updatedAt: new Date().toISOString(),
      });

      if (callback) {
        callback({
          success: true,
          status: updatedUser.status,
        });
      }
    } catch (error) {
      console.error('[Socket.io Seating Status Update Error]:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  /**
   * 座席表検索ハイライトイベントのブロードキャスト (特定の生徒/教員の座席を全画面強調表示)
   * event: 'seating:highlight_seat'
   */
  socket.on('seating:highlight_seat', (data) => {
    try {
      const { layoutId, targetCellId, targetType, targetName } = data;

      if (!layoutId || !targetCellId) return;

      // 同一レイアウト閲覧中の他教員クライアントへハイライト位置を通知
      socket.broadcast.emit('seating:seat_highlighted', {
        layoutId,
        targetCellId,
        targetType, // 'STUDENT' | 'TEACHER'
        targetName,
        operatorName: user.name,
      });
    } catch (error) {
      console.error('[Socket.io Seating Highlight Error]:', error);
    }
  });

  /**
   * 座席配置変更の即時通知 (他クライアントでのリアルタイム再描画用)
   * event: 'seating:grid_updated'
   */
  socket.on('seating:grid_updated', (data) => {
    try {
      const { layoutId } = data;
      if (!layoutId) return;

      // 該当レイアウトの変更を全クライアントへ通知
      socket.broadcast.emit('seating:layout_reloaded', {
        layoutId,
        updatedBy: user.name,
      });
    } catch (error) {
      console.error('[Socket.io Seating Grid Update Error]:', error);
    }
  });
}

export default registerSeatingSocketHandlers;