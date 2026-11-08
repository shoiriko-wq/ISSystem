/**
 * ヘッダー右部（アカウント系）の枠の二重化検査（ダーク系・ツートン逆転テーマ）
 *
 * 経緯: readability.css R2 の border-width shorthand が方向指定クラス (border-l / border-b ...) に
 *       4面分の枠幅を配っていたため、アカウントの「区切り線 (border-l border-main)」を持つ
 *       ラッパーが角丸なしの全周2px枠を描き、内側の #user-menu-btn の角丸枠と二重になった。
 *       ライトテーマでは装飾分離線撤去ルールが .border-l を透明化するため見えず、
 *       ダーク系 / ツートン逆転 (暗×◯◯) でのみ顕在化した。R2 を面単位へ分割して解消する。
 *
 * 検証項目（theme-dark-slate と theme-dc-slate の両方）:
 *  1. header.app-header: 上左右の枠幅 0、下部仕切り線は 2px 以上（全周枠を描かない）
 *  2. アカウントラッパー: 上右下的枠幅 0、左の区切り線のみ 2px（角張った外枠を描かない）
 *  3. #user-menu-btn: 4面すべて 2px の実枠＋角丸 6px 以上（内側の枠は維持）
 *  4. ラッパーの区切り線とアカウントボックス左端の離间隔 8px 以上（線が枠に重ならない）
 *  5. 天気・時計ウィジェット (.header-widget / #weather-widget-btn): 4面 1px 以上の実枠＋角丸 6px 以上
 *  6. サイドバー: 右仕切り 2px 以上（R3 の骨格枠は維持）
 *  7. ライトテーマでは装飾分離線撤去ルールで区切り線が透明（既存の意図を維持）
 *  8. スローショット: scripts/output/header-frames-dark.png, header-frames-inverted.png
 * 実行: node scripts/test-header-frames.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
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
const num = (v) => parseFloat(v) || 0;

// ダーク系（バーも暗色）とツートン逆転（暗内容＋明バー）で枠を測る
const THEMES = [
  { id: 'dark-slate', cls: 'theme-dark-slate', mode: 'dark', chrome: 'light', shot: 'header-frames-dark.png' },
  { id: 'dc-slate', cls: 'theme-dc-slate', mode: 'dark', chrome: 'inverted', shot: 'header-frames-inverted.png' },
];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
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

// 4面の枠幅・角丸・左端位置を採る
const probeBox = (sel) => page.evaluate((selector) => {
  const el = document.querySelector(selector);
  if (!el) return null;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    cls: String(el.className).slice(0, 52),
    top: cs.borderTopWidth, right: cs.borderRightWidth,
    bottom: cs.borderBottomWidth, left: cs.borderLeftWidth,
    leftStyle: cs.borderLeftStyle, leftColor: cs.borderLeftColor,
    radius: cs.borderTopLeftRadius, bg: cs.backgroundColor,
    leftEdge: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height),
  };
}, sel);

// アカウントラッパー（border-l border-main の div）を親から採る
const probeWrap = () => page.evaluate(() => {
  const el = document.querySelector('#user-menu-btn').parentElement;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  return {
    cls: String(el.className).slice(0, 52),
    top: cs.borderTopWidth, right: cs.borderRightWidth,
    bottom: cs.borderBottomWidth, left: cs.borderLeftWidth,
    leftStyle: cs.borderLeftStyle, leftColor: cs.borderLeftColor,
    leftEdge: Math.round(r.left), width: Math.round(r.width),
  };
});


for (const theme of THEMES) {
  await page.evaluate((t) => {
    const el = document.documentElement;
    el.className = t.cls;
    el.setAttribute('data-theme-mode', t.mode);
    el.setAttribute('data-chrome', t.chrome);
  }, theme);
  await sleep(400);

  const header = await probeBox('header.app-header');
  const btn = await probeBox('#user-menu-btn');
  const wrap = await probeWrap();
  const weather = await probeBox('#weather-widget-btn');
  const clock = await probeBox('.header-widget--static');
  const sidebar = await probeBox('.app-sidebar');

  log(`${theme.id} header`, header);
  log(`${theme.id} acctWrap`, wrap);
  log(`${theme.id} userBtn`, btn);

  const tag = theme.id;
  check(`${tag}: ヘッダーは全周枠を描かない（上左右 0px、下部仕切り線は 2px 以上）`,
    header && num(header.top) === 0 && num(header.left) === 0 && num(header.right) === 0 && num(header.bottom) >= 2,
    { top: header?.top, left: header?.left, right: header?.right, bottom: header?.bottom });

  check(`${tag}: アカウントラッパーは左の区切り線のみ（上右下的枠 0px = 角張った外枠なし）`,
    wrap && num(wrap.top) === 0 && num(wrap.right) === 0 && num(wrap.bottom) === 0
      && num(wrap.left) >= 2 && wrap.leftStyle === 'solid',
    { top: wrap?.top, right: wrap?.right, bottom: wrap?.bottom, left: wrap?.left, style: wrap?.leftStyle });

  check(`${tag}: アカウントボックスは 4面 2px の実枠（角丸 6px 以上）`,
    btn && num(btn.top) >= 2 && num(btn.right) >= 2 && num(btn.bottom) >= 2 && num(btn.left) >= 2
      && num(btn.radius) >= 6,
    { top: btn?.top, right: btn?.right, bottom: btn?.bottom, left: btn?.left, radius: btn?.radius });

  // 区切り線とボックス枠が重ならない（二重線にならない）ことを位置で確認
  const lineGap = btn && wrap ? btn.leftEdge - (wrap.leftEdge + num(wrap.left)) : null;
  check(`${tag}: 区切り線とアカウント枠の離间隔 8px 以上（二重線にならない）`,
    lineGap !== null && lineGap >= 8,
    { lineGap, wrapLeftEdge: wrap?.leftEdge, btnLeftEdge: btn?.leftEdge });

  check(`${tag}: 区切り線はダーク系で見える色で描かれる（透明でない）`,
    wrap && wrap.leftColor !== 'rgba(0, 0, 0, 0)' && wrap.leftColor !== 'transparent',
    { leftColor: wrap?.leftColor });

  check(`${tag}: 天気・時計ウィジェット（.header-widget）は 4面 1px 以上の実枠＋角丸 6px 以上`,
    weather && num(weather.top) >= 1 && num(weather.right) >= 1 && num(weather.bottom) >= 1
      && num(weather.left) >= 1 && num(weather.radius) >= 6
      && weather.leftStyle === 'solid'
      && clock && num(clock.top) >= 1 && num(clock.right) >= 1 && num(clock.bottom) >= 1
      && num(clock.left) >= 1 && num(clock.radius) >= 6,
    { weather: { top: weather?.top, right: weather?.right, bottom: weather?.bottom, left: weather?.left, radius: weather?.radius },
      clock: { top: clock?.top, right: clock?.right, bottom: clock?.bottom, left: clock?.left, radius: clock?.radius } });

  check(`${tag}: サイドバーの右仕切り線は 2px 以上（R3 の骨格枠は維持）`,
    sidebar && num(sidebar.right) >= 2, { right: sidebar?.right });

  const headerEl = await page.$('header.app-header');
  await headerEl.screenshot({ path: `${OUT_DIR}/${theme.shot}` });
}

// ライトテーマでは装飾分離線撤去ルールが .border-l を透明化（既存の意図）ことを確認
await page.evaluate(() => {
  document.documentElement.className = 'theme-light-azure';
  document.documentElement.setAttribute('data-theme-mode', 'light');
  document.documentElement.setAttribute('data-chrome', 'light');
});
await sleep(400);
const lightWrap = await probeWrap();
log('light-azure acctWrap', lightWrap);
check('ライトテーマでは区切り線が透明（装飾分離線撤去ルールは維持）',
  lightWrap && (lightWrap.leftColor === 'rgba(0, 0, 0, 0)' || lightWrap.leftColor === 'transparent')
    && num(lightWrap.top) === 0 && num(lightWrap.right) === 0 && num(lightWrap.bottom) === 0,
  { leftColor: lightWrap?.leftColor, top: lightWrap?.top, right: lightWrap?.right, bottom: lightWrap?.bottom });

await browser.close();

if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('ALL PASSED');
