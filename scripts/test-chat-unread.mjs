/**
 * 職員チャットの未読者機能の監査（未読者への再通知は廃止済み＝一覧表示のみであることを検証）
 *
 * 検証項目:
 *  1. チャット画面に「再通知」ボタンが存在しない（ヘッダー・メッセージ行の両方）
 *  2. 再通知ハンドラ（handleRenotifyAll）がグローバルに存在しない
 *  3. メッセージの「未読: N名」クリックは confirm を出さず、未読者一覧をトースト表示するだけ
 *  4. クリック中に /chat/renotify へのリクエストが発生しない（API 廃止）
 *  5. 未読者一覧表示（未読数・成员・既読にする）機能はそのまま残る
 *
 * 実行: node scripts/test-chat-unread.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const log = (name, val) => console.log(`${name} = ${JSON.stringify(val)}`);
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));

// 再通知 API へのリクエストを記録（廃止されているべきなので 0 件が期待値）
const renotifyRequests = [];
page.on('request', (req) => {
  if (req.url().includes('/chat/renotify')) renotifyRequests.push(req.method() + ' ' + req.url());
});

await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

// confirm を記録するスタブ（未読者一覧が confirm を出さないことを確認するため）
await page.evaluate(() => {
  window.__confirmCalls = 0;
  window.confirm = () => { window.__confirmCalls += 1; return false; };
});

await page.evaluate(() => document.querySelector('a[data-tab="chat"]').click());
await sleep(1400);

const chatView = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('#chat-messages button, #chat-header-actions button')];
  const renotifyButtons = buttons.filter((b) => b.textContent.includes('再通知'));
  const headerBtns = [...document.querySelectorAll('#chat-header-actions button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim());
  return {
    renotifyCount: renotifyButtons.length,
    headerBtns,
    hasUnreadListBtn: !!document.querySelector('.btn-show-unreaders'),
    hasMarkReadBtn: !!document.querySelector('#chat-btn-mark-read'),
    hasMembersBtn: !!document.querySelector('#chat-btn-members'),
    renotifyGlobal: typeof window.handleRenotifyAll,
    unreadListGlobal: typeof window.showUnreadersList,
  };
});
log('chat-view', chatView);

check('チャット画面に「再通知」ボタンがない（ヘッダー・メッセージ行の両方）', chatView.renotifyCount === 0,
  { renotifyCount: chatView.renotifyCount, headerBtns: chatView.headerBtns });
check('再通知ハンドラ handleRenotifyAll はグローバルに存在しない', chatView.renotifyGlobal === 'undefined',
  { renotifyGlobal: chatView.renotifyGlobal });
check('「未読: N名」ボタン・既読にする・メンバー表示は残る',
  chatView.hasUnreadListBtn && chatView.hasMarkReadBtn && chatView.hasMembersBtn,
  { hasUnreadListBtn: chatView.hasUnreadListBtn, hasMarkReadBtn: chatView.hasMarkReadBtn, hasMembersBtn: chatView.hasMembersBtn });

// 未読者一覧をクリック（confirm なし・API 呼び出しなし・トースト表示）
const unreadClick = await page.evaluate(async () => {
  const btn = document.querySelector('.btn-show-unreaders');
  if (!btn) return { toast: null };
  const before = window.__confirmCalls;
  btn.click();
  await new Promise((r) => setTimeout(r, 350));
  const toasts = [...document.querySelectorAll('#toast-container div')]
    .map((e) => e.textContent.replace(/\s+/g, ' ').trim())
    .filter((t) => t.includes('未読'));
  return { confirmCalls: window.__confirmCalls - before, toast: toasts.length > 0 ? toasts[0].slice(0, 90) : null };
});
log('unread-list-click', unreadClick);
check('未読者クリックは confirm を出さず、未読者一覧をトーストで表示するだけ',
  unreadClick.confirmCalls === 0 && unreadClick.toast !== null,
  { confirmCalls: unreadClick.confirmCalls, toast: unreadClick.toast });
check('/chat/renotify へのリクエストは発生しない（API 廃止）', renotifyRequests.length === 0, renotifyRequests);

// ソース側の遺物（UI・設定・ルート）とサーバー応答を監査
const chatSrc = fs.readFileSync(path.join(ROOT, 'public/js/modules/chat.module.js'), 'utf8');
const configSrc = fs.readFileSync(path.join(ROOT, 'public/js/config.js'), 'utf8');
const routeSrc = fs.readFileSync(path.join(ROOT, 'src/routes/index.js'), 'utf8');
const apiCall = /apiPost\(\s*['"]\/chat\/renotify/.test(chatSrc);
const btnId = chatSrc.includes('chat-btn-renotify-all');
check('chat.module.js に再通知の API 呼び出し・ボタン ID・ハンドラが残っていない', !apiCall && !btnId && !chatSrc.includes('handleRenotifyAll'),
  { apiCall, btnId, handler: chatSrc.includes('handleRenotifyAll') });
check('chat.module.js の未読者一覧表示 showUnreadersList は残ってボタンにも接続済み（機能は list 表示のみ）',
  chatSrc.includes('function showUnreadersList') && chatSrc.includes('showUnreadersList(msgId)') && chatSrc.includes('btn-show-unreaders'),
  { listFn: chatSrc.includes('function showUnreadersList'), wired: chatSrc.includes('showUnreadersList(msgId)') });
check('config.js の CHAT に UNREAD_RENOTIFY がない', !configSrc.includes('UNREAD_RENOTIFY'), null);
check('src/routes/index.js に router.post("/chat/renotify") がない', !routeSrc.includes("router.post('/chat/renotify'"), null);

const routeStatus = await fetch(`${BASE}/api/chat/renotify`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ channelId: 'general', targetUsers: ['X'] }),
}).then((r) => r.status);
log('renotify-route-status', routeStatus);
check('サーバーの /api/chat/renotify は 404（ルート廃止）', routeStatus === 404, routeStatus);

await browser.close();

if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('ALL PASSED');
