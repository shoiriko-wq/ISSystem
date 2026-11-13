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
 *      コントロール高さは 2.4rem に統一）。「はじめてご利用…暗号化して保存されます」の案内文は存在しない
 *  4a-test. ヘッダーの「接続テスト」で IMAP / SMTP を実接続テストし、結果パネルと status (接続失敗) が出る
 *  4f-2. フォーム内の「接続テスト（保存前に試す）」は未保存の入力値でテストし、フォームは残る
 *  4g. 受信/送信済みタブ: 検証用メッセージを DB へ直接登録し、タブ切替で受信3件・送信済み2件と
 *      右本文を実測。左一覧の初期選択・未読バッジ (3->2) も実測
 *  4g2. 「新規作成」モーダル: 宛先・件名・本文欄が並び、SMTP 到達不能で送信は失敗トースト、閉じるで消える
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
 * folder = 'inbox'（受信）3件・'sent'（送信済み）2件。受信は全て未読 (is_read=0)。
 * user_id はログイン staff_code T2026001 のユーザーレコード id 'kyomu01'（FK が users(id) を指すため）。
 * account_id は UI で保存された接続アカウント（mail_accounts の 1件目）の id を実参照する。
 */
async function seedMailMessages() {
  await query(`DELETE FROM mail_messages WHERE user_id = 'kyomu01'`);
  const acc = await query(
    `SELECT id FROM mail_accounts WHERE user_id = 'kyomu01' ORDER BY created_at, id LIMIT 1`
  );
  const accountId = acc.rows[0]?.id;
  if (!accountId) throw new Error('seedMailMessages: 接続アカウント (mail_accounts) が見つかりません');
  const inboxRows = [
    ['mail_kyomu01_inbox_9001', '9001', '山田太郎', 'yamada@issystem.example', 'UI検証メール1',
      '本文一: 左一覧の一番下に現れる受信検証メッセージです。右ペインの本文表示を確認する文章です。', 0, '2026-06-01 09:00:00'],
    ['mail_kyomu01_inbox_9002', '9002', '佐藤花子', 'sato@issystem.example', 'UI検証メール2',
      '本文二: 2件目の受信メッセージです。選んだメールが既読扱いになり未読バッジが減ることを確認します。', 0, '2026-06-02 10:00:00'],
    ['mail_kyomu01_inbox_9003', '9003', '教務室', 'kyomu@issystem.example', 'UI検証メール3',
      '本文三: 最新の受信メッセージです。初期選択で右ペインにこの本文が出ることを確認します。', 0, '2026-06-03 11:00:00'],
  ];
  for (const [id, uid, senderName, senderEmail, subject, body, isRead, receivedAt] of inboxRows) {
    await query(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, uid, sender_name, sender_email, subject, body, is_read, received_at)
       VALUES ('${id}', 'kyomu01', '${accountId}', 'inbox', '${uid}', '${senderName}', '${senderEmail}', '${subject}', '${body}', ${isRead}, '${receivedAt}')`
    );
  }
  const sentRows = [
    ['mail_kyomu01_seed_sent1', '送信済みメール1', 'yamada@issystem.example', '本文一: 送信済みボックスの1件目です。タブ切替で表示されることを確認します。', '2026-06-01 15:00:00'],
    ['mail_kyomu01_seed_sent2', '送信済みメール2', 'sato@issystem.example', '本文二: 送信済みボックスの2件目です。初期選択で右ペインに出ることを確認します。', '2026-06-02 16:00:00'],
  ];
  for (const [id, subject, recipients, body, receivedAt] of sentRows) {
    await query(
      `INSERT INTO mail_messages (id, user_id, account_id, folder, sender_name, sender_email, recipients, subject, body, is_read, received_at)
       VALUES ('${id}', 'kyomu01', '${accountId}', 'sent', '田中太郎', 'tanaka.ui@issystem.example', '${recipients}', '${subject}', '${body}', 1, '${receivedAt}')`
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
    testBtnText: (document.getElementById('mail-btn-test')?.textContent || '').replace(/\s+/g, ' ').trim(),
    testResultText: (document.getElementById('mail-test-result')?.textContent || '').replace(/\s+/g, ' ').trim(),
    formTestBtnText: (document.getElementById('mail-btn-test-form')?.textContent || '').replace(/\s+/g, ' ').trim(),
    listItems: items,
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
        socketBound: s.socketBound, activeAccountId: s.activeAccountId, accounts: s.accounts } : null;
    })(),
    headerInfo: (() => {
      const h = document.querySelector('#view-mail > div');
      if (!h) return null;
      const rootFont = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const h2 = h.querySelector('h2');
      const sb = document.getElementById('mail-btn-settings');
      const tb = document.getElementById('mail-btn-test');
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
        testH: px(tb),
        refreshH: px(rb),
        refreshW: wx(rb),
        targetH: Math.round(rootFont * 2.4 * 10) / 10,
      };
    })(),
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

// 4a2. ヘッダーコントロール高さは掲示板・施設物品予約と同じ 2.4rem に統一
const hc = configured.headerInfo;
check('メール設定・接続テスト・再読み込みボタンは 2.4rem 高に統一（再読み込みは正方形）',
  hc && hc.settingsH === hc.targetH && hc.testH === hc.targetH && hc.refreshH === hc.targetH && hc.refreshW === hc.targetH,
  { settingsH: hc?.settingsH, testH: hc?.testH, refreshH: hc?.refreshH, refreshW: hc?.refreshW, targetH: hc?.targetH });
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
check('設定済みで WSS 通知ハンドラが登録される（60秒周期の受信はサーバー側cron。クライアント側 setInterval は無し）',
  configured.mailSnap && configured.mailSnap.clientPollMs === null && configured.mailSnap.clientPolling === false &&
  configured.mailSnap.serverPollMs === 60000 && configured.mailSnap.socketBound === true &&
  configured.mailSnap.activeAccountId === configured.mailSnap.accounts[0]?.id &&
  configured.toasts.every((t) => !t.includes('受信できませんでした')) &&
  configured.hasInbox === true && configured.listItems.length >= 3,
  { mailSnap: configured.mailSnap, toasts: configured.toasts.slice(-2), items: configured.listItems.length });

// 4a-test. ヘッダーの「接続テスト」→ IMAP / SMTP を実接続テスト（到達不能サーバーなので NG になる）
check('ヘッダーに接続テストボタンがある', configured.testBtnText.includes('接続テスト'), configured.testBtnText);
await page.click('#mail-btn-test');
await sleep(600);
const testingToast = await snapshot(page);
check('接続テスト実行中の案内トースト', testingToast.toasts.some((t) => t.includes('接続テストを実行しています')), testingToast.toasts.slice(-2));
await sleep(2000);
const tested = await snapshot(page);
check('接続テスト結果パネルに IMAP / SMTP が並ぶ',
  tested.testResultText.includes('接続テスト結果') &&
  tested.testResultText.includes('IMAP (受信)') &&
  tested.testResultText.includes('SMTP (送信)'),
  { testResultText: tested.testResultText.slice(0, 160) });
check('到達不能サーバーのテストは IMAP / SMTP とも接続 NG',
  tested.testResultText.includes('IMAP (受信): 接続 NG') && tested.testResultText.includes('SMTP (送信): 接続 NG'),
  { testResultText: tested.testResultText.slice(0, 200) });
check('テスト失敗でヘッダーの状態が接続失敗になりトーストが出る',
  tested.headerText.includes('接続失敗') && tested.toasts.some((t) => t.includes('接続テスト: 接続失敗')),
  { headerText: tested.headerText.slice(0, 110), toasts: tested.toasts.slice(-1) });
// 設定を削除する前に受信箱表示と既読状態が続くことを確認する
check('接続テスト後も受信箱と右本文が表示される',
  tested.hasInbox === true && tested.listItems.length >= 3 && tested.detailBody.length > 40,
  { items: tested.listItems.length, detail: tested.detailSubject });

// 4b. 「メール設定」ボタン
check('メール設定ボタンがある', configured.settingsBtn.includes('メール設定'), configured.settingsBtn);

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
check('選んだメールが既読扱い (未読バッジ 3->2)',
  afterSelect.unreadBadgeText === '2' && afterSelect.unreadBadgeHidden === false,
  { badge: afterSelect.unreadBadgeText, dots: afterSelect.listItems.map((i) => (i.readDot ? 'read' : 'unread')) });

// 4g. 受信/送信済みタブの切替（DB の folder='sent' 2件と右本文を表示する）
await page.click('#mail-tab-sent');
await sleep(600);
const sentView = await snapshot(page);
check('受信タブが受信3件・送信済みタブが2件を表示する',
  sentView.tabs.sentActive === true && sentView.tabs.inboxActive === false &&
  sentView.listItems.length === 2 &&
  sentView.listItems.every((i) => i.subject.startsWith('送信済みメール')) &&
  sentView.detailSubject.startsWith('送信済みメール'),
  { items: sentView.listItems.map((i) => i.subject), detail: sentView.detailSubject, tabs: sentView.tabs });

// 4g2. 「新規作成」モーダル（SMTP が到達不能なため送信は失敗トーストになり、モーダルは開いたまま）
check('新規作成ボタンがある', sentView.tabs.composeText.includes('新規作成'), sentView.tabs.composeText);
await page.click('#mail-btn-compose');
await sleep(500);
const composed = await snapshot(page);
check('新規作成モーダルに宛先・件名・本文欄と送信ボタンが並ぶ',
  composed.modalOpen === true && composed.modalFields === true,
  { modalOpen: composed.modalOpen, fields: composed.modalFields });
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

// 4f. 「メール設定」でフォームを開く -> 「変更しない」で受信箱へ戻る
await page.click('#mail-btn-settings');
await sleep(600);
const opened = await snapshot(page);
check('メール設定ボタンでフォームを開く', opened.hasForm === true && opened.emailValue === 'tanaka.ui@issystem.example', { hasForm: opened.hasForm, emailValue: opened.emailValue });

// 4f-2. フォーム内の「接続テスト（保存前に試す）」→ 未保存の入力値でテスト（DB の status は変わらない）
check('フォーム内に接続テストボタンがある', opened.formTestBtnText.includes('接続テスト（保存前に試す）'), opened.formTestBtnText);
await page.evaluate(() => {
  document.getElementById('mail-setup-password').value = 'ui-secret-123';
  document.getElementById('mail-setup-imap-host').value = 'imap.issystem.example';
  document.getElementById('mail-setup-imap-port').value = '993';
  document.getElementById('mail-setup-smtp-host').value = 'smtp.issystem.example';
  document.getElementById('mail-setup-smtp-port').value = '465';
});
await page.click('#mail-btn-test-form');
await sleep(2600);
const formTested = await snapshot(page);
check('フォーム値の接続テストで結果パネルが出る',
  formTested.testResultText.includes('imap.issystem.example:993') &&
  formTested.testResultText.includes('smtp.issystem.example:465') &&
  formTested.testResultText.includes('IMAP (受信): 接続 NG'),
  { testResultText: formTested.testResultText.slice(0, 200) });
check('フォーム値テストではフォームが消えず、テスト中のトーストが出る',
  formTested.hasForm === true && formTested.toasts.some((t) => t.includes('接続テスト')),
  { hasForm: formTested.hasForm, toasts: formTested.toasts.slice(-1) });

await page.click('#mail-btn-cancel-edit');
await sleep(600);
const back = await snapshot(page);
check('「変更しない」で受信箱へ戻る', back.hasInbox === true && back.hasForm === false && back.listItems.length >= 3, { hasInbox: back.hasInbox, items: back.listItems.length });

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
check('追加後は新アカウントの受信箱（空）を表示し、1件目の未読2は全アカウント合計のバッジに残る',
  twoAccounts.listItems.length === 0 && twoAccounts.unreadBadgeText === '2' &&
  twoAccounts.mailSnap.accounts.find((a) => a.email === 'tanaka.ui@issystem.example')?.unread === 2,
  { items: twoAccounts.listItems.length, badge: twoAccounts.unreadBadgeText, snap: twoAccounts.mailSnap });

// 1件目のアカウントタブへ切り替えると受信3件と右本文が戻る（切替時に受信問い合わせる）
const firstId = twoAccounts.mailSnap.accounts.find((a) => a.email === 'tanaka.ui@issystem.example').id;
await page.evaluate((id) => document.querySelector(`#mail-account-tabs [data-mail-account="${id}"]`).click(), firstId);
await sleep(1800);
const backFirst = await snapshot(page);
check('アカウントタブ切替で1件目の受信ボックス（3件）と右本文が戻る',
  backFirst.accountTabActive === 'tanaka.ui@issystem.example' && backFirst.listItems.length === 3 &&
  backFirst.detailBody.length > 40,
  { active: backFirst.accountTabActive, items: backFirst.listItems.length, detail: backFirst.detailSubject });

// 4i. サーバー側cron受信 → WSS (mail:new_messages) 通知で一覧だけが無再描画に更新される
// (実 IMAP は到達不能なので、cron が受信して DB へ保存した状態を DB 側で再現する)
const wssAccountId = twoAccounts.mailSnap.accounts.find((a) => a.email === 'tanaka.ui@issystem.example').id;
await page.evaluate((id) => document.querySelector(`#mail-account-tabs [data-mail-account="${id}"]`).click(), wssAccountId);
await sleep(1200);
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

// 後続チェック (再読み込み後 3件・未読2) のため検証用レコードを片付ける
await query(`DELETE FROM mail_messages WHERE id = 'mail_kyomu01_wss'`);
// アカウント削除は表示中アカウントだけ（2件目を削除すると1件目が残る）
const secondMailId = twoAccounts.mailSnap.accounts.find((a) => a.email === 'second.ui@issystem.example').id;
await page.evaluate((id) => document.querySelector(`#mail-account-tabs [data-mail-account="${id}"]`).click(), secondMailId);
await sleep(1800);
await page.click('#mail-btn-settings');
await sleep(600);
await page.click('#mail-btn-remove');
await sleep(1600);
const afterDelete = await snapshot(page);
check('表示中アカウントの削除は2件目だけが消え、1件目の受信ボックス（3件）と未読バッジ2が残る',
  afterDelete.accountTabCount === 1 && afterDelete.accountTabActive === 'tanaka.ui@issystem.example' &&
  afterDelete.listItems.length === 3 && afterDelete.unreadBadgeText === '2' && afterDelete.hasForm === false,
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
  reloaded.mailSnap?.serverPollMs === 60000 &&
  reloaded.refreshIconClass.includes('lucide-download'),
  { active: reloaded.accountTabActive, mailSnap: reloaded.mailSnap, icon: reloaded.refreshIconClass });
check('接続テストの失敗状態 (status=FAILED) は再読み込み後もヘッダーに残る',
  reloaded.headerText.includes('接続失敗') && reloaded.testResultText === '',
  { headerText: reloaded.headerText.slice(0, 110), testResultText: reloaded.testResultText.slice(0, 60) });
check('再読み込み後も既読状態が DB に残る (受信3件中1件既読・未読バッジ 2)',
  reloaded.listItems.length === 3 && reloaded.unreadBadgeText === '2' &&
  reloaded.listItems.filter((i) => i.readDot).length === 1,
  { badge: reloaded.unreadBadgeText, dots: reloaded.listItems.map((i) => (i.readDot ? 'read' : 'unread')) });

await page.screenshot({ path: path.join(OUT_DIR, 'mail-setup.png'), fullPage: false });

// 6. 設定を削除して初回フォームへ戻す (検証後に DB を未設定状態へ戻す)
await page.click('#mail-btn-settings');
await sleep(600);
await page.click('#mail-btn-remove');
await sleep(1200);
const reset = await snapshot(page);
check('設定削除で初回フォームへ戻る', reset.hasForm === true && reset.hasInbox === false, { hasForm: reset.hasForm, hasInbox: reset.hasInbox });
check('削除で未読バッジが消える', reset.unreadBadgeHidden === true, { badge: reset.unreadBadgeText, hidden: reset.unreadBadgeHidden });

// 6b. 未設定状態での接続テストは「先に登録が必要」の警告トーストになる
await page.click('#mail-btn-test');
await sleep(600);
const unsetting = await snapshot(page);
check('未設定の接続テストは登録案内の警告トースト',
  unsetting.toasts.some((t) => t.includes('接続テストの前にメールアドレスとパスワードを登録')),
  { toasts: unsetting.toasts.slice(-1) });

await browser.close();

// 後続検証のため kyomu01 のメール設定と検証用メッセージを DB から消す（設定は UI の削除で消えている）
await query(`DELETE FROM mail_messages WHERE user_id = 'kyomu01'`);
await pool.end();

console.log('--- mail UI result ---');
console.log(failures.length === 0 ? 'ALL PASS' : `NG: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
