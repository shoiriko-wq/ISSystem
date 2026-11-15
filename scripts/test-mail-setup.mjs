/**
 * サイドメニュー順序とメール初回設定 (メールアドレス + パスワード) の実ブラウザ検証
 *
 * 検証項目:
 *  1. サイドメニューの順序が ダッシュボード / 職員掲示板 / 職員チャット / メール /
 *     スケジュール / 施設物品予約 / 簡易承認 / 座席表 / 定期考査 である
 *  2. メールタブの初回は設定フォームが表示され、メールアドレスはユーザー情報からプリフィルされる
 *  2a. 上級設定（IMAP / SMTP）は .env の初期値（GitHub 非公開の秘匿情報）でプリフィルされる
 *  3. 不正メールアドレスの送信はエラートーストになり、フォームは残る
 *  4. 正常な設定保存で受信箱パネルへ切り替わり、アカウントタブにアドレスが表示される（ヘッダーの接続アカウント行は廃止）
 *  4a. ヘッダーデザインは職員掲示板・施設物品予約と同一（ツールバー面＋text-base タイトル＋w-4 アイコン、
 *      コントロール高さは 2.4rem に統一。メール設定と再読み込みは 2.4rem 正方形のアイコンのみ）。
 *      ヘッダーに接続テストボタンは無く、「設定保存済み（未接続確認）」バッヂも出ない
 *  4f-2. 接続テストはメール設定メニュー内の「接続テスト」だけで実行し、結果パネルは設定メニュー直下に出す。
 *        編集中のアカウントなので成否は status に記録されヘッダーバッヂが「接続失敗」へ更新される（フォーム入力値は無再描画で保持）
 *  4g. 受信/送信済みタブ: 検証用メッセージを DB へ直接登録し、タブ切替で受信1ページ目50件（DB総件数118）・
 *      送信済み1ページ目50件（DB総件数60）と右本文を実測。左一覧の初期選択・未読バッジ (26->25) も実測
 *  4g3. 無限スクロール: 受信・送信ボックスとも最下部スクロールで50件ずつAppendする。受信はDBの118件で尽きた後、
 *      IMAP 依頼（到達不能サーバー）で失敗トーストとなり表示は止まらず「これより過去のメールはありません」へ。
 *      受信ボタンのIMAP失敗も表示を止めない。件数表示はDB総件数、ボックス切替は先頭へ、ページAppendは表示位置そのまま、
 *      定期受信は1ページ目を更新し読み込み済み過去ページは重複のみ置換する（過去ページを消さない）
 *  4g2. 「新規作成」モーダル: #modal-container に常設し、スクリーンは画面全体を覆いカードは画面内に収まる
 *      （タブビューの fadeIn transform を包含ボックスにするとタイトルバーがクリップされる）。宛先・件名・本文欄が
 *      並び、SMTP 到達不能で送信は失敗トースト、閉じるで消える。アカウント全削除（初回フォーム）ではモーダルも撤去される
 *  5. ページ再読み込み後も設定済み状態 (フォームは出ない) が続き、テスト失敗状態と既読状態 (未読2) が残る
 *  6. 「設定を削除」で初回フォームへ戻り、後続検証のため DB を未設定状態へ戻す
 * 実行: node scripts/test-mail-setup.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE  UI_USER  UI_PASS  CHROME_PATH
 * 出力: scripts/output/mail-setup.png  / NG が 1 件でもあれば exit code 1
 *  注意: 実 IMAP/SMTP は外部サーバーなので検証では到達不能。一覧表示は検証用メッセージを
 *        DB（mail_messages）へ直接登録して DB 読み出しの描画を実測する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import config from '../config/default.js';
import { query, pool } from '../config/database.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'scripts', 'output');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';

// .env（Git にコミットしない秘匿情報）のメールサーバー初期値 == フォームのプリフィル期待値
const MAIL_DEFAULTS = {
  imapHost: config.mail.imapHost,
  imapPort: config.mail.imapPort,
  smtpHost: config.mail.smtpHost,
  smtpPort: config.mail.smtpPort,
};

const EXPECTED_ORDER = [
  'ダッシュボード',
  '職員掲示板',
  '職員チャット',
  'メール',
  'スケジュール',
  '施設物品予約',
  '簡易承認',
  '座席表',
  '定期考査',
];

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH を指定してください。');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

/**
 * 受信箱と送信済みボックスの検証用メッセージを DB (mail_messages) へ直接登録する。
 * 実 IMAP は外部サーバーで検証では到達不能なため、一覧は DB 読み出しで表示される。
 * 受信は 118件 (1ページ目50件 + 過去ページ68件。2025-01-01 からの過去分115件 + 最新3件で、
 * 「UI検証メール3」(2026-06-03) が最新 = 初期選択)、未読は SEED_INBOX_UNREAD件。
 * 送信済みは 60件 (1ページ目50件 + 過去ページ10件)。受信・送信ボックスの50件ずつの無限スクロールを実測する。
 * user_id はログイン staff_code T2026001 のユーザーレコード id 'kyomu01'（FK が users(id) を指すため）。
 * account_id は UI で保存された接続アカウント（mail_accounts の 1件目）の id を実参照する。
 */
const pad2 = (n) => String(n).padStart(2, '0');
const PAGE = 50;              // モジュールの PAGE_SIZE と同じ（1ページ表示件数）
const SEED_INBOX_TOTAL = 118; // 受信ボックスのDB総件数（件数表示はこれ、一覧は50件ずつAppend）
const SEED_SENT_TOTAL = 60;   // 送信ボックスのDB総件数
const SEED_INBOX_UNREAD = 92 + 3; // 過去分115件の未読92件 + 最新3件（全て未読）

