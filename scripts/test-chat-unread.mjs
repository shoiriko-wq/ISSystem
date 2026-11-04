/**
 * 職員チャットの未読者機能の監査（未読者への再通知は廃止済み＝一覧表示のみであることを検証）
 *
 * 検証項目:
 *  1. チャット画面に「再通知」ボタンが存在しない（ヘッダー・メッセージ行の両方）
 *  2. 再通知ハンドラ（handleRenotifyAll）がグローバルに存在しない
 *  3. メッセージの「未読: N名」クリックは confirm を出さず、未読者一覧をトースト表示するだけ
 *  4. クリック中に /chat/renotify へのリクエストが発生しない（API 廃止）
 *  5. 未読者一覧表示（未読数・成员・既読にする）機能はそのまま残る
 *  6. 投稿直後の自分の行が「全員既読」化せず 未読: N名（メンバー数-1）を表示する
 *  7. サーバー配信（POST 応答・Socket）に未読者名簿（メンバー・送信者以外）が載る
 *  8. 投稿で既存メッセージが一斉に全員既読化しない（未読行は残る）
 *  9. 別メンバーが閲覧（chat:mark_as_read）すると未読が1名减算される
 * 10. ページリロード後の未読者数は既読ログ（サーバー）と一致する
 *
 * 実行: node scripts/test-chat-unread.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { io } from 'socket.io-client';

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

// ===== 未読・既読の整合性（投稿直後に「全員既読」化してしまうバグ）の検証 =====
const chatSnapshot = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#chat-messages-container [data-msg-id]')];
  const parsed = rows.map((row) => {
    const footer = row.querySelector('[data-read-footer]');
    const btn = footer ? footer.querySelector('.btn-show-unreaders') : null;
    return {
      id: row.getAttribute('data-msg-id'),
      body: row.querySelector('p') ? row.querySelector('p').textContent.trim() : '',
      allRead: footer ? footer.textContent.includes('全員既読') : false,
      unread: btn ? parseInt((btn.textContent.match(/未読:\s*(\d+)/) || [])[1] || '0', 10) : 0,
    };
  });
  const memberCountEl = document.getElementById('chat-member-count');
  return {
    rows: parsed,
    memberCount: parseInt((memberCountEl ? memberCountEl.textContent : '0') || '0', 10),
    unreadRows: parsed.filter((r) => r.unread > 0).length,
  };
});

// 田中先生 (t-tanaka) として WebSocket を接続し、新着配信と既読回执を観測する
const tanakaLogin = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ staff_code: 'T2026002', password: PASS }),
}).then((r) => r.json());

const tanakaSocket = io(BASE, { auth: { token: tanakaLogin.token } });
await new Promise((resolve, reject) => {
  tanakaSocket.on('connect', resolve);
  tanakaSocket.on('connect_error', reject);
});
tanakaSocket.emit('chat:join_channel', 'general');
await sleep(400);

const beforePost = await chatSnapshot();
log('rows-before-post', { memberCount: beforePost.memberCount, unreadRows: beforePost.unreadRows });

const marker = `未読既読検証 ${Date.now()}`;
// 過去の実行の残り行（同じ語を含む）との混同を避けるため本文の完全一致で新着行を特定する
const findPostedRow = (rows, text) => rows.find((r) => r.body.trim() === text);

const incoming = new Promise((resolve) => {
  tanakaSocket.on('chat:message', (data) => {
    const m = data.message || data;
    const text = String(m.message_text || m.text || m.message || '');
    if (text.trim() === marker) resolve(m);
  });
});

await page.evaluate((text) => {
  const ta = document.getElementById('chat-input-message');
  const form = document.getElementById('chat-send-form');
  ta.value = text;
  if (form.requestSubmit) form.requestSubmit();
  else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}, marker);

const newMessage = await Promise.race([
  incoming,
  new Promise((_, reject) => setTimeout(() => reject(new Error('新着メッセージが配信されない')), 8000)),
]);
const newId = newMessage.id;

const serverUnreadIds = (Array.isArray(newMessage.unreadIds) ? newMessage.unreadIds : []).map((id) => String(id));
log('new-message-unread-ids', serverUnreadIds);
check('サーバー配信に新着の未読者名簿（メンバーのうち送信者以外）が載る',
  serverUnreadIds.length >= 1 && serverUnreadIds.includes('t-tanaka') && !serverUnreadIds.includes('kyomu01'),
  { serverUnreadIds });

await sleep(1200);
const afterPost = await chatSnapshot();
const postedRow = findPostedRow(afterPost.rows, marker);
log('after-post', { memberCount: afterPost.memberCount, postedRow, unreadRows: afterPost.unreadRows });

check('投稿直後の自分の行は「全員既読」ではなく 未読: N名（メンバー数-1）',
  postedRow && !postedRow.allRead && postedRow.unread === afterPost.memberCount - 1,
  { postedRow, memberCount: afterPost.memberCount });

check('投稿で既存メッセージが一斉に全員既読化しない（未読行は保持される）',
  afterPost.unreadRows >= Math.max(1, beforePost.unreadRows),
  { before: beforePost.unreadRows, after: afterPost.unreadRows });

// 田中先生がチャンネルを閲覧（既読位置更新）→ 新着の未読が1名减算されること
tanakaSocket.emit('chat:mark_as_read', { channelId: 'general', lastReadMessageId: newId });

let afterReceipt = null;
for (let i = 0; i < 14; i++) {
  await sleep(250);
  const snap = await chatSnapshot();
  afterReceipt = findPostedRow(snap.rows, marker);
  if (afterReceipt && afterReceipt.unread === serverUnreadIds.length - 1) break;
}
log('after-tanaka-mark-read', afterReceipt);
check('メンバーが閲覧すると新着の未読者が1名减算される（既読回执が未読者名簿へ反映）',
  afterReceipt && !afterReceipt.allRead && afterReceipt.unread === serverUnreadIds.length - 1,
  { expected: serverUnreadIds.length - 1, afterReceipt });

// ページ読み込み直し後は未読者数がサーバーの既読ログと一致すること
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);
const loggedInAfterReload = await page.evaluate(
  () => !!document.getElementById('app-container') && !document.getElementById('app-container').classList.contains('hidden')
);
if (!loggedInAfterReload) {
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(1200);
}
await page.evaluate(() => document.querySelector('a[data-tab="chat"]').click());
await sleep(1600);

const reloaded = await chatSnapshot();
const reloadRow = findPostedRow(reloaded.rows, marker);
log('after-reload', reloadRow);
check('リロード後の未読者数は既読ログと一致する（未読者が何名か表示される）',
  reloadRow && reloadRow.unread === serverUnreadIds.length - 1,
  { expected: serverUnreadIds.length - 1, reloadRow });

// 新着行の未読者一覧トーストに未読メンバー名が並ぶ（全員既読のトーストにならない）こと
const unreadListAfter = await page.evaluate((text) => {
  const rows = [...document.querySelectorAll('#chat-messages-container [data-msg-id]')];
  const row = rows.find((r) => (r.querySelector('p')?.textContent || '').trim() === text);
  const btn = row ? row.querySelector('.btn-show-unreaders') : null;
  if (!btn) return { toast: null };
  btn.click();
  return new Promise((res) => setTimeout(() => {
    const toasts = [...document.querySelectorAll('#toast-container div')]
      .map((e) => e.textContent.replace(/\s+/g, ' ').trim())
      .filter((t) => t.includes('未読者'));
    res({ toast: toasts.length > 0 ? toasts[0].slice(0, 120) : null });
  }, 400));
}, marker);
log('unread-list-after-post', unreadListAfter);
check('新着行の未読者一覧に未読メンバー名が表示される（全員既読のトーストにならない）',
  unreadListAfter.toast !== null && unreadListAfter.toast.includes('未読者（'),
  { toast: unreadListAfter.toast });

tanakaSocket.close();

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
