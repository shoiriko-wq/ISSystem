/**
 * ISSystem メールモジュール
 * 左ペインにメールタイトルと日時、右ペインにメール本文（詳細）を表示する。
 * 「メールの設定」ボタンで接続設定フォーム（メールアドレス・パスワード）を開く。
 * パスワードはサーバー側で AES-256-GCM 暗号化保存され、ブラウザへは返されない。
 */

import { apiGet, apiPost, apiDelete } from '../api.js';
import { escapeHTML, refreshLucideIcons, showToast } from '../ui-helpers.js';
import { state } from '../state.js';

const VIEW_ID = 'view-mail';

let account = null;
let messages = [];
let selectedId = null;
let showSetupForm = true; // 初回は必ず入力フォームを表示

const STATUS_META = {
  UNVERIFIED: { label: '設定保存済み（未接続確認）', cls: 'text-warning-strong', bg: 'bg-warning-soft' },
  VERIFIED: { label: '接続確認済み', cls: 'text-success-strong', bg: 'bg-success-soft' },
  FAILED: { label: '接続失敗', cls: 'text-danger-strong', bg: 'bg-danger-soft' },
};

function statusMeta(status) {
  return STATUS_META[String(status || 'UNVERIFIED')] || STATUS_META.UNVERIFIED;
}

