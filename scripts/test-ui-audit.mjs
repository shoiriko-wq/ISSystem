/**
 * ページ全体の「枠線」監査（実ブラウザスクリーンショット）
 *
 * 目的: 各ビューのセクションコンテナ・内部項目・ホバーリングの描画状態を
 *       画像として記録し、不要な枠線と必要な区切り線の判定根拠を得る。
 * 実行: node scripts/test-ui-audit.mjs        （ISSystem サーバーが必要）
 *  options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123
 * 出力: scripts/output/audit-<tab>.png, audit-sidebar.png, audit-sidebar-hover.png
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'scripts', 'output');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const TABS = ['dashboard', 'bulletin', 'chat', 'facility', 'schedule', 'approval', 'seating', 'exam'];

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH 環境変数でパスを指定してください。');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors']
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));
await page.setViewport({ width: 1280, height: 1200 });

await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });

// ログイン
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

// ダッシュボード 4セクションの記事カード: ホバーでリング + 浮き上がり（実アプリ）
const dashArticleSections = ['#dash-pinned-bulletins', '#dash-news-summary', '#dash-today-facilities', '#dash-today-schedules'];
const liveArticleHovers = [];
for (const sel of dashArticleSections) {
  const el = await page.$(`${sel} > div.rounded-lg`);
  if (!el) { liveArticleHovers.push({ sel, skip: 'no article items' }); continue; }
  await page.mouse.move(5, 5);
  await el.hover();
  await sleep(400);
  liveArticleHovers.push(await page.evaluate((node, selName) => {
    const cs = getComputedStyle(node);
    return {
      sel: selName, outline: cs.outlineStyle, transform: cs.transform,
      cursor: cs.cursor, top: parseFloat(cs.borderTopWidth),
      borderColor: cs.borderTopColor, shadow: cs.boxShadow.slice(0, 28)
    };
  }, el, sel));
  await page.screenshot({ path: path.join(OUT_DIR, `audit-dashboard-hover-${sel.replace('#', '')}.png`) });
}
console.log(`  dashboard article hover (live): ${JSON.stringify(liveArticleHovers)}`);

const mainEl = await page.$('main');
for (const tab of TABS) {
  const nav = await page.$(`a[data-tab="${tab}"]`);
  if (!nav) { console.log(`  skip - ${tab} (nav not found)`); continue; }
  await nav.click();
  await sleep(900);
  await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTop = 0; });
  await mainEl.screenshot({ path: path.join(OUT_DIR, `audit-${tab}-1.png`) });
  const metrics = await page.evaluate(() => {
    const m = document.querySelector('main');
    return { scroll: m.scrollHeight, visible: m.clientHeight };
  });
  if (metrics.scroll > metrics.visible + 20) {
    await page.evaluate(() => { const m = document.querySelector('main'); m.scrollTop = m.clientHeight; });
    await sleep(300);
    await mainEl.screenshot({ path: path.join(OUT_DIR, `audit-${tab}-2.png`) });
  }
  console.log(`  shot - ${tab} (scroll=${metrics.scroll}, visible=${metrics.visible})`);
}

// サイドバー（ホバーリング前後）: 枠リングが見切れるか
await page.evaluate(() => { const m = document.querySelector('main'); if (m) m.scrollTop = 0; });
const sidebar = await page.$('.app-sidebar');
await sidebar.screenshot({ path: path.join(OUT_DIR, 'audit-sidebar.png') });
const firstNav = await page.$('a[data-tab="dashboard"]');
await firstNav.hover();
await sleep(400);
await sidebar.screenshot({ path: path.join(OUT_DIR, 'audit-sidebar-hover-first.png') });
const navs = await page.$$('a[data-tab]');
const lastNav = navs[navs.length - 1];
await lastNav.hover();
await sleep(400);
await sidebar.screenshot({ path: path.join(OUT_DIR, 'audit-sidebar-hover-last.png') });

const ringRoom = await page.evaluate(() => {
  const nav = document.querySelector('.app-sidebar nav');
  const item = document.querySelector('.app-sidebar .nav-item');
  const csNav = getComputedStyle(nav);
  const csItem = getComputedStyle(item);
  return {
    navPadding: `${csNav.paddingTop}/${csNav.paddingRight}/${csNav.paddingBottom}/${csNav.paddingLeft}`,
    navOverflow: csNav.overflowY,
    sidebarOverflow: getComputedStyle(document.querySelector('.app-sidebar')).overflow,
    outlineWidth: csItem.outlineWidth,
    outlineOffset: csItem.outlineOffset
  };
});
console.log(`  ring room: ${JSON.stringify(ringRoom)}`);

// ダッシュボードのグループ枠と見出し仕切り線の状態（実アプリ）
const frameInfo = await page.evaluate(() => {
  const grid = document.querySelector('.dashboard-grid');
  const gcs = grid ? getComputedStyle(grid) : null;
  const heads = [...document.querySelectorAll('#view-dashboard h3')].map((h) =>
    parseFloat(getComputedStyle(h.parentElement).borderBottomWidth));
  const cards = [...document.querySelectorAll('#view-dashboard .card')].map((c) =>
    parseFloat(getComputedStyle(c).borderTopWidth));
  return {
    gridBorder: gcs ? `${gcs.borderTopWidth} ${gcs.borderTopStyle} ${gcs.paddingTop}` : 'none',
    headerDividers: heads,
    cardBorders: cards
  };
});
console.log(`  dashboard frames: ${JSON.stringify(frameInfo)}`);

// 狭幅（アイコンのみ）モード：アイコンが見切れないか
// 新しいページで計測する（既存ページの要素スクリーンショットはページスケールを変え、
// 計測値と描画（アニメーションの巻き戻り）を歪めるため）
const npage = await browser.newPage();
await npage.setViewport({ width: 1020, height: 750 });
await npage.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
const appReady = await npage.waitForSelector('#app-container:not(.hidden)', { timeout: 8000 }).catch(() => null);
if (!appReady) {
  await npage.type('#login-userid', USER);
  await npage.type('#login-password', PASS);
  await npage.evaluate(() => window.handleLoginClick());
  await npage.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
}
await sleep(1200);
const narrowIcons = await npage.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  const cs = getComputedStyle(sb);
  const sr = sb.getBoundingClientRect();
  const contentLeft = sr.left + parseFloat(cs.borderLeftWidth);
  const contentRight = sr.right - parseFloat(cs.borderRightWidth);
  const lines = [`viewport=${innerWidth} sidebar=${Math.round(sr.width)} content=${Math.round(contentLeft)}..${Math.round(contentRight)}`];
  [...document.querySelectorAll('.app-sidebar .nav-item')].forEach((n) => {
    const icon = n.querySelector('svg.lucide, i[data-lucide], i');
    const ir = icon.getBoundingClientRect();
    const nr = n.getBoundingClientRect();
    lines.push(`${(n.getAttribute('title') || '').slice(0, 4)} nav=${Math.round(nr.left)}..${Math.round(nr.right)} icon=${Math.round(ir.left)}..${Math.round(ir.right)} clipL=${Math.round(contentLeft - ir.left)} clipR=${Math.round(ir.right - contentRight)} label=${getComputedStyle(n.querySelector('.nav-label')).display}`);
  });
  return lines;
});
console.log(`  narrow icons: ${narrowIcons.join('\n              ')}`);
await npage.screenshot({ path: path.join(OUT_DIR, 'audit-narrow-sidebar.png'), clip: { x: 0, y: 0, width: 120, height: 430 } });

// ホバリングでせり出した状態：ラベルが見え、アイコン・ラベルが箱内に収まるか
await npage.mouse.move(31, 400);
await sleep(600);
const expandedNarrow = await npage.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  const cs = getComputedStyle(sb);
  const sr = sb.getBoundingClientRect();
  const contentRight = sr.right - parseFloat(cs.borderRightWidth);
  const lines = [`sidebar=${Math.round(sr.width)} contentRight=${Math.round(contentRight)}`];
  [...document.querySelectorAll('.app-sidebar .nav-item')].forEach((n) => {
    const icon = n.querySelector('svg.lucide, i[data-lucide], i');
    const label = n.querySelector('.nav-label');
    const lr = label.getBoundingClientRect();
    lines.push(`${(n.getAttribute('title') || '').slice(0, 4)} icon=${Math.round(icon.getBoundingClientRect().left)} labelRight=${Math.round(lr.right)} label=${getComputedStyle(label).display} opacity=${getComputedStyle(label).opacity}`);
  });
  return lines;
});
console.log(`  narrow hover: ${expandedNarrow.join('\n              ')}`);
await npage.screenshot({ path: path.join(OUT_DIR, 'audit-narrow-sidebar-hover.png'), clip: { x: 0, y: 0, width: 240, height: 430 } });
await npage.screenshot({ path: path.join(OUT_DIR, 'audit-narrow-dashboard.png') });

await browser.close();
console.log(`\nDONE -> ${OUT_DIR}`);
