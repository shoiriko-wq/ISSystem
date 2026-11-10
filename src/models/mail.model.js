/**
 * ISSystem Mail Account Data Access Model
 * PostgreSQL (mail_accounts) / パスワードは AES-256-GCM で暗号化して保存する
 */

import crypto from 'node:crypto';
import { query } from '../../config/database.js';
import config from '../../config/default.js';

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

  /** ユーザーのメール接続設定 (無ければ null) */
  async getAccount(userId) {
    const res = await query('SELECT * FROM mail_accounts WHERE user_id = ?', [String(userId)]);
    return res.rows[0] || null;
  },

  /** ユーザーの登録メールアドレス (プロフィールからの初期値提示用) */
  async getUserEmail(userId) {
    const res = await query('SELECT email FROM users WHERE id = ?', [String(userId)]);
    return res.rows[0]?.email || null;
  },

  /** メール接続設定の登録 / 更新 (user_id は UNIQUE なので UPSERT) */
  async upsertAccount({
    id, user_id, email_address, password_enc,
    imap_host, imap_port, imap_tls, imap_folder,
    smtp_host, smtp_port, smtp_tls, sent_folder, display_name, status,
  }) {
    const rowId = id || `mail_${String(user_id)}`;
    const res = await query(
      `INSERT INTO mail_accounts (id, user_id, email_address, password_enc, imap_host, imap_port, imap_tls, imap_folder, smtp_host, smtp_port, smtp_tls, sent_folder, display_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
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
         display_name  = EXCLUDED.display_name,
         status        = EXCLUDED.status,
         updated_at    = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        rowId,
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
        display_name ?? null,
        status || 'UNVERIFIED',
      ]
    );
    return res.rows[0] || null;
  },

  /** メール接続設定の削除 (存在すれば true) */
  async deleteAccount(userId) {
    const res = await query('DELETE FROM mail_accounts WHERE user_id = ?', [String(userId)]);
    return res.rowCount > 0;
  },

  /** 全件取得 (管理者・接続機能のバッチ処理用 / 復号はしない) */
  async listAccounts() {
    const res = await query('SELECT * FROM mail_accounts ORDER BY updated_at DESC');
    return res.rows;
  },

  /** 接続テスト結果の保存 (status + 最終確認時刻) */
  async setStatus(userId, status) {
    const res = await query(
      `UPDATE mail_accounts SET status = ?, last_checked_at = CURRENT_TIMESTAMP WHERE user_id = ? RETURNING *`,
      [String(status), String(userId)]
    );
    return res.rows[0] || null;
  },

  /** メッセージ一覧 (folder = 'inbox' 受信ボックス / 'sent' 送信ボックス / 新しい順) */
  async listMessages(userId, folder = 'inbox', limit = 50) {
    const res = await query(
      `SELECT * FROM mail_messages WHERE user_id = ? AND folder = ? ORDER BY received_at DESC LIMIT ?`,
      [String(userId), String(folder), Number(limit)]
    );
    return res.rows;
  },

  /** 未読件数 (受信ボックス) */
  async countUnread(userId) {
    const res = await query(
      "SELECT COUNT(*) AS count FROM mail_messages WHERE user_id = ? AND folder = 'inbox' AND is_read = 0",
      [String(userId)]
    );
    return Number(res.rows[0]?.count || 0);
  },

  /** 受信ボックスへメールを保存する (IMAP UID で重複挿入を防ぐ) */
  async upsertInboxMessage({ user_id, uid, sender_name, sender_email, subject, body, is_read, received_at }) {
    const res = await query(
      `INSERT INTO mail_messages (id, user_id, folder, uid, sender_name, sender_email, subject, body, is_read, received_at)
       VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, folder, uid) DO UPDATE SET
         sender_name = EXCLUDED.sender_name,
         sender_email = EXCLUDED.sender_email,
         subject = EXCLUDED.subject,
         body = EXCLUDED.body,
         is_read = EXCLUDED.is_read,
         received_at = EXCLUDED.received_at
       RETURNING *`,
      [
        `mail_${String(user_id)}_inbox_${String(uid)}`,
        String(user_id),
        String(uid),
        String(sender_name),
        String(sender_email),
        String(subject),
        String(body),
        is_read ? 1 : 0,
        received_at,
      ]
    );
    return res.rows[0] || null;
  },

  /** 送信ボックスへ送信記録を追加する */
  async addSentMessage({ user_id, recipients, sender_name, sender_email, subject, body }) {
    const res = await query(
      `INSERT INTO mail_messages (id, user_id, folder, uid, sender_name, sender_email, recipients, subject, body, is_read, received_at)
       VALUES (?, ?, 'sent', NULL, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        `mail_${crypto.randomUUID()}`,
        String(user_id),
        String(sender_name),
        String(sender_email),
        String(recipients),
        String(subject),
        String(body),
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

  /** uid から受信ボックスのレコードを探す (既読マークの同期用) */
  async findInboxByUid(userId, uid) {
    const res = await query(
      "SELECT * FROM mail_messages WHERE user_id = ? AND folder = 'inbox' AND uid = ?",
      [String(userId), String(uid)]
    );
    return res.rows[0] || null;
  },

  /** 受信ボックス最終確認時刻を更新 */
  async touchLastChecked(userId) {
    const res = await query(
      `UPDATE mail_accounts SET last_checked_at = CURRENT_TIMESTAMP WHERE user_id = ? RETURNING *`,
      [String(userId)]
    );
    return res.rows[0] || null;
  },
};

export default mailModel;
