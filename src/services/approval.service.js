/**
 * ISSystem Workflow & Approval Integration Service
 * 簡易決裁・物品購入リクエスト・出張申請・チャット自動連携ロジック
 */

import approvalModel from '../models/approval.model.js';
import { chatService } from './chat.service.js';
import chatModel from '../models/chat.model.js';
import userModel from '../models/user.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

export const approvalService = {
  /**
   * 決裁・申請一覧の取得 (ログイン教員の役割・フィルターに応じて抽出)
   * @param {Object} filters - { applicantId, approverId, status, category }
   * @param {Object} user - { id, role, is_kyomu }
   */
  async getApprovals(filters = {}, user) {
    let list = await approvalModel.findAll(filters);

    // 一般教員の場合は、自身が「申請者」または「指定承認者」の案件に絞り込み（教務・管理者は全件参照可）
    if (user.role !== 'ADMIN' && !user.is_kyomu) {
      list = list.filter(a => a.applicant_id === user.id || a.approver_id === user.id);
    }

    return list;
  },

  /**
   * 決裁・申請の詳細取得
   * @param {string} id
   * @param {Object} user
   */
  async getApprovalDetail(id, user) {
    if (!id) {
      throw new ApiError(400, '決裁IDが指定されていません。');
    }

    const approval = await approvalModel.findById(id);
    if (!approval) {
      throw new ApiError(404, '対象の決裁・申請が見つかりません。');
    }

    // 閲覧権限のチェック
    const isApplicant = approval.applicant_id === user.id;
    const isApprover = approval.approver_id === user.id;
    const isAuthorized = isApplicant || isApprover || user.role === 'ADMIN' || user.is_kyomu === true;

    if (!isAuthorized) {
      throw new ApiError(403, 'この決裁情報を閲覧する権限がありません。');
    }

    return approval;
  },

  /**
   * 新規決裁申請（物品購入・出張等）の起案 & 専用チャット自動連携生成
   * @param {Object} data - { title, category, description, amount, approver_id }
   * @param {Object} applicantUser - { id, name }
   */
  async createApproval(data, applicantUser) {
    const { title, category, description, amount, approver_id } = data;

    if (!title || !category) {
      throw new ApiError(400, '申請タイトルおよび申請区分は必須項目です。');
    }

    // 承認者が指定されている場合、ユーザー存在確認
    let approverUser = null;
    if (approver_id) {
      approverUser = await userModel.findById(approver_id);
      if (!approverUser) {
        throw new ApiError(404, '指定された承認者教員が存在しません。');
      }
    }

    // 1. 決裁レコードの作成
    const newApproval = await approvalModel.create({
      title: title.trim(),
      category,
      description: description ? description.trim() : '',
      amount: amount ? parseInt(amount, 10) : 0,
      applicant_id: applicantUser.id,
      applicant_name: applicantUser.name,
      approver_id: approver_id || null,
    });

    // 2. ワークフロー専用チャットチャンネルの自動生成
    try {
      const workflowChannel = await chatService.createWorkflowChannel({
        id: newApproval.id,
        title: newApproval.title,
        applicant_id: applicantUser.id,
        applicant_name: applicantUser.name,
        approver_id: approver_id || null,
      });

      // 決裁データへ専用チャットチャンネルIDを紐付け
      await approvalModel.linkChatChannel(newApproval.id, workflowChannel.id);
      newApproval.linked_chat_channel_id = workflowChannel.id;
    } catch (err) {
      // チャットチャンネル生成失敗時も決裁自体は継続し、ログ出力
      console.error('Failed to auto-create workflow chat channel:', err);
    }

    // 監査ログ記録
    await auditModel.logAction({
      userId: applicantUser.id,
      action: 'CREATE_APPROVAL_REQUEST',
      targetEntity: 'APPROVAL',
      targetId: newApproval.id,
      changesJson: JSON.stringify({
        title: newApproval.title,
        category: newApproval.category,
        amount: newApproval.amount,
        approverId: approver_id,
      }),
    });

    return newApproval;
  },

  /**
   * 決裁ステータス（承認 / 却下）の実行 & 連携チャットへの結果自動投稿
   * @param {string} id
   * @param {string} status - 'APPROVED' | 'REJECTED'
   * @param {string|null} comment - 承認/却下コメント
   * @param {Object} approverUser - { id, name, role, is_kyomu }
   */
  async processApproval(id, status, comment = null, approverUser) {
    if (!id || !['APPROVED', 'REJECTED'].includes(status)) {
      throw new ApiError(400, '無効な決裁パラメータまたはステータスです。');
    }

    const approval = await approvalModel.findById(id);
    if (!approval) {
      throw new ApiError(404, '対象の決裁申請が存在しません。');
    }

    if (approval.status !== 'PENDING') {
      throw new ApiError(400, `この申請は既に処理済みです。 (現在の状態: ${approval.status})`);
    }

    // 承認権限の検証 (指定承認者本人のほか、管理者および教務主任が実行可能)
    const isDesignatedApprover = approval.approver_id === approverUser.id;
    const isKyomuOrAdmin = approverUser.role === 'ADMIN' || approverUser.is_kyomu === true;

    if (!isDesignatedApprover && !isKyomuOrAdmin) {
      throw new ApiError(403, 'この申請を承認または却下する権限がありません。');
    }

    // 1. 決裁ステータスの更新
    const updatedApproval = await approvalModel.updateStatus(
      id,
      status,
      approverUser.id,
      approverUser.name,
      comment ? comment.trim() : null
    );

    // 2. 紐付くチャットチャンネルへ自動結果通知メッセージを送信
    if (approval.linked_chat_channel_id) {
      const statusLabel = status === 'APPROVED' ? '【承認完了】' : '【却下】';
      const resultMessage = `${statusLabel} 決裁申請「${approval.title}」が ${approverUser.name} 先生により${status === 'APPROVED' ? '承認' : '却下'}されました。\nコメント: ${comment ? comment.trim() : 'なし'}`;

      await chatModel.sendMessage({
        channel_id: approval.linked_chat_channel_id,
        sender_id: 'SYSTEM',
        sender_name: 'システム自動通知',
        message_text: resultMessage,
      });
    }

    // 監査ログの記録
    await auditModel.logAction({
      userId: approverUser.id,
      action: status === 'APPROVED' ? 'APPROVE_REQUEST' : 'REJECT_REQUEST',
      targetEntity: 'APPROVAL',
      targetId: id,
      changesJson: JSON.stringify({
        status,
        comment,
        approverName: approverUser.name,
      }),
    });

    return updatedApproval;
  },

  /**
   * 未承認の決裁申請に対する催促リマインドメッセージの送信
   * @param {string} id
   * @param {Object} applicantUser
   */
  async remindApprover(id, applicantUser) {
    const approval = await approvalModel.findById(id);
    if (!approval) {
      throw new ApiError(404, '対象の決裁申請が見つかりません。');
    }

    if (approval.applicant_id !== applicantUser.id) {
      throw new ApiError(403, '起案者本人のみ催促リマインドを送信できます。');
    }

    if (approval.status !== 'PENDING') {
      throw new ApiError(400, '保留中の申請のみリマインド可能です。');
    }

    if (approval.linked_chat_channel_id) {
      const remindMessage = `【催促リマインド】決裁申請「${approval.title}」の確認・承認をお願いいたします。(起案者: ${applicantUser.name})`;
      
      await chatModel.sendMessage({
        channel_id: approval.linked_chat_channel_id,
        sender_id: applicantUser.id,
        sender_name: applicantUser.name,
        message_text: remindMessage,
      });
    }

    await auditModel.logAction({
      userId: applicantUser.id,
      action: 'REMIND_APPROVAL',
      targetEntity: 'APPROVAL',
      targetId: id,
    });

    return { message: '承認者へ催促リマインドを送信しました。' };
  },
};

export default approvalService;