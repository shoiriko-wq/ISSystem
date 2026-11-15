/**
 * ISSystem Mail Account Data Access Model
 * PostgreSQL (mail_accounts) / パスワードは AES-256-GCM で暗号化して保存する
 */

import crypto from 'node:crypto';
import { query } from '../../config/database.js';
import config from '../../config/default.js';
import { nowIso } from '../utils/db.js';

/** TIMESTAMP(タイムゾーン無し)列は JST 壁時計で保存する (UTC 壁時計を入れると JST 0時以降で日付が1日ずれる)
 *  'YYYY-MM-DD HH:MM:SS' を返す。解析不能なら null。
 */
function toJstWall(value) {
  if (value == null) return null;
  const wall = (d) => (Number.isNaN(d.getTime()) ? null : d.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' }).replace('T', ' ').substring(0, 19));
  if (value instanceof Date) return wall(value);
  const text = String(value).trim();
  if (!text) return null;
  // JST 壁時計の文字列 ('2026-11-12 10:00:00' など) はそのまま使う
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(text)) return text.replace('T', ' ');
  return wall(new Date(text));
}

const ALGO = 'aes-256-gcm';

// 2026/11/8 監査 Critical 対策: 暗号化キーは JWT_SECRET から導出しない
// （JWT secret が漏れた者は全メールパスワードを復号できた）。専用 secret
// MAIL_ENC_SECRET を scrypt で導出する別系統キーへ分離した。
// ローテ手順: .env の MAIL_ENC_SECRET を新値へ変更後、
// `npm run rotate:mail-key -- OLD_SECRET=<旧MAIL_ENC_SECRET>` で再暗号化し、
// サーバーを再起動する。
const KEY_SALT = 'issystem-mail-enc-v2';

/** MAIL_ENC_SECRET から導出する 32バイト暗号化キー */
function deriveKey() {
  return crypto.scryptSync(String(config.mail.encSecret), KEY_SALT, 32);
}

