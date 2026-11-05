// 施設ヘッダーの統一サイズ＋タイムライン時間ヘッダー行の sticky（縦スクロールで固定）＋コントラスト検証
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const THEMES = ['cb-teal', 'cb-navy', 'dc-slate', 'dc-forest', 'dc-plum', 'light-azure', 'light-sea', 'light-sand'];

const failures = [];
const log = (name, detail) => { console.log(`${name} = ${JSON.stringify(detail)}`); };
const check = (name, ok, detail = null) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, ignoreHTTPSErrors: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1000);
await page.evaluate(() => document.querySelector('a[data-tab="facility"]').click());
await sleep(1500);

// ヘッダー操作群の高さ・フォント、sticky ヘッダー、スクロール挙動
const geom = await page.evaluate(() => {
  const cs = (el) => getComputedStyle(el);
  const header = document.getElementById('facility-time-header');
  const cont = document.querySelector('.timeline-scroll-container');
  const title = document.querySelector('#view-facility h2');
  const dateInput = document.getElementById('facility-date-picker');
  const prevBtn = document.getElementById('facility-prev-day');
  const todayBtn = document.getElementById('facility-btn-today');
  const createBtn = document.getElementById('facility-btn-create');
  return {
    titleFs: cs(title).fontSize,
    dateH: Math.round(dateInput.getBoundingClientRect().height),
    dateFs: cs(dateInput).fontSize,
    dateIconFs: cs(dateInput, '::webkit-calendar-picker-indicator').fontSize,
    prevH: Math.round(prevBtn.getBoundingClientRect().height),
    todayH: Math.round(todayBtn.getBoundingClientRect().height),
    createH: Math.round(createBtn.getBoundingClientRect().height),
    todayFs: cs(todayBtn).fontSize,
    createFs: cs(createBtn).fontSize,
    hintEl: cs(document.querySelector('#view-facility .card span.text-muted')).fontSize,
    contMaxH: cs(cont).maxHeight,
    contOverflowY: cs(cont).overflowY,
    headerPos: cs(header).position,
    headerZ: cs(header).zIndex,
    headerLabelFs: cs(header.querySelector('[style*="left"]')).fontSize,
  };
});
log('facility-geom', geom);
check('ヘッダーの操作群（日付入力・日付ナビ・本日・新規予約）の高さが 2.4rem(42px) で揃い、文字サイズも 1.02rem(17.85px) に統一、時間ラベルも同じサイズ',
  geom.dateH === 42 && geom.prevH === 42 && geom.todayH === 42 && geom.createH === 42
  && geom.dateFs === '17.85px' && geom.dateIconFs === '17.85px' && geom.todayFs === '17.85px' && geom.createFs === '17.85px'
  && geom.headerLabelFs === '17.5px' && geom.hintEl === '17.5px', geom);
check('タイムラインの枠は縦スクロール主体（overflow-y auto・max-height 65vh = 585px）で、時間ヘッダー行は sticky（本文バンドより上層 z-50）',
  geom.contOverflowY === 'auto' && geom.contMaxH === '585px'
  && geom.headerPos === 'sticky' && geom.headerZ === '50',
  { contMaxH: geom.contMaxH, contOverflowY: geom.contOverflowY, headerPos: geom.headerPos, headerZ: geom.headerZ });

// テーマごとに時間ラベル（text-soft）とヘッダーテキストのコントラストを確認
for (const theme of THEMES) {
  await page.evaluate(async (t) => { const m = await import('/js/theme.js'); m.applyTheme(t); }, theme);
  await sleep(450);
  const c = await page.evaluate(() => {
    const cs = (el) => getComputedStyle(el);
    const rgb = (s) => {
      const n = (s.match(/[\d.]+/g) || []).map(Number);
      if (s.startsWith('color(srgb')) return [n[0] * 255, n[1] * 255, n[2] * 255];
      if (s.startsWith('color(oklch')) { /* oklch は canvas 経由で sRGB 化 */
        const c = document.createElement('canvas').getContext('2d');
        c.fillStyle = s; const hex = c.fillStyle;
        return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
      }
      return n.slice(0, 3);
    };
    const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = (s) => { const [r, g, b] = rgb(s); return lin(r) * 0.2126 + lin(g) * 0.7152 + lin(b) * 0.0722; };
    const ratio = (a, b) => { const la = L(a), lb = L(b); const hi = Math.max(la, lb), lo = Math.min(la, lb); return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100; };
    const header = document.getElementById('facility-time-header');
    const label = header.querySelector('[style*="left"]');
    const hint = document.querySelector('#view-facility .card span.text-muted');
    const title = document.querySelector('#view-facility h2');
    const cardBg = cs(document.querySelector('#view-facility .card')).backgroundColor;
    const stripBg = cs(title.closest('div')).backgroundColor;
    return {
      timeLabel: ratio(cs(label).color, cs(header).backgroundColor),
      hint: ratio(cs(hint).color, cardBg),
      titleOnStrip: ratio(cs(title).color, stripBg),
    };
  });
  const ok = c.timeLabel >= 4.5 && c.hint >= 4.5 && c.titleOnStrip >= 4.5;
  log(`contrast:${theme}`, c);
  check(`${theme} では時間ラベル・ヘッダーテキストがコントラスト AA (4.5:1)`, ok, c);
}

// キーボード（枠にフォーカスして矢印キー）でも縦スクロールできる
await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  c.scrollTop = 0;
  c.focus();
});
await page.keyboard.press('ArrowDown');
await page.keyboard.press('ArrowDown');
await sleep(200);
const kbScroll = await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  const header = document.getElementById('facility-time-header');
  return {
    scrollTop: Math.round(c.scrollTop),
    focused: document.activeElement === c,
    outlineW: getComputedStyle(c).outlineWidth,
    headerTopDelta: Math.round(header.getBoundingClientRect().top - c.getBoundingClientRect().top),
  };
});
log('keyboard-scroll', kbScroll);
check('枠にフォーカスして矢印キーで縦スクロールでき、焦点リングが表示され、ヘッダー行は固定のまま',
  kbScroll.focused === true && kbScroll.scrollTop > 0 && parseFloat(kbScroll.outlineW) >= 1
  && kbScroll.headerTopDelta >= 0 && kbScroll.headerTopDelta <= 3, kbScroll);

// 縦スクロール状態でヘッダー行が固定されているスクリーンショット（cb-teal・狭幅）
await page.evaluate(async () => { const m = await import('/js/theme.js'); m.applyTheme('cb-teal'); });
await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  c.style.maxHeight = '240px';
  c.scrollTop = 180;
});
await sleep(450);
await page.screenshot({ path: `${import.meta.dirname}/output/facility-header-sticky.png` });

await browser.close();
if (failures.length) { console.log(`\n${failures.length} FAILURES`); process.exit(1); }
console.log('ALL PASSED');
