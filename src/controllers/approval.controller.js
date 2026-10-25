/**
 * ISSystem Workflow & Approval Controller
 * 簡易決裁・物品購入リクエスト・出張申請・ワンクリック承認 / 却下・催促リマインドAPI
 */

import approvalService from '../services/approval.service.js';

export const approvalController = {
  /**
   * 決裁・申請一覧の取得 (フィルター・役割に応じた絞り込み)
   * GET /api/approvals
   */
  async getApprovals(req, res, next) {
    try {
      const { applicantId, approverId, status, category } = req.query;
      const user = req.user;

      const approvals = await approvalService.getApprovals(
        { applicantId, approverId, status, category },
        user
      );

      return res.status(200).json({
        success: true,
        count: approvals.length,
        approvals,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 決裁・申請の詳細取得
   * GET /api/approvals/:id
   */
  async getApprovalDetail(req, res, next) {
    try {
      const { id } = req.params;
      const user = req.user;

      const approval = await approvalService.getApprovalDetail(id, user);

      return res.status(200).json({
        success: true,
        approval,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 新規決裁申請 (物品購入・出張申請等) の起案 & 専用チャット自動生成
   * POST /api/approvals
   */
  async createApproval(req, res, next) {
    try {
      const { title, category, description, amount, approver_id } = req.body;
      const applicantUser = req.user;

      const newApproval = await approvalService.createApproval(
        {
          title,
          category,
          description,
          amount,
          approver_id,
        },
        applicantUser
      );

      return res.status(201).json({
        success: true,
        message: '決裁申請を起案しました。(協議専用チャットが自動生成されました)',
        approval: newApproval,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 決裁ステータスの処理 (承認 / 却下) & 連携チャット通知
   * PUT /api/approvals/:id/process
   */
  async processApproval(req, res, next) {
    try {
      const { id } = req.params;
      const { status, comment } = req.body;
      const approverUser = req.user;

      const updatedApproval = await approvalService.processApproval(
        id,
        status,
        comment,
        approverUser
      );

      const statusLabel = status === 'APPROVED' ? '承認' : '却下';

      return res.status(200).json({
        success: true,
        message: `決裁申請を${statusLabel}しました。`,
        approval: updatedApproval,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 未承認案件に対する承認者への催促リマインド通知送信
   * POST /api/approvals/:id/remind
   */
  async remindApprover(req, res, next) {
    try {
      const { id } = req.params;
      const applicantUser = req.user;

      const result = await approvalService.remindApprover(id, applicantUser);

      return res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  },
};

export default approvalController;