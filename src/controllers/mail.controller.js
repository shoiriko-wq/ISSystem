/**
 * ISSystem Mail Controller
 * メール接続設定 API (自分の設定のみ閲覧・変更・削除可)
 */

import mailService from '../services/mail.service.js';

export const mailController = {
  /**
   * 自分のメール接続設定取得 (初回は needs_setup: true)
   * GET /api/mail/account
   */
  async getAccount(req, res, next) {
    try {
      const account = await mailService.getAccount(req.user);
      return res.status(200).json({ success: true, account });
    } catch (error) {
      next(error);
    }
  },

  /**
   * メール接続設定の登録 / 更新 (初回はメールアドレスとパスワードを入力)
   * POST /api/mail/account
   */
  async saveAccount(req, res, next) {
    try {
      const account = await mailService.saveAccount(req.body || {}, req.user);
      return res.status(201).json({
        success: true,
        message: 'メール接続設定を保存しました。',
        account,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * メール接続設定の削除
   * DELETE /api/mail/account
   */
  async deleteAccount(req, res, next) {
    try {
      const result = await mailService.deleteAccount(req.user);
      return res.status(200).json({
        success: true,
        message: 'メール接続設定を削除しました。',
        ...result,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 接続テスト (POST /api/mail/test)
   * body に password とフォーム値を送れば未保存設定をプレテスト、空なら保存済み設定でテストし status を更新
   */
  async testConnection(req, res, next) {
    try {
      const result = await mailService.testConnection(req.body || {}, req.user);
      const message =
        result.status === 'VERIFIED'
          ? '接続テスト: IMAP / SMTP とも接続確認済み'
          : '接続テスト: 接続失敗 (IMAP / SMTP)';
      return res.status(200).json({ success: true, message, ...result });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 受信箱の表示 (左：件名と日時、右：本文)
   * GET /api/mail/messages
   */
  async getInbox(req, res, next) {
    try {
      const { messages, unread } = await mailService.getInbox(req.user);
      return res.status(200).json({ success: true, messages, unread });
    } catch (error) {
      next(error);
    }
  },

  /**
   * メッセージを既読にする
   * POST /api/mail/messages/:id/read
   */
  async markMessageRead(req, res, next) {
    try {
      const message = await mailService.markMessageRead(req.params.id, req.user);
      return res.status(200).json({ success: true, message });
    } catch (error) {
      next(error);
    }
  },
};

export default mailController;
