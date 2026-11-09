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
 * 11. 左下の目のマーク（非表示編集モード）は ON/OFF でアイコンと色が見た目に連動する
 * 12. 発言行のメタ（アイコン・名前・年月日時間）は相手＝左からアイコン・名前・日時、
 *     自分＝右からアイコン・名前・日時となり、年月日時間は名前と下揃え（単一行・サイズ維持）
 * 13. 未読者・取り消しメニューは普段隠れ、コメント行へホバー（またはフォーカス）時だけ
 *     吹き出しの下へプルダウン表示される（実マウスで押せる・レイアウトシフトなし）


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
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
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
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));

// 再通知 API へのリクエストを記録（廃止されているべきなので 0 件が期待値）
const renotifyRequests = [];
page.on('request', (req) => {
  if (req.url().includes('/chat/renotify')) renotifyRequests.push(req.method() + ' ' + req.url());
});

// ★ 職員全体チャット撤廃（2026/11/9 v3.1.2）: general / PUBLIC は存在しない
// ⇒ 個人が作成した 3 名グループを作りに検証する（田中先生が未読者として観測できる）
const MY_ID = 'kyomu01';
const GROUP_MEMBERS = [MY_ID, 't-tanaka', 't-sato'];
const probeToken = await fetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ staff_code: USER, password: PASS }),
}).then((r) => r.json()).then((j) => j.token);

const probeGroup = await fetch(`${BASE}/api/chat/channels`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${probeToken}` },
  body: JSON.stringify({
    name: '未読検証グループ',
    type: 'GROUP',
    member_ids: GROUP_MEMBERS,
    memberIds: GROUP_MEMBERS,
  }),
}).then((r) => r.json());
const groupId = probeGroup?.data?.id || probeGroup?.id || probeGroup?.channel?.id;
log('probe-group-created', { groupId, members: GROUP_MEMBERS });
check('個人作成グループ（3名）を 201 で作成できる', Boolean(groupId), probeGroup);

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

// サイドバーのグループ行をクリックして閲覧先を切り替える（職員全体チャンネルは撤廃済み）
const openChatGroup = async (gid) => {
  const opened = await page.evaluate((id) => {
    const row = document.querySelector(`#chat-channels-list [data-channel-id="${id}"]`);
    if (!row) return false;
    row.click();
    return true;
  }, gid);
  await sleep(900);
  return opened;
};

// シード済みグループ（教務部連絡＝kyomu01・田中先生がメンバー）を開いて未読者一覧等を検証する
const seedGroupOpened = await openChatGroup('kyomu');
log('seed-group-opened', { seedGroupOpened });
check('シード済みグループ（教務部連絡）を開いて閲覧できる', seedGroupOpened === true, { seedGroupOpened });

const chatView = await page.evaluate(() => {
  const buttons = [...document.querySelectorAll('#chat-messages button, #chat-header-actions button')];
  const renotifyButtons = buttons.filter((b) => b.textContent.includes('再通知'));
  const headerBtns = [...document.querySelectorAll('#chat-header-actions button')].map((b) => b.textContent.replace(/\s+/g, ' ').trim());
  const sidebar = document.querySelector('.chat-sidebar-channels');
  const footer = sidebar ? sidebar.querySelector('div.border-t') : null;
  const headerRow = sidebar ? sidebar.querySelector('div.border-b') : null;
  const toggleHide = document.querySelector('#chat-btn-toggle-hide');
  return {
    renotifyCount: renotifyButtons.length,
    headerBtns,
    hasUnreadListBtn: !!document.querySelector('.btn-show-unreaders'),
    hasMarkReadBtn: !!document.querySelector('#chat-btn-mark-read'),
    hasMembersBtn: !!document.querySelector('#chat-btn-members'),
    renotifyGlobal: typeof window.handleRenotifyAll,
    unreadListGlobal: typeof window.showUnreadersList,
    sidebarText: (sidebar?.textContent || '').replace(/\s+/g, ' ').trim(),
    createInFooter: !!footer?.querySelector('#chat-btn-create-group'),
    createInHeaderRow: !!headerRow?.querySelector('#chat-btn-create-group'),
    hasToggleHide: !!toggleHide,
    togglePressed: toggleHide ? toggleHide.getAttribute('aria-pressed') : null,
    toggleText: (toggleHide?.textContent || '').trim(),
    toggleHasEyeIcon: !!toggleHide?.querySelector('svg,i[data-lucide]'),
    toggleInner: toggleHide ? toggleHide.innerHTML.replace(/\s+/g, ' ').trim() : null,
    toggleBg: toggleHide ? getComputedStyle(toggleHide).backgroundColor : null,
    toggleColor: toggleHide ? getComputedStyle(toggleHide).color : null,
    toggleBorder: toggleHide ? getComputedStyle(toggleHide).borderTopColor : null,
    hideBtnsInFooter: !!footer?.querySelector('.chat-hide-btn'),
    hideBtns: document.querySelectorAll('#chat-channels-list .chat-hide-btn').length,
    toggleBadge: document.querySelectorAll('#chat-toggle-hidden .badge-count').length,
  };
});
log('chat-view', chatView);

