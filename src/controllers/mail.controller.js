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
   * 自分の全メール接続設定取得 (アカウントタブ表示用)
   * GET /api/mail/accounts
   */
  async listAccounts(req, res, next) {
    try {
      const { accounts } = await mailService.listAccounts(req.user);
      return res.status(200).json({ success: true, accounts });
    } catch (error) {
      next(error);
    }
  },

  /**
   * メール接続設定の登録 / 更新 (初回はメールアドレスとパスワードを入力 / body.id でアカウント更新)
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
   * メール接続設定の削除 (query.account_id 指定はそのアカウントのみ / 未指定は全アカウント)
   * DELETE /api/mail/account
   */
  async deleteAccount(req, res, next) {
    try {
      const result = await mailService.deleteAccount(req.user, req.query.account_id ?? null);
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
   * ボックス表示 (folder=inbox 受信ボックス / folder=sent 送信ボックス / account_id 未指定は主アカウント)
   * GET /api/mail/messages
   */
  async getInbox(req, res, next) {
    try {
      const folder = req.query.folder === 'sent' ? 'sent' : 'inbox';
      const { folder: normalized, account_id, messages, unread } = await mailService.getInbox(
        req.user,
        folder,
        req.query.account_id ?? null
      );
      return res.status(200).json({ success: true, folder: normalized, account_id, messages, unread });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 受信ボックスの取得 (IMAP へ接続して新着をDB保存 / account_id 未指定は主アカウント)
   * POST /api/mail/inbox/refresh
   */
  async refreshInbox(req, res, next) {
    try {
      const result = await mailService.fetchInbox(req.user, req.body?.account_id ?? req.query.account_id ?? null);
      return res.status(200).json({
        success: true,
        message: `受信ボックスを更新しました（新規 ${result.added} 件）`,
        ...result,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * メール送信 (SMTP 送信 + 送信済みボックス保存)
   * POST /api/mail/send
   */
  async sendMessage(req, res, next) {
    try {
      const result = await mailService.sendMessage(req.user, req.body || {});
      const message = result.append_warning
        ? `送信しました（${result.append_warning}）`
        : '送信しました。';
      return res.status(201).json({ success: true, message, message_row: result.message });
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
