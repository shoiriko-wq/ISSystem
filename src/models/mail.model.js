/**
 * ISSystem Mail Account Data Access Model
 * PostgreSQL (mail_accounts) / パスワードは AES-256-GCM で暗号化して保存する
 */

import crypto from 'node:crypto';
import { query } from '../../config/database.js';
import config from '../../config/default.js';

const ALGO = 'aes-256-gcm';

/** JWT シークレットから導出する 32バイト暗号化キー */
function deriveKey() {
  return crypto.createHash('sha256').update(String(config.auth.jwtSecret)).digest();
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
  async upsertAccount({ id, user_id, email_address, password_enc, imap_host, imap_port, smtp_host, smtp_port, status }) {
    const rowId = id || `mail_${String(user_id)}`;
    const res = await query(
      `INSERT INTO mail_accounts (id, user_id, email_address, password_enc, imap_host, imap_port, smtp_host, smtp_port, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET
         email_address = EXCLUDED.email_address,
         password_enc  = EXCLUDED.password_enc,
         imap_host     = EXCLUDED.imap_host,
         imap_port     = EXCLUDED.imap_port,
         smtp_host     = EXCLUDED.smtp_host,
         smtp_port     = EXCLUDED.smtp_port,
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
        smtp_host ?? null,
        smtp_port ?? null,
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

  /** 受信箱のメッセージ一覧 (新しい順) */
  async listMessages(userId, limit = 50) {
    const res = await query(
      `SELECT * FROM mail_messages WHERE user_id = ? ORDER BY received_at DESC LIMIT ?`,
      [String(userId), Number(limit)]
    );
    return res.rows;
  },

  /** メッセージ件数 (受信箱初期シード判定用) */
  async countMessages(userId) {
    const res = await query('SELECT COUNT(*) AS count FROM mail_messages WHERE user_id = ?', [String(userId)]);
    return Number(res.rows[0]?.count || 0);
  },

  /** メッセージの初期シード挿入 (既存なら何もしない) */
  async seedMessages(userId, messages) {
    for (const msg of messages) {
      await query(
        `INSERT INTO mail_messages (id, user_id, sender_name, sender_email, subject, body, is_read, received_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT (id) DO NOTHING`,
        [String(msg.id), String(userId), String(msg.sender_name), String(msg.sender_email), String(msg.subject), String(msg.body), msg.received_at]
      );
    }
    return messages.length;
  },

  /** メッセージを既読にする (そのユーザーのメッセージのみ) */
  async markRead(messageId, userId) {
    const res = await query(
      `UPDATE mail_messages SET is_read = 1 WHERE id = ? AND user_id = ? RETURNING *`,
      [String(messageId), String(userId)]
    );
    return res.rows[0] || null;
  },

  /** 受信箱最終確認時刻を更新 */
  async touchLastChecked(userId) {
    const res = await query(
      `UPDATE mail_accounts SET last_checked_at = CURRENT_TIMESTAMP WHERE user_id = ? RETURNING *`,
      [String(userId)]
    );
    return res.rows[0] || null;
  },
};

export default mailModel;
