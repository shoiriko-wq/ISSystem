/**
 * ISSystem Mail Routes
 * GET /api/mail/account            : 自分のメール接続設定取得 (初回は needs_setup)
 * POST /api/mail/account           : メール接続設定の登録 / 更新
 * DELETE /api/mail/account         : メール接続設定の削除
 * POST /api/mail/test              : 接続テスト
 * GET /api/mail/messages?folder=   : ボックス表示 (inbox 受信 / sent 送信 / drafts 下書き / trash ごみ箱 / limit・before・before_id で keyset ページング)
 * POST /api/mail/inbox/refresh     : 受信ボックスの取得 (IMAP)
 * POST /api/mail/folder/sync       : 下書き・ごみ箱・送信済みフォルダの IMAP 同期 (ヘッダのみ)
 * GET  /api/mail/counts            : 4フォルダの件数 (受信箱未読含む)
 * POST /api/mail/draft             : 下書きの保存 (id 指定は更新)
 * POST /api/mail/draft/:id/send    : 下書きを送信 (SMTP + 送信ボックス記録)
 * POST /api/mail/send              : メール送信 (SMTP + 送信済みボックス保存)
 * POST /api/mail/messages/:id/trash   : ごみ箱へ移動 (IMAP でも COPY + 削除フラグ)
 * POST /api/mail/messages/:id/restore : ごみ箱から受信箱へ復元
 * POST /api/mail/messages/:id/purge   : ごみ箱から完全削除
 * POST /api/mail/imap-data/clear      : 表示中フォルダのIMAPデータを消す (受信箱はIMAPから自動再取得)
 * POST /api/mail/messages/:id/read : メッセージ既読
 */

import { Router } from 'express';
import { mailController } from '../controllers/mail.controller.js';
import { requireAuth } from '../middlewares/auth.middleware.js';

const router = Router();

router.get('/mail/account', requireAuth, mailController.getAccount);
router.get('/mail/accounts', requireAuth, mailController.listAccounts);
router.post('/mail/account', requireAuth, mailController.saveAccount);
router.delete('/mail/account', requireAuth, mailController.deleteAccount);
router.post('/mail/test', requireAuth, mailController.testConnection);
router.get('/mail/messages', requireAuth, mailController.getInbox);
router.post('/mail/inbox/refresh', requireAuth, mailController.refreshInbox);
router.post('/mail/inbox/older', requireAuth, mailController.loadOlderInbox);
router.post('/mail/send', requireAuth, mailController.sendMessage);
router.post('/mail/draft', requireAuth, mailController.saveDraft);
router.post('/mail/draft/:id/send', requireAuth, mailController.sendDraft);
router.post('/mail/folder/sync', requireAuth, mailController.syncFolder);
router.get('/mail/counts', requireAuth, mailController.mailboxCounts);
router.post('/mail/messages/:id/read', requireAuth, mailController.markMessageRead);
router.post('/mail/messages/:id/trash', requireAuth, mailController.moveToTrash);
router.post('/mail/messages/:id/restore', requireAuth, mailController.restoreMessage);
router.post('/mail/messages/:id/purge', requireAuth, mailController.purgeMessage);
router.post('/mail/imap-data/clear', requireAuth, mailController.clearImapData);
router.post('/mail/messages/:id/body', requireAuth, mailController.fetchMessageBody);
router.get('/mail/messages/:id/body', requireAuth, mailController.fetchMessageBody);
router.get('/mail/messages/:id/attachment', requireAuth, mailController.fetchMessageAttachment);

export default router;