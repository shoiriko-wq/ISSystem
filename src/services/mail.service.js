/**
 * ISSystem Mail Service
 * メール接続設定 (メールアドレス + パスワード) の検証・暗号化保存・監査ログ
 * 初回は未設定 (needs_setup) とし、UI でメールアドレスとパスワードを入力させる
 */

import mailModel from '../models/mail.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';
import { probeImap, probeSmtp, DEFAULT_TIMEOUT_MS } from './mail.transport.js';
import config from '../../config/default.js';

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const HOST_RE = /^[A-Za-z0-9.-]+$/;
const MIN_PASSWORD = 5;

/** .env に保存されたメールサーバー初期値（GitHub にはコミットしない秘匿情報） */
function mailDefaults() {
  const m = config.mail || {};
  return {
    imap_host: m.imapHost ?? null,
    imap_port: m.imapPort ?? null,
    smtp_host: m.smtpHost ?? null,
    smtp_port: m.smtpPort ?? null,
  };
}

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

/** DB 行を UI へ返す形へ正規化 (パスワードは一切返さない。未設定時は .env の初期値を返す) */
function toView(row, suggestedEmail = '') {
  const d = mailDefaults();
  return {
    needs_setup: !row,
    email_address: row ? row.email_address : null,
    suggested_email: row ? row.email_address : suggestedEmail,
    status: row ? row.status : 'UNVERIFIED',
    imap_host: row?.imap_host ?? d.imap_host,
    imap_port: row?.imap_port ?? d.imap_port,
    smtp_host: row?.smtp_host ?? d.smtp_host,
    smtp_port: row?.smtp_port ?? d.smtp_port,
    last_checked_at: row?.last_checked_at ?? null,
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

/** 接続プローブ (テスト時に差し替え可能なシーム) */
const probes = { imap: probeImap, smtp: probeSmtp };

/**
 * 接続プローブの差し替え (検証専用。引数が空なら実装へ戻す)
 * @param {{imap?: Function, smtp?: Function}} overrides
 */
export function setProbeOverrides(overrides = {}) {
  probes.imap = overrides.imap ?? probeImap;
  probes.smtp = overrides.smtp ?? probeSmtp;
}

/** 接続設定から IMAP / SMTP をテストし status を決める */
async function probeSettings({ email, password, imapHost, imapPort, smtpHost, smtpPort }) {
  const timeoutMs = config.mail?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const imap = await probes.imap({
    host: imapHost,
    port: imapPort,
    secure: Number(imapPort) === 993,
    user: email,
    password,
    timeoutMs,
  });
  const smtp = await probes.smtp({
    host: smtpHost,
    port: smtpPort,
    secure: Number(smtpPort) === 465,
    user: email,
    password,
    timeoutMs,
  });
  return { imap, smtp, status: imap.ok && smtp.ok ? 'VERIFIED' : 'FAILED' };
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
    const d = mailDefaults();
    const imapHost = normalizeHost(body.imap_host ?? body.imapHost, '受信サーバー (IMAP)') ?? d.imap_host;
    const imapPort = normalizePort(body.imap_port ?? body.imapPort, '受信サーバー (IMAP)') ?? d.imap_port;
    const smtpHost = normalizeHost(body.smtp_host ?? body.smtpHost, '送信サーバー (SMTP)') ?? d.smtp_host;
    const smtpPort = normalizePort(body.smtp_port ?? body.smtpPort, '送信サーバー (SMTP)') ?? d.smtp_port;

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

  /**
   * 接続テスト (設定済みなら保存設定でテストし status を更新、未保存のフォーム値はテストのみ)
   * POST /api/mail/test
   */
  async testConnection(payload, user) {
    const body = payload || {};
    const d = mailDefaults();
    const wantsProbe = typeof body.password === 'string' && body.password.trim() !== '';

    let email = null;
    let password = null;
    let row = null;
    let imapHost = null;
    let imapPort = null;
    let smtpHost = null;
    let smtpPort = null;

    if (wantsProbe) {
      // フォーム入力値でのプレテスト (DB へ書き込まず status も変更しない)
      email = normalizeEmail(body.email_address ?? body.email);
      password = normalizePassword(body.password);
      imapHost = normalizeHost(body.imap_host ?? body.imapHost, '受信サーバー') ?? d.imap_host;
      imapPort = normalizePort(body.imap_port ?? body.imapPort, '受信ポート') ?? d.imap_port;
      smtpHost = normalizeHost(body.smtp_host ?? body.smtpHost, '送信サーバー') ?? d.smtp_host;
      smtpPort = normalizePort(body.smtp_port ?? body.smtpPort, '送信ポート') ?? d.smtp_port;
    } else {
      row = await mailModel.getAccount(user.id);
      if (!row) {
        throw new ApiError(409, '接続テストの前にメールアドレスとパスワードを登録してください。');
      }
      password = mailModel.decryptPassword(row.password_enc);
      if (!password) {
        throw new ApiError(409, '登録済みパスワードを復号できません。再度入力して保存してください。');
      }
      email = row.email_address;
      imapHost = row.imap_host ?? d.imap_host;
      imapPort = row.imap_port ?? d.imap_port;
      smtpHost = row.smtp_host ?? d.smtp_host;
      smtpPort = row.smtp_port ?? d.smtp_port;
    }

    if (!imapHost || !imapPort) {
      throw new ApiError(409, '受信サーバー (IMAP) が設定されていません。接続テストの前に設定してください。');
    }
    if (!smtpHost || !smtpPort) {
      throw new ApiError(409, '送信サーバー (SMTP) が設定されていません。接続テストの前に設定してください。');
    }

    const { imap, smtp, status } = await probeSettings({
      email,
      password,
      imapHost,
      imapPort,
      smtpHost,
      smtpPort,
    });

    const result = {
      status,
      imap: { ok: imap.ok, message: imap.message },
      smtp: { ok: smtp.ok, message: smtp.message },
      checked_at: new Date().toISOString(),
      email_address: email,
      imap_host: imapHost,
      imap_port: imapPort,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
    };

    // 保存済み設定のテスト時のみ status を更新し監査ログへ残す
    if (row) {
      const updated = await mailModel.setStatus(user.id, status);
      result.account = toView(updated);
      await auditModel.logAction({
        userId: user.id,
        action: 'MAIL_CONNECTION_TEST',
        targetEntity: 'MAIL_ACCOUNT',
        targetId: row.id,
        changesJson: JSON.stringify({
          status,
          imap_ok: imap.ok,
          imap_message: imap.message,
          smtp_ok: smtp.ok,
          smtp_message: smtp.message,
        }),
      });
    }

    return result;
  },
};

export default mailService;
