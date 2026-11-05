/**
 * サイドメニュー順序とメール初回設定 (メールアドレス + パスワード) の実ブラウザ検証
 *
 * 検証項目:
 *  1. サイドメニューの順序が ダッシュボード / 職員掲示板 / 職員チャット / メール /
 *     スケジュール / 施設物品予約 / 簡易承認 / 座席表 / 定期考査 である
 *  2. メールタブの初回は設定フォームが表示され、メールアドレスはユーザー情報からプリフィルされる
 *  3. 不正メールアドレスの送信はエラートーストになり、フォームは残る
 *  4. 正常な設定保存で受信箱パネルへ切り替わり、ヘッダーにアドレスが表示される
 *  5. ページ再読み込み後も設定済み状態 (フォームは出ない) が続く
 *  6. 「設定を削除」で初回フォームへ戻り、後続検証のため DB を未設定状態へ戻す
 * 実行: node scripts/test-mail-setup.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE  UI_USER  UI_PASS  CHROME_PATH
 * 出力: scripts/output/mail-setup.png  / NG が 1 件でもあれば exit code 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'scripts', 'output');
const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';

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
    passwordField: !!document.getElementById('mail-setup-password'),
    hasInbox: !!document.getElementById('mail-inbox-list'),
    settingsBtn: (document.getElementById('mail-btn-settings')?.textContent || '').replace(/\s+/g, ' ').trim(),
    listItems: items,
    detailSubject: (document.getElementById('mail-detail-subject')?.textContent || '').trim(),
    detailDatetime: (document.getElementById('mail-detail-datetime')?.textContent || '').trim(),
    detailBody: (document.getElementById('mail-detail-body')?.textContent || '').trim(),
    unreadBadgeText: badge ? badge.textContent.trim() : '',
    unreadBadgeHidden: badge ? badge.classList.contains('hidden') : null,
    headerText: (document.getElementById('view-mail')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    toasts,
  };
});

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
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
const configured = await snapshot(page);
check('保存で受信箱へ切り替わる', configured.hasInbox === true && configured.hasForm === false, { hasInbox: configured.hasInbox, hasForm: configured.hasForm });
check('ヘッダーにアドレス表示', configured.headerText.includes('tanaka.ui@issystem.example'), configured.headerText);

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

// 4f. 「メール設定」でフォームを開く -> 「変更しない」で受信箱へ戻る
await page.click('#mail-btn-settings');
await sleep(600);
const opened = await snapshot(page);
check('メール設定ボタンでフォームを開く', opened.hasForm === true && opened.emailValue === 'tanaka.ui@issystem.example', { hasForm: opened.hasForm, emailValue: opened.emailValue });
await page.click('#mail-btn-cancel-edit');
await sleep(600);
const back = await snapshot(page);
check('「変更しない」で受信箱へ戻る', back.hasInbox === true && back.hasForm === false && back.listItems.length >= 3, { hasInbox: back.hasInbox, items: back.listItems.length });

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

await page.screenshot({ path: path.join(OUT_DIR, 'mail-setup.png'), fullPage: false });

// 6. 設定を削除して初回フォームへ戻す (検証後に DB を未設定状態へ戻す)
await page.click('#mail-btn-settings');
await sleep(600);
await page.click('#mail-btn-remove');
await sleep(1200);
const reset = await snapshot(page);
check('設定削除で初回フォームへ戻る', reset.hasForm === true && reset.hasInbox === false, { hasForm: reset.hasForm, hasInbox: reset.hasInbox });
check('削除で未読バッジが消える', reset.unreadBadgeHidden === true, { badge: reset.unreadBadgeText, hidden: reset.unreadBadgeHidden });

await browser.close();

console.log('--- mail UI result ---');
console.log(failures.length === 0 ? 'ALL PASS' : `NG: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
