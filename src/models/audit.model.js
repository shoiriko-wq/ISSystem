/**
 * ISSystem Editing Lock & System Audit Log Data Access Model
 * リソース排他編集ロック・システム操作/エラー監査ログデータ操作 (SQLite対応 & Cron連携拡張版)
 */

import { query } from '../../config/database.js';

// デモ・開発用インメモリキャッシュストア
const mockLocks = new Map(); // key: `${resourceType}_${resourceId}`
const mockAuditLogs = [];

export const auditModel = {
  /**
   * 特定リソースの現在の排他編集ロック状態を取得
   * @param {string} resourceType - 'seating', 'exam', 'schedule' 等
   * @param {string} resourceId
   */
  async getEditingLock(resourceType, resourceId) {
    const key = `${resourceType}_${resourceId}`;
    if (mockLocks.has(key)) {
      return mockLocks.get(key);
    }

    try {
      const sql = `
        SELECT resource_type, resource_id, user_id as locked_by_user_id, user_name as locked_by_user_name, created_at as locked_at, updated_at as last_active_at
        FROM editing_locks
        WHERE resource_type = ? AND resource_id = ?
      `;
      const res = await query(sql, [resourceType, String(resourceId)]);
      return res.rows[0] || null;
    } catch (error) {
      return null;
    }
  },

  /**
   * リソースの排他編集ロックを取得またはハートビート更新
   * @param {string} resourceType
   * @param {string} resourceId
   * @param {string} userId
   * @param {string} userName
   */
  async upsertEditingLock(resourceType, resourceId, userId, userName = '教員') {
    const key = `${resourceType}_${resourceId}`;
    const now = new Date();

    const lockData = {
      resource_type: resourceType,
      resource_id: resourceId,
      locked_by_user_id: userId,
      locked_by_user_name: userName,
      locked_at: mockLocks.has(key) ? mockLocks.get(key).locked_at : now,
      last_active_at: now,
    };

    mockLocks.set(key, lockData);

    try {
      const sql = `
        INSERT INTO editing_locks (resource_type, resource_id, user_id, user_name, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT (resource_type, resource_id)
        DO UPDATE SET 
          user_id = EXCLUDED.user_id,
          user_name = EXCLUDED.user_name,
          updated_at = CURRENT_TIMESTAMP
      `;
      await query(sql, [resourceType, String(resourceId), userId, userName]);
    } catch (error) {
      console.warn('[AuditModel] DB lock upsert fallback:', error.message);
    }

    return lockData;
  },

  /**
   * リソースの排他編集ロックを解放
   * @param {string} resourceType
   * @param {string} resourceId
   */
  async releaseEditingLock(resourceType, resourceId) {
    const key = `${resourceType}_${resourceId}`;
    mockLocks.delete(key);

    try {
      const sql = `DELETE FROM editing_locks WHERE resource_type = ? AND resource_id = ?`;
      await query(sql, [resourceType, String(resourceId)]);
    } catch (error) {
      // ログ無視
    }
  },

  /**
   * 【Cron用】期限切れ（指定秒数無操作）の編集ロック一覧を取得
   * @param {number} timeoutSeconds (デフォルト 180秒)
   */
  async getExpiredEditingLocks(timeoutSeconds = 180) {
    const expiredList = [];
    const now = Date.now();

    // 1. メモリキャッシュ側のチェック
    for (const [key, lock] of mockLocks.entries()) {
      const lastActive = new Date(lock.last_active_at).getTime();
      if ((now - lastActive) / 1000 >= timeoutSeconds) {
        expiredList.push(lock);
      }
    }

    // 2. DB側のチェック
    try {
      const sql = `
        SELECT resource_type, resource_id, user_id as locked_by_user_id, user_name as locked_by_user_name
        FROM editing_locks
        WHERE (strftime('%s', 'now') - strftime('%s', updated_at)) >= ?
      `;
      const res = await query(sql, [timeoutSeconds]);
      if (res.rows && res.rows.length > 0) {
        res.rows.forEach(row => {
          if (!expiredList.some(item => item.resource_type === row.resource_type && item.resource_id === row.resource_id)) {
            expiredList.push(row);
          }
        });
      }
    } catch (error) {
      // キャッシュ結果を返す
    }

    return expiredList;
  },

  /**
   * 【Cron用】期限切れの編集ロックを一括解放
   * @param {number} timeoutSeconds
   */
  async releaseExpiredEditingLocks(timeoutSeconds = 180) {
    const now = Date.now();

    // 1. メモリキャッシュ側の解除
    for (const [key, lock] of mockLocks.entries()) {
      const lastActive = new Date(lock.last_active_at).getTime();
      if ((now - lastActive) / 1000 >= timeoutSeconds) {
        mockLocks.delete(key);
      }
    }

    // 2. DB側の解除
    try {
      const sql = `
        DELETE FROM editing_locks
        WHERE (strftime('%s', 'now') - strftime('%s', updated_at)) >= ?
      `;
      return await query(sql, [timeoutSeconds]);
    } catch (error) {
      return { rowCount: 0 };
    }
  },

  /**
   * 【Cron用】古くなった監査ログのクリーンアップ（指定日数保持）
   * @param {number} daysToKeep (デフォルト 90日)
   */
  async cleanOldAuditLogs(daysToKeep = 90) {
    try {
      const sql = `
        DELETE FROM system_audit_logs
        WHERE created_at < date('now', '-' || ? || ' days')
      `;
      const res = await query(sql, [daysToKeep]);
      return res.changes || res.rowCount || 0;
    } catch (error) {
      console.warn('[AuditModel] cleanOldAuditLogs fallback:', error.message);
      return 0;
    }
  },

  /**
   * システム操作・例外エラー監査ログの記録
   */
  async logAction(logData) {
    const logEntry = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      user_id: logData.userId || null,
      action: logData.action,
      target_entity: logData.targetEntity || logData.target || null,
      target_id: logData.targetId || null,
      changes_json: logData.changesJson || (logData.details ? JSON.stringify(logData.details) : null),
      ip_address: logData.ipAddress || null,
      timestamp: new Date(),
    };

    mockAuditLogs.push(logEntry);

    try {
      const sql = `
        INSERT INTO system_audit_logs (user_id, action, target, details, ip_address)
        VALUES (?, ?, ?, ?, ?)
      `;
      await query(sql, [
        logEntry.user_id,
        logEntry.action,
        logEntry.target_entity,
        logEntry.changes_json,
        logEntry.ip_address,
      ]);
    } catch (error) {
      console.warn('[AuditModel] DB logAction fallback:', error.message);
    }

    return logEntry;
  },

  /**
   * 監査ログの検索・一覧取得
   */
  async getAuditLogs(filters = {}) {
    const limit = filters.limit || 100;
    if (mockAuditLogs.length > 0) {
      let list = [...mockAuditLogs];
      if (filters.userId) list = list.filter((l) => l.user_id === filters.userId);
      if (filters.action) list = list.filter((l) => l.action === filters.action);
      return { logs: list.reverse().slice(0, limit), pagination: { total: list.length } };
    }

    try {
      const sql = `
        SELECT l.*, u.name as user_name
        FROM system_audit_logs l
        LEFT JOIN users u ON l.user_id = u.id
        ORDER BY l.created_at DESC
        LIMIT ?
      `;
      const res = await query(sql, [limit]);
      return { logs: res.rows || [], pagination: { total: res.rows.length } };
    } catch (error) {
      return { logs: [], pagination: { total: 0 } };
    }
  },
};

// --- named import (個別インポート) 用の展開エクスポート ---
export const {
  getEditingLock,
  upsertEditingLock,
  releaseEditingLock,
  getExpiredEditingLocks,
  releaseExpiredEditingLocks,
  cleanOldAuditLogs,
  logAction,
  getAuditLogs,
} = auditModel;

export default auditModel;