/**
 * ISSystem メールモジュール
 * 左ペインにメールタイトルと日時、右ペインにメール本文（詳細）を表示する。
 * ボックスは4フォルダ（受信ボックス・送信ボックス・下書き・ごみ箱）。下書きは IMAP 下書きフォルダへ APPEND、
 * ごみ箱は IMAP の COPY + 削除フラグ + EXPUNGE と対応づけ、DB の folder 値 ('inbox'/'sent'/'drafts'/'trash') が正になる。
 * ヘッダーの「メール設定」ボタン（アイコンのみ）でメール設定メニュー（接続設定フォーム＋接続テスト）を開く。
 * 接続テストと結果パネルはメール設定メニュー内に置く（ヘッダーに接続テストボタンは無い）。
 * ヘッダーの状態バッヂは「接続確認済み」「接続失敗」だけ出す（「設定保存済み（未接続確認）」バッヂは撤廃）。
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
// 4フォルダ ('inbox' 受信ボックス / 'sent' 送信ボックス / 'drafts' 下書き / 'trash' ごみ箱)
const FOLDERS = ['inbox', 'sent', 'drafts', 'trash'];
const FOLDER_META = {
  inbox: { label: '受信ボックス', icon: 'inbox', empty: '受信ボックスは空です。右上の受信ボタンで取得します。', syncLabel: '受信ボックスをIMAPと同期' },
  sent: { label: '送信ボックス', icon: 'send', empty: '送信ボックスは空です。「新規作成」で送るとここに記録されます。', syncLabel: '送信ボックスをIMAPと同期' },
  drafts: { label: '下書き', icon: 'file-pen', empty: '下書きは空です。「新規作成」で下書き保存するとここに記録されます。', syncLabel: '下書きフォルダをIMAPと同期' },
  trash: { label: 'ごみ箱', icon: 'trash-2', empty: 'ごみ箱は空です。メール一覧の詳細からごみ箱へ移動できます。', syncLabel: 'ごみ箱をIMAPと同期' },
};
let folder = 'inbox';      // 表示中のボックス (FOLDERS のいずれか)
// accountId -> { inbox:[], sent:[], drafts:[], trash:[], inboxTotal, sentTotal, draftsTotal, trashTotal,
//                inboxHasMore, sentHasMore, draftsHasMore, trashHasMore, inboxImapMore, inboxUnread, counts, loadingOlder }
let messagesByAccount = {};
let listScrollTop = 0;   // 左一覧のスクロール位置（ページをAppendしても表示位置をそのまま維持する）
let olderFetching = false; // 過去分の読み込み中（スクロールの二重発火防止）
// フォルダごとの選択中ID（受信・送信・下書き・ごみ箱で独立に覚え、タブ復帰で選択を失わない）
let selectedIds = { inbox: null, sent: null, drafts: null, trash: null };
let showSetupForm = true; // 初回は必ず入力フォームを表示
let setupTargetId = null; // 設定フォームの編集対象 (null = 新規追加 / activeAccountId = 編集中)
let lastTest = null;      // 直近の接続テスト結果
let testing = false;      // 接続テスト実行中（二重クリック防止）
let fetching = false;     // 受信ボックスの取得中（二重クリック防止）
let sending = false;      // 送信中（二重クリック防止）
let composeReply = null;  // 返信・転送の作成状態 { mode:'reply'|'reply-all'|'forward', reply_to_id, folder }（送信時にAPIへ渡す）
let composeTitleDefault = null;  // lucide 変換後の「メール新規作成」タイトルマーカー（閉じる時の復元用。挿し替えで押下要素が切れないため再描画しない）
let syncing = false;      // フォルダのIMAP同期中（二重クリック防止）
let savingDraft = false;  // 下書き保存中（二重クリック防止）
let draftId = null;       // 新規作成モーダルが開いている下書きID (null = 新規作成)
let acting = false;       // ごみ箱移動・復元・完全削除の実行中（二重クリック防止）

const PAGE_SIZE = 50; // 1ページで読む受信ボックスの件数 (一覧の無限スクロール = API limit)
// 受信は常時接続 IMAP IDLE (src/services/mail.service.js の runWatchLoop)。60秒周期のcron定期受信は廃止 (2026-11-14)
const IDLE_RECONNECT_MIN_MS = 1500000; // 再接続窓の下限 25分 (Dovecot imap_idle_max 30分未満で自発 DONE + 再接続)
const IDLE_RECONNECT_MAX_MS = 1740000; // 再接続窓の上限 29分 (窓内で乱数を選び、全クライアントの同時再接続を避ける)
let socketBound = false;      // WSS の mail:new_messages ハンドラを登録したか

/** 表示中のボックス一覧 (受信 / 送信 / 下書き / ごみ箱) */
function currentList() {
  return (messagesByAccount[activeAccountId] && messagesByAccount[activeAccountId][folder]) || [];
}

/** 表示中のボックスで選択中のメールID */
function currentSelectedId() {
  return selectedIds[folder];
}

/** 選択中IDをボックスごとに設定 */
function setCurrentSelectedId(id) {
  selectedIds[folder] = id;
}

/** 各ボックスの選択中IDを先頭行へ寄せる (表示中の一覧に選択中行が無い時だけ) */
function normalizeSelection(store) {
  for (const f of FOLDERS) {
    const list = store[f] || [];
    if (!list.some((m) => m.id === selectedIds[f])) selectedIds[f] = list[0]?.id || null;
  }
}

/** 表示中アカウントのページングストア (未初期化なら既定値で作る) */
function ensureStore(accountId) {
  const store = messagesByAccount[accountId] || (messagesByAccount[accountId] = { inbox: [], sent: [], drafts: [], trash: [] });
  for (const f of FOLDERS) {
    if (!Array.isArray(store[f])) store[f] = [];
    if (typeof store[`${f}Total`] !== 'number') store[`${f}Total`] = store[f].length;
    if (store[`${f}HasMore`] !== true && store[`${f}HasMore`] !== false) store[`${f}HasMore`] = false;
  }
  // inboxImapMore: IMAP 側にまだ未取得の受信過去分が残る (null = 未判定 / false = 尽きた・到達不能・上限到達)
  if (store.inboxImapMore !== true && store.inboxImapMore !== false) store.inboxImapMore = null;
  if (typeof store.inboxUnread !== 'number') store.inboxUnread = store.inbox.filter((m) => !m.is_read).length;
  if (store.loadingOlder !== true) store.loadingOlder = false;
  // counts: サーバーの 4フォルダ件数 (GET /api/mail/counts。タブ件数表示の正)
  if (!store.counts || typeof store.counts !== 'object') {
    store.counts = {
      inbox: typeof store.inboxTotal === 'number' ? store.inboxTotal : store.inbox.length,
      sent: typeof store.sentTotal === 'number' ? store.sentTotal : store.sent.length,
      drafts: typeof store.draftsTotal === 'number' ? store.draftsTotal : store.drafts.length,
      trash: typeof store.trashTotal === 'number' ? store.trashTotal : store.trash.length,
    };
  }
  return store;
}

