/**
 * 簡易決裁モデル (Approvals Model)
 * PostgreSQL (pg) 準拠実装
 */

import { query } from '../../config/database.js';
import { nowIso } from '../utils/db.js';

class ApprovalModel {
  async findById(id) {
    try {
      const res = await query(
        `SELECT a.*, u.name as applicant_name, ap.name as approver_name
         FROM approvals a
         LEFT JOIN users u ON a.applicant_id = u.id
         LEFT JOIN users ap ON a.approver_id = ap.id
         WHERE a.id = $1`,
        [id]
      );
      return res.rows[0] || null;
    } catch (err) {
      console.error('[ApprovalModel] findById failed:', err.message);
      return null;
    }
  }

  async findAll(filters = {}) {
    try {
      const params = [];
      let sql = `
        SELECT a.*, u.name as applicant_name, ap.name as approver_name
        FROM approvals a
        LEFT JOIN users u ON a.applicant_id = u.id
        LEFT JOIN users ap ON a.approver_id = ap.id
        WHERE 1 = 1
      `;

      if (filters.applicant_id) {
        params.push(filters.applicant_id);
        sql += ` AND a.applicant_id = $${params.length}`;
      }
      if (filters.status) {
        params.push(filters.status);
        sql += ` AND a.status = $${params.length}`;
      }
      sql += ` ORDER BY a.created_at DESC LIMIT 100`;

      const res = await query(sql, params);
      return res.rows;
    } catch (err) {
      console.error('[ApprovalModel] findAll failed:', err.message);
      return [];
    }
  }

  async create(approval) {
    const ts = nowIso();
    const data = {
      ...approval,
      id: `app_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      status: approval.status || 'PENDING',
      created_at: approval.created_at || ts,
      updated_at: ts,
    };
    try {
      await query(
        `INSERT INTO approvals (id, title, category, description, amount, applicant_id, approver_id, status, linked_chat_channel_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          data.id,
          data.title,
          data.category || 'PURCHASE',
          data.description || null,
          data.amount || 0,
          data.applicant_id || null,
          data.approver_id || null,
          data.status,
          data.linked_chat_channel_id || null,
          data.created_at,
          data.updated_at,
        ]
      );
      return data;
    } catch (err) {
      console.error('[ApprovalModel] create failed:', err.message);
      throw err;
    }
  }

  async updateStatus(id, { status, approver_id = null, comment = null }) {
    const ts = nowIso();
    try {
      await query(
        `UPDATE approvals SET status = $1, approver_id = $2, comment = $3, approved_at = $4, updated_at = $5 WHERE id = $6`,
        [status, approver_id, comment, status === 'APPROVED' || status === 'REJECTED' ? ts : null, ts, id]
      );
      return this.findById(id);
    } catch (err) {
      console.error('[ApprovalModel] updateStatus failed:', err.message);
      throw err;
    }
  }

  async linkToChat(id, channelId) {
    const nowStr = nowIso();
    try {
      await query(
        `UPDATE approvals SET linked_chat_channel_id = $1, updated_at = $2 WHERE id = $3`,
        [channelId, nowStr, id]
      );
      return this.findById(id);
    } catch (err) {
      console.error('[ApprovalModel] linkToChat failed:', err.message);
      throw err;
    }
  }
}

export default new ApprovalModel();