/**
 * ISSystem Mail Service
 * メール接続設定 (メールアドレス + パスワード + 暗号化モード) の検証・暗号化保存・監査ログ
 * 初回は未設定 (needs_setup) とし、UI でメールアドレスとパスワードを入力させる
 * 受信ボックス (IMAP 取得) と送信ボックス (SMTP 送信 + IMAP APPEND) を実接続で扱う
 */

import mailModel from '../models/mail.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';
import {
  probeImap, probeSmtp, imapFetchMessages, imapAppend, imapMarkSeen, smtpSend,
  parseMessage, buildRawMessage,
  normalizeTlsMode, DEFAULT_TIMEOUT_MS,
} from './mail.transport.js';
import config from '../../config/default.js';

const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const HOST_RE = /^[A-Za-z0-9.-]+$/;
const MIN_PASSWORD = 5;
const MAX_RECIPIENTS = 20;

/** .env に保存されたメールサーバー初期値（GitHub にはコミットしない秘匿情報。暗号化の既定は TLS を使用しない） */
function mailDefaults() {
  const m = config.mail || {};
  return {
    imap_host: m.imapHost ?? null,
    imap_port: m.imapPort ?? null,
    imap_tls: normalizeTlsMode(m.imapTls),
    imap_folder: m.inboxFolder ?? 'INBOX',
    smtp_host: m.smtpHost ?? null,
    smtp_port: m.smtpPort ?? null,
    smtp_tls: normalizeTlsMode(m.smtpTls),
    sent_folder: m.sentFolder ?? 'Sent',
    display_name: m.displayName ?? null,
    timeout_ms: m.timeoutMs ?? DEFAULT_TIMEOUT_MS,
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

/** 暗号化モード検証 ('none' = 暗号化なし / 'starttls' / 'tls' = TLS 直結。未指定なら既定値) */
function normalizeTlsField(raw, label, fallback) {
  const rawStr = raw === undefined || raw === null ? '' : String(raw).trim().toLowerCase();
  if (!rawStr) return fallback;
  const mode = normalizeTlsMode(rawStr);
  if (mode !== rawStr) throw new ApiError(400, `${label}の暗号化モードが正しくありません（暗号化なし / STARTTLS / TLS 直結）。`);
  return mode;
}

/** IMAP フォルダ名検証 (未入力なら既定値) */
function normalizeFolder(raw, label, fallback) {
  const rawStr = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!rawStr) return fallback;
  if (rawStr.length > 128 || /[\r\n]/.test(rawStr)) throw new ApiError(400, `${label}のフォルダ名が正しくありません。`);
  return rawStr;
}

/** 差出人名検証 (未入力なら null) */
function normalizeDisplayName(raw) {
  const rawStr = raw === undefined || raw === null ? '' : String(raw).trim();
  if (!rawStr) return null;
  if (rawStr.length > 120) throw new ApiError(400, '差出人名は120文字以内で入力してください。');
  return rawStr;
}

/** 宛先一覧検証 (カンマ・スペース区切りのメールアドレス) */
function normalizeRecipients(raw) {
  const text = Array.isArray(raw) ? raw.join(',') : String(raw ?? '');
  const list = text.split(/[,\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (list.length === 0) throw new ApiError(400, '宛先メールアドレスを入力してください。');
  if (list.length > MAX_RECIPIENTS) throw new ApiError(400, `宛先は${MAX_RECIPIENTS}件までです。`);
  for (const addr of list) {
    if (!EMAIL_RE.test(addr)) throw new ApiError(400, `宛先「${addr}」の形式が正しくありません。`);
  }
  return list;
}

/** DB 行を UI へ返す形へ正規化 (パスワードは一切返さない。未設定時は .env の初期値を返す) */
function toView(row, suggestedEmail = '') {
  const d = mailDefaults();
  return {
    needs_setup: !row,
    id: row ? row.id : null,
    email_address: row ? row.email_address : null,
    suggested_email: row ? row.email_address : suggestedEmail,
    status: row ? row.status : 'UNVERIFIED',
    imap_host: row?.imap_host ?? d.imap_host,
    imap_port: row?.imap_port ?? d.imap_port,
    imap_tls: row?.imap_tls ?? d.imap_tls,
    imap_folder: row?.imap_folder ?? d.imap_folder,
    smtp_host: row?.smtp_host ?? d.smtp_host,
    smtp_port: row?.smtp_port ?? d.smtp_port,
    smtp_tls: row?.smtp_tls ?? d.smtp_tls,
    sent_folder: row?.sent_folder ?? d.sent_folder,
    display_name: row?.display_name ?? d.display_name,
    last_checked_at: row?.last_checked_at ?? null,
    updated_at: row ? row.updated_at : null,
  };
}

/** メッセージ行を UI へ返す形へ正規化 (folder = 'inbox' 受信 / 'sent' 送信) */
function toMessageView(row) {
  return {
    id: row.id,
    folder: row.folder,
    uid: row.uid ?? null,
    sender_name: row.sender_name,
    sender_email: row.sender_email,
    recipients: String(row.recipients || '').split(',').filter(Boolean),
    subject: row.subject,
    body: row.body,
    is_read: Number(row.is_read) === 1,
    received_at: row.received_at,
  };
}

/** 接続プローブ (テスト時に差し替え可能なシーム) */
const probes = {
  imap: probeImap,
  smtp: probeSmtp,
  fetch: imapFetchMessages,
  append: imapAppend,
  markSeen: imapMarkSeen,
  send: smtpSend,
};

/**
 * 接続プローブと送受信関数の差し替え (検証専用。引数が空なら実装へ戻す)
 * @param {{imap?: Function, smtp?: Function, fetch?: Function, append?: Function, markSeen?: Function, send?: Function}} overrides
 */
export function setProbeOverrides(overrides = {}) {
  probes.imap = overrides.imap ?? probeImap;
  probes.smtp = overrides.smtp ?? probeSmtp;
  probes.fetch = overrides.fetch ?? imapFetchMessages;
  probes.append = overrides.append ?? imapAppend;
  probes.markSeen = overrides.markSeen ?? imapMarkSeen;
  probes.send = overrides.send ?? smtpSend;
}

/** 接続設定から IMAP / SMTP をテストし status を決める (暗号化モードは設定値を使う) */
async function probeSettings({ email, password, imapHost, imapPort, imapTls, smtpHost, smtpPort, smtpTls }) {
  const timeoutMs = config.mail?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const imap = await probes.imap({
    host: imapHost,
    port: imapPort,
    tlsMode: imapTls,
    user: email,
    password,
    timeoutMs,
  });
  const smtp = await probes.smtp({
    host: smtpHost,
    port: smtpPort,
    tlsMode: smtpTls,
    user: email,
    password,
    timeoutMs,
  });
  return { imap, smtp, status: imap.ok && smtp.ok ? 'VERIFIED' : 'FAILED' };
}



/** 接続設定から送受信用のパラメータを作る (パスワードは復号して使う) */
function transportParams(row) {
  const password = mailModel.decryptPassword(row.password_enc);
  if (!password) {
    throw new ApiError(409, '登録済みパスワードを復号できません。再度入力して保存してください。');
  }
  const d = mailDefaults();
  return {
    email: row.email_address,
    password,
    imapHost: row.imap_host ?? d.imap_host,
    imapPort: row.imap_port ?? d.imap_port,
    imapTls: normalizeTlsMode(row.imap_tls ?? d.imap_tls),
    imapFolder: row.imap_folder ?? d.imap_folder,
    smtpHost: row.smtp_host ?? d.smtp_host,
    smtpPort: row.smtp_port ?? d.smtp_port,
    smtpTls: normalizeTlsMode(row.smtp_tls ?? d.smtp_tls),
    sentFolder: row.sent_folder ?? d.sent_folder,
    displayName: row.display_name ?? d.display_name ?? row.sender_name ?? null,
    timeoutMs: d.timeout_ms,
  };
}

/** 受信サーバーの必須チェック (未設定では受信箱を取得できない) */
function requireImap(p) {
  if (!p.imapHost || !p.imapPort) {
    throw new ApiError(409, '受信サーバー (IMAP) が設定されていません。メール設定で入力してください。');
  }
}

/** 送信サーバーの必須チェック (未設定ではメールを送れない) */
function requireSmtp(p) {
  if (!p.smtpHost || !p.smtpPort) {
    throw new ApiError(409, '送信サーバー (SMTP) が設定されていません。メール設定で入力してください。');
  }
}

/** 送信用アカウント解決 (account_id 未指定は主アカウント = 作成1件目) */
async function resolveAccount(user, accountId = null) {
  return accountId
    ? await mailModel.getAccountById(accountId, user.id)
    : await mailModel.getAccount(user.id);
}

export const mailService = {
  /** 自分のメール接続設定取得 (初回は needs_setup = true。1件目を主アカウントとして返す) */
  async getAccount(user) {
    const row = await mailModel.getAccount(user.id);
    const profileEmail = row ? '' : await mailModel.getUserEmail(user.id);
    return toView(row, profileEmail || '');
  },

  /** 自分の全メール接続設定 (アカウントタブ表示用。未設定時は .env 初期値 1 件を needs_setup で返す) */
  async listAccounts(user) {
    const rows = await mailModel.listAccountsForUser(user.id);
    if (rows.length === 0) {
      const profileEmail = await mailModel.getUserEmail(user.id);
      return { accounts: [toView(null, profileEmail || '')] };
    }
    return { accounts: rows.map((row) => toView(row)) };
  },

  /** メール接続設定の登録 / 更新 (パスワードは暗号化して保存。暗号化モードとフォルダも保存) */
  async saveAccount(payload, user) {
    const body = payload || {};
    const email = normalizeEmail(body.email_address ?? body.email);
    const password = normalizePassword(body.password);
    const d = mailDefaults();
    const imapHost = normalizeHost(body.imap_host ?? body.imapHost, '受信サーバー (IMAP)') ?? d.imap_host;
    const imapPort = normalizePort(body.imap_port ?? body.imapPort, '受信サーバー (IMAP)') ?? d.imap_port;
    const imapTls = normalizeTlsField(body.imap_tls ?? body.imapTls, '受信サーバー (IMAP)', d.imap_tls);
    const imapFolder = normalizeFolder(body.imap_folder ?? body.imapFolder, '受信フォルダ', d.imap_folder);
    const smtpHost = normalizeHost(body.smtp_host ?? body.smtpHost, '送信サーバー (SMTP)') ?? d.smtp_host;
    const smtpPort = normalizePort(body.smtp_port ?? body.smtpPort, '送信サーバー (SMTP)') ?? d.smtp_port;
    const smtpTls = normalizeTlsField(body.smtp_tls ?? body.smtpTls, '送信サーバー (SMTP)', d.smtp_tls);
    const sentFolder = normalizeFolder(body.sent_folder ?? body.sentFolder, '送信済みフォルダ', d.sent_folder);
    const displayName = normalizeDisplayName(body.display_name ?? body.displayName);

    // id 指定は自分のアカウントを更新、未指定は同一アドレスがあれば更新 / 無ければ新規作成
    const requestedId = body.id ? String(body.id) : null;
    const targetRow = requestedId ? await mailModel.getAccountById(requestedId, user.id) : null;
    if (requestedId && !targetRow) {
      throw new ApiError(404, '更新対象のメール接続設定が見つかりません。');
    }

    const saved = await mailModel.upsertAccount({
      id: targetRow?.id ?? null,
      user_id: user.id,
      email_address: email,
      password_enc: mailModel.encryptPassword(password),
      imap_host: imapHost,
      imap_port: imapPort,
      imap_tls: imapTls,
      imap_folder: imapFolder,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_tls: smtpTls,
      sent_folder: sentFolder,
      display_name: displayName,
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
        imap_tls: saved.imap_tls,
        imap_folder: saved.imap_folder,
        smtp_host: saved.smtp_host,
        smtp_port: saved.smtp_port,
        smtp_tls: saved.smtp_tls,
        sent_folder: saved.sent_folder,
        display_name: saved.display_name,
      }),
    });

    return toView(saved);
  },

  /** メール接続設定の削除 (accountId 指定はそのアカウントのみ / 未指定は自分の全アカウント) */
  async deleteAccount(user, accountId = null) {
    const rows = accountId
      ? await mailModel.listAccountsForUser(user.id).then((all) => all.filter((r) => r.id === String(accountId)))
      : await mailModel.listAccountsForUser(user.id);
    if (!rows.length) throw new ApiError(404, 'メール接続設定が見つかりません。');

    const targetIds = rows.map((r) => r.id);
    await Promise.all(targetIds.map((id) => mailModel.deleteAccount(user.id, id)));

    for (const row of rows) {
      await auditModel.logAction({
        userId: user.id,
        action: 'MAIL_ACCOUNT_DELETE',
        targetEntity: 'MAIL_ACCOUNT',
        targetId: row.id,
        changesJson: JSON.stringify({ email_address: row.email_address }),
      });
    }

    return { ok: true };
  },

  /**
   * ボックス表示 (folder='inbox' 受信ボックス / 'sent' 送信ボックス。DBに保存済みだけを返す)
   * GET /api/mail/messages?folder=inbox|sent&account_id= (account_id 未指定は主アカウント)
   */
  async getInbox(user, folder = 'inbox', accountId = null) {
    const account = await resolveAccount(user, accountId);
    if (!account) {
      throw new ApiError(409, 'メール接続設定が未登録です。最初にメールアドレスとパスワードを登録してください。');
    }

    const normalized = folder === 'sent' ? 'sent' : 'inbox';
    const rows = await mailModel.listMessages(account.id, normalized);
    const messages = rows.map(toMessageView);
    const unread = messages.filter((m) => !m.is_read).length;

    // 最終確認時刻を記録 (監査ログ対象外)
    await mailModel.touchLastChecked(account.id);

    return { folder: normalized, account_id: account.id, messages, unread };
  },

  /**
   * 受信ボックスの取得 (IMAP に接続し、まだ保存されていない新着をDBへ書き込んで一覧を返す)
   * POST /api/mail/inbox/refresh (account_id 未指定は主アカウント)
   */
  async fetchInbox(user, accountId = null) {
    const account = await resolveAccount(user, accountId);
    if (!account) {
      throw new ApiError(409, 'メール接続設定が未登録です。最初にメールアドレスとパスワードを登録してください。');
    }

    const p = transportParams(account);
    requireImap(p);

    // 受信失敗（DNS/接続/ログイン）は 502 として扱う（500 の SERVER_ERROR 監査ログを出さない）
    let fetched = [];
    try {
      fetched = await probes.fetch({
        host: p.imapHost,
        port: p.imapPort,
        tlsMode: p.imapTls,
        user: p.email,
        password: p.password,
        folder: p.imapFolder,
        timeoutMs: p.timeoutMs,
      });
    } catch (err) {
      throw new ApiError(502, `受信に失敗しました: ${err.message}`);
    }

    let added = 0;
    for (const item of fetched) {
      const existing = await mailModel.findInboxByUid(account.id, item.uid);
      if (existing) continue;
      const parsed = parseMessage(item.raw, item.internaldate);
      const saved = await mailModel.upsertInboxMessage({
        account_id: account.id,
        user_id: user.id,
        sender_name: parsed.sender_name,
        sender_email: parsed.sender_email,
        subject: parsed.subject,
        body: parsed.body,
        received_at: parsed.received_at,
        uid: item.uid,
      });
      if (saved) added += 1;
    }

    await mailModel.touchLastChecked(account.id);

    const rows = await mailModel.listMessages(account.id, 'inbox');
    const messages = rows.map(toMessageView);
    return {
      folder: 'inbox',
      account_id: account.id,
      messages,
      unread: messages.filter((m) => !m.is_read).length,
      fetched: fetched.length,
      added,
    };
  },

  /**
   * メール送信 (SMTP で送り、送信済みボックスへDB保存。IMAP が設定済みなら送信済みフォルダへも保存)
   * POST /api/mail/send (payload.account_id 未指定は主アカウント)
   */
  async sendMessage(user, payload) {
    const account = await resolveAccount(user, payload?.account_id ?? payload?.accountId ?? null);
    if (!account) {
      throw new ApiError(409, 'メール接続設定が未登録です。最初にメールアドレスとパスワードを登録してください。');
    }

    const p = transportParams(account);
    requireSmtp(p);

    const recipients = normalizeRecipients(payload?.to ?? payload?.recipients);
    const subject = String(payload?.subject ?? '').trim();
    const bodyText = String(payload?.body ?? payload?.text ?? '').replace(/\r/g, '');
    if (!subject) throw new ApiError(400, '件名を入力してください。');
    if (!bodyText) throw new ApiError(400, '本文を入力してください。');

    const raw = buildRawMessage({
      from: p.email,
      displayName: p.displayName,
      to: recipients,
      subject,
      body: bodyText,
    });

    // 送信失敗（DNS/接続/ログイン）は 502 として扱う（500 の SERVER_ERROR 監査ログを出さない）
    let sent;
    try {
      sent = await probes.send({
        host: p.smtpHost,
        port: p.smtpPort,
        tlsMode: p.smtpTls,
        user: p.email,
        password: p.password,
        from: p.email,
        to: recipients,
        raw,
        timeoutMs: p.timeoutMs,
      });
    } catch (err) {
      throw new ApiError(502, `送信に失敗しました: ${err.message}`);
    }

    if (!sent.ok) throw new ApiError(502, `送信に失敗しました: ${sent.message}`);

    const row = await mailModel.addSentMessage({
      account_id: account.id,
      user_id: user.id,
      sender_email: p.email,
      sender_name: p.displayName || '',
      recipients,
      subject,
      body: bodyText,
    });

    // 送信済みフォルダへの保存は送信成功とは切り分ける (IMAP 未設定なら行わない)
    let appendWarning = null;
    if (p.imapHost && p.imapPort) {
      try {
        await probes.append({
          host: p.imapHost,
          port: p.imapPort,
          tlsMode: p.imapTls,
          user: p.email,
          password: p.password,
          folder: p.sentFolder,
          raw,
          timeoutMs: p.timeoutMs,
        });
      } catch (err) {
        appendWarning = `送信済みフォルダに保存できませんでした: ${err.message}`;
      }
    }

    await auditModel.logAction({
      userId: user.id,
      action: 'MAIL_SEND',
      targetEntity: 'MAIL_MESSAGE',
      targetId: row?.id ?? null,
      changesJson: JSON.stringify({ recipients, subject }),
    });

    return { ok: true, message: toMessageView(row), append_warning: appendWarning };
  },

  /** メッセージを既読にする (自分のボックスのみ。受信ボックスでは IMAP 側にも既読フラグを立てる) */
  async markMessageRead(messageId, user) {
    const row = await mailModel.markRead(messageId, user.id);
    if (!row) throw new ApiError(404, 'メッセージが見つかりません。');

    // IMAP の既読フラグは best-effort (サーバー側の失敗でDBの既読状態を巻き戻さない)
    if (row.folder === 'inbox' && row.uid) {
      try {
        const accountRow = row.account_id
          ? await mailModel.getAccountById(row.account_id, user.id)
          : await mailModel.getAccount(user.id);
        const p = transportParams(accountRow);
        await probes.markSeen({
          host: p.imapHost,
          port: p.imapPort,
          tlsMode: p.imapTls,
          user: p.email,
          password: p.password,
          folder: p.imapFolder,
          uid: row.uid,
          timeoutMs: p.timeoutMs,
        });
      } catch (_err) {
        // 既読はDBで記録済み。サーバー反映は次回以降に任せる
      }
    }

    await auditModel.logAction({
      userId: user.id,
      action: 'MAIL_MESSAGE_READ',
      targetEntity: 'MAIL_MESSAGE',
      targetId: row.id,
      changesJson: JSON.stringify({ subject: row.subject }),
    });

    return toMessageView(row);
  },

  /** 復号した接続設定 (メール送受信機能でのサーバー内部使用 / account_id 未指定は主アカウント) */
  async getDecryptedAccount(user, accountId = null) {
    const row = await resolveAccount(user, accountId);
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
    let imapTls = null;
    let smtpHost = null;
    let smtpPort = null;
    let smtpTls = null;

    if (wantsProbe) {
      // フォーム入力値でのプレテスト (DB へ書き込まず status も変更しない)
      email = normalizeEmail(body.email_address ?? body.email);
      password = normalizePassword(body.password);
      imapHost = normalizeHost(body.imap_host ?? body.imapHost, '受信サーバー') ?? d.imap_host;
      imapPort = normalizePort(body.imap_port ?? body.imapPort, '受信ポート') ?? d.imap_port;
      imapTls = normalizeTlsField(body.imap_tls ?? body.imapTls, '受信サーバー', d.imap_tls);
      smtpHost = normalizeHost(body.smtp_host ?? body.smtpHost, '送信サーバー') ?? d.smtp_host;
      smtpPort = normalizePort(body.smtp_port ?? body.smtpPort, '送信ポート') ?? d.smtp_port;
      smtpTls = normalizeTlsField(body.smtp_tls ?? body.smtpTls, '送信サーバー', d.smtp_tls);
    } else {
      row = await resolveAccount(user, body.account_id ?? body.accountId ?? null);
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
      imapTls = normalizeTlsMode(row.imap_tls ?? d.imap_tls);
      smtpHost = row.smtp_host ?? d.smtp_host;
      smtpPort = row.smtp_port ?? d.smtp_port;
      smtpTls = normalizeTlsMode(row.smtp_tls ?? d.smtp_tls);
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
      imapTls,
      smtpHost,
      smtpPort,
      smtpTls,
    });

    const result = {
      status,
      imap: { ok: imap.ok, message: imap.message },
      smtp: { ok: smtp.ok, message: smtp.message },
      checked_at: new Date().toISOString(),
      email_address: email,
      imap_host: imapHost,
      imap_port: imapPort,
      imap_tls: imapTls,
      smtp_host: smtpHost,
      smtp_port: smtpPort,
      smtp_tls: smtpTls,
    };

    // 保存済み設定のテスト時のみ status を更新し監査ログへ残す (テストしたアカウント単位)
    if (row) {
      const updated = await mailModel.setStatus(row.id, status);
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
