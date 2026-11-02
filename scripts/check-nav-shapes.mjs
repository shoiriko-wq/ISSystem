/**
 * サイドメニュー（アイコンのみモード / 画面下バー）の選択背景形状を測定する診断スクリプト
 * 実行: node scripts/check-nav-shapes.mjs   （ISSystem サーバーが必要）
 * options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'scripts', 'output');
const BASE = process.env.UI_BASE || 'http://127.0.0.1:3100';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const VIEWPORTS = [320, 500, 760, 1020, 1280];

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH を指定してください。');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});

for (const vw of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({ width: vw, height: 900 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(1000);

  const report = await page.evaluate(() => {
    const sb = document.querySelector('.app-sidebar');
    const nav = sb.querySelector('nav');
    const navItems = [...sb.querySelectorAll('.nav-item')];
    const px = (v) => Math.round(parseFloat(v) * 100) / 100;
    const rows = navItems.map((n) => {
      const r = n.getBoundingClientRect();
      const cs = getComputedStyle(n);
      const icon = n.querySelector('svg.lucide, i[data-lucide]');
      const ir = icon ? icon.getBoundingClientRect() : null;
      const label = n.querySelector('.nav-label');
      return {
        title: (n.getAttribute('title') || n.textContent.trim()).slice(0, 6),
        w: px(r.width), h: px(r.height),
        iconW: ir ? px(ir.width) : null, iconH: ir ? px(ir.height) : null,
        labelShown: label ? getComputedStyle(label).display !== 'none' : false,
        radius: cs.borderTopLeftRadius,
        bg: cs.backgroundColor,
        active: n.classList.contains('active'),
        pad: `${cs.paddingTop}/${cs.paddingRight}/${cs.paddingBottom}/${cs.paddingLeft}`,
        barW: cs.getPropertyValue('--nav-bar-width')
      };
    });
    const sbBox = sb.getBoundingClientRect();
    return {
      viewport: innerWidth,
      sidebar: { w: px(sbBox.width), h: px(sbBox.height), pad: getComputedStyle(sb).padding },
      nav: { w: px(nav.getBoundingClientRect().width), h: px(nav.getBoundingClientRect().height), pad: getComputedStyle(nav).padding },
      items: rows
    };
  });

  console.log(`\n=== viewport=${report.viewport} sidebar=${report.sidebar.w}x${report.sidebar.h} nav=${report.nav.w}x${report.nav.h} ===`);
  report.items.forEach((i) => {
    console.log(`  ${i.active ? '[ACTIVE]' : '[      ]'} ${i.title} box=${i.w}x${i.h} (ratio=${(i.w / i.h).toFixed(2)}) icon=${i.iconW}x${i.iconH} label=${i.labelShown} pad=${i.pad} radius=${i.radius} bg=${i.bg}`);
  });

  // せり出し前（アイコンのみ）のスクリーンショット
  const collapsedShot = path.join(OUT_DIR, `nav-shapes-${vw}-collapsed.png`);
  const collapsedEl = await page.$('.app-sidebar');
  const collapsedBox = await collapsedEl.boundingBox();
  await collapsedEl.screenshot({ path: collapsedShot });
  // 画面全体のスクリーンショット（要素スクリーンショットが見切れるため）
  const fullShot = path.join(OUT_DIR, `nav-shapes-${vw}-full.png`);
  await page.screenshot({
    path: fullShot,
    clip: { x: 0, y: collapsedBox.y, width: Math.min(vw, 420), height: Math.min(collapsedBox.height, 260) },
    captureBeyondViewport: true
  });

  // ホバーせり出し状態も測定
  const sbBoxForHover = await page.$('.app-sidebar');
  const hb = await sbBoxForHover.boundingBox();
  await page.mouse.move(hb.x + 3, hb.y + hb.height / 2);
  await sleep(500);
  const hoverReport = await page.evaluate(() => {
    const sb = document.querySelector('.app-sidebar');
    const navItems = [...sb.querySelectorAll('.nav-item')];
    const px = (v) => Math.round(parseFloat(v) * 100) / 100;
    const active = navItems.find((n) => n.classList.contains('active'));
    const r = active.getBoundingClientRect();
    const cs = getComputedStyle(active);
    const icon = active.querySelector('svg.lucide, i[data-lucide]');
    const ir = icon.getBoundingClientRect();
    const label = active.querySelector('.nav-label');
    return {
      sidebar: px(sb.getBoundingClientRect().width),
      activeBox: `${px(r.width)}x${px(r.height)}`,
      ratio: px(r.width / r.height),
      icon: `${px(ir.width)}x${px(ir.height)}`,
      label: getComputedStyle(label).display,
      pad: `${cs.paddingTop}/${cs.paddingLeft}`
    };
  });
  console.log(`  [HOVER] sidebar=${hoverReport.sidebar} activeBox=${hoverReport.activeBox} ratio=${hoverReport.ratio} icon=${hoverReport.icon} label=${hoverReport.label} pad=${hoverReport.pad}`);

  const shot = path.join(OUT_DIR, `nav-shapes-${vw}-hover.png`);
  const hoverEl = await page.$('.app-sidebar');
  await hoverEl.screenshot({ path: shot });
  console.log(`  shots -> ${collapsedShot}, ${shot}`);

  await page.close();
}

await browser.close();