check('チャット画面に「再通知」ボタンがない（ヘッダー・メッセージ行の両方）', chatView.renotifyCount === 0,
  { renotifyCount: chatView.renotifyCount, headerBtns: chatView.headerBtns });
check('再通知ハンドラ handleRenotifyAll はグローバルに存在しない', chatView.renotifyGlobal === 'undefined',
  { renotifyGlobal: chatView.renotifyGlobal });
check('「未読: N名」とメンバー表示は残り、右ヘッダーの「既読にする」「リストから非表示」は撤廃',
  chatView.hasUnreadListBtn && chatView.hasMembersBtn &&
  chatView.headerBtns.length === 1 &&
  !chatView.headerBtns.some((t) => t.includes('既読') || t.includes('非表示')) &&
  chatView.hasMarkReadBtn === false,
  { headerBtns: chatView.headerBtns, hasUnreadListBtn: chatView.hasUnreadListBtn, hasMembersBtn: chatView.hasMembersBtn, hasMarkReadBtn: chatView.hasMarkReadBtn });
check('サイドバーの「接続状態: オンライン」の文字がない',
  !chatView.sidebarText.includes('接続状態') && !chatView.sidebarText.includes('オンライン'),
  { sidebarText: chatView.sidebarText });
check('グループ作成ボタンはフッター（ヘッダー行にはない）で、目のマークの非表示トグルボタンがフッターにある',
  chatView.createInFooter === true && chatView.createInHeaderRow === false &&
  chatView.hasToggleHide === true && chatView.toggleText === '' &&
  chatView.toggleHasEyeIcon === true && chatView.togglePressed === 'false',
  { createInFooter: chatView.createInFooter, createInHeaderRow: chatView.createInHeaderRow, toggleText: chatView.toggleText, toggleHasEyeIcon: chatView.toggleHasEyeIcon, togglePressed: chatView.togglePressed });
check('目のマークを押す前はグループ名の横に非表示ボタンが出ない', chatView.hideBtns === 0, { hideBtns: chatView.hideBtns });

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

// ===== サイドバーの目のマーク（非表示モード）を実マウスで検証 =====
const centerOf = async (sel) => {
  const el = await page.$(sel);
  if (!el) return null;
  const box = await el.boundingBox();
  if (!box) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
};
const mouseClickSel = async (sel) => {
  const c = await centerOf(sel);
  if (!c) return false;
  await page.mouse.click(c.x, c.y);
  return true;
};
// 目のマークの見た目を読む前にマウスをチャット本文へ退避させる。
// hover による色変化（.btn-secondary:hover と readability.css の hover リング）が
// モード連動の判定へ混ざると、OFF 復帰時に枠線色が初期値と一致しないため。
const unhoverEye = async () => {
  const c = await centerOf('#chat-messages-container');
  if (c) await page.mouse.move(c.x, c.y, { steps: 2 });
  await sleep(220);
};
// トーストがサイドバーフッターを覆うと実クリックがトーストに当たる（テスト中はトーストを消す）
const clearToasts = () => page.evaluate(() => {
  const c = document.getElementById('toast-container');
  const footer = document.querySelector('.chat-sidebar-channels div.border-t');
  const overlap = (() => {
    if (!c || !footer) return null;
    const a = c.getBoundingClientRect(), b = footer.getBoundingClientRect();
    return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
  })();
  if (c) c.innerHTML = '';
  return { overlap };
});

