/**
 * ISSystem Workflow & Simple Approval Data Access Model
 * 簡易決裁・物品購入リクエスト SQLite (database.sqlite) 完全対応モデル
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../../database.sqlite');

async function getDb() {
  return await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
}

// デモ・開発用インメモリキャッシュストア
const mockApprovals = new Map();

export const approvalModel = {
  /**
   * 決裁・申請データのID検索
   * @param {string} id
   */
  async findById(id) {
    if (!id) return null;
    if (mockApprovals.has(id)) return mockApprovals.get(id);

    try {
      const db = await getDb();
      const item = await db.get(
        `SELECT a.*, u.name as applicant_name, ap.name as approver_name
         FROM approvals a
         LEFT JOIN users u ON a.applicant_id = u.id
         LEFT JOIN users ap ON a.approver_id = ap.id
         WHERE a.id = ?`,
        [id]
      );
      await db.close();
      return item || null;
    } catch (err) {
      console.warn('[ApprovalModel SQLite Warning] findById fallback:', err.message);
      return null;
    }
  },

  /**
   * 申請データの一覧取得 (申請者・承認者・ステータス等でフィルタリング)
   * @param {Object} filters - { applicantId, approverId, status, category }
   */
  async findAll(filters = {}) {
    try {
      const db = await getDb();
      const params = [];
      let sql = `
        SELECT a.*, u.name as applicant_name, ap.name as approver_name
        FROM approvals a
        LEFT JOIN users u ON a.applicant_id = u.id
        LEFT JOIN users ap ON a.approver_id = ap.id
        WHERE 1=1
      `;

      if (filters.applicantId) {
        sql += ` AND a.applicant_id = ?`;
        params.push(filters.applicantId);
      }
      if (filters.status) {
        sql += ` AND a.status = ?`;
        params.push(filters.status);
      }
      if (filters.category) {
        sql += ` AND a.category = ?`;
        params.push(filters.category);
      }

      sql += ` ORDER BY a.created_at DESC`;

      const rows = await db.all(sql, params);
      await db.close();

      if (rows && rows.length > 0) {
        return rows;
      }
      return Array.from(mockApprovals.values());
    } catch (err) {
      console.warn('[ApprovalModel SQLite Warning] findAll fallback to mock:', err.message);
      return Array.from(mockApprovals.values());
    }
  },

  /**
   * 新規決裁・物品購入申請の登録
   * @param {Object} data
   */
  async create(data) {
    const id = data.id || `app_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const newApproval = {
      id,
      title: data.title || '無題の申請',
      category: data.category || 'PURCHASE',
      description: data.description || '',
      amount: data.amount ? parseInt(data.amount, 10) : 0,
      applicant_id: data.applicant_id || data.applicantId || 'kyomu01',
      applicant_name: data.applicant_name || '教員',
      approver_id: data.approver_id || null,
      approver_name: null,
      status: 'PENDING',
      comment: null,
      linked_chat_channel_id: data.linked_chat_channel_id || null,
      created_at: nowStr,
      updated_at: nowStr,
      approved_at: null
    };

    mockApprovals.set(id, newApproval);

    try {
      const db = await getDb();
      await db.run(
        `INSERT INTO approvals (id, title, category, description, amount, applicant_id, approver_id, status, linked_chat_channel_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, newApproval.title, newApproval.category, newApproval.description,
          newApproval.amount, newApproval.applicant_id, newApproval.approver_id,
          newApproval.status, newApproval.linked_chat_channel_id,
          newApproval.created_at, newApproval.updated_at
        ]
      );
      await db.close();
    } catch (err) {
      console.warn('[ApprovalModel SQLite Warning] create DB insert failed, saved to mock:', err.message);
    }

    return newApproval;
  },

  /**
   * 決裁ステータス（承認 / 却下）の更新
   * @param {string} id
   * @param {string} status - 'APPROVED' | 'REJECTED'
   * @param {string} approverId
   * @param {string} approverName
   * @param {string|null} comment
   */
  async updateStatus(id, status, approverId, approverName, comment = null) {
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const item = await this.findById(id);

    if (item) {
      item.status = status;
      item.approver_id = approverId;
      item.approver_name = approverName;
      item.comment = comment;
      item.approved_at = nowStr;
      item.updated_at = nowStr;
      mockApprovals.set(id, item);
    }

    try {
      const db = await getDb();
      await db.run(
        `UPDATE approvals
         SET status = ?, approver_id = ?, comment = ?, approved_at = ?, updated_at = ?
         WHERE id = ?`,
        [status, approverId, comment, nowStr, nowStr, id]
      );
      await db.close();
    } catch (err) {
      console.warn('[ApprovalModel SQLite Warning] updateStatus DB failed:', err.message);
    }

    return item || { id, status, approver_id: approverId, comment, approved_at: nowStr };
  },

  /**
   * 専用チャットチャンネルIDの連携紐付け
   * @param {string} id
   * @param {string} channelId
   */
  async linkChatChannel(id, channelId) {
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const item = await this.findById(id);
    if (item) {
      item.linked_chat_channel_id = channelId;
      item.updated_at = nowStr;
    }

    try {
      const db = await getDb();
      await db.run(`UPDATE approvals SET linked_chat_channel_id = ?, updated_at = ? WHERE id = ?`, [channelId, nowStr, id]);
      await db.close();
    } catch (err) {
      console.warn('[ApprovalModel SQLite Warning] linkChatChannel DB failed:', err.message);
    }
  }
};

export default approvalModel;