/**
 * ダッシュボード「記事を共有」機能の回帰テスト（実ブラウザ + サーバー実データ検証）
 *
 * 検証ルール:
 *  1. ピックアップ教育ニュースの「すべて見る」ボタン（dash-btn-news-more）は撤廃済み
 *  2. 「記事を共有」ボタン（dash-btn-news-share）が同じ位置に存在する
 *  3. クリックで #news-share-modal（モーダル規約: modal-overlay > modal-card > modal-header + modal-form + modal-footer）が開く
 *  4. モーダルの入力欄は記事URLだけ（タイトル・ひとこと・共有先・チャンネル選択・掲示対象日は撤廃）
 *  5. 記事URLが空では送信しない（エラートースト表示、モーダルは開いたまま、POST 発生なし）
 *  6. URL入力 → 職員チャットへ共有（スキーマ無しは https:// を補完、本文は「【記事共有】+ドメイン名+URL」の2行）
 *  7. 投稿先は閲覧中の職員チャットチャンネル（/api/chat/channels/:id/messages）
 *  8. 共有後はモーダルが閉じ、成功トーストとチャットタブへ遷移、サーバー側にも実メッセージが残る
 *  9. フッター「閉じる」と ESC キーで閉じられる（全モーダル共通規約）
 * 10. 背景クリック規則: モーダル内で押し開始→背景で離すと閉じない、背景で押し開始→閉じる
 * 11. ボタン・モーダルの Lucide アイコンが SVG として実描画される
 *
 * 実行: node scripts/test-news-share-modal.mjs  （ISSystem サーバーが必要）
 *  options: UI_BASE=https://127.0.0.1:3443  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NODE_EXTRA_CA_CERTS ||= path.join(ROOT, 'certs', 'issystem-ca.crt');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
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

// 共有投稿の POST を記録（送信先と本文を検証するため）
const posts = [];
page.on('request', (req) => {
  const url = req.url();
  if (req.method() !== 'POST') return;
  if (/\/api\/chat\/channels\/[^/]+\/messages$/.test(url) || /\/api\/bulletins$/.test(url)) {
    let body = null;
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = null; }
    posts.push({ endpoint: url.replace(BASE, ''), body });
  }
});
/**
 * ダッシュボードタブへ戻ってから「記事を共有」ボタンを実クリックする
 * （共有後に他タブへ遷移するとダッシュボードのウィジェットが非表示になり、直接クリックできないため）
 */
async function openShare() {
  await page.evaluate(() => document.querySelector('.app-sidebar .nav-item[data-tab="dashboard"]').click());
  await sleep(400);
  await page.click('#dash-btn-news-share');
  await sleep(500);
}


await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

// ---- 1,2. ボタンの撤廃と新設 ----
const btnInfo = await page.evaluate(() => {
  const share = document.getElementById('dash-btn-news-share');
  return {
    moreExists: !!document.getElementById('dash-btn-news-more'),
    shareExists: !!share,
    shareText: (share?.textContent || '').replace(/\s+/g, ' ').trim(),
    modalExists: !!document.getElementById('news-share-modal'),
    hasCloseX: !!document.querySelector('#news-share-modal .modal-close-x'),
    footerCloseCount: document.querySelectorAll('#news-share-modal .modal-footer .modal-close').length,
  };
});
check('「すべて見る」ボタン（dash-btn-news-more）は撤廃済み', !btnInfo.moreExists, btnInfo);
check('「記事を共有」ボタンが同じ位置に存在する', btnInfo.shareExists && btnInfo.shareText.includes('記事を共有'), btnInfo);
check('モーダル規約（X・フッター閉じる）が揃っている', btnInfo.modalExists && btnInfo.hasCloseX && btnInfo.footerCloseCount >= 1, btnInfo);

// ---- 3,4. クリックでモーダルが開き、入力欄は記事URLだけ ----
await page.click('#dash-btn-news-share');
await sleep(600);
const opened = await page.evaluate(() => ({
  open: !document.getElementById('news-share-modal').classList.contains('hidden'),
  urlPlaceholder: document.getElementById('news-share-url')?.placeholder,
  inputIds: [...document.querySelectorAll('#news-share-form input, #news-share-form select, #news-share-form textarea')].map((e) => e.id),
  submitCount: document.querySelectorAll('#news-share-form button[type="submit"]').length,
  focusedId: document.activeElement?.id,
}));
check('クリックで共有モーダルが開く', opened.open, opened);
check('URL入力欄がフォーカスされる', !!opened.urlPlaceholder && opened.focusedId === 'news-share-url', opened);
check('入力欄は記事URLだけ（タイトル・ひとこと・共有先・チャンネル選択・掲示対象日は撤廃）',
  opened.inputIds.length === 1 && opened.inputIds[0] === 'news-share-url' && opened.submitCount === 1, opened);