/** 1ページ目（最新ページ）の結果をストアへ反映する。読み込み済みの過去ページは重複を除いて保持する */
function applyPageOne(store, res, key) {
  const fresh = res.messages || [];
  const ids = new Set(fresh.map((m) => m.id));
  store[key] = [...fresh, ...store[key].filter((m) => !ids.has(m.id))];
  const total = typeof res.total === 'number' ? res.total : store[key].length;
  const hasMore = res.has_more === true;
  store[`${key}Total`] = total;
  store[`${key}HasMore`] = hasMore;
  store.counts[key] = total;
  if (key === 'inbox') {
    store.inboxUnread = typeof res.unread === 'number' ? res.unread : store.inbox.filter((m) => !m.is_read).length;
    if (res.imap_more === true || res.imap_more === false) store.inboxImapMore = res.imap_more;
  }
}

/** 1ページ目を DB から読み直してストアへ反映する (送信・下書き・ごみ箱の操作後) */
async function reloadFolderPageOne(accountId, key) {
  const store = ensureStore(accountId);
  const res = await apiGet(`/mail/messages?folder=${key}&account_id=${encodeURIComponent(accountId)}&limit=${PAGE_SIZE}`);
  applyPageOne(store, res, key);
  return res;
}

/** 4フォルダ件数をサーバーから読み直し、タブの件数表示だけ差し替える (表示は止めない) */
async function refreshCounts(accountId) {
  const store = ensureStore(accountId);
  try {
    const res = await apiGet(`/mail/counts?account_id=${encodeURIComponent(accountId)}`);
    if (res.counts && typeof res.counts === 'object') store.counts = { ...store.counts, ...res.counts };
    if (typeof res.unread === 'number') store.inboxUnread = res.unread;
    for (const f of FOLDERS) store[`${f}Total`] = typeof store.counts[f] === 'number' ? store.counts[f] : store[f].length;
  } catch (err) {
    // 件数表示の読み直しに失敗しても表示は止めない (ローカルの累計でタブ表示を維持する)
  }
  updateTabCounts();
  updateMailUnreadBadge();
}

/** タブの件数表示 (全件数) をストアの counts だけ差し替える (タブ自体は作り替えない) */
function updateTabCounts() {
  const store = messagesByAccount[activeAccountId] || null;
  if (!store) return;
  for (const f of FOLDERS) {
    const el = document.getElementById(`mail-${f}-count`);
    if (!el) continue;
    const n = typeof store.counts?.[f] === 'number' ? store.counts[f] : (typeof store[`${f}Total`] === 'number' ? store[`${f}Total`] : store[f].length);
    el.textContent = `${n}件`;
  }
}

/** keyset ページングのカーソル（表示中ボックス最古の行。4フォルダ共通） */
function pageCursor(store) {
  const list = store[folder] || [];
  const last = list[list.length - 1];
  return last ? { before: last.received_at, before_id: last.id } : null;
}

/** スクロールでまだ古いメールを読み込めるか（DB に古い行が残る / 受信箱は IMAP 側に過去分が残る） */
function canLoadOlder(store) {
  if (!store) return false;
  const list = store[folder] || [];
  if (!list.length) return false;
  if (folder === 'inbox') return store.inboxHasMore === true || store.inboxImapMore === null;
  return store[`${folder}HasMore`] === true;
}

/**
 * 無限スクロール: 一覧を最下部までスクロールしたら古いページをAppendする（表示はそのまま、下に追加だけ）
 * DB の受信履歴が尽きた受信箱は IMAP へ過去分を依頼し、取得できた分だけ下に足す（スクロールがシームレスに続く）
 */
async function loadOlderMessages() {
  if (!account || account.needs_setup) return;
  const accountId = activeAccountId || account.id;
  const store = ensureStore(accountId);
  if (olderFetching) return;
  if (!canLoadOlder(store)) return;

  olderFetching = true;
  store.loadingOlder = true;
  renderMailView();

  try {
    const cursor = pageCursor(store);
    // 受信箱は DB の履歴が尽きても IMAP 側に過去分が残っていれば、その古い1ページ分を取り込む
    if (folder === 'inbox' && store.inboxHasMore !== true && store.inboxImapMore !== false) {
      const older = await apiPost('/mail/inbox/older', { account_id: accountId });
      store.inboxImapMore = older.more === true;
      if (older.capped === true) store.inboxImapMore = false; // IMAP 履歴の上限（サーバー側 IMAP_HISTORY_CAP）に達して打ち切り
    }
    const query = `/mail/messages?folder=${folder}&account_id=${encodeURIComponent(accountId)}&limit=${PAGE_SIZE}`
      + (cursor ? `&before=${encodeURIComponent(cursor.before)}&before_id=${encodeURIComponent(cursor.before_id)}` : '');
    const res = await apiGet(query);
    const key = folder;
    const ids = new Set(store[key].map((m) => m.id));
    for (const m of (res.messages || [])) {
      if (!ids.has(m.id)) store[key].push(m); // 重複は足さない（新着受信でページがずれても一覧は正常）
    }
    store[`${key}Total`] = typeof res.total === 'number' ? res.total : store[key].length;
    store[`${key}HasMore`] = res.has_more === true;
    store.counts[key] = store[`${key}Total`];
  } catch (err) {
    showToast(`過去のメールを取得できませんでした: ${err.message}`, 'error');
    // IMAP に到達できない（DNS / 接続 / ログイン）受信箱は過去分読み込みを打ち切り、表示は止めない
    if (folder === 'inbox') store.inboxImapMore = false;
  } finally {
    store.loadingOlder = false;
    olderFetching = false;
    renderMailView();
  }
}

/** 一覧のスクロールを監視して最下部接近で過去分を読み込む（1ページずつAppend表示するため表示位置はそのまま） */
function bindInfiniteScroll() {
  const listEl = document.getElementById('mail-inbox-list');
  if (!listEl) return;
  // 再描画後もスクロール位置をそのまま復元する（ページAppendで表示は止めない）
  listEl.scrollTop = listScrollTop;
  if (listEl.dataset.scrollBound === '1') return;
  listEl.dataset.scrollBound = '1';
  listEl.addEventListener('scroll', () => {
    const store = ensureStore(activeAccountId || account.id);
    if (!canLoadOlder(store)) {
      // 過去分が残っていない受信箱は末尾越えのスクロールを受け付けない（表示位置はそのまま）
      listEl.scrollTop = listScrollTop;
      return;
    }
    listScrollTop = listEl.scrollTop;
    if (listEl.scrollTop + listEl.clientHeight >= listEl.scrollHeight - 40) loadOlderMessages();
  });
  // 画面が短くスクロールが発生しない時は、空きがあれば自動で次のページを読み込む（1ページずつAppend表示）
  // 高さ指定(max-h)が適用された表示域に収まる時だけ発火する（スタイル適用直後は max-height が none = 発火しない）
  const maxH = parseFloat(getComputedStyle(listEl).maxHeight);
  if (Number.isFinite(maxH) && listEl.scrollHeight <= maxH + 1 && canLoadOlder(ensureStore(activeAccountId || account.id))) {
    loadOlderMessages();
  }
}

/** ヘッダーの状態バッヂ（接続確認済み・接続失敗のみ。「設定保存済み（未接続確認）」バッヂは撤廃した） */
const STATUS_META = {
  VERIFIED: { label: '接続確認済み', cls: 'text-success-strong', bg: 'bg-success-soft' },
  FAILED: { label: '接続失敗', cls: 'text-danger-strong', bg: 'bg-danger-soft' },
};

/** 状態バッヂの HTML。未接続確認 (UNVERIFIED) はバッヂを出さない（空文字） */
function statusBadgeHtml(status) {
  const meta = STATUS_META[String(status || '')];
  if (!meta) return '';
  return `<span id="mail-status-badge" class="text-[10px] px-2 py-0.5 rounded border border-divider ${meta.bg} ${meta.cls} font-bold shrink-0">${meta.label}</span>`;
}