async function seedMailMessages() {
  await query(`DELETE FROM mail_messages WHERE user_id = 'kyomu01'`);
  const acc = await query(
    `SELECT id FROM mail_accounts WHERE user_id = 'kyomu01' ORDER BY created_at, id LIMIT 1`
  );
  const accountId = acc.rows[0]?.id;
  if (!accountId) throw new Error('seedMailMessages: 接続アカウント (mail_accounts) が見つかりません');

  const insertInbox = (id, uid, senderName, senderEmail, subject, body, isRead, receivedAt) =>
    query(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, subject, body, is_read, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, 'kyomu01', accountId, 'inbox', uid, senderName, senderEmail, subject, body, isRead, receivedAt]
    );
  const insertSent = (id, subject, recipients, body, receivedAt) =>
    query(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, sender_name, sender_email, recipients, subject, body, is_read, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [id, 'kyomu01', accountId, 'sent', '田中太郎', 'tanaka.ui@issystem.example', recipients, subject, body, 1, receivedAt]
    );

  // 最新3件（初期選択と既読テスト用。「UI検証メール3」が最新で listItems[0] になる）
  const newestRows = [
    ['mail_kyomu01_inbox_9001', '9001', '山田太郎', 'yamada@issystem.example', 'UI検証メール1',
      '本文一: 左一覧の1ページ目に現れる受信検証メッセージです。右ペインの本文表示を確認する文章です。', 0, '2026-06-01 09:00:00'],
    ['mail_kyomu01_inbox_9002', '9002', '佐藤花子', 'sato@issystem.example', 'UI検証メール2',
      '本文二: 2件目の受信メッセージです。選んだメールが既読扱いになり未読バッジが減ることを確認します。', 0, '2026-06-02 10:00:00'],
    ['mail_kyomu01_inbox_9003', '9003', '教務室', 'kyomu@issystem.example', 'UI検証メール3',
      '本文三: 最新の受信メッセージです。初期選択で右ペインにこの本文が出ることを確認します。', 0, '2026-06-03 11:00:00'],
  ];
  for (const [id, uid, senderName, senderEmail, subject, body, isRead, receivedAt] of newestRows) {
    await insertInbox(id, uid, senderName, senderEmail, subject, body, isRead, receivedAt);
  }

  // 過去分115件（2025-01-01 から1日刻みで1件ずつ、UID は IMAP の UID が古い順に採番される順序に合わせる）
  for (let i = 0; i < 115; i++) {
    const d = new Date(2025, 0, 1 + i, 7 + (i % 10), i % 60, 0);
    await insertInbox(
      `mail_kyomu01_inbox_${1100 + i}`, String(1100 + i),
      `過去差出人${i + 1}`, `older${i + 1}@issystem.example`,
      `過去メール${i + 1}`,
      `過去メールの本文${i + 1}: 1ページ目の50件を越えた過去ページ。スクロールAppendで最下位が入れ替わる。`,
      i < 68 && i % 3 === 0 ? 1 : 0, // 過去分(古い68件)に既読23件。1ページ目の直近47件は全て未読
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`
    );
  }

  // 送信ボックスの60件（既存2件 + 過去分58件。1ページ目は2026-06-04 の分刻み50件）
  await insertSent('mail_kyomu01_seed_sent1', '送信済みメール1', 'yamada@issystem.example',
    '本文一: 送信済みボックスの1件目です。タブ切替で表示されることを確認します。', '2026-06-01 15:00:00');
  await insertSent('mail_kyomu01_seed_sent2', '送信済みメール2', 'sato@issystem.example',
    '本文二: 送信済みボックスの2件目です。初期選択で右ペインに出ることを確認します。', '2026-06-02 16:00:00');
  for (let i = 0; i < 58; i++) {
    const d = new Date(2026, 5, 4, 9, i, 0);
    await insertSent(
      `mail_kyomu01_seed_sent${i + 3}`, `送信済みメール${i + 3}`, 'yamada@issystem.example',
      `送信済み過去メールの本文${i + 3}: 送信ボックスも50件ずつAppendする。`,
      `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:00`
    );
  }
}

/** サイドメニューのラベル順・メールタブの状態スナップショット */
const snapshot = (page) => page.evaluate(() => {
  const labels = [...document.querySelectorAll('.app-sidebar .nav-item')]
    .filter((n) => !n.classList.contains('hidden'))
    .map((n) => (n.querySelector('.nav-label')?.textContent || '').trim());
  const view = document.getElementById('view-mail');
  const toasts = [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim());
  const items = [...document.querySelectorAll('#mail-inbox-list [data-mail-id]')].map((b) => ({
    id: b.getAttribute('data-mail-id'),
    subject: (b.querySelector('.font-bold')?.textContent || '').trim(),
    time: (b.querySelector('.font-mono')?.textContent || '').trim(),
    selected: b.classList.contains('bg-accent-soft'),
    readDot: (b.querySelector('.rounded-full')?.className || '').includes('bg-divider'),
  }));
  const badge = document.getElementById('mail-unread-count');
  return {
    labels,
    viewActive: view ? view.classList.contains('active') : null,
    hasForm: !!document.getElementById('mail-setup-form'),
    emailValue: document.getElementById('mail-setup-email')?.value || '',
    imapHostValue: document.getElementById('mail-setup-imap-host')?.value || '',
    imapPortValue: document.getElementById('mail-setup-imap-port')?.value || '',
    smtpHostValue: document.getElementById('mail-setup-smtp-host')?.value || '',
    smtpPortValue: document.getElementById('mail-setup-smtp-port')?.value || '',
    passwordField: !!document.getElementById('mail-setup-password'),
    hasInbox: !!document.getElementById('mail-inbox-list'),
    settingsBtn: (document.getElementById('mail-btn-settings')?.textContent || '').replace(/\s+/g, ' ').trim(),
    settingsAriaLabel: document.getElementById('mail-btn-settings')?.getAttribute('aria-label') || '',
    settingsIconClass: (document.querySelector('#mail-btn-settings svg')?.getAttribute('class') || ''),
    hasHeaderTestBtn: !!document.getElementById('mail-btn-test'),
    statusBadgeText: (document.getElementById('mail-status-badge')?.textContent || '').trim(),
    // 接続テスト結果パネルはメール設定メニュー（設定フォーム）の中にある（受信箱面には出ない）
    resultInSettings: !!document.getElementById('mail-test-result') && !!document.getElementById('mail-setup-form') && !document.getElementById('mail-inbox-list'),
    testResultText: (document.getElementById('mail-test-result')?.textContent || '').replace(/\s+/g, ' ').trim(),
    formTestBtnText: (document.getElementById('mail-btn-test-form')?.textContent || '').replace(/\s+/g, ' ').trim(),
    listItems: items,
    pageText: (document.getElementById('mail-list-foot')?.textContent || '').replace(/\s+/g, ' ').trim(),
    loaderText: (document.getElementById('mail-list-loader')?.textContent || '').replace(/\s+/g, ' ').trim(),
    listScrollTop: document.getElementById('mail-inbox-list')?.scrollTop ?? -1,
    detailSubject: (document.getElementById('mail-detail-subject')?.textContent || '').trim(),
    detailDatetime: (document.getElementById('mail-detail-datetime')?.textContent || '').trim(),
    detailBody: (document.getElementById('mail-detail-body')?.textContent || '').trim(),
    unreadBadgeText: badge ? badge.textContent.trim() : '',
    unreadBadgeHidden: badge ? badge.classList.contains('hidden') : null,
    tabs: (() => {
      const ti = document.getElementById('mail-tab-inbox');
      const ts = document.getElementById('mail-tab-sent');
      const cb = document.getElementById('mail-btn-compose');
      return {
        inboxText: (ti?.textContent || '').trim(),
        sentText: (ts?.textContent || '').trim(),
        inboxActive: ti ? ti.getAttribute('aria-selected') === 'true' : null,
        sentActive: ts ? ts.getAttribute('aria-selected') === 'true' : null,
        composeText: (cb?.textContent || '').trim(),
      };
    })(),
    modalOpen: (() => {
      const m = document.getElementById('mail-compose-modal');
      return !!m && !m.classList.contains('hidden');
    })(),
    modalFields: (() => {
      const m = document.getElementById('mail-compose-modal');
      if (!m) return false;
      return !!m.querySelector('#mail-compose-to') && !!m.querySelector('#mail-compose-subject') &&
        !!m.querySelector('#mail-compose-body') && !!m.querySelector('#mail-compose-form button[type="submit"]');
    })(),
    composeMounted: (() => {
      const m = document.getElementById('mail-compose-modal');
      return m ? (m.parentElement?.id || null) : null; // #modal-container に常設されているか
    })(),
    modalGeo: (() => {
      const m = document.getElementById('mail-compose-modal');
      if (!m) return null;
      const card = m.querySelector('.modal-card');
      const mr = m.getBoundingClientRect(), cr = card.getBoundingClientRect();
      const cx = cr.x + cr.width / 2, cy = cr.y + cr.height / 2;
      const top = document.elementFromPoint(cx, cy);
      return {
        parent: m.parentElement?.id || null,
        overlay: { x: Math.round(mr.x), y: Math.round(mr.y), w: Math.round(mr.width), h: Math.round(mr.height) },
        card: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
        viewport: { w: innerWidth, h: innerHeight },
        centerHit: top && top.closest ? !!top.closest('#mail-compose-modal') : false,
      };
    })(),
    headerText: (document.getElementById('view-mail')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    fullViewText: document.getElementById('view-mail')?.textContent || '',
    accountTabsText: (document.getElementById('mail-account-tabs')?.textContent || '').replace(/\s+/g, ' ').trim(),
    accountTabCount: document.querySelectorAll('#mail-account-tabs [data-mail-account]').length,
    accountTabActive: (document.querySelector('#mail-account-tabs [data-mail-account][aria-selected="true"] .font-bold')?.textContent || '').trim(),
    addAccountBtn: !!document.getElementById('mail-btn-add-account'),
    accountTabsAboveBox: (() => {
      const at = document.getElementById('mail-account-tabs');
      const bt = document.getElementById('mail-box-tabs');
      if (!at || !bt) return null;
      return at.getBoundingClientRect().bottom <= bt.getBoundingClientRect().top + 1;
    })(),
    refreshIconClass: (document.querySelector('#mail-btn-refresh svg')?.getAttribute('class') || ''),
    boxCountText: (document.getElementById('mail-box-count')?.textContent || '').trim(),
    inboxTabCountText: (document.getElementById('mail-inbox-count')?.textContent || '').trim(),
    sentTabCountText: (document.getElementById('mail-sent-count')?.textContent || '').trim(),
    listMarker: document.querySelector('#mail-inbox-list[data-ui-marker]')?.getAttribute('data-ui-marker') || '',
    tabsMarker: document.querySelector('#mail-box-tabs[data-ui-marker]')?.getAttribute('data-ui-marker') || '',
    tabUnreadMap: (() => {
      const map = {};
      document.querySelectorAll('#view-mail [data-mail-tab-unread]').forEach((el) => {
        map[el.getAttribute('data-mail-tab-unread')] = el.textContent.trim();
      });
      return map;
    })(),
    mailSnap: (() => {
      const s = window.__mailSnap ? window.__mailSnap() : null;
      return s ? { clientPollMs: s.clientPollMs, clientPolling: s.clientPolling, serverPollMs: s.serverPollMs,
        idleReconnectMinMs: s.idleReconnectMinMs, idleReconnectMaxMs: s.idleReconnectMaxMs,
        socketBound: s.socketBound, activeAccountId: s.activeAccountId, pageSize: s.pageSize,
        pagination: s.pagination, accounts: s.accounts, compose: s.compose } : null;
    })(),
    headerInfo: (() => {
      const h = document.querySelector('#view-mail > div');
      if (!h) return null;
      const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const h2 = h.querySelector('h2');
      const sb = document.getElementById('mail-btn-settings');
      const cb = document.getElementById('mail-btn-compose');
      const rb = document.getElementById('mail-btn-refresh');
      const px = (el) => (el ? Math.round(parseFloat(getComputedStyle(el).height) * 10) / 10 : null);
      const wx = (el) => (el ? Math.round(parseFloat(getComputedStyle(el).width) * 10) / 10 : null);
      return {
        toolbar: h.classList.contains('bg-surface-strong') && h.classList.contains('rounded-xl') && h.classList.contains('border'),
        isCard: h.classList.contains('card'),
        h2Text: (h2?.textContent || '').replace(/\s+/g, ' ').trim(),
        h2Class: h2?.className || '',
        h2Size: h2 ? Math.round(parseFloat(getComputedStyle(h2).fontSize) * 10) / 10 : null,
        iconClass: h2?.querySelector('i[data-lucide], svg')?.getAttribute('class') || '',
        settingsH: px(sb),
        settingsW: wx(sb),
        composeH: px(cb),
        refreshH: px(rb),
        refreshW: wx(rb),
        targetH: Math.round(rootFont * 2.4 * 10) / 10,
      };
    })(),
    // 4フォルダタブ (下書き・ごみ箱) とフォルダ別の操作ボタン、ヘッダーアイコンの aria-label
    draftsTabText: (document.getElementById('mail-tab-drafts')?.textContent || '').replace(/\s+/g, ' ').trim(),
    trashTabText: (document.getElementById('mail-tab-trash')?.textContent || '').replace(/\s+/g, ' ').trim(),
    draftsTabActive: document.getElementById('mail-tab-drafts')?.getAttribute('aria-selected') === 'true',
    trashTabActive: document.getElementById('mail-tab-trash')?.getAttribute('aria-selected') === 'true',
    actionButtons: (() => {
      const map = {};
      document.querySelectorAll('#view-mail [data-mail-action]').forEach((el) => {
        map[el.getAttribute('data-mail-action')] = (el.textContent || '').replace(/\s+/g, ' ').trim();
      });
      return map;
    })(),
    clearBtnAria: document.getElementById('mail-imap-clear-btn')?.getAttribute('aria-label') || '',
    refreshBtnAria: document.getElementById('mail-btn-refresh')?.getAttribute('aria-label') || '',
    saveDraftBtnText: (document.getElementById('mail-save-draft-btn')?.textContent || '').replace(/\s+/g, ' ').trim(),
    detailBadgeText: (document.querySelector('#mail-detail .badge')?.textContent || '').trim(),
    composeTitleText: (document.getElementById('mail-compose-title')?.textContent || '').replace(/\s+/g, ' ').trim(),
    toasts,
  };
});

// 検証開始前に kyomu01（staff_code T2026001）のメール設定とメッセージを消し、既知の開始状態（未設定・受信箱空）を作る
await query(`DELETE FROM mail_messages WHERE user_id = 'kyomu01'`);
await query(`DELETE FROM mail_accounts WHERE user_id = 'kyomu01'`);

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

// 1. サイドメニューの順序
const first = await snapshot(page);
check('サイドメニューの順序', JSON.stringify(first.labels) === JSON.stringify(EXPECTED_ORDER), first.labels);

// 2. メールタブ初回フォーム (プリフィル)
await page.click('.app-sidebar [data-tab="mail"]');
await sleep(1200);
const setup = await snapshot(page);
check('メールタブ表示', setup.viewActive === true, setup.viewActive);
check('初回は設定フォーム', setup.hasForm === true && setup.passwordField === true, { hasForm: setup.hasForm, passwordField: setup.passwordField });
check('メールアドレスはユーザー情報からプリフィル', setup.emailValue.includes('@'), setup.emailValue);

// 2a. IMAP / SMTP の初期値は .env（秘匿設定）から自動プリフィルされる
check('IMAP/SMTP 初期値は .env の秘匿設定からプリフィル',
  setup.imapHostValue === MAIL_DEFAULTS.imapHost &&
  setup.imapPortValue === String(MAIL_DEFAULTS.imapPort) &&
  setup.smtpHostValue === MAIL_DEFAULTS.smtpHost &&
  setup.smtpPortValue === String(MAIL_DEFAULTS.smtpPort),
  {
    expected: MAIL_DEFAULTS,
    imap: `${setup.imapHostValue}:${setup.imapPortValue}`,
    smtp: `${setup.smtpHostValue}:${setup.smtpPortValue}`,
  });

// 2b. ヘッダーデザイン（職員掲示板・施設物品予約と同一のツールバー。card 枠ではない）
const hi = setup.headerInfo;
check('メールヘッダーはツールバー面（bg-surface-strong + 実枠。card 枠ではない）',
  hi && hi.toolbar === true && hi.isCard === false,
  { toolbar: hi?.toolbar, isCard: hi?.isCard });
check('メールタイトルは text-base と w-4 アイコン',
  hi && hi.h2Text === 'メール' && hi.h2Class.includes('text-base') && /\bw-4\b/.test(hi.iconClass),
  { h2Text: hi?.h2Text, h2Class: hi?.h2Class, h2Size: hi?.h2Size, iconClass: hi?.iconClass });
check('初回の案内文（はじめてご利用…暗号化して保存されます）は表示されない',
  !/はじめてご利用|暗号化して保存/.test(setup.fullViewText),
  { fullViewText: setup.fullViewText.slice(0, 120) });

// 3a. ブラウザ側バリデーション: 明らかな不正メールは送信がblockされ、フォームは残る
await page.evaluate(() => {
  document.getElementById('mail-setup-email').value = 'bad-mail-address';
  document.getElementById('mail-setup-password').value = 'abcdef';
  document.getElementById('mail-setup-form').requestSubmit();
});
await sleep(900);
const blocked = await snapshot(page);
const htmlInvalid = await page.evaluate(() => document.getElementById('mail-setup-email').checkValidity() === false);
check('ブラウザ側で不正メールを送信block', htmlInvalid === true && blocked.hasForm === true && !blocked.hasInbox, { htmlInvalid, hasForm: blocked.hasForm });

// 3b. サーバー検証: ブラウザは通すがサーバーが拒否する形式はエラートーストになりフォームが残る
await page.evaluate(() => {
  document.getElementById('mail-setup-email').value = 'a@b.c';
  document.getElementById('mail-setup-password').value = 'abcdef';
  document.getElementById('mail-setup-form').requestSubmit();
});
await sleep(1200);
const bad = await snapshot(page);
const badToast = bad.toasts.some((t) => t.includes('メールアドレス'));
check('サーバー検証でエラートースト', badToast === true, bad.toasts);
check('不正メール後はフォーム維持', bad.hasForm === true && !bad.hasInbox, { hasForm: bad.hasForm, hasInbox: bad.hasInbox });


// 4. 正常な設定保存 -> 左一覧と右本文へ
await page.evaluate(() => {
  document.getElementById('mail-setup-email').value = 'tanaka.ui@issystem.example';
  document.getElementById('mail-setup-password').value = 'ui-secret-123';
  document.getElementById('mail-setup-imap-host').value = 'imap.issystem.example';
  document.getElementById('mail-setup-imap-port').value = '993';
  document.getElementById('mail-setup-form').requestSubmit();
});
await sleep(1500);
// 検証用メッセージを DB へ登録し、再読み込みで「DB 読み出しの一覧表示」を实測する（実IMAPは到達不能）
await seedMailMessages();
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);
await page.click('.app-sidebar [data-tab="mail"]');
await sleep(1800);
const configured = await snapshot(page);
check('保存で受信箱へ切り替わる', configured.hasInbox === true && configured.hasForm === false, { hasInbox: configured.hasInbox, hasForm: configured.hasForm });
check('アカウントタブに接続アカウントのアドレスが表示される（ヘッダーの接続アカウント行は廃止）',
  configured.accountTabCount === 1 && configured.accountTabActive === 'tanaka.ui@issystem.example' &&
  configured.accountTabsText.includes('tanaka.ui@issystem.example') &&
  !/接続アカウント|最終受信確認/.test(configured.fullViewText),
  { count: configured.accountTabCount, active: configured.accountTabActive, text: configured.accountTabsText.slice(0, 120) });

// 4a2. ヘッダーコントロール高さは掲示板・施設物品予約と同じ 2.4rem に統一（メール設定と再読み込みは 2.4rem 正方形）
const hc = configured.headerInfo;
check('メール設定・新規作成・再読み込みボタンは 2.4rem 高に統一（メール設定と再読み込みは 2.4rem 正方形）',
  hc && hc.settingsH === hc.targetH && hc.settingsW === hc.targetH && hc.composeH === hc.targetH &&
  hc.refreshH === hc.targetH && hc.refreshW === hc.targetH,
  { settingsH: hc?.settingsH, settingsW: hc?.settingsW, composeH: hc?.composeH,
    refreshH: hc?.refreshH, refreshW: hc?.refreshW, targetH: hc?.targetH });
check('設定済みヘッダーに受信箱案内文は出ない',
  !/はじめてご利用|暗号化して保存/.test(configured.fullViewText),
  { fullViewText: configured.fullViewText.slice(0, 120) });

// 4a3. 受信ボタンはダウンロードアイコン（リロード表示から変更。2.4rem 正方形の寸法は維持）
check('受信ボタンはダウンロードアイコン（refresh-cw アイコンは使わない）',
  configured.refreshIconClass.includes('lucide-download') && !configured.refreshIconClass.includes('lucide-refresh-cw'),
  { refreshIconClass: configured.refreshIconClass });

// 4a4. アカウントタブの配置（受信ボックス・送信ボックスタブの上にアカウントタブ、末尾に追加 (+) タブ）
check('アカウントタブが受信ボックス・送信ボックスタブより上にある',
  configured.accountTabsAboveBox === true, { accountTabsAboveBox: configured.accountTabsAboveBox });
check('アカウントタブの末尾にアカウント追加 (+) タブがある',
  configured.addAccountBtn === true, { addAccountBtn: configured.addAccountBtn });

// 4a5. サーバー側cron受信による WSS 通知フック（クライアント自律受信は廃止済み 2026/11/13）
check('設定済みで WSS 通知ハンドラが登録される（受信は常時 IMAP IDLE。クライアント側 setInterval も60秒cron受信も無し。再接続窓は25〜29分）',
  configured.mailSnap && configured.mailSnap.clientPollMs === null && configured.mailSnap.clientPolling === false &&
  configured.mailSnap.serverPollMs === null &&
  configured.mailSnap.idleReconnectMinMs === 1500000 && configured.mailSnap.idleReconnectMaxMs === 1740000 &&
  configured.mailSnap.socketBound === true &&
  configured.mailSnap.activeAccountId === configured.mailSnap.accounts[0]?.id &&
  configured.toasts.every((t) => !t.includes('受信できませんでした')) &&
  configured.hasInbox === true && configured.listItems.length >= 3,
  { mailSnap: configured.mailSnap, toasts: configured.toasts.slice(-2), items: configured.listItems.length });

// 4a-test. ヘッダーに接続テストボタンは無い（接続テストはメール設定メニューに統合済み）
check('ヘッダーに接続テストボタンは無い（接続テストはメール設定メニューへ統合）',
  configured.hasHeaderTestBtn === false, { hasHeaderTestBtn: configured.hasHeaderTestBtn });
check('メール設定ボタンはアイコンのみ（文字なし・aria-label・settings アイコン・2.4rem 正方形）',
  configured.settingsBtn === '' && configured.settingsAriaLabel.includes('メール設定') &&
  configured.settingsIconClass.includes('lucide-settings') &&
  hc && hc.settingsH === hc.targetH && hc.settingsW === hc.targetH,
  { settingsBtn: configured.settingsBtn, aria: configured.settingsAriaLabel, icon: configured.settingsIconClass,
    settingsH: hc?.settingsH, settingsW: hc?.settingsW });
check('「設定保存済み（未接続確認）」バッヂは出ない（未接続確認ではヘッダーにバッヂが無い）',
  configured.statusBadgeText === '' && !/未接続確認|設定保存済み/.test(configured.fullViewText),
  { statusBadgeText: configured.statusBadgeText, headerText: configured.headerText.slice(0, 110) });
// 4f-2 でメール設定メニュー内の「接続テスト」を実行する（受信箱表示と右本文はそのまま続く）

// 4b. 「メール設定」ボタン（アイコンのみ）と受信箱案内文
check('設定済みヘッダーの右端にメール設定ボタン（アイコンのみ）と受信ボタンが並ぶ',
  configured.settingsBtn === '' && configured.settingsAriaLabel.includes('メール設定') &&
  configured.refreshIconClass.includes('lucide-download'),
  { settingsBtn: configured.settingsBtn, aria: configured.settingsAriaLabel, icon: configured.refreshIconClass });

// 4c. 左ペイン: タイトルと日時
const timeRe = /^\d{2}\/\d{2} \d{2}:\d{2}$/;
check('左一覧にタイトルと日時が並ぶ',
  configured.listItems.length >= 3 && configured.listItems.every((i) => i.subject.length > 0 && timeRe.test(i.time)),
  configured.listItems.map((i) => `${i.subject} | ${i.time}`));

// 4d. 右ペイン: 初期選択の本文
check('初期選択で右ペインに本文',
  configured.listItems[0]?.selected === true &&
  configured.detailSubject === configured.listItems[0]?.subject &&
  configured.detailBody.length > 40 &&
  /\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/.test(configured.detailDatetime),
  { detailSubject: configured.detailSubject, detailDatetime: configured.detailDatetime, bodyLen: configured.detailBody.length });

// 4e. 2件目を選ぶと右ペインが切り替わり既読になる
const secondId = configured.listItems[1]?.id;
await page.evaluate((id) => document.querySelector(`#mail-inbox-list [data-mail-id="${id}"]`)?.click(), secondId);
await sleep(900);
const afterSelect = await snapshot(page);
check('別メールを選ぶと右本文が切り替わる',
  afterSelect.detailSubject === configured.listItems[1]?.subject && afterSelect.detailBody.length > 40,
  { detailSubject: afterSelect.detailSubject });
check('選んだメールが既読扱い (未読バッジ 26->25。読み込み済みページだけでなく全履歴の未読を使う)',
  afterSelect.unreadBadgeText === String(SEED_INBOX_UNREAD - 1) && afterSelect.unreadBadgeHidden === false,
  { badge: afterSelect.unreadBadgeText, dots: afterSelect.listItems.map((i) => (i.readDot ? 'read' : 'unread')) });

// 4g. 受信/送信済みタブの切替（DB の folder='sent' を1ページ目50件と右本文で表示する。件数表示はDB総件数）
await page.click('#mail-tab-sent');
await sleep(600);
const sentView = await snapshot(page);
check('受信タブはDB総件数118件・送信済みタブはDB総件数60件を表示する（スクロール位置は先頭へ）',
  sentView.tabs.sentActive === true && sentView.tabs.inboxActive === false &&
  sentView.tabs.inboxText.includes(`全 ${SEED_INBOX_TOTAL}件`) && sentView.tabs.sentText.includes(`全 ${SEED_SENT_TOTAL}件`) &&
  sentView.listScrollTop === 0 && sentView.listItems.length === PAGE &&
  sentView.listItems.every((i) => i.subject.startsWith('送信済みメール')) &&
  sentView.detailSubject.startsWith('送信済みメール'),
  { tabs: sentView.tabs, items: sentView.listItems.length, scrollTop: sentView.listScrollTop, detail: sentView.detailSubject });
check('送信ボックス1ページ目は50件、カーソルは表示中ボックス最古の行（受信・送信ボックス共通のkeyset）',
  sentView.mailSnap?.pagination?.folder === 'sent' && sentView.mailSnap?.pagination?.loadedSent === PAGE &&
  sentView.mailSnap?.pagination?.sentTotal === SEED_SENT_TOTAL && sentView.mailSnap?.pagination?.sentHasMore === true &&
  sentView.mailSnap?.pagination?.oldest.endsWith(`+${sentView.listItems[PAGE - 1].id}`),
  { pagination: sentView.mailSnap?.pagination, oldestItem: sentView.listItems[PAGE - 1]?.id });

// 4g2. 「新規作成」モーダル（SMTP が到達不能なため送信は失敗トーストになり、モーダルは開いたまま）
check('新規作成ボタンがある', sentView.tabs.composeText.includes('新規作成'), sentView.tabs.composeText);
await page.click('#mail-btn-compose');
await sleep(500);
const composed = await snapshot(page);
check('新規作成モーダルに宛先・件名・本文欄と送信ボタンが並ぶ',
  composed.modalOpen === true && composed.modalFields === true,
  { modalOpen: composed.modalOpen, fields: composed.modalFields });
// モーダルは #modal-container 常設でスクリーンが画面全体を覆い、カードは画面内に収まる
// （#view-mail の fadeIn transform を包含ボックスにするとスクリムがタブ面だけになりカード上部が切れる）
check('新規作成モーダルは画面全体を覆い、カードは画面内に収まる（タイトルバーがクリップされない）',
  composed.modalGeo && composed.modalGeo.parent === 'modal-container' &&
  composed.modalGeo.overlay.x === 0 && composed.modalGeo.overlay.y === 0 &&
  composed.modalGeo.overlay.w === composed.modalGeo.viewport.w &&
  composed.modalGeo.overlay.h === composed.modalGeo.viewport.h &&
  composed.modalGeo.card.y >= 0 &&
  composed.modalGeo.card.y + composed.modalGeo.card.h <= composed.modalGeo.viewport.h &&
  composed.modalGeo.centerHit === true,
  { modalGeo: composed.modalGeo, modalMounted: composed.composeMounted });
await page.evaluate(() => {
  document.getElementById('mail-compose-to').value = 'yamada@issystem.example';
  document.getElementById('mail-compose-subject').value = 'UI検証送信';
  document.getElementById('mail-compose-body').value = '新規作成モーダルからの検証本文です。';
  document.querySelector('#mail-compose-form button[type="submit"]').click();
});
await sleep(2500);
const sendFailed = await snapshot(page);
check('SMTP 到達不能で送信は失敗トーストになりモーダルは開いたまま',
  sendFailed.toasts.some((t) => t.includes('送信できませんでした')) && sendFailed.modalOpen === true,
  { toasts: sendFailed.toasts.slice(-1), modalOpen: sendFailed.modalOpen });
await page.click('#mail-compose-modal button.modal-close');
await sleep(400);
const closed = await snapshot(page);
check('閉じるボタンで新規作成モーダルが消える', closed.modalOpen === false, { modalOpen: closed.modalOpen });
// 受信箱タブへ戻す（次のセクションは受信箱表示で検証する）
await page.click('#mail-tab-inbox');
await sleep(400);

// 4g3. 受信・送信ボックスの50件ずつの無限スクロール（DB総件数表示・keysetカーソル・Append表示位置・IMAP過去分）
const scrollListToBottom = async (ms = 1200) => {
  await page.evaluate(() => {
    const el = document.getElementById('mail-inbox-list');
    el.scrollTop = el.scrollHeight;
  });
  await sleep(ms);
};

// 1ページ目は50件、件数表示はDB総件数、has_more=true、カーソルは最古の行（受信・送信ボックス共通のkeyset）
const page1Inbox = await snapshot(page);
check('受信箱1ページ目は50件・件数表示はDB総件数118件・has_more=true・カーソルは最古の行',
  page1Inbox.listItems.length === PAGE && page1Inbox.tabs.inboxText.includes(`全 ${SEED_INBOX_TOTAL}件`) &&
  page1Inbox.mailSnap?.pageSize === PAGE && page1Inbox.mailSnap?.pagination?.folder === 'inbox' &&
  page1Inbox.mailSnap?.pagination?.loadedInbox === PAGE && page1Inbox.mailSnap?.pagination?.inboxTotal === SEED_INBOX_TOTAL &&
  page1Inbox.mailSnap?.pagination?.inboxHasMore === true && page1Inbox.mailSnap?.pagination?.canLoadOlder === true &&
  page1Inbox.mailSnap?.pagination?.inboxImapMore === null &&
  page1Inbox.mailSnap?.pagination?.oldest.endsWith(`+${page1Inbox.listItems[PAGE - 1].id}`),
  { items: page1Inbox.listItems.length, tab: page1Inbox.tabs.inboxText, pagination: page1Inbox.mailSnap?.pagination });

// 最下部スクロールでDBの次ページをAppend（表示位置はそのまま、ページを先頭へ戻さない）
await scrollListToBottom();
const page2Inbox = await snapshot(page);
check('スクロールで受信箱2ページ目（50件）をAppendし表示位置はそのまま（has_more=true・件数表示はDB総件数118件）',
  page2Inbox.listItems.length === PAGE * 2 && page2Inbox.mailSnap?.pagination?.loadedInbox === PAGE * 2 &&
  page2Inbox.mailSnap?.pagination?.inboxHasMore === true && page2Inbox.listScrollTop > 0 &&
  page2Inbox.listScrollTop === page2Inbox.mailSnap?.pagination?.scrollTop &&
  page2Inbox.tabs.inboxText.includes(`全 ${SEED_INBOX_TOTAL}件`) &&
  page2Inbox.toasts.every((t) => !t.includes('受信できませんでした')) &&
  page2Inbox.mailSnap?.pagination?.oldest.endsWith(`+${page2Inbox.listItems[PAGE * 2 - 1].id}`),
  { items: page2Inbox.listItems.length, scrollTop: page2Inbox.listScrollTop, pagination: page2Inbox.mailSnap?.pagination });

// 最古までスクロール -> DBの受信履歴118件で尽きる（has_more=false、まだIMAP過去分は未判定）
await scrollListToBottom();
const page3Inbox = await snapshot(page);
check('受信箱はDBの受信履歴118件で尽きる（has_more=false、IMAP過去分は未判定、Append表示位置はそのまま）',
  page3Inbox.listItems.length === SEED_INBOX_TOTAL && page3Inbox.mailSnap?.pagination?.loadedInbox === SEED_INBOX_TOTAL &&
  page3Inbox.mailSnap?.pagination?.inboxHasMore === false && page3Inbox.mailSnap?.pagination?.inboxImapMore === null &&
  page3Inbox.mailSnap?.pagination?.canLoadOlder === true && page3Inbox.listScrollTop > 0 &&
  page3Inbox.listItems[0].subject === 'UI検証メール3',
  { items: page3Inbox.listItems.length, pagination: page3Inbox.mailSnap?.pagination });

// DBが尽きた受信箱 -> 最古スクロールでIMAPの過去分を依頼するが、到達不能サーバーは失敗トーストになり表示は止まらない
await scrollListToBottom(2500);
const imapFails = await snapshot(page);
check('DB尽きの受信箱でIMAP過去分依頼は到達不能により失敗トースト（読み込み表示は消え、118件と右本文はそのまま、終了表示へ）',
  imapFails.toasts.some((t) => t.includes('過去のメールを取得できませんでした')) &&
  imapFails.mailSnap?.pagination?.inboxImapMore === false &&
  imapFails.mailSnap?.pagination?.canLoadOlder === false &&
  imapFails.mailSnap?.pagination?.loadingOlder === false &&
  imapFails.listItems.length === SEED_INBOX_TOTAL && imapFails.loaderText === '' &&
  imapFails.pageText === 'これより過去のメールはありません' &&
  imapFails.detailBody.length > 40 && imapFails.hasInbox === true,
  { toasts: imapFails.toasts.slice(-1), pageText: imapFails.pageText, items: imapFails.listItems.length });

// 尽きた後にスクロールしても追加読み込みは発生しない（表示位置はそのまま）
const topBeforeIdle = imapFails.listScrollTop;
await scrollListToBottom();
const idleInbox = await snapshot(page);
check('尽きた受信箱をさらにスクロールしても読み込みは発生せず表示はそのまま（118件・表示位置不変）',
  idleInbox.listItems.length === SEED_INBOX_TOTAL && idleInbox.mailSnap?.pagination?.loadingOlder === false &&
  idleInbox.listScrollTop === topBeforeIdle && idleInbox.pageText === 'これより過去のメールはありません',
  { items: idleInbox.listItems.length, scrollTop: idleInbox.listScrollTop, pageText: idleInbox.pageText });

// 受信ボタン（リフレッシュ）のIMAP失敗も表示を止めない（118件と右本文が残り、追加読み込みも発生しない）
await page.click('#mail-btn-refresh');
await sleep(2500);
const refreshFail = await snapshot(page);
check('受信ボタンのIMAP失敗はトーストだけ（118件と右本文・終了表示はそのまま、追加読み込みなし）',
  refreshFail.toasts.some((t) => t.includes('受信できませんでした')) &&
  refreshFail.listItems.length === SEED_INBOX_TOTAL && refreshFail.detailBody.length > 40 &&
  refreshFail.pageText === 'これより過去のメールはありません' &&
  refreshFail.mailSnap?.pagination?.loadingOlder === false,
  { toasts: refreshFail.toasts.slice(-1), items: refreshFail.listItems.length });

// 送信ボックスの過去ページ（50件 -> スクロールで60件、尽きたら「これより過去のメールはありません」）
await page.click('#mail-tab-sent');
await sleep(600);
await scrollListToBottom();
const sentPage2 = await snapshot(page);
check('送信ボックスはスクロールで60件Append（総件数60件でhas_more=false・終了表示・表示位置そのまま）',
  sentPage2.listItems.length === SEED_SENT_TOTAL && sentPage2.mailSnap?.pagination?.loadedSent === SEED_SENT_TOTAL &&
  sentPage2.mailSnap?.pagination?.sentHasMore === false && sentPage2.mailSnap?.pagination?.canLoadOlder === false &&
  sentPage2.pageText === 'これより過去のメールはありません' && sentPage2.listScrollTop > 0 &&
  sentPage2.tabs.sentText.includes(`全 ${SEED_SENT_TOTAL}件`),
  { items: sentPage2.listItems.length, pagination: sentPage2.mailSnap?.pagination, pageText: sentPage2.pageText });

// 受信ボックスタブへ戻すと先頭表示（スクロール位置は引き継がない。読み込み済みの過去ページは保持）
await page.click('#mail-tab-inbox');
await sleep(600);
const backTopInbox = await snapshot(page);
check('受信ボックスタブへ戻すと先頭表示（スクロール位置は先頭。読み込み済みの過去ページは保持し118件）',
  backTopInbox.listScrollTop === 0 && backTopInbox.listItems.length === SEED_INBOX_TOTAL &&
  backTopInbox.listItems[0].subject === 'UI検証メール3' &&
  backTopInbox.mailSnap?.pagination?.loadedInbox === SEED_INBOX_TOTAL &&
  backTopInbox.mailSnap?.pagination?.inboxTotal === SEED_INBOX_TOTAL,
  { scrollTop: backTopInbox.listScrollTop, items: backTopInbox.listItems.length, loaded: backTopInbox.mailSnap?.pagination?.loadedInbox });

// 4f. 「メール設定」（アイコンのみ）でメール設定メニューを開く -> メニュー内に接続テストボタンがある
await page.click('#mail-btn-settings');
await sleep(600);
const opened = await snapshot(page);
check('メール設定ボタン（アイコンのみ）でメール設定メニューが開く',
  opened.hasForm === true && opened.emailValue === 'tanaka.ui@issystem.example' &&
  opened.formTestBtnText.includes('接続テスト') && opened.testResultText === '',
  { hasForm: opened.hasForm, emailValue: opened.emailValue, formTestBtnText: opened.formTestBtnText });
check('メール設定メニューを開いても「設定保存済み（未接続確認）」バッヂは出ない',
  opened.statusBadgeText === '' && !/未接続確認|設定保存済み/.test(opened.fullViewText),
  { statusBadgeText: opened.statusBadgeText, headerText: opened.headerText.slice(0, 110) });

// 4f-2. メニュー内の「接続テスト」→ 現在の入力値で IMAP / SMTP を実接続テスト（到達不能サーバーなので IMAP/SMTP とも NG）。
//       編集中のアカウントのテストなので成否は status=FAILED に記録され、ヘッダーバッヂが「接続失敗」へ更新される
await page.evaluate(() => {
  document.getElementById('mail-setup-password').value = 'ui-secret-123';
  document.getElementById('mail-setup-imap-host').value = 'imap.issystem.example';
  document.getElementById('mail-setup-imap-port').value = '993';
  document.getElementById('mail-setup-smtp-host').value = 'smtp.issystem.example';
  document.getElementById('mail-setup-smtp-port').value = '465';
});
await page.click('#mail-btn-test-form');
await sleep(600);
const formTesting = await snapshot(page);
check('接続テスト実行中の案内トースト', formTesting.toasts.some((t) => t.includes('接続テストを実行しています')), formTesting.toasts.slice(-2));
await sleep(2400);
const formTested = await snapshot(page);
check('テスト結果パネルはメール設定メニューの直下に出る（受信箱面には出ない）',
  formTested.hasForm === true && formTested.hasInbox === false && formTested.resultInSettings === true,
  { hasForm: formTested.hasForm, hasInbox: formTested.hasInbox, resultInSettings: formTested.resultInSettings });
check('テスト結果パネルに IMAP / SMTP が並び、入力値のサーバー:ポートが実測される',
  formTested.testResultText.includes('接続テスト結果') &&
  formTested.testResultText.includes('imap.issystem.example:993') &&
  formTested.testResultText.includes('smtp.issystem.example:465') &&
  formTested.testResultText.includes('IMAP (受信): 接続 NG') &&
  formTested.testResultText.includes('SMTP (送信): 接続 NG'),
  { testResultText: formTested.testResultText.slice(0, 200) });
check('編集中のアカウントのテスト成否は status=FAILED に記録され、ヘッダーバッヂが「接続失敗」へ更新される',
  formTested.statusBadgeText === '接続失敗' && formTested.headerText.includes('接続失敗') &&
  formTested.toasts.some((t) => t.includes('接続テスト: 接続失敗')),
  { statusBadgeText: formTested.statusBadgeText, headerText: formTested.headerText.slice(0, 110), toasts: formTested.toasts.slice(-1) });
check('結果表示で設定フォームは消えず、入力値は無再描画でそのまま残る',
  formTested.hasForm === true && formTested.emailValue === 'tanaka.ui@issystem.example' &&
  formTested.imapHostValue === 'imap.issystem.example' && formTested.imapPortValue === '993' &&
  formTested.smtpHostValue === 'smtp.issystem.example' && formTested.smtpPortValue === '465',
  { email: formTested.emailValue, imap: `${formTested.imapHostValue}:${formTested.imapPortValue}`,
    smtp: `${formTested.smtpHostValue}:${formTested.smtpPortValue}` });

// 4f-3. 「変更しない」で受信箱へ戻る（テスト結果パネルは設定メニュー専用。受信箱面には出さない）
await page.click('#mail-btn-cancel-edit');
await sleep(600);
const back = await snapshot(page);
check('「変更しない」で受信箱へ戻る（テスト結果パネルは受信箱面に出さない）',
  back.hasInbox === true && back.hasForm === false && back.listItems.length >= 3 &&
  back.testResultText === '' && back.resultInSettings === false,
  { hasInbox: back.hasInbox, items: back.listItems.length, testResultText: back.testResultText.slice(0, 60) });
check('テスト失敗状態 (status=FAILED) は受信箱面のヘッダーバッヂとして残る',
  back.statusBadgeText === '接続失敗', { statusBadgeText: back.statusBadgeText });

// 4h. 複数アカウントの同時表示: 「+」タブで 2件目を追加し、アカウントタブで切り替える
await page.click('#mail-btn-add-account');
await sleep(600);
await page.evaluate(() => {
  document.getElementById('mail-setup-email').value = 'second.ui@issystem.example';
  document.getElementById('mail-setup-password').value = 'ui-secret-456';
  document.getElementById('mail-setup-imap-host').value = 'imap.issystem.example';
  document.getElementById('mail-setup-imap-port').value = '993';
  document.getElementById('mail-setup-form').requestSubmit();
});
await sleep(2000);
const twoAccounts = await snapshot(page);
check('「+」タブで追加した 2件目のアカウントタブが増える',
  twoAccounts.accountTabCount === 2 && twoAccounts.accountTabsText.includes('second.ui@issystem.example') &&
  twoAccounts.accountTabActive === 'second.ui@issystem.example',
  { count: twoAccounts.accountTabCount, active: twoAccounts.accountTabActive, text: twoAccounts.accountTabsText.slice(0, 200) });
check('追加後は新アカウントの受信箱（空）を表示し、1件目の未読25は全アカウント合計のバッジに残る（サーバーの全履歴未読）',
  twoAccounts.listItems.length === 0 && twoAccounts.unreadBadgeText === String(SEED_INBOX_UNREAD - 1) &&
  twoAccounts.mailSnap.accounts.find((a) => a.email === 'tanaka.ui@issystem.example')?.unread === SEED_INBOX_UNREAD - 1,
  { items: twoAccounts.listItems.length, badge: twoAccounts.unreadBadgeText, snap: twoAccounts.mailSnap });

// 1件目のアカウントタブへ切り替えると読み込み済みの受信118件と右本文が戻る（切替時に受信問い合わせる）
const firstId = twoAccounts.mailSnap.accounts.find((a) => a.email === 'tanaka.ui@issystem.example').id;
await page.evaluate((id) => document.querySelector(`#mail-account-tabs [data-mail-account="${id}"]`).click(), firstId);
await sleep(1800);
const backFirst = await snapshot(page);
check('アカウントタブ切替で1件目の受信ボックス（読み込み済み118件・スクロール位置は先頭）と右本文が戻る',
  backFirst.accountTabActive === 'tanaka.ui@issystem.example' && backFirst.listItems.length === SEED_INBOX_TOTAL &&
  backFirst.listScrollTop === 0 && backFirst.detailBody.length > 40 &&
  backFirst.mailSnap?.pagination?.loadedInbox === SEED_INBOX_TOTAL,
  { active: backFirst.accountTabActive, items: backFirst.listItems.length, scrollTop: backFirst.listScrollTop,
    detail: backFirst.detailSubject, pagination: backFirst.mailSnap?.pagination });

// 4i. サーバー側cron受信 → WSS (mail:new_messages) 通知で一覧だけが無再描画に更新される
// (実 IMAP は到達不能なので、cron が受信して DB へ保存した状態を DB 側で再現する)
const wssAccountId = twoAccounts.mailSnap.accounts.find((a) => a.email === 'tanaka.ui@issystem.example').id;
await page.evaluate((id) => document.querySelector(`#mail-account-tabs [data-mail-account="${id}"]`).click(), wssAccountId);
await sleep(1200);
// WSS 検証節だけ受信ボックスを 4件（未読3）に整える（118件のシードは件数表示の検証用。節末で seedMailMessages() が戻る）
await query(`DELETE FROM mail_messages WHERE user_id = 'kyomu01' AND folder = 'inbox' AND account_id = '${wssAccountId}'`);
const wssSeedRows = [
  ['mail_kyomu01_wss_seed1', '9101', 'WSS 検証差出人1', 'wss1@issystem.example', 'WSS検証メール1',
    'WSS 検証用に整えた受信ボックスの1件目（既読）。件数表示と未読バッジの実測用本文です。', 1, '2026-11-10 09:00:00'],
  ['mail_kyomu01_wss_seed2', '9102', 'WSS 検証差出人2', 'wss2@issystem.example', 'WSS検証メール2',
    'WSS 検証用に整えた受信ボックスの2件目（未読）。件数表示と未読バッジの実測用本文です。', 0, '2026-11-11 10:00:00'],
  ['mail_kyomu01_wss_seed3', '9103', 'WSS 検証差出人3', 'wss3@issystem.example', 'WSS検証メール3',
    'WSS 検証用に整えた受信ボックスの3件目（未読）。件数表示と未読バッジの実測用本文です。', 0, '2026-11-12 11:00:00'],
];
for (const [id, uid, senderName, senderEmail, subject, body, isRead, receivedAt] of wssSeedRows) {
  await query(`INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, subject, body, is_read, received_at)
    VALUES ($1, 'kyomu01', $2, 'inbox', $3, $4, $5, $6, $7, $8, $9)`,
    [id, wssAccountId, uid, senderName, senderEmail, subject, body, isRead, receivedAt]);
}
// cron が受信して DB へ保存した状態を DB 側で再現する（実 IMAP は到達不能）
await query(`INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, subject, body, is_read, received_at)
  VALUES ('mail_kyomu01_wss', 'kyomu01', '${wssAccountId}', 'inbox', '9501', 'WSS 通知者', 'wss@issystem.example', 'WSS新着メール',
    'サーバー側cronが受信してDBへ保存した新着メール。WSS通知で一覧だけが無再描画に更新されることを確認する本文です。', 0, '2026-11-13 09:00:00')`);

// ノード作り替え (Animation 再発火) を実測するため一覧コンテナとタブ面へ識別マーカーを仕込む
await page.evaluate(() => {
  document.getElementById('mail-inbox-list').setAttribute('data-ui-marker', 'list');
  document.getElementById('mail-box-tabs').setAttribute('data-ui-marker', 'tabs');
});
const appliedWss = await page.evaluate((payload) => window.__mailApply(payload), {
  account_id: wssAccountId, user_id: 'kyomu01', account_email: 'tanaka.ui@issystem.example',
  added: 1, unread: 3, total: 4, newest_subject: 'WSS新着メール', newest_sender: 'WSS 通知者',
});
await sleep(400);
const afterWss = await snapshot(page);
check('WSS 通知で受信ボックスが DB の最新へ更新される (4件・未読3・件数表示も追従)',
  appliedWss === true && afterWss.listItems.length === 4 && afterWss.unreadBadgeText === '3' &&
  afterWss.boxCountText.includes('全 4件 / 未読 3件') && afterWss.inboxTabCountText === '4件' &&
  afterWss.listItems.some((i) => i.subject === 'WSS新着メール'),
  { applied: appliedWss, items: afterWss.listItems.length, badge: afterWss.unreadBadgeText,
    box: afterWss.boxCountText, tab: afterWss.inboxTabCountText });
check('WSS 更新は一覧カードの中身だけを差し替える (一覧コンテナとタブ面のノードは無傷 = Animation 再発火なし)',
  afterWss.listMarker === 'list' && afterWss.tabsMarker === 'tabs' && afterWss.detailBody.length > 40 &&
  afterWss.tabUnreadMap[wssAccountId] === '3',
  { listMarker: afterWss.listMarker, tabsMarker: afterWss.tabsMarker, tabUnread: afterWss.tabUnreadMap,
    detail: afterWss.detailSubject });

// 後続チェック（アカウント削除後・再読み込み後の 1ページ目50件と未読94）のため受信シード118件を戻し、1件だけ既読にする
await seedMailMessages();
await query(`UPDATE mail_messages SET is_read = 1 WHERE id = 'mail_kyomu01_inbox_9002'`);
// アカウント削除は表示中アカウントだけ（2件目を削除すると1件目が残る）
const secondMailId = twoAccounts.mailSnap.accounts.find((a) => a.email === 'second.ui@issystem.example').id;
await page.evaluate((id) => document.querySelector(`#mail-account-tabs [data-mail-account="${id}"]`).click(), secondMailId);
await sleep(1800);
await page.click('#mail-btn-settings');
await sleep(600);
await page.click('#mail-btn-remove');
await sleep(1600);
const afterDelete = await snapshot(page);
check('表示中アカウントの削除は2件目だけが消え、1件目の受信ボックス（1ページ目50件）と未読バッジ25が残る',
  afterDelete.accountTabCount === 1 && afterDelete.accountTabActive === 'tanaka.ui@issystem.example' &&
  afterDelete.listItems.length === PAGE && afterDelete.unreadBadgeText === String(SEED_INBOX_UNREAD - 1) &&
  afterDelete.hasForm === false,
  { count: afterDelete.accountTabCount, active: afterDelete.accountTabActive, items: afterDelete.listItems.length,
    badge: afterDelete.unreadBadgeText, hasForm: afterDelete.hasForm });

// 5. ページ再読み込み後も受信箱 (左一覧 + 右本文) が続く
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);
await page.click('.app-sidebar [data-tab="mail"]');
await sleep(1200);
const reloaded = await snapshot(page);
check('再読み込み後も設定済み', reloaded.hasInbox === true && reloaded.hasForm === false, { hasInbox: reloaded.hasInbox, hasForm: reloaded.hasForm });
check('再読み込み後も左一覧と右本文',
  reloaded.listItems.length >= 3 && reloaded.detailSubject.length > 0 && reloaded.detailBody.length > 40,
  { titles: reloaded.listItems.map((i) => i.subject), detail: reloaded.detailSubject });
check('再読み込み後もアカウントタブ・WSS 通知ハンドラ・ダウンロードアイコン',
  reloaded.accountTabActive === 'tanaka.ui@issystem.example' && reloaded.accountTabCount === 1 &&
  reloaded.mailSnap?.socketBound === true && reloaded.mailSnap?.clientPollMs === null &&
  reloaded.mailSnap?.serverPollMs === null &&
  reloaded.mailSnap?.idleReconnectMinMs === 1500000 && reloaded.mailSnap?.idleReconnectMaxMs === 1740000 &&
  reloaded.refreshIconClass.includes('lucide-download'),
  { active: reloaded.accountTabActive, mailSnap: reloaded.mailSnap, icon: reloaded.refreshIconClass });
check('接続テストの失敗状態 (status=FAILED) は再読み込み後もヘッダーバッヂとして残り、テスト結果パネルは出ない（設定メニュー専用）',
  reloaded.headerText.includes('接続失敗') && reloaded.statusBadgeText === '接続失敗' && reloaded.testResultText === '',
  { headerText: reloaded.headerText.slice(0, 110), statusBadgeText: reloaded.statusBadgeText, testResultText: reloaded.testResultText.slice(0, 60) });
check('再読み込み後も既読状態が DB に残る (受信118件中1件既読・未読バッジ 25。1ページ目50件表示)',
  reloaded.listItems.length === PAGE && reloaded.unreadBadgeText === String(SEED_INBOX_UNREAD - 1) &&
  reloaded.listItems.filter((i) => i.readDot).length === 1,
  { badge: reloaded.unreadBadgeText, dots: reloaded.listItems.map((i) => (i.readDot ? 'read' : 'unread')) });

await page.screenshot({ path: path.join(OUT_DIR, 'mail-setup.png'), fullPage: false });

// 4g4. 4フォルダタブ（受信・送信・下書き・ごみ箱）、下書き保存、下書きのごみ箱移動と復元、
//      ごみ箱の完全削除、IMAPデータ消去。実 IMAP は到達不能なので下書き2件・ごみ箱1件を DB へ直接登録し、
//      DB 読み出しの描画と件数表示を実測する（IMAP 側の操作は到達不能で失敗トーストになる）
const SEED_DRAFTS = 2;
const SEED_TRASH = 1;
const folderAccountId = backTopInbox.mailSnap.activeAccountId;
const seedDraft = async (id, subject, body, receivedAt) => query(
  `INSERT INTO mail_messages (id, user_id, account_id, folder, sender_name, sender_email, recipients, subject, body, is_read, received_at)
   VALUES ($1, 'kyomu01', $2, 'drafts', '田中太郎', 'tanaka.ui@issystem.example', 'yamada@issystem.example', $3, $4, 1, $5)`,
  [id, folderAccountId, subject, body, receivedAt]
);
const seedTrashRow = async (id, uid, subject, body, receivedAt) => query(
  `INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, subject, body, is_read, received_at)
   VALUES ($1, 'kyomu01', $2, 'trash', $3, '山田太郎', 'yamada@issystem.example', $4, $5, 0, $6)`,
  [id, folderAccountId, uid, subject, body, receivedAt]
);
await seedDraft('mail_kyomu01_draft1', '下書きメール1',
  '下書き1の本文です。下書きタブの表示と「下書き保存」で増える件数を実測する文章です。', '2026-06-05 09:00:00');
await seedDraft('mail_kyomu01_draft2', '下書きメール2',
  '下書き2の本文です。この下書きをごみ箱へ移動して受信箱へ復元する流れを実測する文章です。', '2026-06-06 10:00:00');
await seedTrashRow('mail_kyomu01_trash1', '7101', 'ごみ箱メール1',
  'ごみ箱の本文です。完全に削除（IMAP からも削除）とIMAPデータ消去を実測する文章です。', '2026-05-20 12:00:00');

// ごみ箱移動・完全削除・IMAPデータ消去は確認ダイアログを出すので自動で承諾する
page.on('dialog', (d) => d.accept());
const clickMailRow = async (id) => page.evaluate((mid) => {
  const el = document.querySelector(`#mail-inbox-list [data-mail-id="${mid}"]`);
  if (el) el.click();
}, id);
const countsOf = (snap) => snap.mailSnap?.pagination?.counts || {};

await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);
await page.click('.app-sidebar [data-tab="mail"]');
await sleep(1800);
const foldersView = await snapshot(page);
check('4フォルダタブが並び件数表示される（受信118・送信60・下書き2・ごみ箱1）',
  foldersView.tabs.inboxText.includes(`全 ${SEED_INBOX_TOTAL}件`) &&
  foldersView.tabs.sentText.includes(`全 ${SEED_SENT_TOTAL}件`) &&
  foldersView.draftsTabText.includes(`下書き 全 ${SEED_DRAFTS}件`) &&
  foldersView.trashTabText.includes(`ごみ箱 全 ${SEED_TRASH}件`) &&
  countsOf(foldersView).drafts === SEED_DRAFTS && countsOf(foldersView).trash === SEED_TRASH &&
  foldersView.saveDraftBtnText.includes('下書き保存'),
  { inbox: foldersView.tabs.inboxText, sent: foldersView.tabs.sentText, drafts: foldersView.draftsTabText,
    trash: foldersView.trashTabText, counts: countsOf(foldersView), saveDraft: foldersView.saveDraftBtnText });