// ---- 4. URL 空の送信は禁止 ----
await page.click('#news-share-form button[type="submit"]');
await sleep(600);
const afterEmpty = await page.evaluate(() => ({
  open: !document.getElementById('news-share-modal').classList.contains('hidden'),
  toasts: [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
}));
check('URL 空では POST が発生しない', posts.length === 0, posts);
check('URL 空ではエラートースト表示、モーダルは開いたまま', afterEmpty.open && afterEmpty.toasts.some((t) => t.includes('URL')), afterEmpty);


// ---- 5,6,7,8. 職員チャットへ共有（スキーマ無しURLは https:// 補完・本文は2行・閲覧中チャンネルへ） ----
await page.type('#news-share-url', 'mext.go.jp/b_menu/happou/20261107.html');
await page.click('#news-share-form button[type="submit"]');
await sleep(1200);

const chatPost = posts.find((p) => p.endpoint.includes('/chat/channels/'));
check('URLが https:// へ補完され、本文は「【記事共有】+ドメイン名+URL」の2行（ひとこと欄は無い）',
  chatPost?.body?.messageText === '【記事共有】mext.go.jp\nhttps://mext.go.jp/b_menu/happou/20261107.html',
  chatPost?.body?.messageText);

// 投稿先は閲覧中の職員チャットチャンネル（チャットサイドバーの active なチャンネル）
const activeChannelId = await page.evaluate(() =>
  document.querySelector('#chat-channels-list [data-channel-id].active')?.getAttribute('data-channel-id') || null);
const postChannelId = chatPost ? decodeURIComponent(chatPost.endpoint.split('/')[4]) : null;
check('投稿先は閲覧中の職員チャットチャンネル（/api/chat/channels/:id/messages）',
  !!chatPost && /^\/api\/chat\/channels\/[A-Za-z0-9_-]+\/messages$/.test(chatPost.endpoint)
  && !!activeChannelId && postChannelId === activeChannelId,
  { endpoint: chatPost?.endpoint, activeChannelId, postChannelId });

const afterChat = await page.evaluate(() => ({
  open: !document.getElementById('news-share-modal').classList.contains('hidden'),
  activeView: document.querySelector('.tab-view:not(.hidden)')?.id,
  toasts: [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
}));
check('共有後モーダルが閉じチャットタブへ遷移・成功トースト',
  !afterChat.open && afterChat.activeView === 'view-chat' && afterChat.toasts.some((t) => t.includes('職員チャットへ記事を共有')), afterChat);

const chatMsgs = await page.evaluate(async (cid) => {
  const m = await import('/js/api.js');
  const res = await m.apiGet(`/chat/channels/${cid}/messages`);
  const list = res.messages || res.data || (Array.isArray(res) ? res : []);
  return list.map((x) => String(x.content || x.messageText || x.text || ''));
}, postChannelId);
// メッセージは created_at 昇順なので共有メッセージは末尾側にある
check('サーバー実データ: 閲覧中の職員チャットチャンネルに共有メッセージが登録されている',
  chatMsgs.some((t) => t.includes('https://mext.go.jp/')), chatMsgs.slice(-2));

// ---- 9. 閉じるボタン・ESC（全モーダル共通ルール） ----
await openShare();
await page.click('#news-share-modal .modal-footer .modal-close');
await sleep(300);
const closedByBtn = await page.evaluate(() => document.getElementById('news-share-modal').classList.contains('hidden'));
check('フッターの「閉じる」ボタンで閉じられる', closedByBtn);

await openShare();
await page.keyboard.press('Escape');
await sleep(300);
const closedByEsc = await page.evaluate(() => document.getElementById('news-share-modal').classList.contains('hidden'));
check('ESC キーで閉じられる', closedByEsc);

// ---- 10. 背景クリック規則（モーダル内ドラッグ脱出は閉じない／背景押下は閉じる） ----
await openShare();
const geo = await page.evaluate(() => {
  const o = document.getElementById('news-share-modal').getBoundingClientRect();
  const c = document.querySelector('#news-share-modal .modal-card').getBoundingClientRect();
  return { o: { x: o.x, y: o.y, w: o.width, h: o.height }, c: { x: c.x, y: c.y, w: c.width, h: c.height } };
});
const bgPoint = { x: geo.o.x + 8, y: geo.o.y + 8 }; // オーバーレイの左上隅 = カード外の背景
const cardPoint = { x: geo.c.x + geo.c.w / 2, y: geo.c.y + geo.c.h / 2 };

// モーダル内で押し開始 → 背景で離す → 閉じない
await page.mouse.move(cardPoint.x, cardPoint.y);
await page.mouse.down();
await page.mouse.move(bgPoint.x, bgPoint.y);
await page.mouse.up();
await sleep(300);
const afterDragOut = await page.evaluate(() => document.getElementById('news-share-modal').classList.contains('hidden'));
check('モーダル内で押し開始し背景で離すと閉じない（テキスト選択ドラッグのストレス回避）', !afterDragOut, { bgPoint, cardPoint });

// 背景で押し開始 → 背景で離す → 閉じる
await page.mouse.move(bgPoint.x, bgPoint.y);
await page.mouse.down();
await page.mouse.up();
await sleep(300);
const afterBgClick = await page.evaluate(() => document.getElementById('news-share-modal').classList.contains('hidden'));
check('背景で押し開始して離すと閉じる', afterBgClick);

// ---- 11. Lucide アイコンが実描画されている（ボタン・モーダルヘッダー） ----
const icons = await page.evaluate(() => {
  const svgIn = (sel) => !!document.querySelector(sel)?.querySelector('svg');
  return {
    btn: svgIn('#dash-btn-news-share'),
    head: svgIn('#news-share-modal .modal-header .modal-title'),
    closeX: svgIn('#news-share-modal .modal-close-x'),
  };
});
check('ボタン・モーダルのアイコンがSVGとして描画されている', icons.btn && icons.head && icons.closeX, icons);

await browser.close();
console.log('---');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL OK');
process.exit(0);