/** JST の日時表記 (詳細・最終受信確認表示用) */
function formatDateTime(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 一覧用の短縮日時 (MM/DD HH:MM) */
function formatShort(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** 未読件数 */
function unreadCount() {
  return messages.filter((m) => !m.is_read).length;
}

/** サイドメニューのメール未読バッジ */
function updateMailUnreadBadge() {
  const badge = document.getElementById('mail-unread-count');
  if (!badge) return;
  const n = unreadCount();
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.classList.toggle('hidden', n === 0);
}

/** API 読み込み失敗時のカード */
function errorCardHtml(message) {
  return `
    <div class="card p-4 border border-danger-soft">
      <div class="flex items-center gap-2.5 text-danger-strong">
        <i data-lucide="alert-triangle" class="w-4 h-4"></i>
        <p class="text-xs font-bold">メール表示の読み込みに失敗しました</p>
      </div>
      <p class="text-[11px] text-soft mt-1.5">${escapeHTML(message || '')}</p>
      <button type="button" id="mail-btn-refresh" class="btn-secondary py-1.5 px-3 text-xs mt-2">再読み込み</button>
    </div>`;
}

/** モジュール共通ヘッダー (アカウント状態 + メール設定ボタン + 再読み込み) */
function headerHtml() {
  const meta = statusMeta(account?.status || 'UNVERIFIED');
  const configured = !!account && !account.needs_setup;
  const summary = configured
    ? `接続アカウント: <span class="font-bold text-main">${escapeHTML(account.email_address)}</span> / 最終受信確認: ${formatDateTime(account.last_checked_at || account.updated_at)}`
    : 'はじめてご利用の方は、メールアドレスとパスワードを入力してください。パスワードはサーバー内で暗号化して保存されます。';

  return `
    <div class="card p-4">
      <div class="flex items-center justify-between gap-3 flex-wrap">
        <div class="flex items-center gap-2.5">
          <i data-lucide="mail" class="w-5 h-5 text-info"></i>
          <h2 class="text-sm font-bold text-main">メール</h2>
        </div>
        <div class="flex items-center gap-2">
          <span class="text-[10px] px-2 py-0.5 rounded border border-divider ${meta.bg} ${meta.cls} font-bold">${meta.label}</span>
          <button type="button" id="mail-btn-settings" class="btn-secondary py-1.5 px-3 text-xs flex items-center gap-1.5">
            <i data-lucide="settings" class="w-3.5 h-3.5"></i> メール設定
          </button>
          <button type="button" id="mail-btn-refresh" class="btn-secondary py-1.5 px-3 text-xs">再読み込み</button>
        </div>
      </div>
      <p class="text-[11px] text-soft mt-2 leading-relaxed">${summary}</p>
    </div>`;
}

/** 初回（および変更時）のメールアドレス・パスワード入力フォーム */
function setupFormHtml(prefillEmail) {
  const configured = !!account && !account.needs_setup;
  const prefillNote = prefillEmail
    ? '<span class="font-normal text-muted">（ユーザー情報に登録済み）</span>'
    : '<span class="font-normal text-muted">（未登録 / 手入力）</span>';

  return `
    <div class="card p-4">
      <h3 class="text-xs font-bold text-main mb-2 flex items-center gap-2">
        <i data-lucide="mail-check" class="w-4 h-4 text-accent"></i> メール接続設定
      </h3>
      <form id="mail-setup-form" class="space-y-3">
        <div>
          <label for="mail-setup-email" class="block text-xs font-semibold text-soft mb-1">メールアドレス ${prefillNote}</label>
          <input type="email" id="mail-setup-email" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                 value="${escapeHTML(prefillEmail || '')}" autocomplete="username" required>
        </div>
        <div>
          <label for="mail-setup-password" class="block text-xs font-semibold text-soft mb-1">メールパスワード</label>
          <input type="password" id="mail-setup-password" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                 autocomplete="new-password" placeholder="メールサービスのパスワード" required>
        </div>
        <details class="text-[11px] text-soft">
          <summary class="cursor-pointer py-1">上級設定（受信 / 送信サーバー）※未入力なら自動</summary>
          <div class="grid grid-cols-2 gap-3 mt-2">
            <div>
              <label for="mail-setup-imap-host" class="block text-[10px] font-semibold text-muted mb-1">受信サーバー (IMAP)</label>
              <input type="text" id="mail-setup-imap-host" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${escapeHTML(account?.imap_host || '')}" placeholder="例: imap.example.ac.jp">
            </div>
            <div>
              <label for="mail-setup-imap-port" class="block text-[10px] font-semibold text-muted mb-1">IMAP ポート</label>
              <input type="number" id="mail-setup-imap-port" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${account?.imap_port ? String(account.imap_port) : ''}" placeholder="993">
            </div>
            <div>
              <label for="mail-setup-smtp-host" class="block text-[10px] font-semibold text-muted mb-1">送信サーバー (SMTP)</label>
              <input type="text" id="mail-setup-smtp-host" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${escapeHTML(account?.smtp_host || '')}" placeholder="例: smtp.example.ac.jp">
            </div>
            <div>
              <label for="mail-setup-smtp-port" class="block text-[10px] font-semibold text-muted mb-1">SMTP ポート</label>
              <input type="number" id="mail-setup-smtp-port" class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${account?.smtp_port ? String(account.smtp_port) : ''}" placeholder="465">
            </div>
          </div>
        </details>
        <div class="flex items-center gap-2 pt-1">
          <button type="submit" class="btn-primary py-2 px-4 text-xs font-bold">接続設定を保存する</button>
          ${configured ? '<button type="button" id="mail-btn-cancel-edit" class="btn-secondary py-2 px-4 text-xs">変更しない</button>' : ''}
          ${configured ? '<button type="button" id="mail-btn-remove" class="btn-danger py-2 px-4 text-xs">設定を削除</button>' : ''}
        </div>
      </form>
    </div>`;
}

/** 左ペイン: メールタイトルと日時一覧 */
function listHtml() {
  const headerBar = `
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-xs font-bold text-main flex items-center gap-2">
        <i data-lucide="inbox" class="w-4 h-4 text-info"></i> 受信箱
      </h3>
      <span class="text-[10px] text-muted">${messages.length}件 / 未読 ${unreadCount()}件</span>
    </div>`;

  if (messages.length === 0) {
    return `
      <div class="card p-3">
        ${headerBar}
        <div id="mail-inbox-list" class="mt-2 max-h-[70vh] overflow-y-auto">
          <div class="text-center py-8 text-[11px] text-muted leading-relaxed">
            <i data-lucide="inbox" class="w-6 h-6 mx-auto mb-2 opacity-60"></i>
            受信箱は空です。メール接続（IMAP / SMTP）の実装後に受信一覧が表示されます。
          </div>
        </div>
      </div>`;
  }

  const items = messages
    .map((m) => {
      const selected = m.id === selectedId;
      const box = selected ? 'border-accent bg-accent-soft' : 'border-divider hover:bg-surface-strong';
      const title = selected ? 'text-accent-strong' : m.is_read ? 'text-soft' : 'text-main';
      return `
        <button type="button" class="mail-item w-full text-left rounded-lg border ${box} p-2.5 transition"
                data-mail-id="${escapeHTML(m.id)}">
          <div class="flex items-start gap-2">
            <span class="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${m.is_read ? 'bg-divider' : 'bg-info'}"></span>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-bold ${title} truncate">${escapeHTML(m.subject)}</div>
              <div class="text-[10px] text-muted mt-0.5 flex items-center gap-1.5">
                <span class="font-mono shrink-0">${formatShort(m.received_at)}</span>
                <span class="truncate">${escapeHTML(m.sender_name)}</span>
              </div>
            </div>
          </div>
        </button>`;
    })
    .join('');

  return `
    <div class="card p-3">
      ${headerBar}
      <div id="mail-inbox-list" class="mt-2 space-y-1.5 max-h-[70vh] overflow-y-auto">${items}</div>
    </div>`;
}

/** 右ペイン: メール本文（詳細） */
function detailHtml() {
  const msg = messages.find((m) => m.id === selectedId);

  if (!msg) {
    return `
      <div class="card p-4 min-h-[180px]" id="mail-detail">
        <div class="text-center py-10 text-[11px] text-muted leading-relaxed">
          <i data-lucide="mail-open" class="w-7 h-7 mx-auto mb-2 opacity-60"></i>
          左のメールを選ぶと、ここに本文が表示されます。
        </div>
      </div>`;
  }

  const stateBadge = msg.is_read
    ? '<span class="badge bg-surface-strong text-muted border-divider shrink-0">既読</span>'
    : '<span class="badge bg-info-soft text-info-strong border-info-soft shrink-0">未読</span>';

  return `
    <div class="card p-4" id="mail-detail">
      <div class="flex items-start justify-between gap-3">
        <h3 id="mail-detail-subject" class="text-sm font-bold text-main leading-relaxed">${escapeHTML(msg.subject)}</h3>
        ${stateBadge}
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
        <span>差出人: <span class="font-bold text-soft">${escapeHTML(msg.sender_name)}</span> &lt;${escapeHTML(msg.sender_email)}&gt;</span>
        <span id="mail-detail-datetime" class="font-mono">受信日時: ${formatDateTime(msg.received_at)}</span>
      </div>
      <div id="mail-detail-body" class="mt-3 pt-3 border-t border-divider text-xs text-main leading-relaxed whitespace-pre-wrap">${escapeHTML(msg.body)}</div>
    </div>`;
}

/** 二ペイン受信箱 (左: タイトルと日時 / 右: 本文) */
function inboxHtml() {
  return `
    <div class="grid grid-cols-1 lg:grid-cols-[minmax(280px,32%)_1fr] gap-4">
      ${listHtml()}
      ${detailHtml()}
    </div>`;
}

/** メールタブの実データ取得 (設定済みなら受信箱も読む) */
export async function loadMailData() {
  if (!state.currentUser || !state.authToken) return;
  const root = document.getElementById(VIEW_ID);
  if (!root) return;

  try {
    const res = await apiGet('/mail/account');
    account = res.account || null;
    const configured = !!account && !account.needs_setup;

    if (configured) {
      const inbox = await apiGet('/mail/messages');
      messages = inbox.messages || [];
      if (!messages.some((m) => m.id === selectedId)) selectedId = messages[0]?.id || null;
    } else {
      messages = [];
      selectedId = null;
      showSetupForm = true;
    }

    renderMailView();
  } catch (err) {
    root.innerHTML = errorCardHtml(err.message);
    refreshLucideIcons();
    updateMailUnreadBadge();
  }
}

/** メールタブの描画 */
function renderMailView() {
  const root = document.getElementById(VIEW_ID);
  if (!root) return;

  const configured = !!account && !account.needs_setup;
  const parts = [headerHtml()];

  if (configured && !showSetupForm) {
    parts.push(inboxHtml());
  } else {
    const prefill = account?.email_address || account?.suggested_email || state.currentUser?.email || '';
    parts.push(setupFormHtml(prefill));
  }

  root.innerHTML = parts.join('');
  refreshLucideIcons();
  updateMailUnreadBadge();
}

/** メールを選ぶ (左一覧 -> 右本文、未読なら既読記録) */
async function selectMessage(id) {
  const msg = messages.find((m) => m.id === id);
  if (!msg) return;
  selectedId = id;

  if (!msg.is_read) {
    try {
      await apiPost(`/mail/messages/${id}/read`);
      msg.is_read = true;
    } catch (err) {
      // 既読記録の失敗は表示を止めない
    }
  }

  renderMailView();
}

/** モジュール初期化 (#view-mail への委譲イベント登録) */
export function initMailModule() {
  const root = document.getElementById(VIEW_ID);
  if (!root) return;

  root.addEventListener('submit', async (e) => {
    if (e.target.id !== 'mail-setup-form') return;
    e.preventDefault();
    await submitSetup();
  });

  root.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-mail-id]');
    if (item) {
      await selectMessage(item.getAttribute('data-mail-id'));
      return;
    }

    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.id === 'mail-btn-refresh') {
      await loadMailData();
      showToast('受信箱を再読み込みしました', 'info');
    } else if (btn.id === 'mail-btn-settings') {
      showSetupForm = true;
      renderMailView();
    } else if (btn.id === 'mail-btn-cancel-edit') {
      showSetupForm = false;
      renderMailView();
    } else if (btn.id === 'mail-btn-remove') {
      await removeAccount();
    }
  });
}

