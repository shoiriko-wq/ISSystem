/**
 * ISSystem Approval / Workflow Data Access Model
 * PostgreSQL (approvals) 完全対応版
 */

import { query } from '../../config/database.js';
import { nowIso } from '../utils/db.js';

export class ApprovalModel {
  /**
   * 決裁・申請の一覧取得
   * @param {Object} filters - { applicantId, applicant_id, approverId, approver_id, status, category }
   */
  async findAll(filters = {}) {
    const params = [];
    const conditions = [];

    const applicantId = filters.applicantId || filters.applicant_id;
    const approverId = filters.approverId || filters.approver_id;

    if (applicantId) {
      params.push(applicantId);
      conditions.push(`a.applicant_id = $${params.length}`);
    }
    if (approverId) {
      params.push(approverId);
      conditions.push(`a.approver_id = $${params.length}`);
    }
    if (filters.status) {
      params.push(filters.status);
      conditions.push(`a.status = $${params.length}`);
    }
    if (filters.category) {
      params.push(filters.category);
      conditions.push(`a.category = $${params.length}`);
    }

    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';

    const res = await query(
      `SELECT a.*, u.name AS applicant_name, ap.name AS approver_name
       FROM approvals a
       LEFT JOIN users u ON a.applicant_id = u.id
       LEFT JOIN users ap ON a.approver_id = ap.id
       ${where}
       ORDER BY CASE a.status WHEN 'PENDING' THEN 0 WHEN 'APPROVED' THEN 1 ELSE 2 END, a.created_at DESC`,
      params
    );
    return res.rows;
  }

  async findById(id) {
    const res = await query(
      `SELECT a.*, u.name AS applicant_name, ap.name AS approver_name
       FROM approvals a
       LEFT JOIN users u ON a.applicant_id = u.id
       LEFT JOIN users ap ON a.approver_id = ap.id
       WHERE a.id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  /**
   * 新規申請の作成
   * @param {Object} data - { title, category, description, amount, applicant_id, approver_id }
   */
  async create(data) {
    const nowStr = nowIso();
    const id = data.id || `approval_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const res = await query(
      `INSERT INTO approvals (id, title, category, description, amount, applicant_id, approver_id, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9)
       RETURNING *`,
      [
        id,
        data.title,
        data.category || 'PURCHASE',
        data.description || '',
        data.amount || 0,
        data.applicant_id,
        data.approver_id || null,
        nowStr,
        nowStr,
      ]
    );
    return res.rows[0];
  }

  /**
   * 決裁処理（承認 / 却下 / 取消）
   * @param {string} id
   * @param {string} status - 'APPROVED' | 'REJECTED' | 'CANCELLED'
   * @param {string} approverId
   * @param {string} approverName
   * @param {string|null} comment
   */
  async updateStatus(id, status, approverId, approverName, comment = null) {
    const nowStr = nowIso();

    const res = await query(
      `UPDATE approvals
       SET status = $1,
           approver_id = COALESCE($2, approvals.approver_id),
           comment = COALESCE($3, approvals.comment),
           approved_at = CASE WHEN $1 = 'PENDING' THEN approvals.approved_at ELSE $4 END,
           updated_at = $5
       WHERE id = $6
       RETURNING *`,
      [status, approverId || null, comment || null, nowStr, nowStr, id]
    );
    return res.rows[0] || null;
  }

  /**
   * 決裁チャンネルの連携（申請にワークフローチャットを紐付け）
   */
  async linkChatChannel(id, channelId) {
    const nowStr = nowIso();
    const res = await query(
      `UPDATE approvals SET linked_chat_channel_id = $1, updated_at = $2 WHERE id = $3 RETURNING *`,
      [channelId, nowStr, id]
    );
    return res.rows[0] || null;
  }

  // ===== 呼び出し側サービスとの命名互換エイリアス =====

  async findApprovals(filters = {}) {
    return this.findAll(filters);
  }

  async listApprovals(filters = {}) {
    return this.findAll(filters);
  }

  async getApprovalsByStatus(status) {
    return this.findAll({ status });
  }

  async createApproval(data) {
    return this.create(data);
  }

  /**
   * 申請対象（施設/書類/文書）からの参照
   */
  async findByTarget(targetType, targetId) {
    const res = await query(
      'SELECT * FROM approvals WHERE category = $1 AND description LIKE $2 ORDER BY created_at DESC',
      [targetType, `%${targetId}%`]
    );
    return res.rows;
  }


  async approve(id, approverId, approverName, comment = null) {
    return this.updateStatus(id, 'APPROVED', approverId, approverName, comment);
  }

  async reject(id, approverId, approverName, comment = null) {
    return this.updateStatus(id, 'REJECTED', approverId, approverName, comment);
  }
}

// ApprovalModel はクラス宣言時に export 済み
const approvalModel = new ApprovalModel();

export const submitApproval = (...args) => approvalModel.create(...args);
export const createApproval = (...args) => approvalModel.create(...args);
export const getApprovalsById = (...args) => approvalModel.findById(...args);
export const updateStatus = (...args) => approvalModel.updateStatus(...args);
export const getPendingApprovals = (filters = {}) => approvalModel.findAll({ status: 'PENDING', ...filters });
export const findApprovals = (...args) => approvalModel.findAll(...args);
export const listApprovals = (...args) => approvalModel.findAll(...args);
export const getApprovalsByStatus = (...args) => approvalModel.getApprovalsByStatus(...args);
export const linkChatChannel = (...args) => approvalModel.linkChatChannel(...args);
export const linkToChat = (...args) => approvalModel.linkChatChannel(...args);
export const approve = (...args) => approvalModel.approve(...args);
export const reject = (...args) => approvalModel.reject(...args);
export const findByTarget = (...args) => approvalModel.findByTarget(...args);

export default approvalModel;
