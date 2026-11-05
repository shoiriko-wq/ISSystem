/**
 * ISSystem Mail Service
 * メール接続設定 (メールアドレス + パスワード) の検証・暗号化保存・監査ログ
 * 初回は未設定 (needs_setup) とし、UI でメールアドレスとパスワードを入力させる
 */

import mailModel from '../models/mail.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const HOST_RE = /^[A-Za-z0-9.-]+$/;
const MIN_PASSWORD = 5;

/** メールアドレス検証 (小文字化・trim) */
function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email) throw new ApiError(400, 'メールアドレスを入力してください。');
  if (!EMAIL_RE.test(email)) throw new ApiError(400, 'メールアドレスの形式が正しくありません。');
  return email;
}

/** メールパスワード検証 (平文のまま保存せず、长度のみ検証) */
function normalizePassword(raw) {
  const pw = String(raw ?? '');
  if (!pw.trim()) throw new ApiError(400, 'メールパスワードを入力してください。');
  if (pw.length < MIN_PASSWORD) throw new ApiError(400, `メールパスワードは${MIN_PASSWORD}文字以上で入力してください。`);
  return pw;
}

/** サーバー名検証 (未入力なら null) */
function normalizeHost(raw, label) {
  const rawStr = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!rawStr) return null;
  const host = rawStr.toLowerCase();
  if (!HOST_RE.test(host)) throw new ApiError(400, `${label}のサーバー名が正しくありません。`);
  return host;
}

/** ポート番号検証 (未入力なら null) */
function normalizePort(raw, label) {
  const rawStr = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!rawStr) return null;
  const port = Number(rawStr);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ApiError(400, `${label}のポート番号が正しくありません。`);
  return port;
}

/** DB 行を UI へ返す形へ正規化 (パスワードは一切返さない) */
function toView(row, suggestedEmail = '') {
  return {
    needs_setup: !row,
    email_address: row ? row.email_address : null,
    suggested_email: row ? row.email_address : suggestedEmail,
    status: row ? row.status : 'UNVERIFIED',
    imap_host: row ? row.imap_host : null,
    imap_port: row ? row.imap_port : null,
    smtp_host: row ? row.smtp_host : null,
    smtp_port: row ? row.smtp_port : null,
    updated_at: row ? row.updated_at : null,
  };
}

/** 受信箱メッセージを UI へ返す形へ正規化 */
function toMessageView(row) {
  return {
    id: row.id,
    sender_name: row.sender_name,
    sender_email: row.sender_email,
    subject: row.subject,
    body: row.body,
    is_read: Number(row.is_read) === 1,
    received_at: row.received_at,
  };
}

/** 受信箱初期シード (設定保存直後に件名と日時が並ぶサンプルメッセージ) */
function buildSeedMessages(userId) {
  const base = Date.now();
  const iso = (msAgo) => new Date(base - msAgo).toISOString();
  return [
    {
      id: `mail_seed_${userId}_1`,
      sender_name: 'システム管理室',
      sender_email: 'system@issystem.example',
      subject: 'システム定期点検のお知らせ',
      body:
        'いつも ISSystem をご利用いただきありがとうございます。\n\n' +
        '以下の日程でシステムの定期点検を実施します。\n' +
        '点検中は約30分間、すべての機能が利用できなくなります。\n\n' +
        '  日時: 2026年11月12日 (木) 18:00 - 18:30\n' +
        '  内容: サーバー定期保守・データバックアップ確認\n\n' +
        '点検前に施設物品予約と考査結果の一時表示を確認してください。\n' +
        'ご不明な点はシステム管理室までご連絡ください。',
      received_at: iso(2 * 60 * 60 * 1000),
    },
    {
      id: `mail_seed_${userId}_2`,
      sender_name: '情報教育委員会',
      sender_email: 'security@issystem.example',
      subject: '情報セキュリティ月間のご案内',
      body:
        '11月は情報セキュリティ月間です。\n\n' +
        '・メールパスワードの定期的な変更をお願いします。\n' +
        '・共用端末からのログアウトを徹底してください。\n' +
        '・不審なメール Received は開かず、システム管理室へ報告してください。\n\n' +
        'ポスターと掲示用データは職員掲示板の添付ファイルから取得できます。',
      received_at: iso(26 * 60 * 60 * 1000),
    },
    {
      id: `mail_seed_${userId}_3`,
      sender_name: '教務課',
      sender_email: 'kyomu@issystem.example',
      subject: '考査日程の変更について',
      body:
        '11月実施の定期考査について、日程が以下の通り変更になりました。\n\n' +
        '・3年教室B: 11月19日 (金) 5限 美術 (50分)\n' +
        '・3年教室C: 11月20日 (土) 4限 美術 (50分)\n\n' +
        'スケジュールタブの時刻表と、施設物品予約の考査予定へ反映済みです。\n' +
        '監督日程の印刷は簡易承認タブの Excel 出力をご利用ください。',
      received_at: iso(50 * 60 * 60 * 1000),
    },
  ];
}

