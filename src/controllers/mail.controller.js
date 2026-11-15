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
   * body に password とフォーム値を送れば未保存設定をプレテスト（account_id 付きならそのアカウントの status へ成否を記録）、空なら保存済み設定でテストし status を更新
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
   * ボックス表示 (folder=inbox 受信ボックス / sent 送信ボックス / drafts 下書き / trash ごみ箱 / account_id 未指定は主アカウント)
   * GET /api/mail/messages?limit=&before=&before_id=  (before+before_id は直前ページ最古の行 = 無限スクロール用カーソル)
   */
  async getInbox(req, res, next) {
    try {
      const folder = ['inbox', 'sent', 'drafts', 'trash'].includes(req.query.folder) ? req.query.folder : 'inbox';
      const { folder: normalized, account_id, messages, total, unread, has_more, oldest } = await mailService.getInbox(
        req.user,
        folder,
        req.query.account_id ?? null,
        {
          limit: req.query.limit ?? null,
          before: req.query.before ?? null,
          before_id: req.query.before_id ?? null,
        }
      );
      return res.status(200).json({ success: true, folder: normalized, account_id, messages, total, unread, has_more, oldest });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 受信ボックスの過去分取得 (IMAP に接続し、まだ DB に無い UID のうち古い1ページ分をDB保存する)
   * POST /api/mail/inbox/older (account_id 未指定は主アカウント)
   */
  async loadOlderInbox(req, res, next) {
    try {
      const result = await mailService.fetchOlder(req.user, req.body?.account_id ?? req.query.account_id ?? null);
      return res.status(200).json({ success: true, ...result });
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
      const warnings = [result.append_warning, result.keyword_warning].filter(Boolean);
      const base = result.forward_sent
        ? '転送を送信しました。'
        : result.reply_sent
          ? '返信を送信しました。'
          : '送信しました。';
      const message = warnings.length ? `${base}（${warnings.join(' / ')}）` : base;
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

  /**
   * メッセージ本文の遅延取得 (未キャッシュ時は IMAP へ取りに行く)
   * POST /api/mail/messages/:id/body と GET /api/mail/messages/:id/body (GET は alias)
   * レスポンスは message オブジェクトとそのフィールドのトップレベル展開の両方を含む
   * (ブラウザは .message.body、GET alias の簡易読みは .body を使う)
   */
  async fetchMessageBody(req, res, next) {
    try {
      const message = await mailService.getFullMessage(req.params.id, req.user);
      return res.status(200).json({ success: true, ...message, message });
    } catch (error) {
      next(error);
    }
  },

  /**
   * メッセージ添付のダウンロード (section を指定)
   * GET /api/mail/messages/:id/attachment?section=1.2
   */
  async fetchMessageAttachment(req, res, next) {
    try {
      const att = await mailService.getAttachment(req.user, req.params.id, req.query.section);
      res.set('Content-Type', att.type || 'application/octet-stream');
      res.set('Content-Disposition', `attachment; filename="${att.name}"`);
      return res.status(200).send(Buffer.from(att.bytes));
    } catch (error) {
      next(error);
    }
  },
  /**
   * 4フォルダの件数 (受信箱・送信済み・下書き・ごみ箱と受信箱未読)
   * GET /api/mail/counts?account_id=
   */
  async mailboxCounts(req, res, next) {
    try {
      const result = await mailService.mailboxCounts(req.user, req.query.account_id ?? req.body?.account_id ?? null);
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      next(error);
    }
  },

  /**
   * IMAP フォルダ同期 (下書き・ごみ箱・送信済みのヘッダを取り込む)
   * POST /api/mail/folder/sync { folder, account_id }
   */
  async syncFolder(req, res, next) {
    try {
      const folder = ['inbox', 'sent', 'drafts', 'trash'].includes(req.body?.folder) ? req.body.folder : 'inbox';
      const result = await mailService.syncImapFolder(
        req.user,
        req.body?.account_id ?? req.query.account_id ?? null,
        folder
      );
      return res.status(200).json({ success: true, message: `「${result.folder}」を更新しました（新規 ${result.added} 件）`, ...result });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 下書きの保存 (id 指定はその下書きを更新)
   * POST /api/mail/draft { id?, to, subject, body, account_id? }
   */
  async saveDraft(req, res, next) {
    try {
      const result = await mailService.saveDraft(req.user, req.body || {});
      const message = result.append_warning
        ? `下書きを保存しました（${result.append_warning}）`
        : '下書きを保存しました。';
      return res.status(201).json({ success: true, message, message_row: result.message });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 下書きを送信する (SMTP 送信 + 送信ボックスへ記録)
   * POST /api/mail/draft/:id/send
   */
  async sendDraft(req, res, next) {
    try {
      const result = await mailService.sendDraft(req.user, req.params.id, req.body || {});
      const message = result.append_warning
        ? `送信しました（${result.append_warning}）`
        : '下書きを送信しました。';
      return res.status(200).json({ success: true, message, message_row: result.message });
    } catch (error) {
      next(error);
    }
  },

  /**
   * メッセージをごみ箱へ移動する
   * POST /api/mail/messages/:id/trash
   */
  async moveToTrash(req, res, next) {
    try {
      const result = await mailService.moveToTrash(req.user, req.params.id);
      const message = result.move_warning
        ? `ごみ箱へ移動しました（${result.move_warning}）`
        : 'ごみ箱へ移動しました。';
      return res.status(200).json({ success: true, message, message_row: result.message });
    } catch (error) {
      next(error);
    }
  },

  /**
   * ごみ箱から受信箱へ復元する
   * POST /api/mail/messages/:id/restore
   */
  async restoreMessage(req, res, next) {
    try {
      const result = await mailService.restoreFromTrash(req.user, req.params.id);
      const message = result.move_warning
        ? `受信箱へ復元しました（${result.move_warning}）`
        : '受信箱へ復元しました。';
      return res.status(200).json({ success: true, message, message_row: result.message });
    } catch (error) {
      next(error);
    }
  },

  /**
   * ごみ箱のメッセージを完全に削除する
   * POST /api/mail/messages/:id/purge
   */
  async purgeMessage(req, res, next) {
    try {
      const result = await mailService.purgeMessage(req.user, req.params.id);
      const message = result.delete_warning
        ? `${result.message}（${result.delete_warning}）`
        : result.message;
      return res.status(200).json({ success: true, message });
    } catch (error) {
      next(error);
    }
  },

  /**
   * フォルダのIMAPデータを消す (表示・DBキャッシュ・IMAP側)
   * POST /api/mail/imap-data/clear
   */
  async clearImapData(req, res, next) {
    try {
      const result = await mailService.clearImapData(req.user, req.body || {});
      const message = result.warning ? `${result.message}（${result.warning}）` : result.message;
      return res.status(200).json({
        success: true,
        message,
        folder: result.folder,
        imap_folder: result.imap_folder,
        removed: result.removed,
      });
    } catch (error) {
      next(error);
    }
  },
};

export default mailController;