/** ヘッダーの状態バッヂだけ作り替える（接続テスト結果の表示で設定フォームの入力値を消さない） */
function refreshHeaderStatus() {
  const root = document.getElementById(VIEW_ID);
  if (!root) return;
  const html = statusBadgeHtml(account?.status);
  const badge = root.querySelector('#mail-status-badge');
  if (!html) {
    badge?.remove();
    return;
  }
  if (badge) {
    badge.outerHTML = html;
  } else {
    root.querySelector('#mail-btn-compose')?.insertAdjacentHTML('beforebegin', html);
  }
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

/** 未読件数（受信ボックスだけ。送信・下書き・ごみ箱は未読を数えない。読み込み済みページだけでなく全履歴の未読を使う） */
function unreadCount() {
  const store = messagesByAccount[activeAccountId];
  if (store && typeof store.inboxUnread === 'number') return store.inboxUnread;
  return (store?.inbox || []).filter((m) => !m.is_read).length;
}

/** 全アカウントの未読合計（サイドバーバッジ用。サーバーの全履歴未読を使う。読み込み済みページだけで減らさない） */
function totalUnread() {
  const stores = Object.values(messagesByAccount);
  if (stores.length > 0 && stores.every((store) => typeof store.inboxUnread === 'number')) {
    return stores.reduce((sum, store) => sum + store.inboxUnread, 0);
  }
  return stores.reduce((sum, store) => sum + (store.inbox || []).filter((m) => !m.is_read).length, 0);
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
  const syncLabel = {
    inbox: '受信ボックスを取得（IMAP）',
    sent: '送信ボックスを再取得（IMAP）',
    drafts: 'IMAP の下書きから再取得',
    trash: 'IMAP のごみ箱から再取得',
  }[folder];
  const clearLabel = {
    inbox: '表示とDBキャッシュ・IMAPの削除フラグを整理（受信箱は自動で再取得）',
    sent: '送信ボックスの表示とDBキャッシュを消す（IMAP送信済みフォルダは消しません）',
    drafts: '下書きの表示とDBキャッシュ・IMAPの下書きを消す',
    trash: 'ごみ箱の表示とDBキャッシュ・IMAPの削除フラグを消す（自動では再取得しない）',
  }[folder];

  return `
    <div class="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 bg-surface-strong p-3 rounded-xl border border-divider">
      <div class="min-w-0">
        <h2 class="text-base font-bold text-main flex items-center gap-2 shrink-0">
          <i data-lucide="mail" class="w-4 h-4 text-info"></i> メール
        </h2>
      </div>
      <div class="flex items-center gap-2 w-full sm:w-auto justify-end flex-wrap">
        ${statusBadgeHtml(account?.status)}
        <button type="button" id="mail-btn-compose" class="btn-primary shrink-0 flex items-center gap-1.5 font-bold" title="メールを新規に作成します（下書き保存と送信）">
          <i data-lucide="mail-plus" class="w-4 h-4"></i> 新規作成
        </button>
        <button type="button" id="mail-save-draft-btn" class="btn-secondary shrink-0 flex items-center gap-1.5" title="作成中のメールを下書きとして保存します（IMAP の [Gmail]/Drafts へコピー）">
          <i data-lucide="file-pen" class="w-4 h-4"></i> 下書き保存
        </button>
        <button type="button" id="mail-btn-settings" class="icon-btn icon-btn-fixed border border-divider bg-surface shrink-0"
                aria-label="メール設定（接続設定と接続テストを開く）" title="メール設定（接続設定・接続テスト）">
          <i data-lucide="settings" class="w-4 h-4"></i>
        </button>
        <button type="button" id="mail-btn-refresh" class="icon-btn icon-btn-fixed border border-divider bg-surface shrink-0"
                aria-label="${syncLabel}" title="${syncLabel}">
          <i data-lucide="${folder === 'inbox' ? 'download' : 'refresh-cw'}" class="w-4 h-4"></i>
        </button>
        <button type="button" id="mail-imap-clear-btn" class="icon-btn icon-btn-fixed border border-divider bg-surface shrink-0"
                aria-label="${clearLabel}" title="${clearLabel}">
          <i data-lucide="broom" class="w-4 h-4"></i>
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
          <button type="button" id="mail-btn-test-form" class="btn-secondary py-2 px-4 text-xs shrink-0" title="現在の入力値で IMAP / SMTP に実接続テストします（編集中のアカウントは成否を status へ記録します）">接続テスト</button>
          ${configured ? '<button type="button" id="mail-btn-cancel-edit" class="btn-secondary py-2 px-4 text-xs">変更しない</button>' : ''}
          ${configured ? '<button type="button" id="mail-btn-remove" class="btn-danger py-2 px-4 text-xs">設定を削除</button>' : ''}
        </div>
      </form>
    </div>`;
}

/** 左ペイン: メールタイトルと日時一覧（受信ボックス / 送信ボックスで内容を変える） */
function listHtml() {
  const list = currentList();
  const meta = FOLDER_META[folder];
  const isOutbox = folder === 'sent' || folder === 'drafts';
  const store = messagesByAccount[activeAccountId] || null;
  const total = (store?.counts?.[folder] ?? store?.[`${folder}Total`]) ?? list.length;
  const headerBar = `
    <div class="flex items-center justify-between gap-2">
      <h3 class="text-xs font-bold text-main flex items-center gap-2">
        <i data-lucide="${meta.icon}" class="w-4 h-4 text-info"></i> ${meta.label}
      </h3>
      <span class="text-[10px] text-muted" id="mail-box-count">${folder === 'inbox' ? `全 ${total}件 / 未読 ${unreadCount()}件` : `全 ${total}件`}</span>
    </div>`;

  if (list.length === 0) {
    return `
      <div class="card p-3">
        ${headerBar}
        <div id="mail-inbox-list" class="mt-2 max-h-[70vh] overflow-y-auto">
          <div class="text-center py-8 text-[11px] text-muted leading-relaxed">
            <i data-lucide="${meta.icon}" class="w-6 h-6 mx-auto mb-2 opacity-60"></i>
            ${meta.empty}
          </div>
        </div>
      </div>`;
  }

  const items = list
    .map((m) => {
      const selected = m.id === currentSelectedId();
      const box = selected ? 'border-accent bg-accent-soft' : 'border-divider hover:bg-surface-strong';
      const title = selected ? 'text-accent-strong' : m.is_read ? 'text-soft' : 'text-main';
      const dot = folder === 'inbox' ? (m.is_read ? 'bg-divider' : 'bg-info') : (folder === 'drafts' ? 'bg-warning' : 'bg-divider');
      const who = isOutbox ? escapeHTML(m.recipients.join(', ')) : escapeHTML(m.sender_name);
      return `
        <button type="button" class="mail-item w-full text-left rounded-lg border ${box} p-2.5 transition"
                data-mail-id="${escapeHTML(m.id)}">
          <div class="flex items-start gap-2">
            <span class="mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${dot}"></span>
            <div class="min-w-0 flex-1">
              <div class="text-xs font-bold ${title} truncate">${escapeHTML(m.subject)}</div>
              <div class="text-[10px] text-muted mt-0.5 flex items-center gap-1.5">
                <span class="font-mono shrink-0">${formatShort(m.received_at)}</span>
                <span class="truncate">${who}</span>
                ${folder === 'drafts' ? '<span class="text-[10px] text-warning shrink-0">下書き</span>' : ''}
              </div>
            </div>
          </div>
        </button>`;
    })
    .join('');

  // 最下部フッター: 読み込み中はローダ行、読み込むものが尽きた受信箱・送信ボックスは1行の終了表示
  const foot = store?.loadingOlder
    ? '<div id="mail-list-loader" class="py-2 flex items-center justify-center gap-1.5 text-[11px] text-muted"><i data-lucide="loader-2" class="w-4 h-4 animate-spin"></i>過去のメールを読み込み中</div>'
    : (canLoadOlder(store) ? '' : '<div id="mail-list-foot" class="py-2 text-center text-[10px] text-muted">これより過去のメールはありません</div>');

  return `
    <div class="card p-3">
      ${headerBar}
      <div id="mail-inbox-list" class="mt-2 space-y-1.5 max-h-[70vh] overflow-y-auto">${items}${foot}</div>
    </div>`;
}

/** 右ペイン: メール本文（詳細）。受信・ごみ箱は差出人、送信・下書きは宛先を表示し、フォルダ別の操作ボタンを付ける */
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

  const isOutbox = msg.folder === 'sent' || msg.folder === 'drafts';
  const stateBadge = msg.folder === 'sent'
    ? '<span class="badge bg-surface-strong text-muted border-divider shrink-0">送信済み</span>'
    : msg.folder === 'drafts'
      ? '<span class="badge bg-warning-soft text-warning-strong border-warning-soft shrink-0">下書き</span>'
      : msg.folder === 'trash'
        ? '<span class="badge bg-danger-soft text-danger-strong border-danger-soft shrink-0">ごみ箱</span>'
        : msg.is_read
          ? '<span class="badge bg-surface-strong text-muted border-divider shrink-0">既読</span>'
          : '<span class="badge bg-info-soft text-info-strong border-info-soft shrink-0">未読</span>';
  const who = isOutbox
    ? `宛先: <span class="font-bold text-soft">${escapeHTML(msg.recipients.join(', '))}</span>`
    : `差出人: <span class="font-bold text-soft">${escapeHTML(msg.sender_name)}</span> &lt;${escapeHTML(msg.sender_email)}&gt;`;
  const datetimeLabel = msg.folder === 'drafts' ? '保存日時' : msg.folder === 'sent' ? '送信日時' : '受信日時';

  // HTML専用メールはサーバー側でタグ除去しているため、その旨をbannerで示す
  const htmlBanner = msg.html_stripped
    ? '<div class="mt-3 text-[10px] text-warning leading-tight">※ HTMLメールのため、タグを除去して表示しています。</div>'
    : '';

  // 本文はまだキャッシュされていない受信・ごみ箱メールは「読み込み中」プレースホルダ (selectMessage で遅延取得)
  const bodyInner = msg.body
    ? escapeHTML(msg.body)
    : isOutbox
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

  // フォルダ別の操作ボタン (ごみ箱は復元と完全削除、下書きは送信とごみ箱、受信・送信はごみ箱へ移動)
  const actionRow = msg.folder === 'trash'
    ? `
      <div class="mt-3 pt-3 border-t border-divider flex flex-wrap items-center gap-2">
        <button type="button" class="btn-secondary py-1.5 px-3 text-xs shrink-0" data-mail-action="restore" title="ごみ箱から受信箱へ復元します（IMAP でも受信フォルダへコピー）">
          <i data-lucide="rotate-ccw" class="w-3.5 h-3.5"></i> 受信箱へ復元
        </button>
        <button type="button" class="btn-danger py-1.5 px-3 text-xs shrink-0" data-mail-action="purge" title="IMAP とDBから完全に削除します（元に戻せません）">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> 完全に削除
        </button>
      </div>`
    : msg.folder === 'drafts'
      ? `
      <div class="mt-3 pt-3 border-t border-divider flex flex-wrap items-center gap-2">
        <button type="button" class="btn-primary py-1.5 px-3 text-xs font-bold shrink-0" data-mail-action="send-draft" title="下書きの内容をSMTPで送信します（送信ボックスへ記録）">
          <i data-lucide="send" class="w-3.5 h-3.5"></i> この下書きを送信
        </button>
        <button type="button" class="btn-secondary py-1.5 px-3 text-xs shrink-0" data-mail-action="trash" title="ごみ箱へ移動します">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> ごみ箱へ移動
        </button>
      </div>`
      : `
      <div class="mt-3 pt-3 border-t border-divider flex flex-wrap items-center gap-2">
        <button type="button" class="btn-primary py-1.5 px-3 text-xs font-bold shrink-0" data-mail-action="reply" title="差出人へ返信します（引用文を作成フォームへ入れ、返信元メールに \Answered マークを付けます）">
          <i data-lucide="reply" class="w-3.5 h-3.5"></i> 返信
        </button>
        <button type="button" class="btn-secondary py-1.5 px-3 text-xs shrink-0" data-mail-action="reply-all" title="差出人と自分以外の全宛先へ返信します">
          <i data-lucide="reply-all" class="w-3.5 h-3.5"></i> 全員に返信
        </button>
        <button type="button" class="btn-secondary py-1.5 px-3 text-xs shrink-0" data-mail-action="forward" title="このメールの内容を他の宛先へ転送します（転送元メールに \Forwarded マークを付けます）">
          <i data-lucide="forward" class="w-3.5 h-3.5"></i> 転送
        </button>
        <button type="button" class="btn-secondary py-1.5 px-3 text-xs shrink-0" data-mail-action="trash" title="ごみ箱へ移動します（IMAP では COPY + 削除フラグ）">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> ごみ箱へ移動
        </button>
      </div>`;

  return `
    <div class="card p-4" id="mail-detail">
      <div class="flex items-start justify-between gap-3">
        <h3 id="mail-detail-subject" class="text-sm font-bold text-main leading-relaxed">${escapeHTML(msg.subject)}</h3>
        ${stateBadge}
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted">
        <span>${who}</span>
        <span id="mail-detail-datetime" class="font-mono">${datetimeLabel}: ${formatDateTime(msg.received_at)}</span>
      </div>
      ${htmlBanner}
      <div id="mail-detail-body" class="mt-3 pt-3 border-t border-divider text-xs text-main leading-relaxed whitespace-pre-wrap">${bodyInner}</div>
      ${attList}
      ${actionRow}
    </div>`;
}

