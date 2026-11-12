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

  /** ユーザーの登録メールアドレス (プロフィールからの初期値提示用) */
  async getUserEmail(userId) {
    const res = await query('SELECT email FROM users WHERE id = ?', [String(userId)]);
    return res.rows[0]?.email || null;
  },

  /** メール接続設定の登録 / 更新 (id 指定は自分のアカウントを更新、未指定は同一ユーザー同一アドレスで UPSERT) */
  async upsertAccount({
    id, user_id, email_address, password_enc,
    imap_host, imap_port, imap_tls, imap_folder,
    smtp_host, smtp_port, smtp_tls, sent_folder, display_name, status,
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
      `INSERT INTO mail_accounts (id, user_id, email_address, password_enc, imap_host, imap_port, imap_tls, imap_folder, smtp_host, smtp_port, smtp_tls, sent_folder, display_name, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      `SELECT * FROM mail_messages WHERE account_id = ? AND folder = ? ORDER BY received_at DESC LIMIT ?`,
      [String(accountId), String(folder), Number(limit)]
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

  /** 受信ボックスへメールを保存する (アカウント + IMAP UID で重複挿入を防ぐ) */
  async upsertInboxMessage({ account_id, user_id, uid, sender_name, sender_email, subject, body, is_read, received_at }) {
    // received_at / sender_* は NOT NULL。日時が解析不能ならサーバー時刻、差出人が空なら空文字で埋める
    const receivedAt = toJstWall(received_at) ?? nowIso();
    const res = await query(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, subject, body, is_read, received_at)
       VALUES (?, ?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, folder, uid) DO UPDATE SET
         sender_name = EXCLUDED.sender_name,
         sender_email = EXCLUDED.sender_email,
         subject = EXCLUDED.subject,
         body = EXCLUDED.body,
         is_read = EXCLUDED.is_read,
         received_at = EXCLUDED.received_at
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
      ]
    );
    return res.rows[0] || null;
  },

  /** 送信ボックスへ送信記録を追加する */
  async addSentMessage({ account_id, user_id, recipients, sender_name, sender_email, subject, body }) {
    const res = await query(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, recipients, subject, body, is_read, received_at)
       VALUES (?, ?, ?, 'sent', NULL, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
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

  /** uid から受信ボックスのレコードを探す (既読マークの同期用 / アカウント単位) */
  async findInboxByUid(accountId, uid) {
    const res = await query(
      "SELECT * FROM mail_messages WHERE account_id = ? AND folder = 'inbox' AND uid = ?",
      [String(accountId), String(uid)]
    );
    return res.rows[0] || null;
  },

  /** 受信ボックス最終確認時刻を更新 (アカウント単位) */
  async touchLastChecked(accountId) {
    const res = await query(
      `UPDATE mail_accounts SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *`,
      [String(accountId)]
    );
    return res.rows[0] || null;
  },
};

export default mailModel;
