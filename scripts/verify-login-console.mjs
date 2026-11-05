/**
 * ログイン画面 (未ログイン) およびリロード時の 401 / 認証警告が発生しないことを検証する。
 *
 * 実行: node scripts/verify-login-console.mjs
 * options: UI_BASE=http://127.0.0.1:3000  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 */
import puppeteer from 'puppeteer-core';

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 認証を要するエンドポイント (ログイン前に叩かれてはいけないもの)
const AUTH_ENDPOINTS = [
  '/api/chat/', '/api/schedules', '/api/subjects', '/api/bulletins', '/api/facilities',
  '/api/approvals', '/api/seating', '/api/absences', '/api/news', '/api/users', '/api/exam'
];

const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

const consoleMessages = [];
const apiRequests = [];
const responses401 = [];

const reset = () => {
  consoleMessages.length = 0;
  apiRequests.length = 0;
  responses401.length = 0;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('console', (m) => consoleMessages.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => consoleMessages.push(`pageerror: ${e.message}`));
page.on('request', (req) => {
  if (req.url().includes('/api/')) apiRequests.push(`${req.method()} ${new URL(req.url()).pathname}`);
});
page.on('response', (res) => {
  if (res.status() === 401) responses401.push(`${res.request().method()} ${new URL(res.url()).pathname}`);
});

await page.setViewport({ width: 1280, height: 900 });

// ---- 1. 未ログイン (ログイン画面表示) ----
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await sleep(2000);

const preAuthRequests = apiRequests.filter((r) => AUTH_ENDPOINTS.some((e) => r.includes(e)));
const authWarnings = consoleMessages.filter((m) => m.includes('認証セッションが無効'));

console.log('== 未ログイン (ログイン画面) ==');
console.log('  API requests:', JSON.stringify(apiRequests));
check('未ログインで認証必須APIを発行しない', preAuthRequests.length === 0, preAuthRequests);
check('401 レスポンスが発生しない', responses401.length === 0, responses401);
check('「認証セッションが無効」警告が出ない', authWarnings.length === 0, authWarnings);

// ---- 2. ログイン ----
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1500);

const loginConsole = consoleMessages.filter((m) => m.includes('401') || m.includes('認証セッションが無効'));
check('ログイン処理で401・セッション警告が出ない', loginConsole.length === 0, loginConsole);

// ---- 3. 有効セッション保持でリロード (トークン有効な初期化) ----
reset();
await page.reload({ waitUntil: 'networkidle2' });
await sleep(2500);

const reloadAuth = consoleMessages.filter((m) => m.includes('401') || m.includes('認証セッションが無効'));
check('リロード初期化で401・セッション警告が出ない', reloadAuth.length === 0, reloadAuth);
const reLoginRequired = await page.evaluate(() => {
  const login = document.getElementById('login-screen');
  return login ? login.classList.contains('hidden') : false;
});
check('リロード後もログイン状態が維持される', reLoginRequired === true);

// ---- 4. chat タブを開いてチャンネル一覧が取得される ----
reset();
await page.evaluate(() => document.querySelector('.app-sidebar [data-tab="chat"]').click());
await sleep(2000);

const channelCount = await page.evaluate(() => document.querySelectorAll('#chat-channels-list [data-channel-id]').length);
const chat401 = responses401.length;
check('chat タブでチャンネル一覧が描画される', channelCount > 0, { channelCount });
check('chat タブ開封で401が出ない', chat401 === 0, responses401);

// ---- 5. schedule タブ (カテゴリ・行事取得) ----
reset();
await page.evaluate(() => document.querySelector('.app-sidebar [data-tab="schedule"]').click());
await sleep(2000);

const schedCategories = await page.evaluate(() => document.querySelectorAll('#view-schedule [data-category-id], #view-schedule .sched-cat-chip').length);
check('schedule タブ開封で401が出ない', responses401.length === 0, responses401);
console.log('  schedule カテゴリ要素数 =', schedCategories);

// ---- 6. dashboard タブ ----
reset();
await page.evaluate(() => document.querySelector('.app-sidebar [data-tab="dashboard"]').click());
await sleep(2000);
check('dashboard タブ開封で401が出ない', responses401.length === 0, responses401);

console.log('\n== 最終結果 ==');
console.log(failures.length === 0 ? 'ALL PASS' : `FAILURES: ${JSON.stringify(failures)}`);

await browser.close();
process.exit(failures.length === 0 ? 0 : 1);