// 下書きタブ：2件と「下書き」バッヂ、操作は「この下書きを送信」とごみ箱（復元・完全削除は出ない）
await page.click('#mail-tab-drafts');
await sleep(600);
await clickMailRow('mail_kyomu01_draft2');
await sleep(600);
const draftView = await snapshot(page);
check('下書きタブは2件と「下書き」バッヂ、「この下書きを送信」とごみ箱ボタン（復元・完全削除は出ない）',
  draftView.draftsTabActive === true && draftView.tabs.inboxActive === false &&
  draftView.listItems.length === SEED_DRAFTS &&
  draftView.listItems.every((i) => i.subject.startsWith('下書きメール')) &&
  draftView.detailSubject === '下書きメール2' && draftView.detailBadgeText === '下書き' &&
  draftView.detailBody.includes('下書き2の本文') &&
  (draftView.actionButtons['send-draft'] || '').includes('この下書きを送信') &&
  (draftView.actionButtons['trash'] || '').includes('ごみ箱') &&
  !draftView.actionButtons['restore'] && !draftView.actionButtons['purge'],
  { items: draftView.listItems.length, detail: draftView.detailSubject, badge: draftView.detailBadgeText,
    buttons: draftView.actionButtons, draftsActive: draftView.draftsTabActive,
    inboxActive: draftView.tabs.inboxActive, bodyLen: draftView.detailBody.length });

