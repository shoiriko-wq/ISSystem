/**
 * 職員掲示板の左列（タイトル列表）の幅が画面幅に応じて広がることを px で実測する UI テスト
 *
 * 目的: 左列は 16rem（280px）固定だったため、タイトル文字が約195pxしか使えず、
 *       23文字のタイトル（必要387px）が途中で切れていた。床16rem・画面幅の26%・上限24remへ広げる
 *       （`layouts.css` §7.1 の `flex: 0 1 clamp(16rem, 26vw, 24rem)`）。
 *       右ペインは余り。横スクロールは出さない。モバイル（767px以下）は全幅（変更なし）。
 *
 * 検証項目:
 *  1. ルート font-size と画面幅から期待幅 clamp(16rem, 26vw, 24rem) を計算し、実測が ±2px で一致
 *     （768 / 900 / 1100 / 1280 / 1440 / 1600 / 1900px）
 *  2. 画面幅が広いほど左列は広がる（単調に増える）。1900px は 24rem（420px）で打ち止め
 *  3. 768px は床の 16rem（旧の幅を維持）で、右ペインは300px以上残る
 *  4. 右ペインは余り（分割幅 − 左列 − gap と一致）。1100px以上では左列より右ペインが広い
 *  5. どの画面幅でもページ・右ペインに横スクロールなし（`overflow-x` 実測）
 *  6. 1280px のタイトル文字幅は240px以上（旧195pxより広い）。行は1行・ellipsis・nowrap
 *  7. 極めて長いタイトルを挿入しても左列は期待幅のまま（列が押し広げられない）
 *  8. 左列の枠は 2px 実線1枚・角丸0.8rem・影なし（UI十条1・禁则1/2）
 *  9. モバイル（390px）は左列が全幅（分割幅と一致）・縦 stacking・横スクロールなし
 * 10. 収納サイドバー（67.25px）と左列が重ならない（左列の左端 x ≥ サイドバー右端、main の余白追従）
 * 実行: node scripts/test-bulletin-title-pane-width.mjs  （ISSystem サーバーが必要）
 *  options: UI_BASE=https://127.0.0.1:3443  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 * 出力: /tmp/bulletin-title-pane-1280.png / -1600.png / -768.png / -390.png。NG が1件でも exit code 1
 */
import puppeteer from 'puppeteer-core';

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

/** ログインして掲示板タブを開く（このテストは読み取りだけ。API の書き込みはしない） */
const setup = async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new', ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[page js error] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console error] ${m.text()}`); });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(1000);
  await page.evaluate(() => document.querySelector('a[data-tab="bulletin"]').click());
  await sleep(1200);
  return { browser, page };
};

/** 左列・右ペイン・枠・タイトル文字幅を px で実測する。期待幅はルートの font-size と画面幅から計算する */
const measure = (page) => page.evaluate(() => {
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const vw = window.innerWidth;
  const expected = Math.min(Math.max(16 * fs, 0.26 * vw), 24 * fs);
  const split = document.querySelector('.bulletin-split');
  const pane = document.querySelector('.bulletin-title-pane');
  const list = document.getElementById('bulletin-list-container');
  const detail = document.getElementById('bulletin-detail-pane');
  const mainEl = document.querySelector('main');
  const sidebar = document.querySelector('.app-sidebar');
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const spanW = rows.map((r) => Math.round(r.querySelector('.bulletin-row-title').getBoundingClientRect().width));
  const cs = getComputedStyle(pane);
  return {
    vw, fs, expected,
    paneW: Math.round(pane.getBoundingClientRect().width),
    paneX: Math.round(pane.getBoundingClientRect().x),
    splitW: Math.round(split.getBoundingClientRect().width),
    gap: Math.round(parseFloat(getComputedStyle(split).columnGap || getComputedStyle(split).gap)),
    detailW: Math.round(detail.getBoundingClientRect().width),
    flexDir: getComputedStyle(split).flexDirection,
    pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    paneOverflowX: detail.scrollWidth - detail.clientWidth,
    listOverflowX: list.scrollWidth - list.clientWidth,
    maxTitleSpanW: spanW.length ? Math.max(...spanW) : 0,
    rowH: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : 0,
    ellipsis: rows.length ? getComputedStyle(rows[0].querySelector('.bulletin-row-title')).textOverflow : null,
    nowrap: rows.length ? getComputedStyle(rows[0].querySelector('.bulletin-row-title')).whiteSpace : null,
    borderW: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].map((v) => parseFloat(v)),
    borderStyle: cs.borderTopStyle,
    radius: Math.round(parseFloat(cs.borderRadius)),
    shadow: cs.boxShadow,
    mainPadLeft: Math.round(parseFloat(getComputedStyle(mainEl).paddingLeft)),
    sidebarRight: sidebar ? Math.round(sidebar.getBoundingClientRect().right) : null,
    rowsCount: rows.length,
  };
});