export const mailService = {
  /** 自分のメール接続設定取得 (初回は needs_setup = true) */
  async getAccount(user) {
    const row = await mailModel.getAccount(user.id);
    const profileEmail = row ? '' : await mailModel.getUserEmail(user.id);
    return toView(row, profileEmail || '');
  },

  /** メール接続設定の登録 / 更新 (パスワードは暗号化して保存) */
  async saveAccount(payload, user) {
    const body = payload || {};
    const email = normalizeEmail(body.email_address ?? body.email);
    const password = normalizePassword(body.password);
    const imapHost = normalizeHost(body.imap_host ?? body.imapHost, '受信サーバー (IMAP)');
    const imapPort = normalizePort(body.imap_port ?? body.imapPort, '受信サーバー (IMAP)');
    const smtpHost = normalizeHost(body.smtp_host ?? body.smtpHost, '送信サーバー (SMTP)');
    const smtpPort = normalizePort(body.smtp_port ?? body.smtpPort, '送信サーバー (SMTP)');

    const saved = await mailModel.upsertAccount({
      user_id: user.id,
      email_address: email,
      password_enc: mailModel.encryptPassword(password),
      imap_host: imapHost,
      imap_port: imapPort,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      status: 'UNVERIFIED',
    });

    if (!saved) throw new ApiError(500, 'メール接続設定の保存に失敗しました。');

    await auditModel.logAction({
      userId: user.id,
      action: 'MAIL_ACCOUNT_SAVE',
      targetEntity: 'MAIL_ACCOUNT',
      targetId: saved.id,
      changesJson: JSON.stringify({
        email_address: saved.email_address,
        imap_host: saved.imap_host,
        imap_port: saved.imap_port,
        smtp_host: saved.smtp_host,
        smtp_port: saved.smtp_port,
      }),
    });

    return toView(saved);
  },

  /** メール接続設定の削除 */
  async deleteAccount(user) {
    const row = await mailModel.getAccount(user.id);
    if (!row) throw new ApiError(404, 'メール接続設定が見つかりません。');

    await mailModel.deleteAccount(user.id);

    await auditModel.logAction({
      userId: user.id,
      action: 'MAIL_ACCOUNT_DELETE',
      targetEntity: 'MAIL_ACCOUNT',
      targetId: row.id,
      changesJson: JSON.stringify({ email_address: row.email_address }),
    });

    return { ok: true };
  },

  /** 受信箱の表示 (設定済みなら件名・日時一覧と本文を返す / 未設定は 409) */
  async getInbox(user) {
    const account = await mailModel.getAccount(user.id);
    if (!account) {
      throw new ApiError(409, 'メール接続設定が未登録です。最初にメールアドレスとパスワードを登録してください。');
    }

    if ((await mailModel.countMessages(user.id)) === 0) {
      await mailModel.seedMessages(user.id, buildSeedMessages(user.id));
    }

    const rows = await mailModel.listMessages(user.id);
    const messages = rows.map(toMessageView);
    const unread = messages.filter((m) => !m.is_read).length;

    // 最終確認時刻を記録 (監査ログ対象外)
    await mailModel.touchLastChecked(user.id);

    return { messages, unread };
  },

  /** メッセージを既読にする (自分の受信箱のみ) */
  async markMessageRead(messageId, user) {
    const row = await mailModel.markRead(messageId, user.id);
    if (!row) throw new ApiError(404, 'メッセージが見つかりません。');

    await auditModel.logAction({
      userId: user.id,
      action: 'MAIL_MESSAGE_READ',
      targetEntity: 'MAIL_MESSAGE',
      targetId: row.id,
      changesJson: JSON.stringify({ subject: row.subject }),
    });

    return toMessageView(row);
  },

  /** 復号した接続設定 (メール送受信機能でのサーバー内部使用) */
  async getDecryptedAccount(user) {
    const row = await mailModel.getAccount(user.id);
    if (!row) return null;
    return {
      ...row,
      password: mailModel.decryptPassword(row.password_enc),
    };
  },
};

export default mailService;