// 目のマークボタンの見た目（アイコン markup と色）を読む。モード連動の検証用
const eyeState = () => page.evaluate(() => {
  const btn = document.querySelector('#chat-btn-toggle-hide');
  const cs = btn ? getComputedStyle(btn) : null;
  return {
    pressed: btn ? btn.getAttribute('aria-pressed') : null,
    inner: btn ? btn.innerHTML.replace(/\s+/g, ' ').trim() : null,
    bg: cs ? cs.backgroundColor : null,
    color: cs ? cs.color : null,
    border: cs ? cs.borderTopColor : null,
    shadow: cs ? cs.boxShadow : null,
    hideBtns: document.querySelectorAll('#chat-channels-list .chat-hide-btn').length,
  };
});

const eyeClicked = await mouseClickSel('#chat-btn-toggle-hide');
await sleep(450);
const afterEyeOn = await page.evaluate(() => ({
  hideBtns: document.querySelectorAll('#chat-channels-list .chat-hide-btn').length,
  pressed: document.querySelector('#chat-btn-toggle-hide')?.getAttribute('aria-pressed'),
  visibleRows: [...document.querySelectorAll('#chat-channels-list [data-channel-id]')].length,
  eyeInFooter: !!document.querySelector('.chat-sidebar-channels div.border-t .chat-hide-btn'),
}));
log('after-eye-on', afterEyeOn);
check('目のマークを実クリックするとグループ名の横に目のマークの非表示ボタンが出る（フッターに非表示ボタンは出ない）',
  eyeClicked === true && afterEyeOn.hideBtns > 0 && afterEyeOn.pressed === 'true' && afterEyeOn.eyeInFooter === false,
  { eyeClicked, ...afterEyeOn });
await page.screenshot({ path: 'scripts/output/chat-sidebar-eye-on.png' });

await unhoverEye();
const eyeOnState = await eyeState();
log('eye-on-state', eyeOnState);
check('目のマーク ON ではアイコンが開いた目（eye）になり、背景・文字色・枠・影が警告色へ連動する',
  eyeOnState.pressed === 'true' && eyeOnState.inner !== chatView.toggleInner &&
  eyeOnState.bg !== chatView.toggleBg && eyeOnState.color !== chatView.toggleColor &&
  eyeOnState.border !== chatView.toggleBorder && eyeOnState.shadow !== 'none',
  { initial: { inner: chatView.toggleInner, bg: chatView.toggleBg, color: chatView.toggleColor, border: chatView.toggleBorder }, on: eyeOnState });

const targetId = await page.evaluate(() => document.querySelector('#chat-channels-list .chat-hide-btn')?.getAttribute('data-hide-id') || null);
const hideClicked = await mouseClickSel('#chat-channels-list .chat-hide-btn');
await sleep(800);
const afterHide = await page.evaluate((tid) => {
  const rows = [...document.querySelectorAll('#chat-channels-list [data-channel-id]')];
  const toasts = [...document.querySelectorAll('#toast-container div')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()).filter((t) => t.includes('非表示'));
  const toggle = document.querySelector('#chat-toggle-hidden');
  return {
    targetGone: tid !== null && !rows.some((r) => r.getAttribute('data-channel-id') === tid),
    hiddenSection: !!toggle,
    badgeInToggle: toggle ? toggle.querySelectorAll('.badge-count').length : -1,
    toggleText: toggle ? toggle.textContent.replace(/\s+/g, ' ').trim() : null,
    toast: toasts.length > 0 ? toasts[0].slice(0, 60) : null,
    hideBtns: document.querySelectorAll('#chat-channels-list .chat-hide-btn').length,
    pressed: document.querySelector('#chat-btn-toggle-hide')?.getAttribute('aria-pressed'),
  };
}, targetId);
log('after-hide', afterHide);
check('非表示ボタン（目のマーク）を実クリックするとそのグループだけ非表示になり、非表示セクションに件数バッジが出ない',
  hideClicked === true && afterHide.targetGone && afterHide.hiddenSection && afterHide.badgeInToggle === 0 &&
  afterHide.toast !== null && afterHide.toggleText === '非表示グループ',
  { targetId, ...afterHide });