/** アカウントタブ（受信ボックス・送信ボックスの上に並べる。タブにアカウント名を表示し、末尾の + でアカウントを追加） */
function accountTabsHtml() {
  const configured = accounts.filter((a) => !a.needs_setup);
  const tabs = configured.map((a) => {
    const active = a.id === activeAccountId;
    const unread = typeof messagesByAccount[a.id]?.inboxUnread === 'number'
      ? messagesByAccount[a.id].inboxUnread
      : (messagesByAccount[a.id]?.inbox || []).filter((m) => !m.is_read).length;
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

/** ボックスタブ（受信ボックス / 送信ボックス / 下書き / ごみ箱）。1枚の実線枠、選択は青の下線。各タブに全件数を出す */
function tabsHtml() {
  const store = messagesByAccount[activeAccountId] || {};
  const tabs = FOLDERS.map((f, i) => {
    const count = typeof store.counts?.[f] === 'number'
      ? store.counts[f]
      : (typeof store[`${f}Total`] === 'number' ? store[`${f}Total`] : (store[f] || []).length);
    return `
      <button type="button" id="mail-tab-${f}" data-mail-folder="${f}" role="tab"
              aria-selected="${folder === f}" aria-controls="mail-box-area"
              class="mail-tab-btn px-3 py-2 text-xs font-bold flex items-center gap-1.5${i > 0 ? ' border-l border-main' : ''}">
        <i data-lucide="${FOLDER_META[f].icon}" class="w-3.5 h-3.5"></i> ${FOLDER_META[f].label} <span class="text-[10px] text-muted font-normal">全</span> <span class="text-[10px] text-muted font-normal" id="mail-${f}-count">${count}件</span>
      </button>`;
  }).join('');

  return `
    <div id="mail-box-tabs" class="flex rounded-lg border border-main overflow-hidden bg-surface mb-3 flex-wrap" role="tablist" aria-label="メールボックス選択">
      ${tabs}
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
          <h3 id="mail-compose-title" class="modal-title"><i data-lucide="mail-plus" class="w-5 h-5 text-accent"></i> メール新規作成</h3>
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
            <button type="button" id="mail-compose-save-draft-btn" class="btn-secondary px-4 py-2 text-xs" title="現在の入力を下書きとして保存（DBとIMAPの下書きフォルダへ）">下書き保存</button>
            <button type="submit" class="btn-primary px-4 py-2 text-xs font-bold" title="SMTPで送信する">送信する</button>
          </div>
        </form>
      </div>
    </div>`;
}

/** 新規作成モーダルを #modal-container（body 直下）へ常設マウントし、フォーム送信をバインドする。
 *  #view-mail は .tab-view.active の fadeIn（transform: translateY）が position:fixed 子要素の包含ボックスに
 *  なるため、モーダルを #view-mail 内に置くとスクリーンがタブ面だけの box（実測 1180×441）に制限され、
 *  カード上部（タイトルバー「メール新規作成」と閉じる X）が切り詰められて正しく表示されない。
 *  施設・スケジュール・教科モジュールと同じ #modal-container へ置く（fixed が viewport 基準になる）。 */
function mountComposeModal() {
  const host = document.getElementById('modal-container') || document.body;
  const existing = document.getElementById('mail-compose-modal');
  if (existing) {
    if (existing.parentElement !== host) host.appendChild(existing); // 旧 #view-mail 版は移設する
    return existing;
  }
  host.insertAdjacentHTML('beforeend', composeModalHtml());
  const modal = document.getElementById('mail-compose-modal');
  const form = modal.querySelector('#mail-compose-form');
  // モーダルは #view-mail の委譲対象外なので、フォーム送信はフォームへ直接バインドする
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    await sendComposeMessage(form);
  });
  // モーダル内の「下書き保存」はヘッダーの短縮ボタンと同じく現在の入力を保存する
  modal.querySelector('#mail-compose-save-draft-btn')?.addEventListener('click', () => saveComposeDraft(form));
  // 閉じる（X・閉じるボタン）では返信・転送のプレフィル状態と入力欄をクリアする
  modal.querySelectorAll('.modal-close').forEach((b) => b.addEventListener('click', () => resetComposeModal()));
  refreshLucideIcons();
  // lucide 変換後のタイトルマーカーを保存する。閉じる時に refreshLucideIcons() を呼ぶと既存の
  // <svg data-lucide> を挿し替えるため、実マウスクリックの e.target（svg/path）がイベント伝播中に
  // DOM から切り離され、document 委譲の closest('.modal-close') が効かず閉じるボタンが機能しなく
  // なる（UI テスト「閉じるボタンで新規作成モーダルが消える」）。挿し替えは行わない。
  const title = modal.querySelector('#mail-compose-title');
  if (title) composeTitleDefault = title.innerHTML;
  return modal;
}

/** 未設定（設定フォーム表示）時は新規作成モーダルを撤去する（アカウント全削除で残さない） */
function unmountComposeModal() {
  document.getElementById('mail-compose-modal')?.remove();
  composeTitleDefault = null;
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

/** フォームの現在値（メール設定メニュー内の接続テスト用ペイロード。編集中のアカウントは account_id を添える） */
function formProbePayload() {
  const root = document.getElementById(VIEW_ID);
  const get = (id) => root?.querySelector(`#${id}`)?.value ?? '';
  const payload = {
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
  // 編集中のアカウント（setupTargetId）のテストは成否をそのアカウントの status へ反映する
  if (setupTargetId) payload.account_id = setupTargetId;
  return payload;
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
    // ヘッダーの状態バッヂと設定メニュー直下の結果パネルだけ差し替える（フォームの入力値は作り替えない）
    refreshHeaderStatus();
    const slot = document.getElementById('mail-test-slot');
    if (slot) slot.innerHTML = testResultHtml(lastTest);
    else renderMailView();
    refreshLucideIcons();
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
    const store = ensureStore(accountId);
    // 1ページ目（最新ページ）だけ更新し、読み込み済みの過去ページは重複を除いて保持する
    applyPageOne(store, res, 'inbox');
    folder = 'inbox';
    if (accountId === account.id) {
      normalizeSelection(store);
      renderMailView();
    }
    updateMailUnreadBadge();
    await refreshCounts(accountId);
    if (!silent) showToast(res.message, res.added > 0 ? 'success' : 'info');
  } catch (err) {
    // 自動受信・定期受信の失敗は表示を止めない（ダウンロードボタンからの手動受信だけトーストを出す）
    if (!silent) showToast(`受信できませんでした: ${err.message}`, 'error');
  } finally {
    fetching = false;
  }
}

/** 表示中フォルダを IMAP から再同期する (送信・下書き・ごみ箱)。受信箱は受信ボタンが fetchInboxFromServer を使う */
async function performFolderSync() {
  if (syncing) return;
  if (!account || account.needs_setup) {
    showToast('同期の前にメール接続設定を保存してください。', 'warning');
    return;
  }
  if (folder === 'inbox') {
    await fetchInboxFromServer({ silent: false });
    return;
  }
  syncing = true;
  const accountId = account.id;
  try {
    // サーバーが IMAP からの取り込みとDB保存を済ませる (ack で追加件数と総件数を返す) → 1ページ目をDBから読み直す
    const res = await requestMailSocket('mail:sync_folder', { account_id: accountId, folder });
    if (!res?.success) {
      showToast(res?.message || '同期に失敗しました。', 'warning');
      return;
    }
    const store = ensureStore(accountId);
    await reloadFolderPageOne(accountId, folder);
    store[`${folder}HasMore`] = false; // IMAP 同期は1ページで全取得するためページングしない
    normalizeSelection(store);
    renderMailView();
    await refreshCounts(accountId);
    showToast(res.added > 0 ? `${FOLDER_META[folder].label}に新着 ${res.added}件` : `${FOLDER_META[folder].label}は最新`, 'success');
  } catch (err) {
    showToast(`同期できませんでした: ${err.message}`, 'error');
  } finally {
    syncing = false;
  }
}

/** 表示中フォルダのIMAPデータを消す (受信箱はIMAPから自動再取得、ごみ箱は自動再取得しない) */
async function clearIMAPData() {
  if (!account || account.needs_setup) {
    showToast('消す前にメール接続設定を選んでください。', 'warning');
    return;
  }
  const warnings = {
    inbox: '受信箱の表示・DBキャッシュ・IMAPの削除フラグを消します。IMAPから自動で再取得します。',
    sent: '送信ボックスの表示・DBキャッシュを消します（IMAPの送信済みフォルダは消しません）。',
    drafts: '下書きの表示・DBキャッシュ・IMAPの下書きメッセージを消します。',
    trash: 'ごみ箱の表示・DBキャッシュ・IMAPの削除フラグを消します（自動では再取得しません）。',
  };
  if (!window.confirm(`${warnings[folder]}\n\n表示を消しますか？`)) return;
  const accountId = account.id;
  try {
    const res = await apiPost('/mail/imap-data/clear', { account_id: accountId, folder });
    const store = ensureStore(accountId);
    store[folder] = [];
    store.counts[folder] = 0;
    store[`${folder}Total`] = 0;
    store[`${folder}HasMore`] = false;
    if (folder === 'inbox') {
      store.inboxUnread = 0;
      store.inboxImapMore = null; // 受信箱は IMAP から自動再取得する (cron + WSS 通知)
    }
    setCurrentSelectedId(null);
    renderMailView();
    await refreshCounts(accountId);
    showToast(res.message, 'success');
  } catch (err) {
    showToast(`消せませんでした: ${err.message}`, 'error');
  }
}

/**
 * WSS の新着受信通知を適用する (サーバー側cronが IMAP から受信してDBへ保存済み。変化のあったアカウントだけ届く)
 * 一覧カードの中身と件数表示だけを差し替える（ヘッダー・タブ・モーダルは再描画しない = アニメーション の再発火を防ぐ）
 */
export async function applyMailSocketUpdate(payload) {
  const accountId = payload?.account_id;
  if (!accountId || !state.currentUser) return false;
  const folderKey = FOLDERS.includes(payload?.folder) ? payload.folder : 'inbox';

  const store = messagesByAccount[accountId];
  if (!store) {
    // 自分の画面がまだ読み込んでいないアカウントは未読バッジだけ更新する
    updateMailUnreadBadge();
    return false;
  }

  try {
    // サーバーは IMAP 受信と DB 保存を済ませている → DB の最新だけ読む (ブラウザは IMAP に接続しない)
    const res = await apiGet(`/mail/messages?folder=${folderKey}&account_id=${encodeURIComponent(accountId)}&limit=${PAGE_SIZE}`);
    store[folderKey] = res.messages || [];
    // 件数表示・未読・過去分の残存はサーバーの全履歴値へ追従させる（総件数表示はDB総件数）
    store[`${folderKey}Total`] = typeof res.total === 'number' ? res.total : store[folderKey].length;
    store[`${folderKey}HasMore`] = res.has_more === true;
    store.counts[folderKey] = store[`${folderKey}Total`];
    if (typeof res.unread === 'number') store.inboxUnread = res.unread;
    if (res.imap_more === true || res.imap_more === false) store.inboxImapMore = res.imap_more;
  } catch (err) {
    return false;
  }

  updateMailUnreadBadge();
  updateTabCounts();

  // アカウントタブの未読数だけ値を更新する (タブ自体は再描画しない)
  const tabUnread = document.querySelector(`#view-mail [data-mail-tab-unread="${accountId}"]`);
  if (tabUnread) {
    const unread = typeof store.inboxUnread === 'number' ? store.inboxUnread : store.inbox.filter((m) => !m.is_read).length;
    tabUnread.textContent = unread > 99 ? '99+' : String(unread);
  }

  if (accountId !== activeAccountId) return true;

  normalizeSelection(store);

  // 表示中なら一覧カードの中身だけを差し替える (全面再描画・スクロール復帰・アイコン再描画をしない)
  const root = document.getElementById(VIEW_ID);
  const listBox = root ? root.querySelector('#mail-inbox-list') : null;
  if (listBox && folder === folderKey && !showSetupForm && state.currentTab === 'mail') {
    const tmp = document.createElement('div');
    tmp.innerHTML = listHtml();
    const fresh = tmp.querySelector('#mail-inbox-list');
    if (fresh) listBox.innerHTML = fresh.innerHTML;
    const total = typeof store.counts[folderKey] === 'number' ? store.counts[folderKey] : store[folderKey].length;
    const boxCount = document.getElementById('mail-box-count');
    if (boxCount) boxCount.textContent = folderKey === 'inbox' ? `全 ${total}件 / 未読 ${unreadCount()}件` : `全 ${total}件`;
    const tabCount = document.getElementById(`mail-${folderKey}-count`);
    if (tabCount) tabCount.textContent = `${total}件`;
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
  serverPollMs: null,           // 60秒周期のサーバー側cron定期受信も廃止した (2026-11-14。受信は常時 IMAP IDLE)
  idleReconnectMinMs: IDLE_RECONNECT_MIN_MS, // IMAP IDLE セッションの再接続窓 (25分)
  idleReconnectMaxMs: IDLE_RECONNECT_MAX_MS, // IMAP IDLE セッションの再接続窓 (29分)
  socketBound,
  activeAccountId,
  pageSize: PAGE_SIZE,
  // keyset ページングの状態 (無限スクロールの実測用。oldest はカーソル = 表示中ボックス最古の行)
  pagination: (() => {
    const store = messagesByAccount[activeAccountId] || {};
    const list = store[folder] || [];
    const last = list.length ? list[list.length - 1] : null;
    return {
      folder,
      loadedInbox: (store.inbox || []).length,
      loadedSent: (store.sent || []).length,
      loadedDrafts: (store.drafts || []).length,
      loadedTrash: (store.trash || []).length,
      counts: store.counts ? { ...store.counts } : {},
      // 件数の旧キー (UI 検証スクリプトが counts と同値で参照する)
      inboxTotal: store.counts?.inbox ?? 0,
      sentTotal: store.counts?.sent ?? 0,
      draftsTotal: store.counts?.drafts ?? 0,
      trashTotal: store.counts?.trash ?? 0,
      inboxHasMore: store.inboxHasMore === true,
      sentHasMore: store.sentHasMore === true,
      draftsHasMore: store.draftsHasMore === true,
      trashHasMore: store.trashHasMore === true,
      inboxImapMore: store.inboxImapMore ?? null,
      canLoadOlder: canLoadOlder(store),
      loadingOlder: store.loadingOlder === true,
      oldest: last ? `${last.received_at}+${last.id}` : null,
      scrollTop: listScrollTop,
    };
  })(),
  compose: (() => {
    const modal = document.getElementById('mail-compose-modal');
    if (!modal) return { mounted: false };
    return {
      mounted: true,
      open: !modal.classList.contains('hidden'),
      mode: composeReply?.mode ?? null,
      reply_to_id: composeReply?.reply_to_id ?? null,
      to: modal.querySelector('#mail-compose-to')?.value ?? '',
      subject: modal.querySelector('#mail-compose-subject')?.value ?? '',
      body: modal.querySelector('#mail-compose-body')?.value ?? '',
    };
  })(),
  accounts: accounts.filter((a) => !a.needs_setup).map((a) => ({
    id: a.id,
    email: a.email_address,
    unread: typeof messagesByAccount[a.id]?.inboxUnread === 'number'
      ? messagesByAccount[a.id].inboxUnread
      : (messagesByAccount[a.id]?.inbox || []).filter((m) => !m.is_read).length,
  })),
});

// WSS 通知の適用関数 (UI テストが socket 通知をシミュレートし、再描画なしで更新されることを検証するためのフック)
window.__mailApply = (payload) => applyMailSocketUpdate(payload);

/** 新規作成・閉じで返信・転送のプレフィル状態と入力欄をクリアし、タイトルを「メール新規作成」へ戻す。
 *  lucide の再描画は行わない（閉じるボタン押下中に <svg data-lucide> を挿し替えると、実マウスクリックの
 *  e.target が DOM から切り離され、document 委譲の closest('.modal-close') が効かなくなるため）。
 *  マーカーは mountComposeModal で lucide 変換後に保存した composeTitleDefault を復元する。 */
function resetComposeModal() {
  composeReply = null;
  const modal = document.getElementById('mail-compose-modal');
  if (!modal) return;
  modal.querySelector('#mail-compose-form')?.reset();
  const title = modal.querySelector('#mail-compose-title');
  if (title && composeTitleDefault) title.innerHTML = composeTitleDefault;
}

/** 返信・転送の作成フォームを開く (引用文と件名プレフィックスを作り、送信時に reply_to_id / reply_mode を送る) */
async function openComposeReply(mode, msg) {
  const modal = mountComposeModal();
  if (!modal || !account || !msg) return;
  // 本文が未キャッシュの受信・ごみ箱メールは引用前に本文を取得する
  if (!msg.body) {
    msg.body_requested = true;
    await loadLazyBody(msg);
  }
  const quote = String(msg.body || '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  const dateText = String(msg.received_at ?? '').slice(0, 10) || '（日時不明）';
  const baseSubject = String(msg.subject || '').replace(/^(Re|Fwd):\s*/i, '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();
  const selfEmail = String(account.email_address || state?.currentUser?.email || '').toLowerCase();
  const rawRecipients = typeof msg.recipients === 'string' ? msg.recipients.split(',') : (msg.recipients || []);
  const others = Array.from(new Set(rawRecipients.map((r) => String(r).trim().toLowerCase()).filter((r) => r && r !== selfEmail)));

  let to = '';
  let subject = '';
  let body = '';
  if (mode === 'forward') {
    subject = `Fwd: ${baseSubject}`;
    body = `\n---------- 転送されたメッセージ ----------\n差出人: ${msg.sender_name} <${msg.sender_email}>\n日付: ${dateText}\n件名: ${msg.subject}\n\n${quote}\n`;
  } else {
    const list = mode === 'reply-all' ? [String(msg.sender_email || '').toLowerCase(), ...others] : [String(msg.sender_email || '').toLowerCase()];
    to = Array.from(new Set(list.filter(Boolean))).join(', ');
    subject = `Re: ${baseSubject}`;
    body = `${dateText} に ${msg.sender_name} (${msg.sender_email}) は次のように書きました:\n\n${quote}\n`;
  }

  composeReply = { mode, reply_to_id: msg.id, folder: msg.folder };
  const toField = modal.querySelector('#mail-compose-to');
  const subjectField = modal.querySelector('#mail-compose-subject');
  const bodyField = modal.querySelector('#mail-compose-body');
  if (toField) toField.value = to;
  if (subjectField) subjectField.value = subject;
  if (bodyField) bodyField.value = body;
  const title = modal.querySelector('#mail-compose-title');
  if (title) {
    const iconName = mode === 'forward' ? 'forward' : 'reply';
    const label = mode === 'forward' ? 'メール転送' : mode === 'reply-all' ? '全員に返信' : 'メール返信';
    title.innerHTML = `<i data-lucide="${iconName}" class="w-5 h-5 text-accent"></i> ${label}`;
  }
  openModal('mail-compose-modal');
  refreshLucideIcons();
  showToast(mode === 'forward' ? '転送の作成フォームを開きました。宛先を入力して送信してください。' : '返信の作成フォームを開きました。内容を確認して送信してください。', 'info');
}

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
  const replyMeta = composeReply ? { reply_to_id: composeReply.reply_to_id, reply_mode: composeReply.mode } : null;
  showToast(replyMeta ? `${replyMeta.reply_mode === 'forward' ? '転送' : '返信'}を送信中…` : '送信しています…', 'info');
  try {
    const res = await apiPost('/mail/send', { account_id: account.id, to, subject, body: bodyText, ...(replyMeta || {}) });
    const sourceFolder = composeReply?.folder ?? null;
    resetComposeModal(); // 送信後はプレフィル状態・入力欄・タイトルを空へ戻す
    closeModal('mail-compose-modal');
    showToast(res.message, 'success');
    // 送信後は送信ボックスへ切り替えて記録を表示する (返信・転送元フォルダと4フォルダ件数も読み直す)
    folder = 'sent';
    await reloadFolderPageOne(account.id, 'sent');
    if (sourceFolder && sourceFolder !== 'sent') await reloadFolderPageOne(account.id, sourceFolder);
    await refreshCounts(account.id);
    setCurrentSelectedId(currentList()[0]?.id || null);
    renderMailView();
  } catch (err) {
    showToast(`送信できませんでした: ${err.message}`, 'error');
  } finally {
    sending = false;
  }
}

/** 新規作成フォームの内容を下書きとして保存する (POST /mail/draft → IMAP の下書きフォルダへ APPEND) */
async function saveComposeDraft(form) {
  if (savingDraft) return;
  if (!account || account.needs_setup) {
    showToast('下書き保存の前にメール接続設定を保存してください。', 'warning');
    return;
  }
  const to = (form.querySelector('#mail-compose-to')?.value || '').trim();
  const subject = (form.querySelector('#mail-compose-subject')?.value || '').trim();
  const bodyText = form.querySelector('#mail-compose-body')?.value ?? '';
  if (!to && !subject && !bodyText.trim()) {
    showToast('下書きに内容がありません。', 'warning');
    return;
  }

  savingDraft = true;
  showToast('下書きを保存しています…', 'info');
  try {
    const res = await apiPost('/mail/draft', { account_id: account.id, to, subject, body: bodyText });
    showToast(res.message, 'success');
    // 下書きタブへ切り替えて記録を表示する (一覧と4フォルダ件数を読み直す)
    folder = 'drafts';
    await reloadFolderPageOne(account.id, 'drafts');
    await refreshCounts(account.id);
    setCurrentSelectedId(currentList()[0]?.id || null);
    renderMailView();
  } catch (err) {
    showToast(`下書きを保存できませんでした: ${err.message}`, 'error');
  } finally {
    savingDraft = false;
  }
}

/** 表示中メールのフォルダ操作 (ごみ箱へ移動 / ごみ箱から復元 / 完全に削除 / 下書きを送信)。操作後は対象フォルダと件数を読み直す */
async function runMessageAction(action, msg) {
  if (acting || !msg || !account) return;
  // 返信・転送は確認もAPI呼び出しも行わない (作成フォームを開き、送信時に reply_to_id / reply_mode を送る)
  if (action === 'reply' || action === 'reply-all' || action === 'forward') {
    await openComposeReply(action, msg);
    return;
  }
  const confirmText = {
    trash: 'このメールをごみ箱へ移動します。',
    restore: 'このメールをごみ箱から受信箱へ復元します。',
    purge: 'このメールを IMAP とDBから完全に削除します。元に戻せません。',
    'send-draft': 'この下書きをSMTPで送信します。',
  }[action];
  // 送信だけは取り消し確認を出さない (送信取り消しはサポートしない)
  if (action !== 'send-draft' && !window.confirm(confirmText)) return;

  acting = true;
  const source = msg.folder;
  try {
    let res;
    if (action === 'send-draft') {
      showToast('下書きを送信しています…', 'info');
      res = await apiPost(`/mail/draft/${msg.id}/send`, { account_id: account.id });
    } else if (action === 'purge') {
      showToast('完全に削除しています…', 'info');
      res = await apiPost(`/mail/messages/${msg.id}/purge`, { account_id: account.id });
    } else {
      showToast(`${action === 'restore' ? '復元' : 'ごみ箱へ移動'}しています…`, 'info');
      res = await apiPost(`/mail/messages/${msg.id}/${action}`, { account_id: account.id });
    }

    // 操作で変化したフォルダの1ページ目と4フォルダ件数を読み直す (表示は止めない)
    const touched = { trash: [source, 'trash'], restore: ['trash', 'inbox'], purge: ['trash'], 'send-draft': ['drafts', 'sent'] }[action];
    // 操作でフォルダを外れた行は 1ページ目のマージに混ざって残るので、store から先に外す (applyPageOne は読み込み済み行を保持する)
    const storeNow = ensureStore(account.id);
    storeNow[source] = (storeNow[source] || []).filter((m) => m.id !== msg.id);
    for (const f of touched) await reloadFolderPageOne(account.id, f);
    await refreshCounts(account.id);
    showToast(res.message || '操作しました', 'success');
    folder = { trash: 'trash', restore: 'inbox', purge: 'trash', 'send-draft': 'sent' }[action];
    setCurrentSelectedId(currentList()[0]?.id || null);
    renderMailView();
  } catch (err) {
    showToast(`操作できませんでした: ${err.message}`, 'error');
  } finally {
    acting = false;
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
        const store = ensureStore(a.id);
        // 1ページ目は4ボックスそれぞれ50件、総件数・未読・IMAP 過去分の残存を記録する（スクロールで50件ずつAppend）
        if (FOLDERS.every((f) => store[f].length === 0)) {
          for (const f of FOLDERS) {
            const res = await apiGet(`/mail/messages?folder=${f}&account_id=${encodeURIComponent(a.id)}&limit=${PAGE_SIZE}`);
            applyPageOne(store, res, f);
          }
          store.inboxImapMore = null; // IMAP 側の過去分残存は受信・過去分取得の成否で判定する
        }
      }

      const store = messagesByAccount[activeAccountId];
      normalizeSelection(store);
      // 4フォルダ件数をサーバーの全件数へ追従させる (タブ件数表示の正)
      await refreshCounts(activeAccountId);
      // 設定済みならボックスを表示（ページ再読み込み後は showSetupForm が初期値 true のため必ず落とす）
      showSetupForm = false;
    } else {
      account = accounts[0] || null;
      activeAccountId = null;
      messagesByAccount = {};
      folder = 'inbox';
      selectedIds = { inbox: null, sent: null, drafts: null, trash: null };
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

  if (configured && !showSetupForm) {
    parts.push(boxHtml());
  } else {
    // 接続テスト結果はメール設定メニュー（設定フォーム）の直下に出す。受信箱面には出さない
    const prefill = account?.email_address || account?.suggested_email || state.currentUser?.email || '';
    parts.push(setupFormHtml(prefill));
    parts.push('<div id="mail-test-slot" style="display:contents">' + testResultHtml(lastTest) + '</div>');
  }

  root.innerHTML = parts.join('');
  refreshLucideIcons();
  updateMailUnreadBadge();
  updateTabCounts();
  // 新規作成モーダルは #modal-container 側で保持する（タブビュー内に置くと fixed が包含ボックスに制限される）
  if (configured && !showSetupForm) mountComposeModal();
  else unmountComposeModal();
  // 一覧のスクロールで過去分をAppendする（表示位置はそのまま復元する）
  if (configured && !showSetupForm) {
    bindInfiniteScroll();
    // 選択中の受信・ごみ箱メールの本文が未キャッシュなら WSS で遅延取得する
    // （初期選択・アカウント切替・タブ復帰でも右ペインの本文が空のままにならない）
    const sel = currentList().find((m) => m.id === currentSelectedId());
    if (sel && sel.folder !== 'sent' && sel.folder !== 'drafts' && !sel.body && !sel.body_requested) {
      sel.body_requested = true;
      loadLazyBody(sel);
    }
  }
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
      const store = messagesByAccount[activeAccountId];
      if (store && typeof store.inboxUnread === 'number' && store.inboxUnread > 0) store.inboxUnread -= 1;
    } catch (err) {
      // 既読記録の失敗は表示を止めない
    }
  }

  renderMailView();

  // 受信・ごみ箱メールで本文が未キャッシュなら、WSS で本文を遅延取得して詳細ペインを埋める
  if ((msg.folder === 'inbox' || msg.folder === 'trash') && !msg.body && !msg.body_requested) {
    msg.body_requested = true;
    loadLazyBody(msg);
  }
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
  const section = btn.getAttribute('data-att-part');
  const msg = currentList().find((m) => m.id === currentSelectedId());
  if (!msg) return;
  const res = await requestMailSocket('mail:get_attachment', { id: msg.id, section });
  if (!res?.success) { showToast(res?.message || '添付を取得できませんでした。', 'warning'); return; }
  const bytes = base64ToBytes(res.base64);
  const blob = new Blob([bytes], { type: res.type || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = res.name || btn.getAttribute('data-att-name') || 'attachment';
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
      const store = ensureStore(id);
      listScrollTop = 0; // アカウント切替は先頭へ（スクロール位置を引き継がない）
      normalizeSelection(store);
      renderMailView();
      await refreshCounts(id);
      return;
    }

    const tab = e.target.closest('[data-mail-folder]');
    if (tab) {
      const next = tab.getAttribute('data-mail-folder');
      if (!FOLDERS.includes(next)) return;
      folder = next;
      listScrollTop = 0; // ボックス切替は先頭へ（スクロール位置を引き継がない）
      const store = messagesByAccount[activeAccountId];
      if (store) normalizeSelection(store);
      renderMailView();
      return;
    }

    const actionBtn = e.target.closest('[data-mail-action]');
    if (actionBtn) {
      const msg = currentList().find((m) => m.id === currentSelectedId());
      if (!msg) return;
      await runMessageAction(actionBtn.getAttribute('data-mail-action'), msg, actionBtn);
      return;
    }

    const attDl = e.target.closest('[data-mail-att="download"]');
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
      // 新規作成は返信・転送のプレフィルと状態をクリアして空のフォームを開く
      resetComposeModal();
      openModal('mail-compose-modal');
      return;
    }

    if (btn.id === 'mail-save-draft-btn') {
      if (!configured) {
        showToast('下書き保存の前にメール接続設定を保存してください。', 'warning');
        return;
      }
      const composeForm = document.getElementById('mail-compose-modal')?.querySelector('#mail-compose-form');
      if (composeForm) await saveComposeDraft(composeForm);
      return;
    }

    if (btn.id === 'mail-imap-clear-btn') {
      await clearIMAPData();
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
      await performFolderSync();
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
    folder = 'inbox';
    selectedIds = { inbox: null, sent: null, drafts: null, trash: null };
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
    folder = 'inbox';
    selectedIds = { inbox: null, sent: null, drafts: null, trash: null };
    // 削除完了でフォームを閉じる（消したアカウントの編集画面に留まらず、残ったアカウントの受信箱を即表示する）
    showSetupForm = false;
    setupTargetId = null;
    await loadMailData();
    showToast(res.message || 'メール接続設定を削除しました', 'info');
  } catch (err) {
    showToast(err.message || 'メール接続設定の削除に失敗しました', 'error');
  }
}