// 下書き保存：新規作成モーダルの内容で保存し、件数が増える（IMAP 下書きフォルダは到達不能なので警告付き）
await page.evaluate(() => document.getElementById('mail-btn-compose')?.click());
await sleep(600);
const composeOpen = await snapshot(page);
check('下書きタブで新規作成モーダルが開く', composeOpen.modalOpen === true,
  { modalOpen: composeOpen.modalOpen, toasts: composeOpen.toasts });
await page.evaluate(() => {
  document.getElementById('mail-compose-to').value = 'sato@issystem.example';
  document.getElementById('mail-compose-subject').value = 'UI検証下書き3';
  document.getElementById('mail-compose-body').value = '下書き保存ボタンで作成する3件目の下書きの本文です。';
});
await page.evaluate(() => document.getElementById('mail-compose-save-draft-btn')?.click());
await sleep(1800);
const draftSaved = await snapshot(page);
check('「下書き保存」で下書きが3件へ増え、IMAP下書きフォルダ到達不能の警告付きトーストが出る',
  draftSaved.toasts.some((t) => t.includes('下書きを保存しました')) && countsOf(draftSaved).drafts === SEED_DRAFTS + 1 &&
  draftSaved.listItems.some((i) => i.subject === 'UI検証下書き3'),
  { toasts: draftSaved.toasts.slice(-1), drafts: countsOf(draftSaved).drafts,
    subjects: draftSaved.listItems.map((i) => i.subject), modalOpen: draftSaved.modalOpen });
