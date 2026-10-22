/**
 * ISSystem Lock Middleware
 * 編集排他ロック & 3分無操作タイムアウト検証ミドルウェア
 */

import auditModel from '../models/audit.model.js';
import { ApiError } from './error.middleware.js';

/**
 * 編集排他ロックチェックミドルウェアの高階関数
 * @param {string} resourceType - ロック対象リソース種別 ('seating', 'exam' 等)
 */
export function checkEditingLock(resourceType) {
  return async (req, res, next) => {
    try {
      const resourceId = req.params.id || req.body.resourceId;

      if (!resourceId) {
        return next();
      }

      // 3分 (180秒) タイムアウト判定付きで現在のアクティブなロックを取得
      const activeLock = await auditModel.getActiveEditingLock(resourceType, resourceId, 180);

      if (activeLock && activeLock.user_id !== req.user.id) {
        return next(
          new ApiError(
            409,
            `現在、他の教員（${activeLock.user_name || '別のユーザー'}）が編集中です。同時に編集することはできません。`,
            {
              lockedBy: activeLock.user_name,
              lockedAt: activeLock.created_at,
            }
          )
        );
      }

      // 自身のロックであれば最終アクセス時刻を自動更新 (ロック延長)
      if (activeLock && activeLock.user_id === req.user.id) {
        await auditModel.refreshEditingLock(resourceType, resourceId, req.user.id);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
}

export default {
  checkEditingLock,
};