const overlapInfo = await clearToasts();
const eyeOffClicked = await mouseClickSel('#chat-btn-toggle-hide');
await sleep(450);
const afterEyeOff = await page.evaluate(() => ({
  hideBtns: document.querySelectorAll('#chat-channels-list .chat-hide-btn').length,
  pressed: document.querySelector('#chat-btn-toggle-hide')?.getAttribute('aria-pressed'),
}));
log('after-eye-off', { ...afterEyeOff, ...overlapInfo });
check('目のマークを再度押すと非表示ボタンが消える（モード OFF）',
  eyeOffClicked === true && afterEyeOff.hideBtns === 0 && afterEyeOff.pressed === 'false', { eyeOffClicked, ...afterEyeOff, ...overlapInfo });

await unhoverEye();
const eyeOffState = await eyeState();
log('eye-off-state', eyeOffState);
check('目のマーク OFF ではアイコンと色が初期状態へ戻り、見た目がモードに連動する',
  eyeOffState.pressed === 'false' && eyeOffState.inner === chatView.toggleInner &&
  eyeOffState.bg === chatView.toggleBg && eyeOffState.color === chatView.toggleColor &&
  eyeOffState.border === chatView.toggleBorder,
  { initial: { inner: chatView.toggleInner, bg: chatView.toggleBg, color: chatView.toggleColor, border: chatView.toggleBorder }, off: eyeOffState });

await clearToasts();
const expandClicked = await mouseClickSel('#chat-toggle-hidden');
await sleep(450);
await clearToasts();
const unhideClicked = await mouseClickSel('#chat-channels-list .chat-unhide-btn');
await sleep(800);
const restored = await page.evaluate((tid) => ({
  targetBack: [...document.querySelectorAll('#chat-channels-list [data-channel-id]')].some((r) => r.getAttribute('data-channel-id') === tid),
  sectionGone: document.getElementById('chat-toggle-hidden') === null,
}), targetId);
log('restored', restored);
check('非表示セクションの目のマーク（再表示ボタン）で元に戻せる', expandClicked === true && unhideClicked === true &&
  restored.targetBack === true && restored.sectionGone === true, { targetId, ...restored });

await page.screenshot({ path: 'scripts/output/chat-sidebar-eye.png' });


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
tanakaSocket.emit('chat:join_channel', groupId);
await sleep(400);

// 未読・既読の検証は個人作成グループで行う（田中先生が未読者として観測できる）
const probeOpened = await openChatGroup(groupId);
log('probe-group-opened', { groupId, probeOpened });
check('検証用グループを開いて投稿対象にできる', probeOpened === true, { groupId });

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
tanakaSocket.emit('chat:mark_as_read', { channelId: groupId, lastReadMessageId: newId });

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
// リロード後は先頭グループへ自動切替するため、検証用グループを再び開く
const reopened = await openChatGroup(groupId);
log('group-reopened-after-reload', { groupId, reopened });
check('リロード後に検証用グループを再び開ける', reopened === true, { groupId });

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
  body: JSON.stringify({ channelId: groupId, targetUsers: ['X'] }),
}).then((r) => r.status);
log('renotify-route-status', routeStatus);
check('サーバーの /api/chat/renotify は 404（ルート廃止）', routeStatus === 404, routeStatus);

// ===== 相手行を作る（メタ行・ホバーメニュー検証には相手行が必要） =====
// 職員全体チャットは撤廃済み ⇒ 検証は常に個人作成グループ（groupId）で行う
const tanakaSocket2 = io(BASE, { auth: { token: tanakaLogin.token } });
await new Promise((resolve, reject) => {
  tanakaSocket2.on('connect', resolve);
  tanakaSocket2.on('connect_error', reject);
});
tanakaSocket2.emit('chat:join_channel', groupId);
await sleep(300);
const replyText = `相手行検証 ${Date.now()}`;
const replyAck = await new Promise((resolve) => {
  tanakaSocket2.emit('chat:send_message', { channelId: groupId, messageText: replyText }, (ack) => resolve(ack));
});
log('tanaka-reply', { replyText, replyAck });
check('メンバー（田中先生）が検証用グループへ返信できる', replyAck?.success === true, replyAck);
await sleep(1400);
const replyRowVisible = await page.evaluate((text) => {
  const rows = [...document.querySelectorAll('#chat-messages-container [data-msg-id]')];
  return rows.some((r) => (r.querySelector('p')?.textContent || '').trim() === text);
}, replyText);
check('相手からの新着行が列表に描画される', replyRowVisible === true, { replyText, replyRowVisible });

