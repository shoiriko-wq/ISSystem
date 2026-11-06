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
let lastTest = null;      // 直近の接続テスト結果
let testing = false;      // 接続テスト実行中（二重クリック防止）

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

/** モジュール共通ヘッダー（掲示板・施設物品予約と同一デザインのツールバー：左にアイコン＋タイトル、右にコントロール。高さを 2.4rem に統一） */
function headerHtml() {
  const meta = statusMeta(account?.status || 'UNVERIFIED');
  const configured = !!account && !account.needs_setup;
  const summary = configured
    ? `接続アカウント: <span class="font-bold text-main">${escapeHTML(account.email_address)}</span> / 最終受信確認: ${formatDateTime(account.last_checked_at || account.updated_at)}`
    : '';

  return `
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-surface-strong p-3 rounded-xl border border-divider">
      <div class="min-w-0">
        <h2 class="text-base font-bold text-main flex items-center gap-2 shrink-0">
          <i data-lucide="mail" class="w-4 h-4 text-info"></i> メール
        </h2>
        ${summary ? `<p id="mail-account-summary" class="text-[11px] text-muted mt-1 leading-relaxed">${summary}</p>` : ''}
      </div>
      <div class="flex items-center gap-2 w-full sm:w-auto justify-end flex-wrap">
        <span class="text-[10px] px-2 py-0.5 rounded border border-divider ${meta.bg} ${meta.cls} font-bold shrink-0">${meta.label}</span>
        <button type="button" id="mail-btn-test" class="btn-secondary shrink-0 flex items-center gap-1.5" title="IMAP / SMTP に実際に接続してログインを確認します">
          <i data-lucide="plug" class="w-4 h-4"></i> 接続テスト
        </button>
        <button type="button" id="mail-btn-settings" class="btn-secondary shrink-0 flex items-center gap-1.5" title="メール接続設定（メールアドレス・パスワード）">
          <i data-lucide="settings" class="w-4 h-4"></i> メール設定
        </button>
        <button type="button" id="mail-btn-refresh" class="icon-btn icon-btn-fixed border border-divider bg-surface shrink-0" aria-label="受信箱を再読み込み" title="再読み込み">
          <i data-lucide="refresh-cw" class="w-4 h-4"></i>
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
          <button type="button" id="mail-btn-test-form" class="btn-secondary py-2 px-4 text-xs shrink-0" title="保存せずに現在の入力値で IMAP / SMTP 接続を試します">接続テスト（保存前に試す）</button>
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

/** 接続テストの成否を 1 行表示 */
function testRowHtml(label, r, host, port) {
  const cls = r.ok ? 'text-success-strong' : 'text-danger-strong';
  return `
    <div class="flex items-start gap-2">
      <i data-lucide="${r.ok ? 'check' : 'x'}" class="w-4 h-4 ${cls} shrink-0 mt-0.5"></i>
      <div class="min-w-0">
        <div class="text-xs font-bold ${cls}">${label}: ${r.ok ? '接続 OK' : '接続 NG'}</div>
        <div class="text-[10px] text-muted font-mono mt-0.5">${escapeHTML(String(host))}:${escapeHTML(String(port))}</div>
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
        ${testRowHtml('IMAP (受信)', t.imap, t.imap_host, t.imap_port)}
        ${testRowHtml('SMTP (送信)', t.smtp, t.smtp_host, t.smtp_port)}
      </div>
      <p class="text-[10px] text-muted mt-2 font-mono">
        確認 ${escapeHTML(formatDateTime(t.checked_at))}:
        ${t.imap.ok ? 'IMAP OK' : 'IMAP NG'} / ${t.smtp.ok ? 'SMTP OK' : 'SMTP NG'}
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
    smtp_host: get('mail-setup-smtp-host'),
    smtp_port: get('mail-setup-smtp-port'),
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
      // 設定済みなら受信箱を表示（ページ再読み込み後は showSetupForm が初期値 true のため必ず落とす）
      showSetupForm = false;
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

  if (lastTest) parts.push(testResultHtml(lastTest));

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

    if (btn.id === 'mail-btn-test') {
      if (!account || account.needs_setup) {
        showToast('接続テストの前にメールアドレスとパスワードを登録してください。', 'warning');
        return;
      }
      await runConnectionTest();
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
