/**
 * ISSystem Mail Routes
 * GET /api/mail/account            : 自分のメール接続設定取得 (初回は needs_setup)
 * POST /api/mail/account           : メール接続設定の登録 / 更新
 * DELETE /api/mail/account         : メール接続設定の削除
 * POST /api/mail/test              : 接続テスト
 * GET /api/mail/messages?folder=   : ボックス表示 (inbox 受信 / sent 送信 / limit・before・before_id で keyset ページング)
 * POST /api/mail/inbox/refresh     : 受信ボックスの取得 (IMAP)
 * POST /api/mail/inbox/older       : 受信ボックスの過去分取得 (IMAP。まだ DB に無い UID の古い1ページ分)
 * POST /api/mail/send              : メール送信 (SMTP + 送信済みボックス保存)
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
router.post('/mail/messages/:id/read', requireAuth, mailController.markMessageRead);

export default router;