await page.evaluate(() => document.querySelector('#mail-compose-modal button.modal-close')?.click());
await sleep(400);

// 下書きタブの再取得（IMAP同期）は到達不能で失敗トーストだけ。表示は止まらず3件と右本文が残る
await clickMailRow('mail_kyomu01_draft2');
await sleep(400);
const draftAria = (await snapshot(page)).refreshBtnAria;
await page.click('#mail-btn-refresh');
await sleep(2500);
const draftSyncFail = await snapshot(page);
check('下書きタブの再取得ボタンはIMAP下書きフォルダを閲覧できず失敗トーストだけ（3件と右本文はそのまま）',
  draftAria.includes('IMAP の下書きから再取得') &&
  draftSyncFail.toasts.some((t) => t.includes('IMAP フォルダ') && t.includes('閲覧できません')) &&
  draftSyncFail.listItems.length === SEED_DRAFTS + 1 && draftSyncFail.detailBody.includes('下書き2の本文'),
  { aria: draftAria, toasts: draftSyncFail.toasts.slice(-1), items: draftSyncFail.listItems.length });

// 下書きをごみ箱へ移動（IMAP のごみ箱移動は到達不能で警告付き）→ ごみ箱2件、表示はごみ箱タブへ
await clickMailRow('mail_kyomu01_draft2');
await sleep(400);
await page.evaluate(() => document.querySelector('#view-mail [data-mail-action="trash"]').click());
await sleep(1800);
const draftToTrash = await snapshot(page);
check('下書きをごみ箱へ移動するとごみ箱2件・下書き2件へ更新され、表示はごみ箱タブへ切り替わる',
  draftToTrash.toasts.some((t) => t.includes('ごみ箱へ移動しました')) &&
  countsOf(draftToTrash).trash === SEED_TRASH + 1 && countsOf(draftToTrash).drafts === SEED_DRAFTS &&
  draftToTrash.trashTabActive === true && draftToTrash.listItems.length === SEED_TRASH + 1 &&
  draftToTrash.detailSubject === '下書きメール2',
  { toasts: draftToTrash.toasts.slice(-1), counts: countsOf(draftToTrash),
    active: draftToTrash.trashTabActive, detail: draftToTrash.detailSubject });

