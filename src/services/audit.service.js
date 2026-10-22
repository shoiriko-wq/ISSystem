/**
 * ISSystem Audit Log & Resource Lock Service
 * システム操作/エラー監査ログ照会・統計集計・リソース排他編集ロック管理
 */

import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

export const auditService = {
  /**
   * 監査ログの一覧・検索取得
   * @param {Object} filters - { userId, action, limit }
   */
  async getAuditLogs(filters = {}) {
    return await auditModel.getAuditLogs(filters);
  },

  /**
   * アクション種別ごとの監査ログ統計集計の生成
   * @param {number} limit
   */
  async getAuditSummary(limit = 100) {
    const logs = await auditModel.getAuditLogs({ limit });

    const actionCounts = {};
    const userCounts = {};
    let errorLogsCount = 0;

    for (const log of logs) {
      // アクション別集計
      actionCounts[log.action] = (actionCounts[log.action] || 0) + 1;

      // ユーザー別集計
      if (log.user_id) {
        userCounts[log.user_id] = (userCounts[log.user_id] || 0) + 1;
      }

      // エラーログ集計
      if (log.action && (log.action.includes('ERROR') || log.action.includes('FAIL'))) {
        errorLogsCount++;
      }
    }

    return {
      totalCount: logs.length,
      errorCount: errorLogsCount,
      actionDistribution: actionCounts,
      topUserActivity: userCounts,
      recentLogs: logs.slice(0, 10),
    };
  },

  /**
   * 指定リソースの排他編集ロック状態の確認
   * @param {string} resourceType - 'seating', 'exam' 等
   * @param {string} resourceId
   */
  async getResourceLock(resourceType, resourceId) {
    if (!resourceType || !resourceId) {
      throw new ApiError(400, 'リソース種別およびリソースIDは必須です。');
    }

    const lock = await auditModel.getEditingLock(resourceType, resourceId);

    if (!lock) {
      return { isLocked: false, lock: null };
    }

    // 3分（180,000ms）経過している場合は期限切れと判定
    const lockAge = Date.now() - new Date(lock.last_active_at).getTime();
    const isExpired = lockAge >= 3 * 60 * 1000;

    return {
      isLocked: !isExpired,
      isExpired,
      lock,
    };
  },

  /**
   * システム管理者によるリソース排他編集ロックの強制解放
   * @param {string} resourceType
   * @param {string} resourceId
   * @param {Object} adminUser - { id, role }
   */
  async forceReleaseLock(resourceType, resourceId, adminUser) {
    if (!resourceType || !resourceId) {
      throw new ApiError(400, 'リソース種別およびリソースIDは必須です。');
    }

    await auditModel.releaseEditingLock(resourceType, resourceId);

    // 強制解放ログの記録
    await auditModel.logAction({
      userId: adminUser ? adminUser.id : 'SYSTEM',
      action: 'FORCE_RELEASE_LOCK',
      targetEntity: resourceType,
      targetId: resourceId,
    });

    return {
      message: `リソース (${resourceType}:${resourceId}) の排他編集ロックを強制解放しました。`,
    };
  },
};

export default auditService;