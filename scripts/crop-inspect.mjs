/**
 * 枠線精査用クロースアップ撮影（deviceScaleFactor=2）
 * 実行: node scripts/crop-inspect.mjs   （ISSystem サーバーが必要）
 * 出力: scripts/output/crop-*.png
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

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome が見つかりません（CHROME_PATH 指定可）。');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(OUT_DIR, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors']
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1100, deviceScaleFactor: 2 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

async function shoot(selector, name, idx = 0) {
  const els = await page.$$(selector);
  if (!els[idx]) { console.log(`  missing: ${selector}`); return; }
  await els[idx].screenshot({ path: path.join(OUT_DIR, `crop-${name}.png`) });
  const info = await els[idx].evaluate((el) => {
    const cs = getComputedStyle(el);
    return `${el.className.slice(0, 60)} | border:${cs.borderTopWidth} ${cs.borderTopColor} | shadow:${cs.boxShadow.slice(0, 60)}`;
  });
  console.log(`  crop-${name}: ${info}`);
}

// ダッシュボードの各セクション
const dashSections = await page.evaluate(() => [...document.querySelectorAll('#view-dashboard .card')]
  .map((el) => [...el.querySelectorAll('span')].find((s) => /^[a-z]+-soft/.test(s.className))?.textContent.trim()));
console.log(`  dashboard cards: ${JSON.stringify(dashSections)}`);
for (let i = 0; i < 6; i++) await shoot('#view-dashboard .card', `dash-${i}`, i);

// サイドバー上部（ホバー時、拡大）
const firstNav = await page.$('a[data-tab="dashboard"]');
await firstNav.hover();
await sleep(400);
await (await page.$('.app-sidebar nav')).screenshot({ path: path.join(OUT_DIR, 'crop-sidebar-nav.png') });
await (await page.$('a[data-tab="dashboard"]')).screenshot({ path: path.join(OUT_DIR, 'crop-sidebar-item-hover.png') });

// 簡易承認：1件目のアイテムと決済者ボックス
await page.evaluate(() => document.querySelector('a[data-tab="approval"]').click());
await sleep(1000);
await shoot('#view-approval .card', 'approval-card', 1);
await shoot('#view-approval .card', 'approval-header', 0);

await browser.close();
console.log(`\nDONE -> ${OUT_DIR}`);