// ホバー検証は「後ろに行が続く」行を使うため、自分の行を1行追加して相手行を中段へ置く
const followUpText = `追記検証 ${Date.now()}`;
await page.evaluate((text) => {
  const ta = document.getElementById('chat-input-message');
  const form = document.getElementById('chat-send-form');
  ta.value = text;
  if (form.requestSubmit) form.requestSubmit();
}, followUpText);
await sleep(1200);
const hoverRows = await page.evaluate(() => [...document.querySelectorAll('#chat-messages-container .chat-msg-row[data-msg-id]')].map((r) => r.getAttribute('data-own')));
log('hover-rows-order', { followUpText, hoverRows });
check('ホバー検証用の行が並ぶ（自分・相手・自分の順）', hoverRows.length === 3 && hoverRows[0] === 'true' && hoverRows[1] === 'false' && hoverRows[2] === 'true', { hoverRows });

// ===== メタ行（アイコン・名前・年月日時間）の並び順と下揃え =====
// 相手の行: 左から アイコン → 名前 → 年月日時間
// 自分の行: 右から アイコン → 名前 → 年月日時間
// 年月日時間は名前の底辺と揃える（下揃え）。単一行表示とアバターサイズは維持する。
const metaLayout = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#chat-messages-container [data-msg-id]')];
  const rectOf = (el) => {
    const b = el.getBoundingClientRect();
    return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height };
  };
  const parsed = rows.map((row) => {
    const meta = row.firstElementChild;
    if (!meta) return null;
    const kids = [...meta.children];
    const avatar = kids.find((k) => k.classList.contains('rounded-full'));
    const name = kids.find((k) => k.tagName === 'SPAN' && k.classList.contains('font-bold'));
    const time = kids.find((k) => k.tagName === 'SPAN' && k.classList.contains('font-mono'));
    if (!avatar || !name || !time) return null;
    const idx = kids.indexOf(avatar);
    return {
      own: idx === kids.length - 1,
      avatarIsFirst: idx === 0,
      avatarIsLast: idx === kids.length - 1,
      kidCount: kids.length,
      avatar: rectOf(avatar),
      name: rectOf(name),
      time: rectOf(time),
      meta: rectOf(meta),
    };
  }).filter(Boolean);
  return {
    count: parsed.length,
    own: parsed.find((p) => p.own) || null,
    other: parsed.find((p) => !p.own) || null,
  };
});

// 底辺（下）が揃っているか（1.5px 以内）
const bottomsAligned = (p) =>
  Math.abs(p.avatar.bottom - p.name.bottom) <= 1.5 &&
  Math.abs(p.name.bottom - p.time.bottom) <= 1.5;
// メタ行が単一行（子要素がメタ行の枠内に収まる）
const singleRow = (p) =>
  p.avatar.top >= p.meta.top - 1 && p.avatar.bottom <= p.meta.bottom + 1 &&
  p.time.left >= p.meta.left - 1 && p.time.right <= p.meta.right + 1;

log('meta-layout', { count: metaLayout.count, own: metaLayout.own, other: metaLayout.other });

check('相手の発言行は左からアイコン・名前・年月日時間の順で、年月日時間は下揃え',
  metaLayout.other !== null && metaLayout.other.avatarIsFirst &&
  metaLayout.other.avatar.left < metaLayout.other.name.left &&
  metaLayout.other.name.left < metaLayout.other.time.left &&
  bottomsAligned(metaLayout.other) && singleRow(metaLayout.other),
  metaLayout.other);

check('自分の発言行は右からアイコン・名前・年月日時間の順で、年月日時間は下揃え',
  metaLayout.own !== null && metaLayout.own.avatarIsLast &&
  metaLayout.own.time.left < metaLayout.own.name.left &&
  metaLayout.own.name.left < metaLayout.own.avatar.left &&
  metaLayout.own.avatar.right > metaLayout.own.name.right &&
  bottomsAligned(metaLayout.own) && singleRow(metaLayout.own),
  metaLayout.own);

await page.screenshot({ path: 'scripts/output/chat-meta-layout.png' });


// ===== コメントホバー時の読み込みメニュー（未読者・取り消し）=====
// 普段は隠し、コメント行へホバー時だけ吹き出しの下へプルダウンとして開くことを実マウスで検証する。
// confirm はスタブ（取り消し実行を抑止し、呼び出し回数で実マウス到達を判定する）
await page.evaluate(() => {
  window.__confirmCalls = 0;
  window.confirm = () => { window.__confirmCalls += 1; return false; };
});

