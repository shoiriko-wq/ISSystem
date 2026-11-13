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
  imapOpenInbox, imapFetchNewEnvelopes, imapFetchBodyText, imapFetchAttachmentBytes,
  normalizeTlsMode, DEFAULT_TIMEOUT_MS,
} from './mail.transport.js';
import { onlineUserIds } from '../utils/presence.js';
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
    body: row.body ?? '',
    attachments: Array.isArray(row.attachments) ? row.attachments : JSON.parse(row.attachments || '[]'),
    has_attachments: Number(row.has_attachments) === 1,
    html_stripped: Number(row.html_stripped) === 1,
    is_read: Number(row.is_read) === 1,
    received_at: row.received_at,
  };
}

/** 接続プローブ (テスト時に差し替え可能なシーム) */
/** mail_messages.attachments (JSON 文字列) を配列へ変換 */
function parseAttachments(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(String(raw || '[]'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const probes = {
  imap: probeImap,
  smtp: probeSmtp,
  fetch: imapFetchMessages,
  append: imapAppend,
  markSeen: imapMarkSeen,
  send: smtpSend,
  openInbox: imapOpenInbox,
  newEnvelopes: imapFetchNewEnvelopes,
  bodyText: imapFetchBodyText,
  attachmentBytes: imapFetchAttachmentBytes,
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
  probes.openInbox = overrides.openInbox ?? imapOpenInbox;
  probes.newEnvelopes = overrides.newEnvelopes ?? imapFetchNewEnvelopes;
  probes.bodyText = overrides.bodyText ?? imapFetchBodyText;
  probes.attachmentBytes = overrides.attachmentBytes ?? imapFetchAttachmentBytes;
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
   * 1アカウントの受信 (IMAP へ接続し、未保存の新着をDBへ幂等に書き込んで受信ボックスを一覧化)
   * UI の手動受信 (fetchInbox) とサーバー側cron (pollAllInboxes) の両方から使う単一実装
   */
  async fetchInboxForAccount(user, account) {
    const p = transportParams(account);
    requireImap(p);

    // 受信失敗（DNS/接続/ログイン）は 502 で返す（cron では失敗カウントへ変換して落とす）
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
      // raw から解析し、項目が欠けていれば取得値・アカウントアドレス・サーバー時刻で埋める (NOT NULL 維持)
      const parsed = parseMessage(item.raw ?? '', item.internaldate ?? item.received_at ?? null);
      const senderEmail = (parsed.sender_email || item.sender_email || account.email_address).toLowerCase();
      const saved = await mailModel.upsertInboxMessage({
        account_id: account.id,
        user_id: user.id,
        uid: item.uid,
        sender_name: parsed.sender_name || item.sender_name || senderEmail,
        sender_email: senderEmail,
        subject: parsed.subject || item.subject || '',
        body: parsed.body ?? item.body ?? '',
        is_read: item.seen === true,
        received_at: parsed.received_at ?? item.received_at ?? item.internaldate ?? new Date().toISOString(),
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
   * 受信ボックスの手動取得 (UI の受信ボタン)
   * POST /api/mail/inbox/refresh (account_id 未指定は主アカウント)
   */
  async fetchInbox(user, accountId = null) {
    const account = await resolveAccount(user, accountId);
    if (!account) {
      throw new ApiError(409, 'メール接続設定が未登録です。最初にメールアドレスとパスワードを登録してください。');
    }
    return this.fetchInboxForAccount(user, account);
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

    // 送信失敗（DNS/接続/ログイン）は 502 で返す（500 の SERVER_ERROR 相当の 502 として監査ログに記録される）
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

  /** サーバー側cronからの定期受信の入口 (cron.jobs.js が呼ぶ。変化したアカウントのみ WSS 通知) */
  /** アクティブ監視サマリー (テスト用: アカウント数 / 接続中の常時接続セッション数) */
  getActiveWatchSummary() {
    return {
      accounts: pollState.watch.size,
      connected: [...pollState.watch.values()].filter((w) => w.connected).length,
    };
  },

  /** 接続中のユーザ集合からアクティブ監視の開始/停止を照合する (IMAP 取得はせずセッション操作のみ)
   *  onlineUserIds: 接続中の user_id 配列 */
  async reconcileActiveWatch(io, onlineUserIds) {
    return reconcileActiveWatch(io, onlineUserIds);
  },

  /** ユーザの disconnect: そのユーザのアカウント全常時接続セッションをログアウト (2〜3秒で不要) */
  dropWatchForUser(userId) {
    return dropWatchForUser(userId);
  },

  /** cron 照合フック (activeSyncMs ごと。IMAP 取得はせず接続集合のみ照合) */
  async reconcileActiveWatchCron(io) {
    return reconcileActiveWatchCron(io);
  },

  /** 夜間清理フック (受信から bodyCacheDays 日超の受信ボックス本文だけを NULL に戻す) */
  async cleanupBodies() {
    const days = config.mail?.bodyCacheDays ?? 30;
    const n = await mailModel.nullOldBodies(days);
    return n;
  },

  /** メール詳細の本文取得。本文キャッシュにあれば DB から返す (IMAP 取得なし)。
   *  無ければ常時接続セッションで text/plain を取得し (HTML 専用メールはタグ除去) キャッシュへ UPDATE する */
  async getMessageBody(user, messageId) {
    const row = await mailModel.getMessageById(messageId, user.id);
    if (!row) throw new ApiError(404, 'メールが見つかりません。');
    if (row.folder !== 'inbox') {
      return { id: row.id, body: row.body ?? '', html_stripped: Number(row.html_stripped) === 1, attachments: parseAttachments(row.attachments) };
    }
    // キャッシュヒット: 本文があればそのまま返す (IMAP 取得しない)
    if (row.body != null && row.body !== '') {
      return { id: row.id, body: row.body, html_stripped: Number(row.html_stripped) === 1, attachments: parseAttachments(row.attachments) };
    }
    // キャッシュミス: 常時接続セッションで本文 text/plain を取得し UPDATE
    const account = await mailModel.getAccountById(row.account_id, user.id);
    if (!account) throw new ApiError(409, 'メール接続設定が見つかりません。');
    const p = transportParams(account);
    requireImap(p);
    let fetched = null;
    const watch = pollState.watch.get(account.id);
    if (watch?.connected && watch.session) {
      try {
        fetched = await probes.bodyText(watch.session, row.uid);
      } catch (_err) {
        fetched = null; // 常時接続が切れているので単発接続へフォールバック
      }
    }
    if (!fetched) {
      // 単発接続フォールバック (接続中でないユーザの共有アカウント閲覧など)
      const session = await probes.openInbox({
        host: p.imapHost, port: p.imapPort, tlsMode: p.imapTls,
        user: p.email, password: p.password, folder: p.imapFolder, timeoutMs: p.timeoutMs,
      });
      try {
        fetched = await session.fetchBodyText(row.uid);
      } finally {
        await session.logout();
      }
    }
    const body = fetched.body ?? '';
    const stripped = fetched.html_stripped === true;
    await mailModel.updateMessageBody(row.id, user.id, body, stripped);
    return { id: row.id, body, html_stripped: stripped, attachments: parseAttachments(row.attachments) };
  },

  /** メール詳細全文 (本文 + html_stripped + 添付メタ)。本文は lazy 取得 (キャッシュ優先)。getFullMessage(messageId, user) */
  async getFullMessage(messageId, user) {
    return this.getMessageBody(user, messageId);
  },

  /** 添付ファイルダウンロード。BODYSTRUCTURE のセクション番号で IMAP から生バイトを取得する */
  async getAttachment(user, messageId, section) {
    const row = await mailModel.getMessageById(messageId, user.id);
    if (!row) throw new ApiError(404, 'メールが見つかりません。');
    const atts = parseAttachments(row.attachments);
    const att = atts.find((a) => Number(a.section) === Number(section));
    if (!att) throw new ApiError(404, '添付ファイルが見つかりません。');
    const account = await mailModel.getAccountById(row.account_id, user.id);
    if (!account) throw new ApiError(409, 'メール接続設定が見つかりません。');
    const p = transportParams(account);
    requireImap(p);
    const watch = pollState.watch.get(account.id);
    let bytes = null;
    if (watch?.connected && watch.session) {
      try {
        bytes = await probes.attachmentBytes(watch.session, row.uid, att.section);
      } catch (_err) {
        bytes = null;
      }
    }
    if (bytes == null) {
      const session = await probes.openInbox({
        host: p.imapHost, port: p.imapPort, tlsMode: p.imapTls,
        user: p.email, password: p.password, folder: p.imapFolder, timeoutMs: p.timeoutMs,
      });
      try {
        bytes = await session.fetchAttachmentBytes(row.uid, att.section);
      } finally {
        await session.logout();
      }
    }
    return { name: att.name, section: att.section, bytes, type: att.type };
  },

  /** 古すぎる本文 (body_cache_days 日超) を DB から削除し、ヘッダと添付メタのみ残す */
  async cleanupBodies() {
    const removed = await mailModel.nullOldBodies(config.mail?.bodyCacheDays ?? 30);
    return { removed };
  },

  /** cron 照合 (activeSyncMs ごと): 接続中ユーザのアカウントを開き、切断ユーザのセッションを閉じ、closed を再開する */
  async reconcileActiveWatchCron(io) {
    return reconcileActiveWatchCron(io);
  },

  /** socket connect 時にそのユーザのアカウントの常時接続監視を開始する */
  async ensureActiveWatchForUser(userId, io) {
    return ensureActiveWatchForUser(userId, io);
  },

  /** socket disconnect 時にそのユーザの常時接続セッションを全て閉じる */
  dropWatchForUser(userId) {
    dropWatchForUser(userId);
  },

  /** 定期受信の状態 (常時接続セッション・接続中ユーザ・実行中フラグ) をリセット (検証用) */
  resetActiveWatch() {
    for (const w of pollState.watch.values()) {
      try { w.session?.logout(); } catch { /* 切断済みなら無視 */ }
    }
    pollState.watch.clear();
    pollState.running = false;
  },

};

export default mailService;

// =============================================================================
// サーバー側定期受信 (cron) と WSS 通知 (2026/11/13)
// クライアント側の setInterval 受信は廃止した (public/js/modules/mail.module.js)。
// IMAP から受信して DB へ幂等に保存し、受信ボックスが変化したアカウントだけ
// user:<id> 個人ルームへ mail:new_messages を通知する。初回は基準値の記録のみで通知しない。
// =============================================================================

/** 定期受信の状態 (アカウントごとのスナップショット / 連続失敗数 / 実行中フラグ) */
const pollState = {
  running: false,
  io: null,
  onlineUsers: onlineUserIds, // 接続中の user_id (presence.js の共有セットへ接続・切断で自動更新)
  watch: new Map(), // account_id -> { accountId, user_id, account, p, session, connected, closed, exists, uidNext, maxUid, idleTag, reconnectAt, failures }
};

/** IDLE セッションの再接続間隔 (25〜29分の乱数で Dovecot imap_idle_max 30分未満に収め、再接続負荷を分散) */
function randReconnectMs() {
  const min = config.mail?.reconnectMinMs ?? 1500000;
  const max = config.mail?.reconnectMaxMs ?? 1740000;
  return min + Math.floor(Math.random() * Math.max(1, max - min + 1));
}

/** 新着ヘッダ (ENVELOPE+BODYSTRUCTURE) を DB へ UPSERT し、変化のあったアカウントだけ WSS で通知する。本文は取得しない。 */
async function ingestNewEnvelopes(watch, envelopes, io = pollState.io) {
  const added = [];
  let maxUid = watch.maxUid;
  for (const env of envelopes) {
    if (!env.uid) continue;
    const saved = await mailModel.upsertHeader({
      account_id: watch.accountId,
      user_id: watch.user_id,
      uid: env.uid,
      sender_name: env.sender_name,
      sender_email: env.sender_email,
      subject: env.subject,
      attachments: env.attachments,
      html_stripped: env.is_html,
      received_at: env.date,
    });
    if (saved) added.push(saved);
    if (env.uid > maxUid) maxUid = env.uid;
  }
  watch.maxUid = maxUid;
  if (added.length && io) {
    const newest = added[added.length - 1];
    const payload = {
      account_id: watch.accountId,
      user_id: watch.user_id,
      account_email: watch.account.email_address,
      added: added.length,
      newest_subject: newest.subject ?? '',
    };
    io.to(`user:${watch.user_id}`).emit('mail:new_messages', payload);
  }
  return added.length;
}

/** 常時接続セッションを再接続 (logout → imapOpenInbox でベースライン maxUid を取り直す → IDLE 開始) */
async function reconnectWatch(watch, io = pollState.io) {
  try { watch.session?.logout(); } catch { /* 切断済みなら無視 */ }
  watch.connected = false;
  try {
    const opened = await probes.openInbox({
      host: watch.p.imapHost, port: watch.p.imapPort, tlsMode: watch.p.imapTls,
      user: watch.p.email, password: watch.p.password, folder: watch.p.imapFolder, timeoutMs: watch.p.timeoutMs,
    });
    watch.session = opened.session;
    watch.exists = opened.exists;
    watch.uidNext = opened.uidNext;
    watch.maxUid = opened.maxUid;
    watch.connected = true;
    watch.failures = 0;
    watch.reconnectAt = Date.now() + randReconnectMs();
    watch.idleTag = await watch.session.idleStart();
    return true;
  } catch (_err) {
    watch.failures = (watch.failures || 0) + 1;
    const backoff = (config.mail?.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 5000;
    if (watch.failures >= (config.mail?.pollMaxFailures ?? 5)) {
      watch.closed = true;
      watch.reconnectAt = Date.now() + 30 * 60 * 1000; // 到達不能アカウントの自動再開は約30分後
    } else {
      watch.reconnectAt = Date.now() + backoff;
    }
    return false;
  }
}

/**
 * 設定済み全アカウントを受信し、受信ボックスが変化したアカウントだけ WSS で通知する
 * @param {import('socket.io').Server|null} io - Socket.io サーバー (検証用の差し替えも可能)
 * @returns {{skipped: boolean, changed: Array, checked: number, failed: number, stopped_accounts: number}}
 */
/** 1アカウントの常時接続 IDLE ループ (受信中に EXISTS/UIDNEXT 増長を検知してヘッダだけ取得し通知する) */
async function runWatchLoop(watch, io = pollState.io) {
  const response = config.mail?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  while (!watch.closed) {
    if (!watch.connected) {
      const ok = await reconnectWatch(watch, io);
      if (watch.closed) break;
      if (!ok) continue;
    }
    const session = watch.session;
    const idleWindow = watch.reconnectAt - Date.now();
    const readTimeout = Math.max(1000, Math.min(idleWindow > 0 ? idleWindow : response, response));
    session.extend(readTimeout + 1000);
    let line;
    try {
      line = await session.idleReadLine(readTimeout);
    } catch (_e) {
      // 応答なし (新着なし)。再接続窓到達なら DONE+再接続、まだ窓内なら IDLE を継続 (次の readTimeout で読む)
      if (watch.reconnectAt - Date.now() <= 0) { await reconnectWatch(watch, io); }
      continue;
    }
    // untagged 応答 (EXISTS/EXPUNGE/REOPEN など) を受けた → IDLE を抜けて SELECT し直して増長を確認
    try {
      await session.idleDone(watch.idleTag);
    } catch {
      await reconnectWatch(watch, io);
      continue;
    }
    if (watch.closed) break;
    let sel;
    try {
      sel = await session.selectInbox(watch.p.imapFolder);
    } catch {
      await reconnectWatch(watch, io);
      continue;
    }
    if (sel.exists > watch.exists || sel.uidNext > watch.uidNext) {
      const envelopes = await probes.newEnvelopes(session, watch.maxUid + 1);
      if (envelopes.length) await ingestNewEnvelopes(watch, envelopes, io);
    }
    watch.exists = sel.exists;
    watch.uidNext = sel.uidNext;
    if (watch.reconnectAt - Date.now() <= 0) { await reconnectWatch(watch, io); continue; }
    try {
      watch.idleTag = await session.idleStart();
    } catch {
      await reconnectWatch(watch, io);
    }
  }
}

/** 接続中ユーザのアカウントを開いて常時接続監視を開始する (未接続アカウントのみ) */
async function ensureActiveWatchForUser(userId, io = pollState.io) {
  pollState.io = io;
  const rows = await mailModel.listAccountsForUser(userId);
  console.log('[ensure] userId=', userId, 'rows=', rows.map((r) => ({ id: r.id, host: r.imap_host, port: r.imap_port })));
  for (const row of rows) {
    if (!row.imap_host || !row.imap_port) continue;
    if (pollState.watch.has(row.id)) continue;
    const p = transportParams(row);
    const watch = {
      accountId: row.id, user_id: row.user_id, account: row, p,
      session: null, connected: false, closed: false,
      exists: 0, uidNext: 0, maxUid: 0, idleTag: null,
      reconnectAt: 0, failures: 0,
    };
    pollState.watch.set(row.id, watch);
    const ok = await reconnectWatch(watch, io);
    if (ok && !watch.closed) runWatchLoop(watch, io);
  }
}

/** ユーザの disconnect: そのユーザのアカウント全常時接続セッションをログアウトし削除する (2〜3秒で不要) */
function dropWatchForUser(userId) {
  for (const [accountId, watch] of pollState.watch.entries()) {
    if (watch.user_id === String(userId)) {
      watch.closed = true;
      try { watch.session?.logout(); } catch { /* 切断済みなら無視 */ }
      pollState.watch.delete(accountId);
    }
  }
}

/** cron 照合 (activeSyncMs ごと): 接続中ユーザのアカウントを開き、切断ユーザのセッションを閉じ、closed を再開する。IMAP 取得はしない。 */
async function reconcileActiveWatchCron(io = pollState.io) {
  if (io) pollState.io = io;
  const out = { opened: [], dropped: [], reopened: [] };
  const rows = await mailModel.listAllAccounts();
  const seen = new Set();
  for (const row of rows) {
    const online = pollState.onlineUsers.has(String(row.user_id));
    const watch = pollState.watch.get(row.id);
    if (!online) {
      if (watch && !seen.has(row.user_id)) {
        dropWatchForUser(row.user_id);
        out.dropped.push(String(row.user_id));
        seen.add(row.user_id);
      }
      continue;
    }
    if (!watch) {
      await ensureActiveWatchForUser(row.user_id, io);
      out.opened.push(String(row.id));
      continue;
    }
    if (watch.closed && watch.reconnectAt - Date.now() <= 0) {
      const ok = await reconnectWatch(watch, io);
      if (ok && !watch.closed) runWatchLoop(watch, io);
      if (ok) out.reopened.push(String(row.id));
    }
  }
  return out;
}

