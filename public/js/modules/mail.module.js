/**
 * ISSystem メールモジュール
 * 左ペインにメールタイトルと日時、右ペインにメール本文（詳細）を表示する。
 * 「メールの設定」ボタンで接続設定フォーム（メールアドレス・パスワード）を開く。
 * パスワードはサーバー側で AES-256-GCM 暗号化保存され、ブラウザへは返されない。
 */

import { apiGet, apiPost, apiDelete } from '../api.js';
import { escapeHTML, refreshLucideIcons, showToast, openModal, closeModal } from '../ui-helpers.js';
import { state } from '../state.js';
import { socketClient } from '../socket.js';
import { switchTab } from '../main.js';

const VIEW_ID = 'view-mail';

let account = null;
let accounts = [];           // 自分の全メール接続設定 (アカウントタブ表示用)
let activeAccountId = null;  // 表示中のアカウントID
let folder = 'inbox';      // 'inbox' = 受信ボックス / 'sent' = 送信ボックス
let inboxMessages = [];    // 受信ボックス（IMAP から取得してDBに保存済み / 表示中アカウント）
let sentMessages = [];     // 送信ボックス（このシステムから送信したメール / 表示中アカウント）
let messagesByAccount = {}; // accountId -> { inbox: [], sent: [] }
let selectedInboxId = null;
let selectedSentId = null;
let showSetupForm = true; // 初回は必ず入力フォームを表示
let setupTargetId = null; // 設定フォームの編集対象 (null = 新規追加 / activeAccountId = 編集中)
let lastTest = null;      // 直近の接続テスト結果
let testing = false;      // 接続テスト実行中（二重クリック防止）
let fetching = false;     // 受信ボックスの取得中（二重クリック防止）
let sending = false;      // 送信中（二重クリック防止）

const SERVER_POLL_MS = 60000; // サーバー側cronの定期受信間隔 (src/utils/cron.jobs.js / MAIL_POLL_INTERVAL_MS)
let socketBound = false;      // WSS の mail:new_messages ハンドラを登録したか

/** 表示中のボックス一覧 (受信 / 送信) */
function currentList() {
  return folder === 'sent' ? sentMessages : inboxMessages;
}

/** 表示中のボックスで選択中のメールID */
function currentSelectedId() {
  return folder === 'sent' ? selectedSentId : selectedInboxId;
}

/** 選択中IDをボックスごとに設定 */
function setCurrentSelectedId(id) {
  if (folder === 'sent') selectedSentId = id;
  else selectedInboxId = id;
}

const STATUS_META = {
  UNVERIFIED: { label: '設定保存済み（未接続確認）', cls: 'text-warning-strong', bg: 'bg-warning-soft' },
  VERIFIED: { label: '接続確認済み', cls: 'text-success-strong', bg: 'bg-success-soft' },
  FAILED: { label: '接続失敗', cls: 'text-danger-strong', bg: 'bg-danger-soft' },
};

function statusMeta(status) {
  return STATUS_META[String(status || 'UNVERIFIED')] || STATUS_META.UNVERIFIED;
}

