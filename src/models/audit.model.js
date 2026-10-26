/**
 * ISSystem Audit Log & Editing Lock Data Access Model
 * 操作監査ログ (90日保持) と編集排他ロック (3分無操作タイムアウト) の PostgreSQL データ操作
 */

import { query } from '../../config/database.js';

export const auditModel = {
  /**
   * 監査ログの記録
   * @param {Object} params - { userId, userName, action, resourceType, resourceId, oldValue, newValue, ipAddress, userAgent }
   */
  async logAction(params = {}) {
    const sql = `
      INSERT INTO audit_logs (
        user_id, user_name, action, resource_type, resource_id,
        old_value, new_value, ip_address, user_agent
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `;
    // 呼び出し側サービスの命名揺れ (targetEntity / targetId / changesJson 等) を吸収してカラムへマップ
    const userId = params.userId ?? params.user_id ?? null;
    const userName = params.userName ?? params.user_name ?? null;
    const resourceType = params.resourceType ?? params.resource_type ?? params.targetEntity ?? params.target_entity ?? null;
    const rawResourceId = params.resourceId ?? params.resource_id ?? params.targetId ?? params.target_id ?? null;
    const resourceId = rawResourceId === null || rawResourceId === undefined ? null : String(rawResourceId);
    const oldValue = params.oldValue ?? params.old_value ?? null;
    const newValue = params.newValue ?? params.new_value ?? params.changesJson ?? params.changes_json ?? null;

    const toText = (v) => (v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v));

    const result = await query(sql, [
      userId,
      userName,
      params.action,
      resourceType,
      resourceId,
      toText(oldValue),
      toText(newValue),
      params.ipAddress || params.ip_address || null,
      params.userAgent || params.user_agent || null,
    ]);
    return result.rows[0];
  },

  /**
   * 編集操作の監査ログ記録
   */
  async logEdit({ userId, userName, action, resourceType, resourceId, oldValue, newValue, ipAddress, userAgent }) {
    return await this.logAction({
      userId,
      userName,
      action,
      resourceType,
      resourceId,
      oldValue,
      newValue,
      ipAddress,
      userAgent,
    });
  },

  /**
   * 監査ログの検索・ページング取得
   * @param {Object} filters - { userId, action, resourceType, target, startDate, endDate, page, limit }
   */
  async getAuditLogs(filters = {}) {
    const limit = filters.limit || 50;
    const page = filters.page && filters.page > 0 ? filters.page : 1;
    const offset = (page - 1) * limit;

    const conditions = [];
    const values = [];

    if (filters.userId) {
      values.push(filters.userId);
      conditions.push(`user_id = $${values.length}`);
    }

    if (filters.action) {
      values.push(filters.action);
      conditions.push(`action = $${values.length}`);
    }

    if (filters.resourceType) {
      values.push(filters.resourceType);
      conditions.push(`resource_type = $${values.length}`);
    }

    if (filters.target) {
      const pattern = `%${filters.target}%`;
      values.push(pattern);
      const ph = `$${values.length}`;
      conditions.push(`(resource_type ILIKE ${ph} OR resource_id ILIKE ${ph})`);
    }

    if (filters.startDate) {
      values.push(filters.startDate);
      conditions.push(`created_at >= $${values.length}::timestamp`);
    }

    if (filters.endDate) {
      values.push(filters.endDate);
      conditions.push(`created_at <= $${values.length}::timestamp`);
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const countValues = values.slice();

    const countRes = await query(
      `SELECT COUNT(*) AS total FROM audit_logs ${whereSql}`,
      countValues
    );

    const pageValues = values.slice();
    pageValues.push(limit);
    const limitPh = `$${pageValues.length}`;
    pageValues.push(offset);
    const offsetPh = `$${pageValues.length}`;

    const rowsRes = await query(
      `SELECT * FROM audit_logs ${whereSql} ORDER BY created_at DESC LIMIT ${limitPh} OFFSET ${offsetPh}`,
      pageValues
    );

    return {
      logs: rowsRes.rows,
      total: parseInt(countRes.rows[0].total, 10),
      page,
      limit,
    };
  },

  /**
   * 編集排他ロックの取得 (1リソース = 1ロック / UNIQUE制約)
   * @param {string} resourceType
   * @param {string} resourceId
   * @param {string} userId
   * @param {string} userName
   * @param {number} timeoutSeconds - 無操作タイムアウト閾値 (既定 180秒)
   */
  async acquireEditingLock(resourceType, resourceId, userId, userName, timeoutSeconds = 180) {
    // 有効期限内のロックを確認 (タイムアウト超過ロックは自動除去して再取得)
    const existingRes = await query(
      `SELECT * FROM editing_locks
       WHERE resource_type = $1 AND resource_id = $2
         AND EXTRACT(EPOCH FROM (now() - last_accessed)) <= $3
       LIMIT 1`,
      [resourceType, resourceId, timeoutSeconds]
    );

    const existing = existingRes.rows[0];
    if (existing) {
      if (existing.user_id === userId) {
        return await this.refreshEditingLock(resourceType, resourceId, userId);
      }
      const holder = existing.user_name || existing.user_id;
      throw new Error(`現在、${holder} が編集中です。同時に編集することはできません。`);
    }

    // 無操作タイムアウト超過の放置ロックを掃除してから取得
    await query(
      `DELETE FROM editing_locks
       WHERE resource_type = $1 AND resource_id = $2
         AND EXTRACT(EPOCH FROM (now() - last_accessed)) > $3`,
      [resourceType, resourceId, timeoutSeconds]
    );

    const inserted = await query(
      `INSERT INTO editing_locks (resource_type, resource_id, user_id, user_name, acquired_at, last_accessed)
       VALUES ($1, $2, $3, $4, now(), now())
       RETURNING *`,
      [resourceType, resourceId, userId, userName || null]
    );
    return inserted.rows[0];
  },

  /**
   * 編集排他ロックの解放
   */
  async releaseEditingLock(resourceType, resourceId) {
    const res = await query(
      `DELETE FROM editing_locks WHERE resource_type = $1 AND resource_id = $2`,
      [resourceType, resourceId]
    );
    return res.rowCount > 0;
  },

  /**
   * ロックの最終アクセス更新 (自ユーザーのロック延長)
   */
  async refreshEditingLock(resourceType, resourceId, userId) {
    const res = await query(
      `UPDATE editing_locks SET last_accessed = now()
       WHERE resource_type = $1 AND resource_id = $2 AND user_id = $3
       RETURNING *`,
      [resourceType, resourceId, userId]
    );
    return res.rows[0] || null;
  },

  /**
   * アクティブな編集ロックの取得 (タイムアウト判定込み)
   * @param {number} timeoutSeconds
   */
  async getActiveEditingLock(resourceType, resourceId, timeoutSeconds = 180) {
    const res = await query(
      `SELECT * FROM editing_locks
       WHERE resource_type = $1 AND resource_id = $2
         AND EXTRACT(EPOCH FROM (now() - last_accessed)) <= $3
       LIMIT 1`,
      [resourceType, resourceId, timeoutSeconds]
    );
    return res.rows[0] || null;
  },

  /**
   * 無操作タイムアウト超過ロックの一覧 (cron 自動解放用)
   * @param {number} timeoutSeconds
   */
  async getExpiredEditingLocks(timeoutSeconds = 180) {
    const res = await query(
      `SELECT * FROM editing_locks
       WHERE EXTRACT(EPOCH FROM (now() - last_accessed)) > $1
       ORDER BY last_accessed ASC`,
      [timeoutSeconds]
    );
    return res.rows;
  },

  /**
   * 保持期間を超過した監査ログのクリーンアップ
   * @param {number} days - 保持日数 (既定 90日)
   */
  async cleanOldAuditLogs(days = 90) {
    const res = await query(
      `DELETE FROM audit_logs WHERE created_at < now() - make_interval(days => $1::int)`,
      [days]
    );
    return res.rowCount;
  },
};

export const log = (...args) => auditModel.logAction(...args);
export const createAuditLog = (...args) => auditModel.logAction(...args);
export const logAction = (...args) => auditModel.logAction(...args);
export const logEdit = (...args) => auditModel.logEdit(...args);
export const getAuditLogs = (...args) => auditModel.getAuditLogs(...args);
export const getRecentLogs = (...args) => auditModel.getAuditLogs(...args);
export const acquireEditingLock = (...args) => auditModel.acquireEditingLock(...args);
export const releaseEditingLock = (...args) => auditModel.releaseEditingLock(...args);
export const refreshEditingLock = (...args) => auditModel.refreshEditingLock(...args);
export const getActiveEditingLock = (...args) => auditModel.getActiveEditingLock(...args);
export const getExpiredEditingLocks = (...args) => auditModel.getExpiredEditingLocks(...args);
export const cleanOldAuditLogs = (...args) => auditModel.cleanOldAuditLogs(...args);

export default auditModel;