/* ===== 画面幅を7通り変えて左列の幅を px で実測する ===== */
const { browser, page } = await setup();
const widths = [768, 900, 1100, 1280, 1440, 1600, 1900];
const snaps = {};
for (const w of widths) {
  await page.setViewport({ width: w, height: 900 });
  await sleep(350);
  snaps[w] = await measure(page);
  log(`pane@${w}`, snaps[w]);
}

const d = (w) => ({ paneW: snaps[w].paneW, expected: Math.round(snaps[w].expected), detailW: snaps[w].detailW });

check('768pxは床の16rem（旧の280pxを維持）。右ペインは300px以上残る',
  Math.abs(snaps[768].paneW - snaps[768].expected) <= 2 && snaps[768].paneW >= snaps[768].fs * 15.9 && snaps[768].detailW >= 300,
  d(768));
check('900px・1100pxは画面幅の26%で広がる（期待式と±2px。1100pxでは右ペインが左列より広い）',
  Math.abs(snaps[900].paneW - snaps[900].expected) <= 2 && Math.abs(snaps[1100].paneW - snaps[1100].expected) <= 2
  && snaps[1100].paneW > snaps[768].paneW && snaps[1100].detailW > snaps[1100].paneW,
  { g900: d(900), g1100: d(1100) });
check('1280pxは333px（19.0rem = 26vw）。期待式 clamp(16rem, 26vw, 24rem) と±2pxで一致',
  Math.abs(snaps[1280].paneW - snaps[1280].expected) <= 2 && Math.round(snaps[1280].expected) === 333,
  d(1280));
check('1440px（374.4px）と1600px（416px）も期待式と±2pxで一致',
  Math.abs(snaps[1440].paneW - snaps[1440].expected) <= 2 && Math.abs(snaps[1600].paneW - snaps[1600].expected) <= 2
  && Math.round(snaps[1600].expected) === 416,
  { g1440: d(1440), g1600: d(1600) });
check('1900pxは24rem（420px）で打ち止め（これ以上広くならない）',
  Math.abs(snaps[1900].paneW - snaps[1900].fs * 24) <= 2,
  { paneW: snaps[1900].paneW, fs24: Math.round(snaps[1900].fs * 24) });
check('画面幅が広いほど左列の幅は単調に広がる',
  widths.every((w, i, arr) => i === 0 || snaps[w].paneW >= snaps[arr[i - 1]].paneW),
  widths.map((w) => ({ w, paneW: snaps[w].paneW })));
check('右ペインは余り（分割幅 − 左列 − gap と±2pxで一致。gapは0.9rem）',
  widths.every((w) => Math.abs(snaps[w].detailW - (snaps[w].splitW - snaps[w].paneW - snaps[w].gap)) <= 2
    && Math.abs(snaps[w].gap - snaps[w].fs * 0.9) <= 1),
  widths.map((w) => ({ w, splitW: snaps[w].splitW, paneW: snaps[w].paneW, gap: snaps[w].gap, detailW: snaps[w].detailW })));
check('どの画面幅でもページ・右ペイン・左列に横スクロールなし',
  widths.every((w) => snaps[w].pageOverflowX === 0 && snaps[w].paneOverflowX === 0 && snaps[w].listOverflowX === 0),
  widths.map((w) => ({ w, page: snaps[w].pageOverflowX, pane: snaps[w].paneOverflowX, list: snaps[w].listOverflowX })));