const hoverTargets = await page.evaluate(() => {
  const cont = document.getElementById('chat-messages-container');
  const cr = cont.getBoundingClientRect();
  const rows = [...document.querySelectorAll('#chat-messages-container [data-msg-id]')];
  // 列表の表示領域内にあり、後ろに行が続く（＝メニューが重なる状況を作る）行を選ぶ
  const inView = (row) => {
    const b = row.querySelector('div.rounded-2xl');
    if (!b) return false;
    const r = b.getBoundingClientRect();
    const cy = r.y + r.height / 2;
    return cy > cr.top + 20 && cy < cr.bottom - 60 && row !== cont.lastElementChild;
  };
  const bubbleCenter = (row) => {
    const r = row.querySelector('div.rounded-2xl').getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  };
  const own = rows.find((r) => r.getAttribute('data-own') === 'true' && r.querySelector('.chat-cancel-btn') && inView(r));
  const other = rows.find((r) => r.getAttribute('data-own') === 'false' && r.querySelector('.btn-show-unreaders') && inView(r));
  return {
    ownId: own ? own.getAttribute('data-msg-id') : null,
    ownCenter: own ? bubbleCenter(own) : null,
    otherId: other ? other.getAttribute('data-msg-id') : null,
    otherCenter: other ? bubbleCenter(other) : null,
  };
});

const footerState = (rowId) => page.evaluate((rid) => {
  const row = document.querySelector(`#chat-messages-container [data-msg-id="${rid}"]`);
  const footer = row ? row.querySelector('[data-read-footer]') : null;
  const cs = footer ? getComputedStyle(footer) : null;
  const fr = footer ? footer.getBoundingClientRect() : null;
  const bubble = row ? row.querySelector('div.rounded-2xl') : null;
  const br = bubble ? bubble.getBoundingClientRect() : null;
  const rd = (v) => Math.round(v * 100) / 100;
  return {
    opacity: cs ? cs.opacity : null,
    visibility: cs ? cs.visibility : null,
    footerTop: fr ? rd(fr.top) : null,
    footerHeight: fr ? rd(fr.height) : null,
    bubbleTop: br ? rd(br.top) : null,
    bubbleBottom: br ? rd(br.bottom) : null,
    bubbleLeft: br ? rd(br.left) : null,
    bubbleRight: br ? rd(br.right) : null,
    scroll: Math.round(document.getElementById('chat-messages-container').scrollTop),
  };
}, rowId);

const moveAwayFromChat = async () => {
  // フォーカス維持でメニューが開いたままになる（:focus-within）ので、計測前にフォーカスを外す
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  const c = await centerOf('#chat-input-message');
  if (c) await page.mouse.move(c.x, c.y, { steps: 2 });
  await sleep(320);
};

// 1) 普段は隠れている
await moveAwayFromChat();
const hiddenOwn = await footerState(hoverTargets.ownId);
const hiddenOther = await footerState(hoverTargets.otherId);
log('footer-hidden', { hiddenOwn, hiddenOther });
check('普段は未読者・取り消しメニューが隠れている（ホバー前は非表示）',
  hiddenOwn.visibility === 'hidden' && hiddenOwn.opacity === '0' &&
  hiddenOther.visibility === 'hidden' && hiddenOther.opacity === '0',
  { hiddenOwn, hiddenOther });

// 2) 自分のコメントへホバー → プルダウンが吹き出しの下へ開き、取り消しを実マウスで押せる
await clearToasts();
await page.mouse.move(hoverTargets.ownCenter.x, hoverTargets.ownCenter.y, { steps: 3 });
await sleep(320);
const shownOwn = await footerState(hoverTargets.ownId);
// ホバー中のボタン中心座標を実測し、そこにマウスをクリックして到達確認する
const ownClick = await page.evaluate((rid) => {
  const row = document.querySelector(`#chat-messages-container [data-msg-id="${rid}"]`);
  const btn = row.querySelector('.chat-cancel-btn');
  const br = btn.getBoundingClientRect();
  const cx = Math.round(br.x + br.width / 2), cy = Math.round(br.y + br.height / 2);
  const pt = document.elementFromPoint(cx, cy);
  return { cx, cy, hit: pt ? `${pt.tagName}[${pt.className}]` : null };
}, hoverTargets.ownId);
log('own-hit', ownClick);
await page.mouse.click(ownClick.cx, ownClick.cy);
await sleep(350);
const confirmCalls = await page.evaluate(() => window.__confirmCalls);
log('own-hover', { shownOwn, ownClick, confirmCalls });
check('自分のコメントへホバーすると未読・取り消しメニューがプルダウン表示され、取り消しを実マウスで押せる',
  shownOwn.visibility === 'visible' && shownOwn.opacity === '1' &&
  shownOwn.footerHeight > 0 && shownOwn.footerTop >= shownOwn.bubbleBottom &&
  ownClick.hit === 'BUTTON[chat-cancel-btn text-danger hover-text-danger-strong flex items-center gap-1]' &&
  confirmCalls >= 1,
  { shownOwn, ownClick, confirmCalls });