// ごみ箱から受信箱へ復元（IMAP のコピーは到達不能で警告付き）→ 受信箱119件・ごみ箱1件、表示は受信箱タブへ
await page.evaluate(() => document.querySelector('#view-mail [data-mail-action="restore"]').click());
await sleep(1800);
const restored = await snapshot(page);
check('ごみ箱から受信箱へ復元すると受信箱119件・ごみ箱1件へ更新され、表示は受信箱タブへ切り替わる',
  restored.toasts.some((t) => t.includes('受信箱へ復元しました')) &&
  countsOf(restored).inbox === SEED_INBOX_TOTAL + 1 && countsOf(restored).trash === SEED_TRASH &&
  countsOf(restored).drafts === SEED_DRAFTS && restored.tabs.inboxActive === true,
  { toasts: restored.toasts.slice(-1), counts: countsOf(restored), inboxActive: restored.tabs.inboxActive });

// ごみ箱タブ：1件と「ごみ箱」バッヂ、操作は「受信箱へ復元」と「完全に削除」（下書き送信・ごみ箱ボタンは出ない）
await page.click('#mail-tab-trash');
await sleep(600);
await clickMailRow('mail_kyomu01_trash1');
await sleep(600);
const trashView = await snapshot(page);
check('ごみ箱タブは1件と「ごみ箱」バッヂ、「受信箱へ復元」と「完全に削除」ボタン（下書き送信・ごみ箱は出ない）',
  trashView.trashTabActive === true && trashView.listItems.length === SEED_TRASH &&
  trashView.listItems[0].subject === 'ごみ箱メール1' &&
  trashView.detailBadgeText === 'ごみ箱' && trashView.detailBody.includes('ごみ箱の本文') &&
  (trashView.actionButtons['restore'] || '').includes('受信箱へ復元') &&
  (trashView.actionButtons['purge'] || '').includes('完全に削除') &&
  !trashView.actionButtons['send-draft'] && !trashView.actionButtons['trash'],
  { items: trashView.listItems.length, badge: trashView.detailBadgeText, buttons: trashView.actionButtons });