check('1280pxのタイトル文字幅は240px以上（16rem固定の旧195pxより広い）',
  snaps[1280].maxTitleSpanW >= 240, { maxTitleSpanW: snaps[1280].maxTitleSpanW });
check('タイトル行は1行（高さと ellipsis と nowrap）',
  snaps[1280].rowH <= 40 && snaps[1280].ellipsis === 'ellipsis' && snaps[1280].nowrap === 'nowrap' && snaps[1280].rowsCount > 0,
  { rowH: snaps[1280].rowH, ellipsis: snaps[1280].ellipsis, nowrap: snaps[1280].nowrap, rows: snaps[1280].rowsCount });

/* ===== 極めて長いタイトルを挿入しても左列は押し広げられない ===== */
const longPane = await page.evaluate(() => {
  const row = document.querySelector('.bulletin-title-row');
  const span = row.querySelector('.bulletin-row-title');
  span.textContent = '極めて長いタイトルです'.repeat(8);
  const fs = parseFloat(getComputedStyle(document.documentElement).fontSize);
  const expected = Math.min(Math.max(16 * fs, 0.26 * window.innerWidth), 24 * fs);
  return {
    paneW: Math.round(document.querySelector('.bulletin-title-pane').getBoundingClientRect().width),
    expected: Math.round(expected),
    truncated: span.scrollWidth > span.clientWidth,
    rowH: Math.round(row.getBoundingClientRect().height),
  };
});
log('long-title-pane', longPane);
check('極めて長いタイトルでも左列は期待幅（clamp）のまま（列が押し広げられない・タイトルは1行で省略）',
  longPane && Math.abs(longPane.paneW - longPane.expected) <= 2 && longPane.truncated === true && longPane.rowH <= 40,
  longPane);

/* ===== 枠は 2px 実線1枚・角丸 0.8rem・影なし（UI十条1・禁则1/2） ===== */
const frame = snaps[1280];
check('左列の枠は2px実線1枚・角丸0.8rem・影なし（影はホバー目的のみで列に影を置かない）',
  frame.borderW.every((v) => v === 2) && frame.borderStyle === 'solid'
  && Math.abs(frame.radius - frame.fs * 0.8) <= 1 && frame.shadow === 'none',
  { borderW: frame.borderW, borderStyle: frame.borderStyle, radius: frame.radius, shadow: frame.shadow });

/* ===== 収納サイドバー（67.25px）と左列が重ならない（main の余白 4.2rem が追従） ===== */
check('収納サイドバー（67.25px）と左列は重ならない（左列の左端 x ≥ サイドバー右端 + 1。main の padding-left 73.5px）',
  frame.sidebarRight !== null && frame.sidebarRight <= 68 && frame.paneX >= frame.sidebarRight + 1 && frame.mainPadLeft >= 73,
  { sidebarRight: frame.sidebarRight, paneX: frame.paneX, mainPadLeft: frame.mainPadLeft });

/* ===== モバイル（390px）は左列が全幅（縦 stacking。clamp は効かない） ===== */
await page.setViewport({ width: 390, height: 844 });
await sleep(350);
const m390 = await measure(page);
log('pane@390', m390);
check('モバイル（390px）は左列が全幅（分割幅と一致）・縦 stacking・横スクロールなし',
  m390.flexDir === 'column' && Math.abs(m390.paneW - m390.splitW) <= 2 && m390.pageOverflowX === 0 && m390.paneOverflowX === 0,
  { flexDir: m390.flexDir, paneW: m390.paneW, splitW: m390.splitW, pageOverflowX: m390.pageOverflowX });

/* ===== スクリーンショット（数値と描画を両方残す。CSS 阅读だけで通したことにしない） ===== */
for (const [w, name] of [[768, 'bulletin-title-pane-768.png'], [1280, 'bulletin-title-pane-1280.png'],
  [1600, 'bulletin-title-pane-1600.png'], [390, 'bulletin-title-pane-390.png']]) {
  await page.setViewport({ width: w, height: w < 768 ? 844 : 900 });
  await sleep(350);
  await page.screenshot({ path: `/tmp/${name}` });
}

console.log(`\n合計 ${failures.length} 件の失敗`);
await browser.close();
process.exit(failures.length ? 1 : 0);

