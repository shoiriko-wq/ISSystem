/**
 * ISSystem Staff Room Seating & Teacher Presence Socket Handlers
 * 教員在席ステータス (在席/離席/授業中/出張) 即時一斉同期 & 座席検索ハイライト配信
 *
 * 2026/11/7 監査 Critical #1 対策:
 * - 在席更新は接続ユーザー本人 (socket.user.id) のみ。status は SEATING_STATUSES ホワイトリスト
 * - 座席グリッド再読込通知 (seating:grid_updated) は KYOMU / ADMIN のみに制限
 * - ハイライト配信は文字列サニタイズ（任意文字列のブロードキャストを防ぐ）
 */

import authService from '../services/auth.service.js';
import {
  SEATING_STATUSES,
  sanitizeSocketString,
  socketHasRole,
  roleDenied,
} from '../middlewares/socket.middleware.js';

/** 座席グリッド再読込通知を許可するロール */
const GRID_UPDATE_ROLES = ['KYOMU', 'ADMIN'];

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
   * ※ 対象ユーザーは常時 socket.user.id（payload の userId は無視）
   */
  socket.on('seating:update_status', async (data, callback) => {
    try {
      const status = data && typeof data === 'object' ? data.status : data;

      if (!status) {
        if (callback) callback({ success: false, error: 'ステータス値は必須です。' });
        return;
      }
      if (!SEATING_STATUSES.has(String(status))) {
        if (callback) callback({ success: false, error: '無効なステータス区分です。' });
        return;
      }

      // DB/サービス層で在席ステータスを更新（authService 側でも same whitelist を検証）
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
      if (!data || typeof data !== 'object') return;
      const layoutId = sanitizeSocketString(data.layoutId, 64);
      const targetCellId = sanitizeSocketString(data.targetCellId, 64);
      const targetType = sanitizeSocketString(data.targetType, 16);
      const targetName = sanitizeSocketString(data.targetName, 64);

      if (!layoutId || !targetCellId) return;

      // 同一レイアウト閲覧中の他教員クライアントへハイライト位置を通知
      socket.broadcast.emit('seating:seat_highlighted', {
        layoutId,
        targetCellId,
        targetType: targetType === 'STUDENT' || targetType === 'TEACHER' ? targetType : null,
        targetName: targetName || null,
        operatorName: user.name,
      });
    } catch (error) {
      console.error('[Socket.io Seating Highlight Error]:', error);
    }
  });

  /**
   * 座席配置変更の即時通知 (他クライアントでのリアルタイム再描画用)
   * event: 'seating:grid_updated'
   * ※ ロール gate: 座席グリッドの再読込通知は教務主任 / 管理者のみ
   */
  socket.on('seating:grid_updated', (data, callback) => {
    try {
      if (!socketHasRole(socket, GRID_UPDATE_ROLES)) {
        if (callback) callback(roleDenied(GRID_UPDATE_ROLES));
        return;
      }

      const layoutId = sanitizeSocketString(data?.layoutId, 64);
      if (!layoutId) return;

      // 該当レイアウトの変更を全クライアントへ通知
      socket.broadcast.emit('seating:layout_reloaded', {
        layoutId,
        updatedBy: user.name,
      });

      if (callback) callback({ success: true, layoutId });
    } catch (error) {
      console.error('[Socket.io Seating Grid Update Error]:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });
}

export default registerSeatingSocketHandlers;