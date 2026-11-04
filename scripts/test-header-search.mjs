/**
 * ヘッダー横断検索欄と左端アイコンの重なり検査
 *
 * 経緯: readability.css の .input-field padding shorthand (!important) が Tailwind の pl-8/pl-9 を
 *       0.9rem (14.4px) へ潰し、absolute 配置の search アイコン (右端 24〜28px) と
 *       プレースホルダ文字が重なっていた。左パディングを 2.5rem (40px) へ回復して文字を右へずらす。
 *
 * 検証項目:
 *  1. ヘッダー検索欄 #global-search: プレースホルダ開始位置がアイコン右端より 6px 以上右（重ならない）、
 *     プレースホルダ全体が入力欄の content box 内に収まる、アイコンは上下中央、欄幅 256px (w-64) を維持
 *  2. 掲示検索 #bulletin-search-input と座席表検索 #seating-search-input も同じ重なり検査
 *     （座席表検索はプレースホルダが長く意図的に切り詰められるため、収まりは掲示のみ検査）
 *  3. ヘッダーのスローショット (scripts/output/header-search.png)
 * 実行: node scripts/test-header-search.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 * 出力: scripts/output/header-search.png
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const OUT_DIR = `${import.meta.dirname}/output`;
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

await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

// 検索欄（左端アイコン + プレースホルダ）の実測値を採る
// lucide は <i data-lucide> を <svg> に置換するため、アイコンは wrapper 内の svg から探す。
// テキスト幅は flex 親の影響を排して absolute 配置の span で測る。
const probeSearch = (sel) => page.evaluate((selector) => {
  const inp = document.querySelector(selector);
  if (!inp) return null;
  const cs = getComputedStyle(inp);
  const r = inp.getBoundingClientRect();
  const iconEl = inp.parentElement.querySelector('svg.lucide-search')
    || inp.parentElement.querySelector('svg');
  const ir = iconEl ? iconEl.getBoundingClientRect() : null;
  // プレースホルダの描画開始位置 = content box の左端
  const textStart = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  const span = document.createElement('span');
  span.style.cssText = `position:absolute;left:-9999px;top:0;white-space:pre;font-size:${cs.fontSize};font-family:${cs.fontFamily};font-weight:${cs.fontWeight};letter-spacing:${cs.letterSpacing}`;
  span.textContent = inp.placeholder;
  document.body.appendChild(span);
  const textW = span.getBoundingClientRect().width;
  span.remove();
  return {
    placeholder: inp.placeholder,
    paddingLeft: Math.round(parseFloat(cs.paddingLeft)),
    textStart: Math.round(textStart),
    iconRight: ir ? Math.round(ir.right) : null,
    iconCenterY: ir ? Math.round((ir.top + ir.bottom) / 2) : null,
    inputCenterY: Math.round((r.top + r.bottom) / 2),
    gap: ir ? Math.round(textStart - ir.right) : null,
    textW: Math.round(textW),
    contentRight: Math.round(r.left + r.width - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight)),
    inputW: Math.round(r.width),
    containerW: Math.round(inp.parentElement.getBoundingClientRect().width),
  };
}, sel);

const header = await probeSearch('#global-search');
log('header-search', header);

// 掲示検索・座席表検索も同じ構造（モジュール初期化で生成されるためタブを開く）
await page.evaluate(() => document.querySelector('a[data-tab="bulletin"]').click());
await sleep(1200);
const bulletin = await probeSearch('#bulletin-search-input');
log('bulletin-search', bulletin);

await page.evaluate(() => document.querySelector('a[data-tab="seating"]').click());
await sleep(1400);
const seating = await probeSearch('#seating-search-input');
log('seating-search', seating);

// --- 検査 ---
check('ヘッダー検索欄の左パディングがアイコン分回復（40px = 2.5rem）',
  header && header.paddingLeft >= 39, { paddingLeft: header?.paddingLeft });
check('ヘッダー検索欄のプレースホルダがアイコンと重ならない（文字開始はアイコン右端の 6px 以上右）',
  header && header.iconRight !== null && header.gap >= 6,
  { gap: header?.gap, iconRight: header?.iconRight, textStart: header?.textStart });
check('ヘッダー検索欄のプレースホルダ全体が入力欄内に収まる',
  header && header.textStart + header.textW <= header.contentRight + 1,
  { textStart: header?.textStart, textW: header?.textW, contentRight: header?.contentRight });
check('ヘッダー検索欄のアイコンは上下中央（入力の中心と 2px 以内）',
  header && Math.abs(header.iconCenterY - header.inputCenterY) <= 2,
  { iconCenterY: header?.iconCenterY, inputCenterY: header?.inputCenterY });
check('ヘッダー検索欄の幅は w-64 の容器を埋める（250px 以上）',
  header && header.inputW === header.containerW && header.inputW >= 250,
  { inputW: header?.inputW, containerW: header?.containerW });

check('掲示検索欄もプレースホルダがアイコンと重ならない（6px 以上右）',
  bulletin && bulletin.gap >= 6 && bulletin.paddingLeft >= 39,
  { gap: bulletin?.gap, paddingLeft: bulletin?.paddingLeft, iconRight: bulletin?.iconRight });
check('掲示検索欄のプレースホルダ全体が入力欄内に収まる',
  bulletin && bulletin.textStart + bulletin.textW <= bulletin.contentRight + 1,
  { textStart: bulletin?.textStart, textW: bulletin?.textW, contentRight: bulletin?.contentRight });

// 座席表検索欄はプレースホルダが長く意図的に切り詰められるため、重なり（余白）のみ検査
check('座席表検索欄もプレースホルダがアイコンと重ならない（6px 以上右）',
  seating && seating.gap >= 6 && seating.paddingLeft >= 39,
  { gap: seating?.gap, paddingLeft: seating?.paddingLeft, iconRight: seating?.iconRight });

// ヘッダースローショット
const headerEl = await page.$('header.app-header');
await headerEl.screenshot({ path: `${OUT_DIR}/header-search.png` });

await browser.close();

if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('ALL PASSED');
