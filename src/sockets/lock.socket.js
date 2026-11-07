/**
 * ISSystem Simultaneous Editing Lock & Realtime Notification Socket Handlers
 * 画面別同時編集ロック状態・ハートビート更新・無操作3分自動解放・全クライアントリアルタイム同期
 *
 * 2026/11/7 監査 Critical #1 対策:
 * - resourceType はホワイトリスト（SOCKET_RESOURCE_TYPES）のみ許可、resourceId は文字列サニタイズ
 * - auditModel の実署名（位置引数）に合わせて呼び出しを修正
 *   （旧実装は存在しない getEditingLock() を呼ぶ＋acquireEditingLock にオブジェクトを渡していた）
 * - lock:timeout_released は自身保持分しか解放しない
 */

import auditModel from '../models/audit.model.js';
import config from '../../config/default.js';
import {
  isAllowedResourceType,
  sanitizeSocketString,
} from '../middlewares/socket.middleware.js';

/** 3分無操作タイムアウト（秒）— config.realtime.lockTimeoutMs と連動 */
const LOCK_TIMEOUT_SECONDS = Math.round((config.realtime?.lockTimeoutMs || 180000) / 1000);

/**
 * ペイロード対象を安全な形に正規化する
 * @param {Object} data
 * @returns {{resourceType:string, resourceId:string}|null} 不正なら null
 */
function normalizeLockTarget(data) {
  if (!data || typeof data !== 'object') return null;
  const resourceType = sanitizeSocketString(data.resourceType, 32);
  const resourceId = sanitizeSocketString(data.resourceId, 255);
  if (!resourceType || !resourceId) return null;
  if (!isAllowedResourceType(resourceType)) return null;
  return { resourceType: resourceType.toLowerCase(), resourceId };
}

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
      const target = normalizeLockTarget(data);

      if (!target) {
        if (callback) callback({ success: false, error: 'リソース情報が不正です（許可される種別: seating, exam, schedule, facility, approval, bulletin, mail, chat）。' });
        return;
      }
      const { resourceType, resourceId } = target;

      // 現在のロック状態を確認（3分以内のアクティブロック）
      const currentLock = await auditModel.getActiveEditingLock(resourceType, resourceId, LOCK_TIMEOUT_SECONDS);

      // 他のユーザーがアクティブなロックを保持しているか確認 (3分以内の操作)
      if (currentLock && currentLock.user_id !== user.id) {
        if (callback) {
          callback({
            success: false,
            isLockedByOther: true,
            lockedBy: {
              id: currentLock.user_id,
              name: currentLock.user_name || '別の教員',
            },
            lockedAt: currentLock.created_at,
          });
        }
        return;
      }

      // ロックの新規取得または更新（ハートビート）— 位置引数で渡す
      await auditModel.acquireEditingLock(resourceType, resourceId, user.id, user.name, LOCK_TIMEOUT_SECONDS);

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
          expiresInSeconds: LOCK_TIMEOUT_SECONDS,
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
   * ※ 自身thatが保持しているロックのみ解放できる
   */
  socket.on('lock:release', async (data, callback) => {
    try {
      const target = normalizeLockTarget(data);

      if (!target) {
        if (callback) callback({ success: false, error: 'リソース情報が不正です。' });
        return;
      }
      const { resourceType, resourceId } = target;

      const currentLock = await auditModel.getActiveEditingLock(resourceType, resourceId, LOCK_TIMEOUT_SECONDS);
      if (currentLock && currentLock.user_id !== user.id) {
        if (callback) callback({ success: false, error: '他の教員が保持しているロックは解放できません。' });
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
   * ※ 自身保持分のみ解放する（他ユーザーのロックを他端末から解放できない）
   */
  socket.on('lock:timeout_released', async (data) => {
    try {
      const target = normalizeLockTarget(data);
      if (!target) return;
      const { resourceType, resourceId } = target;

      const currentLock = await auditModel.getActiveEditingLock(resourceType, resourceId, LOCK_TIMEOUT_SECONDS);
      if (currentLock && currentLock.user_id !== user.id) return;

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