// ごみ箱の完全削除（IMAP 削除は到達不能で警告付き）→ ごみ箱0件、表示はごみ箱タブのまま
await page.evaluate(() => document.querySelector('#view-mail [data-mail-action="purge"]').click());
await sleep(1800);
const purged = await snapshot(page);
check('ごみ箱の完全削除でDB行が消えごみ箱0件（IMAP到達不能の警告付きトースト、表示はごみ箱タブのまま）',
  purged.toasts.some((t) => t.includes('完全に削除しました')) && countsOf(purged).trash === 0 &&
  purged.trashTabActive === true && purged.listItems.length === 0,
  { toasts: purged.toasts.slice(-1), trash: countsOf(purged).trash, items: purged.listItems.length });

// IMAPデータ消去（ごみ箱）：aria-label はごみ箱用、消去後は0件。IMAP削除フラグは到達不能で 0件（警告付き）
const trashClearAria = (await snapshot(page)).clearBtnAria;
await page.click('#mail-imap-clear-btn');
await sleep(1800);
const trashCleared = await snapshot(page);
check('ごみ箱のIMAPデータ消去は表示とDBキャッシュを消す（トーストに削除フラグ0件とIMAP到達不能の警告、0件へ）',
  trashClearAria.includes('ごみ箱の表示とDBキャッシュ') &&
  trashCleared.toasts.some((t) => t.includes('ごみ箱の表示とDBキャッシュを消し') && t.includes('IMAPの削除フラグ 0件')) &&
  countsOf(trashCleared).trash === 0,
  { aria: trashClearAria, toasts: trashCleared.toasts.slice(-1), trash: countsOf(trashCleared).trash });

