/**
 * サイドメニューせり出し時の main 追従（広幅は非重畳 / 狭幅はオーバーレイ維持）を検証する UI テスト
 * 実行: npm run test:ui:sidebar-push （ISSystem サーバー稼働中・CA 証明書信頼が必要）
 * options: UI_BASE=https://127.0.0.1:3443  UI_USER=T2026001  UI_PASS=password123
 *
 * 期待挙動 (layouts.css §6 + main.js):
 * - 1100px 以上: せり出し (hover/is-hover/is-focus) で main の padding-left が収納幅 4.2rem(73.5px)
 *   からせり出し幅 16.3rem(285.25px) へ追従し、コンテンツ左端がサイドバー右端に着地（重なりなし）
 * - 768〜1099px: main は動かずオーバーレイ（画面崩れ防止）
 * - 768px 未満: 画面下バー（せり出しなし・main の padding は Tailwind 既定）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';

const results = [];
const record = (item, pass, detail = '') => {
  results.push({ item, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${item}${detail ? ` (${detail})` : ''}`);
};

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH を指定してください。');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// main の padding-left と、サイドバー実幅・コンテンツ左端・サイドバー右端を測る
const measure = (page) =>
  page.evaluate(() => {
    const sb = document.querySelector('.app-sidebar');
    const main = document.querySelector('#app-body main');
    const sbR = sb.getBoundingClientRect();
    const cs = getComputedStyle(main);
    const padL = parseFloat(cs.paddingLeft);
    const contentLeft = main.getBoundingClientRect().left + padL;
    return {
      sidebarW: Math.round(sbR.width * 100) / 100,
      sidebarRight: Math.round(sbR.right * 100) / 100,
      padL: Math.round(padL * 100) / 100,
      contentLeft: Math.round(contentLeft * 100) / 100,
      isHover: sb.classList.contains('is-hover'),
      isFocus: sb.classList.contains('is-focus'),
    };
  });

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new',
  ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

async function login(page) {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(800);
}

// --- 広幅 (1280・1150px): main が追従し重なりなし ---
for (const vw of [1280, 1150]) {
  const page = await browser.newPage();
  await page.setViewport({ width: vw, height: 900 });
  await login(page);

  const collapsed = await measure(page);
  record(`[${vw}px] 収納: sidebar ${collapsed.sidebarW}px・main padding-left ${collapsed.padL}px`,
    collapsed.sidebarW <= 70 && collapsed.padL >= 70 && collapsed.padL <= 78 && collapsed.contentLeft >= collapsed.sidebarRight - 1,
    JSON.stringify(collapsed));

  await page.hover('.app-sidebar');
  await sleep(400);
  const expanded = await measure(page);
  record(`[${vw}px] ホバーせり出し: main padding-left がせり出し幅 ${expanded.sidebarW}px に追従し重なりなし`,
    expanded.sidebarW >= 283 && expanded.padL >= 283 && expanded.contentLeft >= expanded.sidebarRight - 2 && expanded.isHover,
    JSON.stringify(expanded));

  // フォーカス専用経路 (is-focus のみ・ホバーなし) でも追従
  await page.mouse.move(vw - 100, 400);
  await sleep(300);
  await page.evaluate(() => document.querySelector('.app-sidebar .nav-item').focus());
  await sleep(400);
  const focusState = await measure(page);
  record(`[${vw}px] クリックフォーカス (is-focus のみ) でも main 追従`,
    focusState.isFocus && !focusState.isHover && focusState.padL >= 283 && focusState.contentLeft >= focusState.sidebarRight - 2,
    JSON.stringify(focusState));

  // フォーカスがサイドバー外へ移れば収納復帰
  await page.evaluate(() => document.querySelector('#app-container button')?.focus());
  await sleep(400);
  const afterBlur = await measure(page);
  record(`[${vw}px] サイドバー外へフォーカス移動で main 収納復帰`,
    !afterBlur.isFocus && afterBlur.padL <= 78,
    JSON.stringify(afterBlur));

  // ホバー→カーソル離脱で収納復帰
  await page.hover('.app-sidebar');
  await sleep(300);
  await page.mouse.move(vw / 2, 400);
  await sleep(400);
  const back = await measure(page);
  record(`[${vw}px] カーソル離脱で収納復帰`,
    back.padL <= 78 && back.sidebarW <= 70 && !back.isHover && !back.isFocus,
    JSON.stringify(back));

  await page.close();
}

// --- 狭幅 (900px, 768〜1099): オーバーレイ維持（main は動かず画面崩れなし） ---
const page900 = await browser.newPage();
await page900.setViewport({ width: 900, height: 900 });
await login(page900);
const base900 = await measure(page900);
await page900.hover('.app-sidebar');
await sleep(400);
const hover900 = await measure(page900);
record('[900px] 狭幅はオーバーレイ維持（sidebar はせり出すが main padding は不変）',
  hover900.sidebarW >= 283 && Math.abs(hover900.padL - base900.padL) < 2 && hover900.contentLeft < hover900.sidebarRight,
  JSON.stringify(hover900));
await page900.close();

// --- 最狭幅 (500px): 画面下バー（せり出しなし） ---
const page500 = await browser.newPage();
await page500.setViewport({ width: 500, height: 900 });
await login(page500);
await page500.hover('.app-sidebar');
await sleep(400);
const bar500 = await measure(page500);
record('[500px] 画面下バー: せり出しなし・main padding は Tailwind 既定 (16px)',
  bar500.sidebarW >= 500 && Math.abs(bar500.padL - 16) < 2,
  JSON.stringify(bar500));
await page500.close();

await browser.close();

const failures = results.filter((r) => !r.pass);
console.log('=====');
console.log(`合計 ${results.length} 件 / 失敗 ${failures.length}`);
if (failures.length) {
  console.error('Sidebar push UI テスト: 失敗あり');
  process.exit(1);
}
console.log('Sidebar push UI テスト ALL PASS');