/** 平文パスワード -> iv:tag:暗号文 (base64) */
function encryptPassword(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

/** iv:tag:暗号文 (base64) -> 平文パスワード (復号不能なら null) */
function decryptPassword(payload) {
  try {
    const parts = String(payload || '').split(':');
    if (parts.length !== 3) return null;
    const [ivB64, tagB64, dataB64] = parts;
    const decipher = crypto.createDecipheriv(ALGO, deriveKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch (err) {
    return null;
  }
}

export const mailModel = {
  encryptPassword,
  decryptPassword,

  /** ユーザーのメール接続設定 (1件目 = 主アカウント。無ければ null) */
  async getAccount(userId) {
    const res = await query(
      'SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY created_at, id LIMIT 1',
      [String(userId)]
    );
    return res.rows[0] || null;
  },

  /** 自分の全メール接続設定 (アカウントタブ表示用 / 作成順) */
  async listAccountsForUser(userId) {
    const res = await query(
      'SELECT * FROM mail_accounts WHERE user_id = ? ORDER BY created_at, id',
      [String(userId)]
    );
    return res.rows;
  },

  /** 指定IDの接続設定 (自分のアカウントだけ返す) */
  async getAccountById(accountId, userId) {
    const res = await query(
      'SELECT * FROM mail_accounts WHERE id = ? AND user_id = ?',
      [String(accountId), String(userId)]
    );
    return res.rows[0] || null;
  },

  /** 設定済み全アカウント (サーバー側定期受信ジョブ用 / IMAP 設定のある行のみ、登録順) */
  async listAllAccounts() {
    const res = await query(
      `SELECT * FROM mail_accounts
       WHERE imap_host IS NOT NULL AND imap_port IS NOT NULL
       ORDER BY created_at, id`
    );
    return res.rows;
  },


  /** ユーザーの登録メールアドレス (プロフィールからの初期値提示用) */
  async getUserEmail(userId) {
    const res = await query('SELECT email FROM users WHERE id = ?', [String(userId)]);
    return res.rows[0]?.email || null;
  },

  /** メール接続設定の登録 / 更新 (id 指定は自分のアカウントを更新、未指定は同一ユーザー同一アドレスで UPSERT) */
  async upsertAccount({
    id, user_id, email_address, password_enc,
    imap_host, imap_port, imap_tls, imap_folder,
    smtp_host, smtp_port, smtp_tls, sent_folder, draft_folder, trash_folder, display_name, status,
  }) {
    const cols = [
      ['email_address', String(email_address)],
      ['password_enc', String(password_enc)],
      ['imap_host', imap_host ?? null],
      ['imap_port', imap_port ?? null],
      ['imap_tls', imap_tls || 'none'],
      ['imap_folder', imap_folder || 'INBOX'],
      ['smtp_host', smtp_host ?? null],
      ['smtp_port', smtp_port ?? null],
      ['smtp_tls', smtp_tls || 'none'],
      ['sent_folder', sent_folder || 'Sent'],
      ['draft_folder', draft_folder || '[Drafts]'],
      ['trash_folder', trash_folder || '[Trash]'],
      ['display_name', display_name ?? null],
      ['status', status || 'UNVERIFIED'],
    ];

    // id 指定は自分のアカウントを UPDATE (アドレスを変更しても id と受信メッセージはそのまま残る)
    if (id) {
      const setSql = cols.map(([c]) => `${c} = ?`).join(', ');
      const res = await query(
        `UPDATE mail_accounts SET ${setSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *`,
        [...cols.map(([, v]) => v), String(id)]
      );
      return res.rows[0] || null;
    }

    const res = await query(
      `INSERT INTO mail_accounts (id, user_id, email_address, password_enc, imap_host, imap_port, imap_tls, imap_folder, smtp_host, smtp_port, smtp_tls, sent_folder, draft_folder, trash_folder, display_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, lower(email_address)) DO UPDATE SET
         email_address = EXCLUDED.email_address,
         password_enc  = EXCLUDED.password_enc,
         imap_host     = EXCLUDED.imap_host,
         imap_port     = EXCLUDED.imap_port,
         imap_tls      = EXCLUDED.imap_tls,
         imap_folder   = EXCLUDED.imap_folder,
         smtp_host     = EXCLUDED.smtp_host,
         smtp_port     = EXCLUDED.smtp_port,
         smtp_tls      = EXCLUDED.smtp_tls,
         sent_folder   = EXCLUDED.sent_folder,
         draft_folder  = EXCLUDED.draft_folder,
         trash_folder  = EXCLUDED.trash_folder,
         display_name  = EXCLUDED.display_name,
         status        = EXCLUDED.status,
         updated_at    = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        `mail_${crypto.randomUUID()}`,
        String(user_id),
        String(email_address),
        String(password_enc),
        imap_host ?? null,
        imap_port ?? null,
        imap_tls || 'none',
        imap_folder || 'INBOX',
        smtp_host ?? null,
        smtp_port ?? null,
        smtp_tls || 'none',
        sent_folder || 'Sent',
        draft_folder || '[Drafts]',
        trash_folder || '[Trash]',
        display_name ?? null,
        status || 'UNVERIFIED',
      ]
    );
    return res.rows[0] || null;
  },

  /** メール接続設定の削除 (accountId 指定はそのアカウントのみ / 未指定は全アカウント。messages は CASCADE で消える) */
  async deleteAccount(userId, accountId = null) {
    const res = accountId
      ? await query('DELETE FROM mail_accounts WHERE id = ? AND user_id = ?', [String(accountId), String(userId)])
      : await query('DELETE FROM mail_accounts WHERE user_id = ?', [String(userId)]);
    return res.rowCount > 0;
  },

  /** 接続テスト結果の保存 (status + 最終確認時刻 / アカウント単位) */
  async setStatus(accountId, status) {
    const res = await query(
      `UPDATE mail_accounts SET status = ?, last_checked_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *`,
      [String(status), String(accountId)]
    );
    return res.rows[0] || null;
  },

  /** メッセージ一覧 (folder = 'inbox' 受信ボックス / 'sent' 送信ボックス / 指定アカウント / 新しい順) */
  async listMessages(accountId, folder = 'inbox', limit = 50) {
    const res = await query(
      `SELECT id, user_id, account_id, folder, uid, sender_name, sender_email, recipients, subject, attachments, has_attachments, html_stripped, is_read, received_at, created_at
       FROM mail_messages WHERE account_id = ? AND folder = ? ORDER BY received_at DESC LIMIT ?`,
      [String(accountId), String(folder), Number(limit)]
    );
    return res.rows;
  },

  /** メッセージ 1 ページ (新しい順。cursor は前ページ最古の (received_at, id) より古い行だけ = 無限スクロール用カーソル) */
  async listMessagesPage(accountId, folder = 'inbox', limit = 50, cursor = null) {
    const lim = Math.min(100, Math.max(1, Number(limit) || 50));
    // 下書きと送信済みは本文を DB に持つので、右の detail ペイン表示のため本文も一緒に返す
    const cols = `SELECT id, user_id, account_id, folder, uid, sender_name, sender_email, recipients,
                  subject, attachments, has_attachments, html_stripped, is_read, received_at, created_at${folder === 'sent' || folder === 'drafts' ? ', body' : ''}`;
    let res;
    if (cursor && cursor.received_at && cursor.id) {
      // 列は JST 壁時計の TIMESTAMP。カーソルも JST 壁時計で渡す（UTC 壁時計だと1日ずれる）
      const before = toJstWall(cursor.received_at) ?? nowIso();
      res = await query(
        `${cols} FROM mail_messages
         WHERE account_id = ? AND folder = ? AND (received_at, id) < (?, ?)
         ORDER BY received_at DESC, id DESC LIMIT ?`,
        [String(accountId), String(folder), before, String(cursor.id), lim]
      );
    } else {
      res = await query(
        `${cols} FROM mail_messages WHERE account_id = ? AND folder = ? ORDER BY received_at DESC, id DESC LIMIT ?`,
        [String(accountId), String(folder), lim]
      );
    }
    const rows = res.rows;
    return { rows, hasMore: rows.length === lim };
  },

  /** 指定アカウント・フォルダのメッセージ総件数 (UI の件数表示用) */
  async countMessages(accountId, folder = 'inbox') {
    const res = await query(
      'SELECT COUNT(*) AS count FROM mail_messages WHERE account_id = ? AND folder = ?',
      [String(accountId), String(folder)]
    );
    return Number(res.rows[0]?.count || 0);
  },

  /** 指定アカウント・フォルダの未読件数 (受信ボックスの未読バッジ用) */
  async countUnreadAccount(accountId, folder = 'inbox') {
    const res = await query(
      'SELECT COUNT(*) AS count FROM mail_messages WHERE account_id = ? AND folder = ? AND is_read = 0',
      [String(accountId), String(folder)]
    );
    return Number(res.rows[0]?.count || 0);
  },

  /** 保存済みの IMAP UID 一覧 (新着検知の重複排除用 / アカウント・フォルダ単位) */
  async listStoredUids(accountId, folder = 'inbox') {
    const res = await query(
      'SELECT uid FROM mail_messages WHERE account_id = ? AND folder = ? AND uid IS NOT NULL ORDER BY uid',
      [String(accountId), String(folder)]
    );
    return res.rows.map((r) => String(r.uid));
  },

  /** メッセージ 1 件 (id と user_id が一致する自分だけ。本文と添付情報を含む) */
  async getMessageById(messageId, userId) {
    const res = await query(
      `SELECT * FROM mail_messages WHERE id = ? AND user_id = ? LIMIT 1`,
      [String(messageId), String(userId)]
    );
    return res.rows[0] || null;
  },

  /** 未読件数 (受信ボックス) */
  async countUnread(userId) {
    const res = await query(
      "SELECT COUNT(*) AS count FROM mail_messages WHERE user_id = ? AND folder = 'inbox' AND is_read = 0",
      [String(userId)]
    );
    return Number(res.rows[0]?.count || 0);
  },

  /** 受信ボックスへメールを保存する (アカウント + IMAP UID で重複挿入を防ぐ。Message-ID / In-Reply-To も保存) */
  async upsertInboxMessage({ account_id, user_id, uid, sender_name, sender_email, subject, body, is_read, received_at, message_id = null, in_reply_to = null }) {
    // received_at / sender_* は NOT NULL。日時が解析不能ならサーバー時刻、差出人が空なら空文字で埋める
    const receivedAt = toJstWall(received_at) ?? nowIso();
    const res = await query(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, subject, body, is_read, received_at, message_id, in_reply_to)
       VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, folder, uid) DO UPDATE SET
         sender_name = EXCLUDED.sender_name,
         sender_email = EXCLUDED.sender_email,
         subject = EXCLUDED.subject,
         body = EXCLUDED.body,
         is_read = EXCLUDED.is_read,
         received_at = EXCLUDED.received_at,
         message_id = COALESCE(EXCLUDED.message_id, mail_messages.message_id),
         in_reply_to = COALESCE(EXCLUDED.in_reply_to, mail_messages.in_reply_to)
       RETURNING *`,
      [
        `mail_${crypto.randomUUID()}`,
        String(user_id),
        String(account_id),
        String(uid),
        String(sender_name ?? sender_email ?? ''),
        String(sender_email ?? ''),
        String(subject ?? ''),
        String(body ?? ''),
        is_read ? 1 : 0,
        receivedAt,
        message_id ? String(message_id) : null,
        in_reply_to ? String(in_reply_to) : null,
      ]
    );
    return res.rows[0] || null;
  },

  /** 新着受信のヘッダのみ UPSERT (本文は NULL。件名・差出人・受信日時・添付有無・添付一覧のみ保存。本文は詳細閲覧時に UPDATE)
   * 受信日時が Date ヘッダーから解析できない場合は nowIso フォールバック。account+folder+uid で重複排除。
   * folder は 'inbox' / 'sent' / 'drafts' / 'trash' (IMAP の対応フォルダから同期した行) */
  async upsertHeader({ account_id, user_id, folder = 'inbox', uid, sender_name, sender_email, subject, attachments, html_stripped, is_read, received_at, message_id = null, in_reply_to = null }) {
    const receivedAt = toJstWall(received_at) ?? nowIso();
    const res = await query(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, subject, body, attachments, has_attachments, html_stripped, is_read, received_at, message_id, in_reply_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, folder, uid) DO UPDATE SET
         sender_name = EXCLUDED.sender_name,
         sender_email = EXCLUDED.sender_email,
         subject = EXCLUDED.subject,
         attachments = EXCLUDED.attachments,
         has_attachments = EXCLUDED.has_attachments,
         html_stripped = EXCLUDED.html_stripped,
         is_read = EXCLUDED.is_read,
         received_at = EXCLUDED.received_at,
         message_id = COALESCE(EXCLUDED.message_id, mail_messages.message_id),
         in_reply_to = COALESCE(EXCLUDED.in_reply_to, mail_messages.in_reply_to)
       RETURNING id, account_id, folder, uid, sender_name, sender_email, subject, is_read, message_id`,
      [
        `mail_${crypto.randomUUID()}`,
        String(user_id),
        String(account_id),
        String(folder),
        String(uid),
        String(sender_name ?? sender_email ?? ''),
        String(sender_email ?? '').toLowerCase(),
        String(subject ?? ''),
        JSON.stringify(Array.isArray(attachments) ? attachments : []),
        Array.isArray(attachments) && attachments.length > 0 ? 1 : 0,
        html_stripped ? 1 : 0,
        is_read ? 1 : 0,
        receivedAt,
        message_id ? String(message_id) : null,
        in_reply_to ? String(in_reply_to) : null,
      ]
    );
    return res.rows[0] || null;
  },

  /** 詳細閲覧時に本文 text/plain をキャッシュへ書き込む (body・html_stripped を UPDATE。受信・送信・下書き・ごみ箱の行を対象にする) */
  async updateMessageBody(messageId, userId, body, html_stripped) {
    const res = await query(
      `UPDATE mail_messages SET body = ?, html_stripped = ? WHERE id = ? AND user_id = ? RETURNING id`,
      [String(body ?? ''), html_stripped ? 1 : 0, String(messageId), String(userId)]
    );
    return res.rows[0] || null;
  },

  /** 夜間清理: 受信から days 日超の受信ボックス本文だけを NULL へ戻す (詳細閲覧時に text/plain を再取得)。件名・差出人・添付有無・受信日時は保持 */
  async nullOldBodies(days = 30) {
    const d = Math.max(7, Number(days) || 30);
    const res = await query(
      `UPDATE mail_messages SET body = NULL WHERE folder = 'inbox' AND received_at < (CURRENT_TIMESTAMP - (? || ' days')::interval) AND body IS NOT NULL`,
      [String(d)]
    );
    return res.rowCount ?? 0;
  },

  /** 送信ボックスへ送信記録を追加する */
  async addSentMessage({ account_id, user_id, recipients, sender_name, sender_email, subject, body, message_id = null, in_reply_to = null }) {
    const res = await query(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, recipients, subject, body, is_read, received_at, message_id, in_reply_to)
       VALUES (?, ?, ?, 'sent', NULL, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?, ?)
       RETURNING *`,
      [
        `mail_${crypto.randomUUID()}`,
        String(user_id),
        String(account_id),
        String(sender_name),
        String(sender_email),
        String(recipients),
        String(subject),
        String(body),
        message_id ? String(message_id) : null,
        in_reply_to ? String(in_reply_to) : null,
      ]
    );
    return res.rows[0] || null;
  },

  /** メッセージを既読にする (そのユーザーの受信ボックスのみ) */
  async markRead(messageId, userId) {
    const res = await query(
      `UPDATE mail_messages SET is_read = 1 WHERE id = ? AND user_id = ? AND folder = 'inbox' RETURNING *`,
      [String(messageId), String(userId)]
    );
    return res.rows[0] || null;
  },

  /** uid からフォルダ内のレコードを探す (IMAP 同期の重複排除用 / アカウント・フォルダ単位) */
  async findByUid(accountId, folder, uid) {
    const res = await query(
      'SELECT * FROM mail_messages WHERE account_id = ? AND folder = ? AND uid = ?',
      [String(accountId), String(folder), String(uid)]
    );
    return res.rows[0] || null;
  },

  /** アカウントの各フォルダ件数 (受信箱・送信済み・下書き・ごみ箱のタブ表示用) */
  async countByFolders(accountId) {
    const res = await query(
      'SELECT folder, COUNT(*) AS count FROM mail_messages WHERE account_id = ? GROUP BY folder',
      [String(accountId)]
    );
    const counts = { inbox: 0, sent: 0, drafts: 0, trash: 0 };
    for (const row of res.rows) {
      if (counts[row.folder] !== undefined) counts[row.folder] = Number(row.count || 0);
    }
    return counts;
  },

  /** メッセージをフォルダ間で移動する (ごみ箱入りの移動と受信箱への復元。自分のユーザーの行のみ) */
  async moveMessageFolder(messageId, userId, folder) {
    const res = await query(
      'UPDATE mail_messages SET folder = ? WHERE id = ? AND user_id = ? RETURNING *',
      [String(folder), String(messageId), String(userId)]
    );
    return res.rows[0] || null;
  },

  /** メッセージ行を完全に削除する (自分のユーザーの行のみ。ごみ箱の完全削除用) */
  async deleteMessageById(messageId, userId) {
    const res = await query(
      'DELETE FROM mail_messages WHERE id = ? AND user_id = ?',
      [String(messageId), String(userId)]
    );
    return res.rowCount > 0;
  },

  /** フォルダのDBキャッシュを全消しする (IMAPデータ消去用。消した行のUIDを返す) */
  async clearFolderRows(accountId, folder = 'inbox') {
    const res = await query(
      'DELETE FROM mail_messages WHERE account_id = ? AND folder = ? RETURNING uid',
      [String(accountId), String(folder)]
    );
    return res.rows.map((r) => r.uid).filter((u) => u !== null && u !== undefined);
  },

  /** 下書きを保存する (id 指定はその下書きを更新、未指定は新規。本文は DB に保持する) */
  async upsertDraft({ id, account_id, user_id, sender_email, recipients, subject, body }) {
    if (id) {
      const res = await query(
        `UPDATE mail_messages SET recipients = ?, subject = ?, body = ?
         WHERE id = ? AND user_id = ? AND account_id = ? AND folder = 'drafts' RETURNING *`,
        [String(recipients), String(subject), String(body), String(id), String(user_id), String(account_id)]
      );
      return res.rows[0] || null;
    }
    const res = await query(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, recipients, subject, body, attachments, has_attachments, is_read, received_at)
       VALUES (?, ?, ?, 'drafts', NULL, ?, ?, ?, ?, ?, '[]', 0, 1, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        `mail_${crypto.randomUUID()}`,
        String(user_id),
        String(account_id),
        String(sender_email),
        String(sender_email).toLowerCase(),
        String(recipients),
        String(subject),
        String(body),
      ]
    );
    return res.rows[0] || null;
  },

  /** 下書きを送信済みへ変更する (SMTP 送信成功後。受信日時を送信時刻へ更新) */
  async markDraftSent(messageId, userId, recipients) {
    const res = await query(
      `UPDATE mail_messages SET folder = 'sent', recipients = ?, is_read = 1, received_at = CURRENT_TIMESTAMP
       WHERE id = ? AND user_id = ? AND folder = 'drafts' RETURNING *`,
      [String(recipients), String(messageId), String(userId)]
    );
    return res.rows[0] || null;
  },

  /** 下書き 1 件を読む (自分のユーザー・下書きフォルダのみ) */
  async getDraft(messageId, userId) {
    const res = await query(
      "SELECT * FROM mail_messages WHERE id = ? AND user_id = ? AND folder = 'drafts'",
      [String(messageId), String(userId)]
    );
    return res.rows[0] || null;
  },

  /** 受信ボックス最終確認時刻を更新 (アカウント単位) */
  /** 返信・転送マーク (\Answered /\Forwarded) を自分のメールの imap_flags へ反映する (行が無ければ null) */
  async markKeywords(messageId, userId, keywords = []) {
    const row = await mailModel.getMessageById(messageId, userId);
    if (!row) return null;
    const flags = new Set(String(row.imap_flags || '').split(',').map((f) => f.trim()).filter(Boolean));
    for (const keyword of keywords) if (keyword) flags.add(String(keyword));
    await query(
      'UPDATE mail_messages SET imap_flags = ? WHERE id = ? AND user_id = ?',
      [Array.from(flags).join(','), String(messageId), String(userId)]
    );
    return await mailModel.getMessageById(messageId, userId);
  },

  async touchLastChecked(accountId) {
    const res = await query(
      `UPDATE mail_accounts SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *`,
      [String(accountId)]
    );
    return res.rows[0] || null;
  },
};

export default mailModel;