// 3) ホバーを離すと再び隠れ、吹き出し位置・列表のスクロールは動かない（レイアウトシフトなし）
await moveAwayFromChat();
const rehiddenOwn = await footerState(hoverTargets.ownId);
log('own-rehidden', { before: hiddenOwn, after: rehiddenOwn });
check('ホバーを離すとメニューが再び隠れ、吹き出し位置・列表のスクロールは動かない',
  rehiddenOwn.visibility === 'hidden' && rehiddenOwn.opacity === '0' &&
  rehiddenOwn.bubbleTop === hiddenOwn.bubbleTop &&
  rehiddenOwn.bubbleLeft === hiddenOwn.bubbleLeft &&
  rehiddenOwn.bubbleRight === hiddenOwn.bubbleRight &&
  rehiddenOwn.scroll === hiddenOwn.scroll,
  { before: hiddenOwn, after: rehiddenOwn });

// 4) 相手のコメントへホバー → 未読者メニューから実マウスで未読者一覧を出す
await clearToasts();
await page.mouse.move(hoverTargets.otherCenter.x, hoverTargets.otherCenter.y, { steps: 3 });
await sleep(320);
const shownOther = await footerState(hoverTargets.otherId);
const otherClick = await page.evaluate((rid) => {
  const row = document.querySelector(`#chat-messages-container [data-msg-id="${rid}"]`);
  const btn = row.querySelector('.btn-show-unreaders');
  const br = btn.getBoundingClientRect();
  const cx = Math.round(br.x + br.width / 2), cy = Math.round(br.y + br.height / 2);
  const pt = document.elementFromPoint(cx, cy);
  return { cx, cy, hit: pt ? `${pt.tagName}[${pt.className}]` : null };
}, hoverTargets.otherId);
log('other-hit', otherClick);
await page.mouse.click(otherClick.cx, otherClick.cy);
await sleep(420);
const otherToast = await page.evaluate(() => {
  const toasts = [...document.querySelectorAll('#toast-container div')]
    .map((e) => e.textContent.replace(/\s+/g, ' ').trim())
    .filter((t) => t.includes('未読者'));
  return toasts.length > 0 ? toasts[0].slice(0, 90) : null;
});
log('other-hover', { shownOther, otherClick, otherToast });
check('相手のコメントへホバーすると未読者メニューがプルダウン表示され、実マウスで未読者一覧が出る',
  shownOther.visibility === 'visible' && shownOther.opacity === '1' &&
  shownOther.footerHeight > 0 && shownOther.footerTop >= shownOther.bubbleBottom &&
  otherClick.hit === 'BUTTON[btn-show-unreaders hover:underline text-warning flex items-center gap-1]' &&
  otherToast !== null && otherToast.includes('未読者（'),
  { shownOther, otherClick, otherToast });

// ホバー中の見た目を確認するスクリーンショット（自分の行をホバー）
await clearToasts();
await page.mouse.move(hoverTargets.ownCenter.x, hoverTargets.ownCenter.y, { steps: 3 });
await sleep(320);
await page.screenshot({ path: 'scripts/output/chat-hover-menu.png' });
await moveAwayFromChat();


await browser.close();

tanakaSocket2.close();
// 検証用グループを削除して後片付けする（撤廃後は個人作成グループのみがチャット単位）
const groupCleaned = await fetch(`${BASE}/api/chat/channels/${groupId}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${probeToken}` },
}).then((r) => r.status);
log('probe-group-cleanup', groupCleaned);
check('検証用グループを削除して後片付けできる', groupCleaned === 200, groupCleaned);

if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('ALL PASSED');