// IMAPデータ消去（下書き）：aria-label は下書き用、消去後は0件（IMAPの下書き削除は到達不能で 0件）
await page.click('#mail-tab-drafts');
await sleep(600);
const draftClearAria = (await snapshot(page)).clearBtnAria;
await page.click('#mail-imap-clear-btn');
await sleep(1800);
const draftCleared = await snapshot(page);
check('下書きのIMAPデータ消去は表示とDBキャッシュとIMAP下書きを消す（3件→0件、IMAP到達不能の警告付き）',
  draftClearAria.includes('下書きの表示とDBキャッシュ') &&
  draftCleared.toasts.some((t) => t.includes('下書きの表示とDBキャッシュを消し')) &&
  countsOf(draftCleared).drafts === 0 && countsOf(draftCleared).trash === 0,
  { aria: draftClearAria, toasts: draftCleared.toasts.slice(-1), drafts: countsOf(draftCleared).drafts });

// 受信箱タブへ戻す（後続の設定削除検証は受信箱面から行う）
await page.click('#mail-tab-inbox');
await sleep(600);

// 7. 返信・転送ボタン: 受信箱メールの操作ボタン、プレフィル内容、SMTP到達不能の送信トースト、状態クリア
await clickMailRow('mail_kyomu01_inbox_9003');
await sleep(700);
const replyButtons = await snapshot(page);
check('受信箱のメールに「返信」「全員に返信」「転送」ボタンが出る（ごみ箱ボタンも残り下書き送信は出ない）',
  (replyButtons.actionButtons['reply'] || '').includes('返信') &&
  (replyButtons.actionButtons['reply-all'] || '').includes('全員に返信') &&
  (replyButtons.actionButtons['forward'] || '').includes('転送') &&
  (replyButtons.actionButtons['trash'] || '').includes('ごみ箱') &&
  !replyButtons.actionButtons['send-draft'],
  { buttons: replyButtons.actionButtons });

// 「返信」は確認ダイアログを出さず作成フォームを開き、差出人・Re:・引用文をプレフィルする
await page.evaluate(() => document.querySelector('#view-mail [data-mail-action="reply"]')?.click());
await sleep(1200);
const replyOpen = await snapshot(page);
const replyCompose = replyOpen.mailSnap?.compose || {};
check('「返信」で作成フォームが開き宛先・Re: 件名・引用本文と「メール返信」タイトルがプレフィルされる',
  replyOpen.modalOpen === true && replyOpen.composeTitleText.includes('メール返信') &&
  replyCompose.mode === 'reply' && replyCompose.reply_to_id === 'mail_kyomu01_inbox_9003' &&
  replyCompose.to === 'kyomu@issystem.example' && replyCompose.subject === 'Re: UI検証メール3' &&
  replyCompose.body.includes('> 本文三') &&
  replyOpen.toasts.some((t) => t.includes('返信の作成フォームを開きました')),
  { title: replyOpen.composeTitleText, compose: replyCompose, toasts: replyOpen.toasts.slice(-2) });

// 送信はSMTP到達不能で失敗トースト。フォームは開いたまま入力を保持し、送信ボックス件数は増えない
await page.evaluate(() => document.querySelector('#mail-compose-form button[type="submit"]')?.click());
await sleep(2000);
const replySent = await snapshot(page);
const sentCompose = replySent.mailSnap?.compose || {};
check('返信送信はSMTP到達不能で失敗トースト（送信ボックス60件と入力はそのまま、返信状態も保持）',
  replySent.toasts.some((t) => t.includes('返信を送信中')) &&
  replySent.toasts.some((t) => t.includes('送信できませんでした')) &&
  countsOf(replySent).sent === SEED_SENT_TOTAL && sentCompose.mode === 'reply' &&
  sentCompose.to === 'kyomu@issystem.example' && sentCompose.body.includes('> 本文三'),
  { toasts: replySent.toasts.slice(-2), sent: countsOf(replySent).sent, compose: sentCompose });

// 閉じると返信状態がクリアされ、新規作成は空フォームと「メール新規作成」タイトルへ戻る
await page.evaluate(() => document.querySelector('#mail-compose-modal button.modal-close')?.click());
await sleep(400);
const closedCompose = await snapshot(page);
check('閉じると返信状態がクリアされ、新規作成は空フォームと「メール新規作成」タイトルへ戻る',
  closedCompose.modalOpen === false && closedCompose.mailSnap?.compose?.mode === null &&
  closedCompose.mailSnap?.compose?.to === '' && closedCompose.mailSnap?.compose?.body === '' &&
  closedCompose.mailSnap?.compose?.reply_to_id === null &&
  closedCompose.composeTitleText.includes('メール新規作成'),
  { compose: closedCompose.mailSnap?.compose, title: closedCompose.composeTitleText });

// 「転送」は Fwd: 件名・転送ヘッダ・引用文をプレフィルする（宛先は空のまま）
await page.evaluate(() => document.querySelector('#view-mail [data-mail-action="forward"]')?.click());
await sleep(1200);
const fwdOpen = await snapshot(page);
const fwdCompose = fwdOpen.mailSnap?.compose || {};
check('「転送」で作成フォームが開き Fwd: 件名・転送ヘッダ・引用本文と「メール転送」タイトルがプレフィルされる',
  fwdOpen.modalOpen === true && fwdOpen.composeTitleText.includes('メール転送') &&
  fwdCompose.mode === 'forward' && fwdCompose.reply_to_id === 'mail_kyomu01_inbox_9003' &&
  fwdCompose.subject === 'Fwd: UI検証メール3' && fwdCompose.to === '' &&
  fwdCompose.body.includes('---------- 転送されたメッセージ ----------') &&
  fwdCompose.body.includes('> 本文三') &&
  fwdOpen.toasts.some((t) => t.includes('転送の作成フォームを開きました')),
  { title: fwdOpen.composeTitleText, compose: fwdCompose });
await page.evaluate(() => document.querySelector('#mail-compose-modal button.modal-close')?.click());
await sleep(400);

// 6. 設定を削除して初回フォームへ戻す (検証後に DB を未設定状態へ戻す)
await page.click('#mail-btn-settings');
await sleep(600);
await page.click('#mail-btn-remove');
await sleep(1200);
const reset = await snapshot(page);
check('設定削除で初回フォームへ戻る', reset.hasForm === true && reset.hasInbox === false, { hasForm: reset.hasForm, hasInbox: reset.hasInbox });
check('削除で未読バッジが消える', reset.unreadBadgeHidden === true, { badge: reset.unreadBadgeText, hidden: reset.unreadBadgeHidden });
check('アカウント全削除（初回フォーム）では新規作成モーダルも撤去される', reset.composeMounted === null, { composeMounted: reset.composeMounted });

// 6b. 未設定（初回フォーム）の接続テスト: パスワードが無ければ警告トーストだけ（テストは実行しない）。
//     パスワードがあればフォーム値でテストし、結果パネルはメール設定メニューに出す（アカウントが無いので status は書き込まれない）
check('初回フォームにも「設定保存済み（未接続確認）」バッヂは出ない',
  reset.statusBadgeText === '' && !/未接続確認|設定保存済み/.test(reset.fullViewText),
  { statusBadgeText: reset.statusBadgeText, headerText: reset.headerText.slice(0, 110) });
await page.click('#mail-btn-test-form');
await sleep(600);
const noPass = await snapshot(page);
check('未設定でパスワード無しテストは「パスワードが必要」の警告トーストだけ（テストは実行しない）',
  noPass.toasts.some((t) => t.includes('接続テストにはメールパスワードが必要です')) &&
  noPass.hasForm === true && noPass.testResultText === '',
  { toasts: noPass.toasts.slice(-1), hasForm: noPass.hasForm, testResultText: noPass.testResultText.slice(0, 40) });
await page.evaluate(() => { document.getElementById('mail-setup-password').value = 'ui-secret-789'; });
await page.click('#mail-btn-test-form');
await sleep(2400);
const unsetting = await snapshot(page);
check('未設定でもフォーム値の接続テストは結果パネルがメール設定メニューに出る（状態バッヂは出ない）',
  unsetting.hasForm === true && unsetting.hasInbox === false && unsetting.resultInSettings === true &&
  unsetting.testResultText.includes('IMAP (受信): 接続 NG') && unsetting.statusBadgeText === '' &&
  unsetting.toasts.some((t) => t.includes('接続テスト: 接続失敗')),
  { testResultText: unsetting.testResultText.slice(0, 120), statusBadgeText: unsetting.statusBadgeText, toasts: unsetting.toasts.slice(-1) });

await browser.close();

// 後続検証のため kyomu01 のメール設定と検証用メッセージを DB から消す（設定は UI の削除で消えている）
await query(`DELETE FROM mail_messages WHERE user_id = 'kyomu01'`);
await pool.end();

console.log('--- mail UI result ---');
console.log(failures.length === 0 ? 'ALL PASS' : `NG: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