/** 接続設定の保存 (初回はメールアドレス + パスワード) */
async function submitSetup() {
  const payload = {
    email_address: (document.getElementById('mail-setup-email')?.value || '').trim(),
    password: document.getElementById('mail-setup-password')?.value ?? '',
    imap_host: (document.getElementById('mail-setup-imap-host')?.value || '').trim(),
    imap_port: (document.getElementById('mail-setup-imap-port')?.value || '').trim(),
    smtp_host: (document.getElementById('mail-setup-smtp-host')?.value || '').trim(),
    smtp_port: (document.getElementById('mail-setup-smtp-port')?.value || '').trim(),
  };

  try {
    const res = await apiPost('/mail/account', payload);
    account = res.account;
    showSetupForm = false;
    selectedId = null;
    await loadMailData();
    showToast(res.message || 'メール接続設定を保存しました', 'success');
  } catch (err) {
    showToast(err.message || 'メール接続設定の保存に失敗しました', 'error');
  }
}

/** 接続設定の削除 (未設定状態へ戻す) */
async function removeAccount() {
  try {
    const res = await apiDelete('/mail/account');
    account = null;
    messages = [];
    selectedId = null;
    showSetupForm = true;
    renderMailView();
    showToast(res.message || 'メール接続設定を削除しました', 'info');
  } catch (err) {
    showToast(err.message || 'メール接続設定の削除に失敗しました', 'error');
  }
}