/** 暗号化モードの表示値 ('none' / 'starttls' / 'tls')。未知の値は 'none' に寄せる */
function tlsValue(mode) {
  const key = String(mode || 'none').toLowerCase();
  return (key === 'starttls' || key === 'tls') ? key : 'none';
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

/** 未読件数（受信ボックスだけ。送信ボックスは未読を数えない） */
function unreadCount() {
  return inboxMessages.filter((m) => !m.is_read).length;
}

/** 全アカウントの未読合計（サイドバーバッジ用） */
function totalUnread() {
  return Object.values(messagesByAccount)
    .reduce((sum, store) => sum + (store.inbox || []).filter((m) => !m.is_read).length, 0);
}

/** サイドメニューのメール未読バッジ（全アカウント合計） */
function updateMailUnreadBadge() {
  const badge = document.getElementById('mail-unread-count');
  if (!badge) return;
  const n = totalUnread();
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

/** モジュール共通ヘッダー（掲示板・施設物品予約と同一デザインのツールバー：左にアイコン＋タイトル、右にコントロール。高さを 2.4rem に統一） */
function headerHtml() {
  const meta = statusMeta(account?.status || 'UNVERIFIED');

  return `
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-surface-strong p-3 rounded-xl border border-divider">
      <div class="min-w-0">
        <h2 class="text-base font-bold text-main flex items-center gap-2 shrink-0">
          <i data-lucide="mail" class="w-4 h-4 text-info"></i> メール
        </h2>
      </div>
      <div class="flex items-center gap-2 w-full sm:w-auto justify-end flex-wrap">
        <span class="text-[10px] px-2 py-0.5 rounded border border-divider ${meta.bg} ${meta.cls} font-bold shrink-0">${meta.label}</span>
        <button type="button" id="mail-btn-compose" class="btn-primary shrink-0 flex items-center gap-1.5 font-bold" title="メールを新規に作成して送信します">
          <i data-lucide="mail-plus" class="w-4 h-4"></i> 新規作成
        </button>
        <button type="button" id="mail-btn-test" class="btn-secondary shrink-0 flex items-center gap-1.5" title="IMAP / SMTP に実際に接続してログインを確認します">
          <i data-lucide="plug" class="w-4 h-4"></i> 接続テスト
        </button>
        <button type="button" id="mail-btn-settings" class="btn-secondary shrink-0 flex items-center gap-1.5" title="メール接続設定（メールアドレス・パスワード）">
          <i data-lucide="settings" class="w-4 h-4"></i> メール設定
        </button>
        <button type="button" id="mail-btn-refresh" class="icon-btn icon-btn-fixed border border-divider bg-surface shrink-0" aria-label="受信ボックスを取得（ダウンロード）" title="受信ボックスを取得（IMAP）">
          <i data-lucide="download" class="w-4 h-4"></i>
        </button>
      </div>
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
          <summary class="cursor-pointer py-1">上級設定（受信 / 送信サーバー・暗号化・フォルダ）※未入力なら自動</summary>
          <div class="grid grid-cols-2 gap-3 mt-2">
            <div>
              <label for="mail-setup-imap-host" class="block text-[10px] font-semibold text-muted mb-1">受信サーバー (IMAP)</label>
              <input type="text" id="mail-setup-imap-host" name="mail-setup-imap-host" autocomplete="off" aria-label="受信サーバー名"
                     class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${escapeHTML(account?.imap_host || '')}" placeholder="例: imap.example.ac.jp">
            </div>
            <div>
              <label for="mail-setup-imap-port" class="block text-[10px] font-semibold text-muted mb-1">IMAP ポート</label>
              <input type="number" id="mail-setup-imap-port" name="mail-setup-imap-port" autocomplete="off" aria-label="IMAPポート"
                     class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${account?.imap_port ? String(account.imap_port) : ''}" placeholder="993">
            </div>
            <div>
              <label for="mail-setup-imap-tls" class="block text-[10px] font-semibold text-muted mb-1">IMAP 暗号化</label>
              <select id="mail-setup-imap-tls" name="mail-setup-imap-tls" autocomplete="off" aria-label="IMAP暗号化モード"
                      class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main">
                <option value="none" ${tlsValue(account?.imap_tls) === 'none' ? 'selected' : ''}>暗号化なし</option>
                <option value="starttls" ${tlsValue(account?.imap_tls) === 'starttls' ? 'selected' : ''}>STARTTLS</option>
                <option value="tls" ${tlsValue(account?.imap_tls) === 'tls' ? 'selected' : ''}>TLS 直結</option>
              </select>
            </div>
            <div>
              <label for="mail-setup-imap-folder" class="block text-[10px] font-semibold text-muted mb-1">受信フォルダ</label>
              <input type="text" id="mail-setup-imap-folder" name="mail-setup-imap-folder" autocomplete="off" aria-label="受信フォルダ名"
                     class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${escapeHTML(account?.imap_folder || 'INBOX')}" placeholder="INBOX">
            </div>
            <div>
              <label for="mail-setup-smtp-host" class="block text-[10px] font-semibold text-muted mb-1">送信サーバー (SMTP)</label>
              <input type="text" id="mail-setup-smtp-host" name="mail-setup-smtp-host" autocomplete="off" aria-label="送信サーバー名"
                     class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${escapeHTML(account?.smtp_host || '')}" placeholder="例: smtp.example.ac.jp">
            </div>
            <div>
              <label for="mail-setup-smtp-port" class="block text-[10px] font-semibold text-muted mb-1">SMTP ポート</label>
              <input type="number" id="mail-setup-smtp-port" name="mail-setup-smtp-port" autocomplete="off" aria-label="SMTPポート"
                     class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${account?.smtp_port ? String(account.smtp_port) : ''}" placeholder="465">
            </div>
            <div>
              <label for="mail-setup-smtp-tls" class="block text-[10px] font-semibold text-muted mb-1">SMTP 暗号化</label>
              <select id="mail-setup-smtp-tls" name="mail-setup-smtp-tls" autocomplete="off" aria-label="SMTP暗号化モード"
                      class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main">
                <option value="none" ${tlsValue(account?.smtp_tls) === 'none' ? 'selected' : ''}>暗号化なし</option>
                <option value="starttls" ${tlsValue(account?.smtp_tls) === 'starttls' ? 'selected' : ''}>STARTTLS</option>
                <option value="tls" ${tlsValue(account?.smtp_tls) === 'tls' ? 'selected' : ''}>TLS 直結</option>
              </select>
            </div>
            <div>
              <label for="mail-setup-sent-folder" class="block text-[10px] font-semibold text-muted mb-1">送信済みフォルダ</label>
              <input type="text" id="mail-setup-sent-folder" name="mail-setup-sent-folder" autocomplete="off" aria-label="送信済みフォルダ名"
                     class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${escapeHTML(account?.sent_folder || 'Sent')}" placeholder="Sent">
            </div>
            <div class="col-span-2">
              <label for="mail-setup-display" class="block text-[10px] font-semibold text-muted mb-1">差出人名（送信時の表示名）</label>
              <input type="text" id="mail-setup-display" name="mail-setup-display" autocomplete="username" aria-label="差出人名"
                     class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     value="${escapeHTML(account?.display_name || '')}" placeholder="例: 山田 太郎">
            </div>
          </div>
        </details>
        <div class="flex items-center gap-2 pt-1">
          <button type="submit" class="btn-primary py-2 px-4 text-xs font-bold">接続設定を保存する</button>
          <button type="button" id="mail-btn-test-form" class="btn-secondary py-2 px-4 text-xs shrink-0" title="保存せずに現在の入力値で IMAP / SMTP 接続を試します">接続テスト（保存前に試す）</button>
          ${configured ? '<button type="button" id="mail-btn-cancel-edit" class="btn-secondary py-2 px-4 text-xs">変更しない</button>' : ''}
          ${configured ? '<button type="button" id="mail-btn-remove" class="btn-danger py-2 px-4 text-xs">設定を削除</button>' : ''}
        </div>
      </form>
    </div>`;
}

/** 左ペイン: メールタイトルと日時一覧（受信ボックス / 送信ボックスで内容を変える） */
function listHtml() {
  const list = currentList();
  const isSent = folder === 'sent';
  const boxTitle = isSent ? '送信ボックス' : '受信ボックス';
  const boxIcon = isSent ? 'send' : 'inbox';
  const headerBar = `
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-xs font-bold text-main flex items-center gap-2">
        <i data-lucide="${boxIcon}" class="w-4 h-4 text-info"></i> ${boxTitle}
      </h3>
      <span class="text-[10px] text-muted" id="mail-box-count">${isSent ? `全 ${list.length}件` : `全 ${list.length}件 / 未読 ${unreadCount()}件`}</span>
    </div>`;

  if (list.length === 0) {
    return `
      <div class="card p-3">
        ${headerBar}
        <div id="mail-inbox-list" class="mt-2 max-h-[70vh] overflow-y-auto">
          <div class="text-center py-8 text-[11px] text-muted leading-relaxed">
            <i data-lucide="${boxIcon}" class="w-6 h-6 mx-auto mb-2 opacity-60"></i>
            ${isSent ? '送信ボックスは空です。「新規作成」で送るとここに記録されます。' : '受信ボックスは空です。右上の受信ボタンで取得します。'}
          </div>
        </div>
      </div>`;
  }

  const items = list
    .map((m) => {
      const selected = m.id === currentSelectedId();
      const box = selected ? 'border-accent bg-accent-soft' : 'border-divider hover:bg-surface-strong';
      const title = selected ? 'text-accent-strong' : m.is_read ? 'text-soft' : 'text-main';
      const who = isSent ? escapeHTML(m.recipients.join(', ')) : escapeHTML(m.sender_name);
      return `
        <button type="button" class="mail-item w-full text-left rounded-lg border ${box} p-2.5 transition"
                data-mail-id="${escapeHTML(m.id)}">
          <div class="flex items-start gap-2">
            <span class="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${isSent || m.is_read ? 'bg-divider' : 'bg-info'}"></span>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-bold ${title} truncate">${escapeHTML(m.subject)}</div>
              <div class="text-[10px] text-muted mt-0.5 flex items-center gap-1.5">
                <span class="font-mono shrink-0">${formatShort(m.received_at)}</span>
                <span class="truncate">${who}</span>
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

/** 右ペイン: メール本文（詳細）。受信は差出人、送信は宛先を表示 */
function detailHtml() {
  const msg = currentList().find((m) => m.id === currentSelectedId());

  if (!msg) {
    return `
      <div class="card p-4 min-h-[180px]" id="mail-detail">
        <div class="text-center py-10 text-[11px] text-muted leading-relaxed">
          <i data-lucide="mail-open" class="w-7 h-7 mx-auto mb-2 opacity-60"></i>
          左のメールを選ぶと、ここに本文が表示されます。
        </div>
      </div>`;
  }

  const isSent = msg.folder === 'sent';
  const stateBadge = isSent
    ? '<span class="badge bg-surface-strong text-muted border-divider shrink-0">送信済み</span>'
    : msg.is_read
      ? '<span class="badge bg-surface-strong text-muted border-divider shrink-0">既読</span>'
      : '<span class="badge bg-info-soft text-info-strong border-info-soft shrink-0">未読</span>';
  const who = isSent
    ? `宛先: <span class="font-bold text-soft">${escapeHTML(msg.recipients.join(', '))}</span>`
    : `差出人: <span class="font-bold text-soft">${escapeHTML(msg.sender_name)}</span> &lt;${escapeHTML(msg.sender_email)}&gt;`;

  // HTML専用メールはサーバー側でタグ除去しているため、その旨をbannerで示す
  const htmlBanner = msg.html_stripped
    ? '<div class="mt-3 text-[10px] text-warning leading-tight">※ HTMLメールのため、タグを除去して表示しています。</div>'
    : '';

  // 本文はまだキャッシュされていない受信メールは「読み込み中」プレースホルダ (selectMessage で遅延取得)
  const bodyInner = msg.body
    ? escapeHTML(msg.body)
    : isSent
      ? '<span class="text-muted">本文がありません。</span>'
      : '<span class="text-muted">本文を読み込み中…</span>';

  // 添付ファイルリスト (name / section。本文同様、実体は開いた時に遅延取得)
  const atts = Array.isArray(msg.attachments) ? msg.attachments : [];
  const attList = atts.length
    ? `<div class="mt-3 flex flex-wrap gap-2">
        ${atts.map((a) => `
        <button type="button" class="inline-flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-divider bg-surface-strong text-main" data-attachment-download data-attachment-section="${escapeHTML(a.section)}" data-attachment-name="${escapeHTML(a.name)}" title="${escapeHTML(a.name)}">
          <i data-lucide="paperclip" class="w-3 h-3"></i>${escapeHTML(a.name)}
        </button>`).join('')}
      </div>`
    : '';

  return `
    <div class="card p-4" id="mail-detail">
      <div class="flex items-start justify-between gap-3">
        <h3 id="mail-detail-subject" class="text-sm font-bold text-main leading-relaxed">${escapeHTML(msg.subject)}</h3>
        ${stateBadge}
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
        <span>${who}</span>
        <span id="mail-detail-datetime" class="font-mono">${isSent ? '送信日時' : '受信日時'}: ${formatDateTime(msg.received_at)}</span>
      </div>
      ${htmlBanner}
      <div id="mail-detail-body" class="mt-3 pt-3 border-t border-divider text-xs text-main leading-relaxed whitespace-pre-wrap">${bodyInner}</div>
      ${attList}
    </div>`;
}

/** アカウントタブ（受信ボックス・送信ボックスの上に並べる。タブにアカウント名を表示し、末尾の + でアカウントを追加） */
function accountTabsHtml() {
  const configured = accounts.filter((a) => !a.needs_setup);
  const tabs = configured.map((a) => {
    const active = a.id === activeAccountId;
    const unread = (messagesByAccount[a.id]?.inbox || []).filter((m) => !m.is_read).length;
    return `
      <button type="button" class="mail-tab-btn px-4 py-2.5 flex items-center gap-2 shrink-0" data-mail-account="${a.id}" role="tab" aria-selected="${active}">
        <i data-lucide="mail" class="w-4 h-4"></i>
        <span class="font-bold">${escapeHTML(a.email_address)}</span>
        ${unread > 0 ? `<span class="text-[11px] font-bold text-danger-strong" data-mail-tab-unread="${escapeHTML(a.id)}">${unread > 99 ? '99+' : unread}</span>` : ''}
      </button>`;
  }).join('');

  const addTab = `
    <button type="button" class="mail-tab-btn px-4 py-2.5 flex items-center gap-1.5 shrink-0" id="mail-btn-add-account" role="tab" aria-label="アカウントを追加" title="アカウントを追加">
      <i data-lucide="plus" class="w-4 h-4"></i>
    </button>`;

  return `
    <div id="mail-account-tabs" class="flex rounded-lg border border-main overflow-hidden bg-surface mb-3 flex-wrap" role="tablist" aria-label="メールアカウント選択">
      ${tabs}
      ${addTab}
    </div>`;
}

/** ボックスタブ（受信ボックス / 送信ボックス）。1枚の実線枠、選択は青の下線 */
function tabsHtml() {
  return `
    <div id="mail-box-tabs" class="flex rounded-lg border border-main overflow-hidden bg-surface mb-3" role="tablist" aria-label="メールボックス選択">
      <button type="button" id="mail-tab-inbox" data-mail-folder="inbox" role="tab"
              aria-selected="${folder === 'inbox'}" aria-controls="mail-box-area"
              class="mail-tab-btn px-3 py-2 text-xs font-bold flex items-center gap-1.5">
        <i data-lucide="inbox" class="w-3.5 h-3.5"></i> 受信ボックス
        <span class="text-[10px] text-muted font-normal" id="mail-inbox-count">${inboxMessages.length}件</span>
      </button>
      <button type="button" id="mail-tab-sent" data-mail-folder="sent" role="tab"
              aria-selected="${folder === 'sent'}" aria-controls="mail-box-area"
              class="mail-tab-btn px-3 py-2 text-xs font-bold flex items-center gap-1.5 border-l border-main">
        <i data-lucide="send" class="w-3.5 h-3.5"></i> 送信ボックス
        <span class="text-[10px] text-muted font-normal" id="mail-sent-count">${sentMessages.length}件</span>
      </button>
    </div>`;
}

/** ボックス表示域（アカウントタブ + ボックスタブ + 左一覧 + 右本文） */
function boxHtml() {
  return `
    <div id="mail-box-area" role="tabpanel" aria-labelledby="mail-tab-${folder}">
      ${accountTabsHtml()}
      ${tabsHtml()}
      <div class="grid grid-cols-1 lg:grid-cols-[minmax(280px,32%)_1fr] gap-4">
        ${listHtml()}
        ${detailHtml()}
      </div>
    </div>`;
}

/** 新規作成モーダル（宛先・件名・本文を入力してSMTPで送信） */
function composeModalHtml() {
  return `
    <div id="mail-compose-modal" class="modal-overlay hidden">
      <div class="modal-card">
        <div class="modal-header">
          <h3 class="modal-title"><i data-lucide="mail-plus" class="w-5 h-5 text-accent"></i> メール新規作成</h3>
          <button type="button" class="modal-close modal-close-x" aria-label="閉じる" title="閉じる">
            <i data-lucide="x" class="w-5 h-5"></i>
          </button>
        </div>
        <form id="mail-compose-form" class="modal-form">
          <div class="modal-body">
            <div>
              <label for="mail-compose-to" class="block text-xs font-semibold text-soft mb-1">宛先（カンマで複数）</label>
              <input type="email" id="mail-compose-to" name="mail-compose-to" multiple autocomplete="off"
                     aria-label="宛先メールアドレス" required
                     class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     placeholder="例: tanaka@school.ed.jp, suzuki@school.ed.jp">
            </div>
            <div>
              <label for="mail-compose-subject" class="block text-xs font-semibold text-soft mb-1">件名</label>
              <input type="text" id="mail-compose-subject" name="mail-compose-subject" autocomplete="off"
                     aria-label="件名" maxlength="200" required
                     class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main"
                     placeholder="件名を入力">
            </div>
            <div>
              <label for="mail-compose-body" class="block text-xs font-semibold text-soft mb-1">本文</label>
              <textarea id="mail-compose-body" name="mail-compose-body" autocomplete="off" aria-label="本文" rows="8" required
                        class="input-field w-full p-2 text-xs rounded bg-surface border border-main text-main leading-relaxed"></textarea>
            </div>
            <p class="text-[10px] text-muted leading-relaxed">接続テスト済みの設定で送信サーバー（SMTP）へ送信し、送信ボックスに記録します。</p>
          </div>
          <div class="modal-footer">
            <button type="button" class="modal-close btn-secondary px-4 py-2 text-xs" title="閉じる">閉じる</button>
            <button type="submit" class="btn-primary px-4 py-2 text-xs font-bold" title="SMTPで送信する">送信する</button>
          </div>
        </form>
      </div>
    </div>`;
}

/** 暗号化モードの日本語表示 */
function tlsLabel(mode) {
  const key = tlsValue(mode);
  if (key === 'starttls') return 'STARTTLS';
  if (key === 'tls') return 'TLS 直結';
  return '暗号化なし';
}

/** 接続テストの成否を 1 行表示（サーバー・ポート・暗号化モード） */
function testRowHtml(label, r, host, port, tls) {
  const cls = r.ok ? 'text-success-strong' : 'text-danger-strong';
  return `
    <div class="flex items-start gap-2">
      <i data-lucide="${r.ok ? 'check' : 'x'}" class="w-4 h-4 ${cls} shrink-0 mt-0.5"></i>
      <div class="min-w-0">
        <div class="text-xs font-bold ${cls}">${label}: ${r.ok ? '接続 OK' : '接続 NG'}</div>
        <div class="text-[10px] text-muted font-mono mt-0.5">${escapeHTML(String(host))}:${escapeHTML(String(port))} / ${tlsLabel(tls)}</div>
        <div class="text-[10px] text-soft mt-0.5">${escapeHTML(r.message || '')}</div>
      </div>
    </div>`;
}

/** 接続テスト結果パネル（ヘッダー直下に IMAP / SMTP の成否と理由を出す） */
function testResultHtml(t) {
  if (!t) return '';
  const badge = t.status === 'VERIFIED'
    ? '<span class="badge bg-success-soft text-success-strong border-success-soft shrink-0">接続確認済み</span>'
    : '<span class="badge bg-danger-soft text-danger-strong border-danger-soft shrink-0">接続失敗</span>';

  return `
    <div class="card p-3 border border-divider" id="mail-test-result">
      <div class="flex items-center justify-between gap-2 mb-2">
        <h3 class="text-xs font-bold text-main flex items-center gap-2">
          <i data-lucide="plug" class="w-4 h-4 text-info"></i> 接続テスト結果
        </h3>
        ${badge}
      </div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        ${testRowHtml('IMAP (受信)', t.imap, t.imap_host, t.imap_port, t.imap_tls)}
        ${testRowHtml('SMTP (送信)', t.smtp, t.smtp_host, t.smtp_port, t.smtp_tls)}
      </div>
      <p class="text-[10px] text-muted mt-2 font-mono">
        確認 ${escapeHTML(formatDateTime(t.checked_at))}:
        ${t.imap.ok ? 'IMAP OK' : 'IMAP NG'} / ${t.smtp.ok ? 'SMTP OK' : 'SMTP NG'}
        （受信 ${tlsLabel(t.imap_tls)}・送信 ${tlsLabel(t.smtp_tls)}）
      </p>
    </div>`;
}

/** フォームの現在値（未保存設定でのプレテスト用ペイロード） */
function formProbePayload() {
  const root = document.getElementById(VIEW_ID);
  const get = (id) => root?.querySelector(`#${id}`)?.value ?? '';
  return {
    email_address: get('mail-setup-email'),
    password: get('mail-setup-password'),
    imap_host: get('mail-setup-imap-host'),
    imap_port: get('mail-setup-imap-port'),
    imap_tls: get('mail-setup-imap-tls'),
    imap_folder: get('mail-setup-imap-folder'),
    smtp_host: get('mail-setup-smtp-host'),
    smtp_port: get('mail-setup-smtp-port'),
    smtp_tls: get('mail-setup-smtp-tls'),
    sent_folder: get('mail-setup-sent-folder'),
    display_name: get('mail-setup-display'),
  };
}

/**
 * 接続テスト実行
 * @param {Object} body 空なら保存済み設定、フォーム値とパスワードを送れば未保存設定のプレテスト
 */
async function runConnectionTest(body = {}) {
  if (testing) return;
  testing = true;
  showToast('接続テストを実行しています…', 'info');
  try {
    const res = await apiPost('/mail/test', body);
    lastTest = {
      status: res.status,
      imap: res.imap,
      smtp: res.smtp,
      imap_host: res.imap_host,
      imap_port: res.imap_port,
      smtp_host: res.smtp_host,
      smtp_port: res.smtp_port,
      checked_at: res.checked_at,
    };
    if (res.account) account = res.account;
    renderMailView();
    showToast(res.message, res.status === 'VERIFIED' ? 'success' : 'warning');
  } catch (err) {
    showToast(`接続テストを実行できません: ${err.message}`, 'error');
  } finally {
    testing = false;
  }
}

/**
 * 受信ボックス取得（IMAP へ接続 → 新着をDB保存 → 一覧を再読み込み）
 * @param {{silent?: boolean}} opts silent=true は自動受信・定期受信（トーストを出さず表示を止めない）
 */
async function fetchInboxFromServer({ silent = false } = {}) {
  if (fetching) return;
  if (!account || account.needs_setup) {
    if (!silent) showToast('受信の前にメール接続設定を保存してください。', 'warning');
    return;
  }
  fetching = true;
  const accountId = account.id;
  try {
    const res = await apiPost('/mail/inbox/refresh', { account_id: accountId });
    const store = messagesByAccount[accountId] || (messagesByAccount[accountId] = { inbox: [], sent: [] });
    store.inbox = res.messages || [];
    folder = 'inbox';
    if (accountId === account.id) {
      inboxMessages = store.inbox;
      if (!inboxMessages.some((m) => m.id === selectedInboxId)) selectedInboxId = inboxMessages[0]?.id || null;
      renderMailView();
    }
    updateMailUnreadBadge();
    if (!silent) showToast(res.message, res.added > 0 ? 'success' : 'info');
  } catch (err) {
    // 自動受信・定期受信の失敗は表示を止めない（ダウンロードボタンからの手動受信だけトーストを出す）
    if (!silent) showToast(`受信できませんでした: ${err.message}`, 'error');
  } finally {
    fetching = false;
  }
}

/**
 * WSS の新着受信通知を適用する (サーバー側cronが IMAP から受信してDBへ保存済み。変化のあったアカウントだけ届く)
 * 一覧カードの中身と件数表示だけを差し替える（ヘッダー・タブ・モーダルは再描画しない = アニメーション の再発火を防ぐ）
 */
export async function applyMailSocketUpdate(payload) {
  const accountId = payload?.account_id;
  if (!accountId || !state.currentUser) return false;

  const store = messagesByAccount[accountId];
  if (!store) {
    // 自分の画面がまだ読み込んでいないアカウントは未読バッジだけ更新する
    updateMailUnreadBadge();
    return false;
  }

  try {
    // サーバーは IMAP 受信と DB 保存を済ませている → DB の最新だけ読む (ブラウザは IMAP に接続しない)
    const res = await apiGet(`/mail/messages?folder=inbox&account_id=${encodeURIComponent(accountId)}`);
    store.inbox = res.messages || [];
  } catch (err) {
    return false;
  }

  updateMailUnreadBadge();

  // アカウントタブの未読数だけ値を更新する (タブ自体は再描画しない)
  const tabUnread = document.querySelector(`#view-mail [data-mail-tab-unread="${accountId}"]`);
  if (tabUnread) {
    const unread = store.inbox.filter((m) => !m.is_read).length;
    tabUnread.textContent = unread > 99 ? '99+' : String(unread);
  }

  if (accountId !== activeAccountId) return true;

  inboxMessages = store.inbox;
  if (!inboxMessages.some((m) => m.id === selectedInboxId)) selectedInboxId = inboxMessages[0]?.id || null;

  // 表示中なら一覧カードの中身だけを差し替える (全面再描画・スクロール復帰・アイコン再描画をしない)
  const root = document.getElementById(VIEW_ID);
  const listBox = root ? root.querySelector('#mail-inbox-list') : null;
  if (listBox && folder === 'inbox' && !showSetupForm && state.currentTab === 'mail') {
    const tmp = document.createElement('div');
    tmp.innerHTML = listHtml();
    const fresh = tmp.querySelector('#mail-inbox-list');
    if (fresh) listBox.innerHTML = fresh.innerHTML;
    const boxCount = document.getElementById('mail-box-count');
    if (boxCount) boxCount.textContent = `全 ${inboxMessages.length}件 / 未読 ${unreadCount()}件`;
    const inboxCount = document.getElementById('mail-inbox-count');
    if (inboxCount) inboxCount.textContent = `${inboxMessages.length}件`;
  }
  return true;
}

/** WSS の mail:new_messages ハンドラ登録 (未接続時は connect 時に貼り付けられる。二重登録しない) */
export function bindMailSocket() {
  if (!socketClient) return;

  const registeredHandlers = new Map();
  const register = (event, handler) => {
    const prev = registeredHandlers.get(event);
    if (prev) socketClient.off(event, prev);
    registeredHandlers.set(event, handler);
    socketClient.on(event, handler);
  };

  register('mail:new_messages', async (payload) => {
    const applied = await applyMailSocketUpdate(payload);
    const added = Number(payload?.added) || 0;
    if (added > 0) {
      const who = payload?.account_email || '';
      const subject = payload.newest_subject ? `「${payload.newest_subject}」` : '';
      showToast(`📪 ${who} に新着メール ${added}件 ${subject}`, 'info', () => switchTab('mail'));
    }
    return applied;
  });

  socketBound = true;
}

/** UI 検証用の内部状態 (クライアント側の自律受信が廃止済み・WSS 通知のみであることを実測するため公開する) */
window.__mailSnap = () => ({
  clientPollMs: null,           // クライアント側の setInterval 受信は廃止した
  clientPolling: false,
  serverPollMs: SERVER_POLL_MS, // サーバー側 cron の受信間隔 (src/utils/cron.jobs.js)
  socketBound,
  activeAccountId,
  accounts: accounts.filter((a) => !a.needs_setup).map((a) => ({
    id: a.id,
    email: a.email_address,
    unread: (messagesByAccount[a.id]?.inbox || []).filter((m) => !m.is_read).length,
  })),
});

// WSS 通知の適用関数 (UI テストが socket 通知をシミュレートし、再描画なしで更新されることを検証するためのフック)
window.__mailApply = (payload) => applyMailSocketUpdate(payload);

/** 新規作成フォームの送信（SMTP へ送信 → 送信ボックスに記録 / 送信元は表示中アカウント） */
async function sendComposeMessage(form) {
  if (sending) return;
  if (!account || account.needs_setup) {
    showToast('送信の前にメール接続設定を保存してください。', 'warning');
    return;
  }
  const to = (form.querySelector('#mail-compose-to')?.value || '').trim();
  const subject = (form.querySelector('#mail-compose-subject')?.value || '').trim();
  const bodyText = form.querySelector('#mail-compose-body')?.value ?? '';

  sending = true;
  showToast('送信しています…', 'info');
  try {
    const res = await apiPost('/mail/send', { account_id: account.id, to, subject, body: bodyText });
    closeModal('mail-compose-modal');
    showToast(res.message, 'success');
    // 送信後は送信ボックスへ切り替えて記録を表示する
    await loadMailData();
    folder = 'sent';
    setCurrentSelectedId(sentMessages[0]?.id || null);
    renderMailView();
  } catch (err) {
    showToast(`送信できませんでした: ${err.message}`, 'error');
  } finally {
    sending = false;
  }
}

/** メールタブの実データ取得 (設定済みアカウント全部のボックスをDBから読む。IMAP 受信はサーバー側cronが行う) */
export async function loadMailData() {
  if (!state.currentUser || !state.authToken) return;
  const root = document.getElementById(VIEW_ID);
  if (!root) return;

  try {
    const res = await apiGet('/mail/accounts');
    accounts = res.accounts || [];
    const configured = accounts.filter((a) => !a.needs_setup);

    if (configured.length > 0) {
      if (!configured.some((a) => a.id === activeAccountId)) activeAccountId = configured[0].id;
      account = configured.find((a) => a.id === activeAccountId);

      // 全アカウントのボックスを読み込む（アカウントタブの未読表示と切替時の即表示のため）
      for (const a of configured) {
        const store = messagesByAccount[a.id] || (messagesByAccount[a.id] = { inbox: [], sent: [] });
        const inbox = await apiGet(`/mail/messages?folder=inbox&account_id=${encodeURIComponent(a.id)}`);
        const sent = await apiGet(`/mail/messages?folder=sent&account_id=${encodeURIComponent(a.id)}`);
        store.inbox = inbox.messages || [];
        store.sent = sent.messages || [];
      }

      const store = messagesByAccount[activeAccountId];
      inboxMessages = store.inbox;
      sentMessages = store.sent;
      if (!inboxMessages.some((m) => m.id === selectedInboxId)) selectedInboxId = inboxMessages[0]?.id || null;
      if (!sentMessages.some((m) => m.id === selectedSentId)) selectedSentId = sentMessages[0]?.id || null;
      // 設定済みならボックスを表示（ページ再読み込み後は showSetupForm が初期値 true のため必ず落とす）
      showSetupForm = false;
    } else {
      account = accounts[0] || null;
      activeAccountId = null;
      messagesByAccount = {};
      inboxMessages = [];
      sentMessages = [];
      selectedInboxId = null;
      selectedSentId = null;
      showSetupForm = true;
    }

    renderMailView();
    // ★ クライアント側の自律受信 (setInterval) は廃止した (2026/11/13)。
    //   受信はサーバー側 cron (既定 60秒) が行い、受信ボックスが変化したアカウントだけ
    //   WSS (mail:new_messages) で通知してくる。手動受信ボタンだけは IMAP を使う。
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

  const configured = accounts.some((a) => !a.needs_setup);
  const parts = [headerHtml()];

  if (lastTest) parts.push(testResultHtml(lastTest));

  if (configured && !showSetupForm) {
    parts.push(boxHtml());
    parts.push(composeModalHtml());
  } else {
    const prefill = account?.email_address || account?.suggested_email || state.currentUser?.email || '';
    parts.push(setupFormHtml(prefill));
  }

  root.innerHTML = parts.join('');
  refreshLucideIcons();
  updateMailUnreadBadge();
}

/** メールを選ぶ (左一覧 -> 右本文、受信ボックスの未読は既読記録する) */
async function selectMessage(id) {
  const msg = currentList().find((m) => m.id === id);
  if (!msg) return;
  setCurrentSelectedId(id);

  if (msg.folder === 'inbox' && !msg.is_read) {
    try {
      await apiPost(`/mail/messages/${id}/read`);
      msg.is_read = true;
    } catch (err) {
      // 既読記録の失敗は表示を止めない
    }
  }

  renderMailView();

  // 受信メールで本文が未キャッシュなら、WSS で本文を遅延取得して詳細ペインを埋める
  if (msg.folder === 'inbox' && !msg.body) loadLazyBody(msg);
}

/** WSS に ack 形式でイベントを送り、応答を Promise で返す (socket 未接続時は success:false) */
function requestMailSocket(event, payload) {
  return new Promise((resolve) => {
    const s = socketClient?.socket;
    if (!s) { resolve({ success: false, message: 'WebSocket に接続されていません。' }); return; }
    s.emit(event, payload, (res) => resolve(res || { success: false }));
  });
}

/** base64 → Uint8Array */
function base64ToBytes(b64) {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

/** 受信メール本文の遅延取得 (WSS mail:get_body。DBキャッシュ→無ければ IMAP 取得)。詳細ペインだけ埋める */
async function loadLazyBody(msg) {
  const res = await requestMailSocket('mail:get_body', { id: msg.id });
  if (!res?.success) {
    const bodyEl = document.getElementById('mail-detail-body');
    if (bodyEl) bodyEl.innerHTML = `<span class="text-muted">${escapeHTML(res?.message || '本文を取得できませんでした。')}</span>`;
    return;
  }
  msg.body = res.message.body ?? '';
  msg.html_stripped = res.message.html_stripped === true;
  msg.attachments = res.message.attachments ?? [];
  msg.body_available = true;
  // 詳細ペインだけ作り替える (一覧カードとタブ面は不変 = Animation 再発火抑止)
  const detail = document.getElementById('mail-detail');
  if (detail) detail.outerHTML = detailHtml();
  refreshLucideIcons();
}

/** 添付ダウンロード (WSS mail:get_attachment。base64 → blob → ダウンロード) */
async function downloadMailAttachment(btn) {
  const section = btn.getAttribute('data-attachment-section');
  const msg = currentList().find((m) => m.id === currentSelectedId());
  if (!msg) return;
  const res = await requestMailSocket('mail:get_attachment', { id: msg.id, section });
  if (!res?.success) { showToast(res?.message || '添付を取得できませんでした。', 'warning'); return; }
  const bytes = base64ToBytes(res.base64);
  const blob = new Blob([bytes], { type: res.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = res.name || btn.getAttribute('data-attachment-name') || 'attachment';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

/** モジュール初期化 (#view-mail への委譲イベント登録) */
export function initMailModule() {
  const root = document.getElementById(VIEW_ID);
  if (!root) return;

  // WSS の新着受信通知ハンドラ (サーバー側 cron が受信し、変化のあったアカウントだけ通知してくる)
  bindMailSocket();

  root.addEventListener('submit', async (e) => {
    if (e.target.id === 'mail-setup-form') {
      e.preventDefault();
      await submitSetup();
      return;
    }
    if (e.target.id === 'mail-compose-form') {
      e.preventDefault();
      await sendComposeMessage(e.target);
    }
  });

  root.addEventListener('click', async (e) => {
    const item = e.target.closest('[data-mail-id]');
    if (item) {
      await selectMessage(item.getAttribute('data-mail-id'));
      return;
    }

    const accTab = e.target.closest('[data-mail-account]');
    if (accTab) {
      const id = accTab.getAttribute('data-mail-account');
      const a = accounts.find((x) => x.id === id && !x.needs_setup);
      if (!a) return;
      activeAccountId = id;
      account = a;
      const store = messagesByAccount[id] || (messagesByAccount[id] = { inbox: [], sent: [] });
      inboxMessages = store.inbox;
      sentMessages = store.sent;
      if (!inboxMessages.some((m) => m.id === selectedInboxId)) selectedInboxId = inboxMessages[0]?.id || null;
      if (!sentMessages.some((m) => m.id === selectedSentId)) selectedSentId = sentMessages[0]?.id || null;
      renderMailView();
      return;
    }

    const tab = e.target.closest('[data-mail-folder]');
    if (tab) {
      folder = tab.getAttribute('data-mail-folder') === 'sent' ? 'sent' : 'inbox';
      renderMailView();
      return;
    }

    const attDl = e.target.closest('[data-attachment-download]');
    if (attDl) {
      await downloadMailAttachment(attDl);
      return;
    }

    const btn = e.target.closest('button');
    if (!btn) return;

    const configured = accounts.some((a) => !a.needs_setup);

    if (btn.id === 'mail-btn-compose') {
      if (!configured) {
        showToast('送信の前にメール接続設定を保存してください。', 'warning');
        return;
      }
      openModal('mail-compose-modal');
      return;
    }

    if (btn.id === 'mail-btn-test') {
      if (!configured) {
        showToast('接続テストの前にメールアドレスとパスワードを登録してください。', 'warning');
        return;
      }
      await runConnectionTest({ account_id: activeAccountId });
      return;
    }

    if (btn.id === 'mail-btn-test-form') {
      const payload = formProbePayload();
      if (!payload.password.trim()) {
        showToast('接続テストにはメールパスワードが必要です。', 'warning');
        return;
      }
      await runConnectionTest(payload);
      return;
    }

    if (btn.id === 'mail-btn-refresh') {
      await fetchInboxFromServer({ silent: false });
    } else if (btn.id === 'mail-btn-settings') {
      setupTargetId = account && !account.needs_setup ? account.id : null;
      showSetupForm = true;
      renderMailView();
    } else if (btn.id === 'mail-btn-add-account') {
      setupTargetId = null; // 「+」タブは新規アカウント追加
      showSetupForm = true;
      renderMailView();
    } else if (btn.id === 'mail-btn-cancel-edit') {
      setupTargetId = null;
      showSetupForm = false;
      renderMailView();
    } else if (btn.id === 'mail-btn-remove') {
      await removeAccount();
    }
  });
}

/** 接続設定の保存 (メールアドレス + パスワード + 暗号化モード・フォルダ。setupTargetId があればそのアカウントを更新) */
async function submitSetup() {
  const read = (id) => (document.getElementById(id)?.value || '').trim();
  const payload = {
    email_address: read('mail-setup-email'),
    password: document.getElementById('mail-setup-password')?.value ?? '',
    imap_host: read('mail-setup-imap-host'),
    imap_port: read('mail-setup-imap-port'),
    imap_tls: read('mail-setup-imap-tls'),
    imap_folder: read('mail-setup-imap-folder'),
    smtp_host: read('mail-setup-smtp-host'),
    smtp_port: read('mail-setup-smtp-port'),
    smtp_tls: read('mail-setup-smtp-tls'),
    sent_folder: read('mail-setup-sent-folder'),
    display_name: read('mail-setup-display'),
  };
  if (setupTargetId) payload.id = setupTargetId;

  try {
    const res = await apiPost('/mail/account', payload);
    account = res.account;
    activeAccountId = res.account.id;
    setupTargetId = null;
    showSetupForm = false;
    selectedInboxId = null;
    selectedSentId = null;
    await loadMailData();
    showToast(res.message || 'メール接続設定を保存しました', 'success');
  } catch (err) {
    showToast(err.message || 'メール接続設定の保存に失敗しました', 'error');
  }
}

/** 接続設定の削除 (表示中アカウントを削除。残れば次のアカウントを表示し、全削除で未設定フォームへ戻す) */
async function removeAccount() {
  try {
    const res = await apiDelete(activeAccountId
      ? `/mail/account?account_id=${encodeURIComponent(activeAccountId)}`
      : '/mail/account');
    account = null;
    activeAccountId = null;
    messagesByAccount = {};
    inboxMessages = [];
    sentMessages = [];
    selectedInboxId = null;
    selectedSentId = null;
    await loadMailData();
    showToast(res.message || 'メール接続設定を削除しました', 'info');
  } catch (err) {
    showToast(err.message || 'メール接続設定の削除に失敗しました', 'error');
  }
}
