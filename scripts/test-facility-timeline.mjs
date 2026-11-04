/**
 * 施設・備品予約タイムラインのグリッド整合監査（8:00〜18:00 の連続タイムライン）
 *
 * 目的: 時間ラベル（08:00〜17:00）の区切りと本文セルの縦ラインが 1px のズレも無く
 *       一致することを、実ブラウザで 2 幅（1280px と 720px＝min-w-[880px] で水平スクロール）を検証。
 * 経緯: ヘッダー行の border-b + border-divider は readability.css R2 が 4 面を 2px に復元するため
 *       左 2px・右 2px の枠線が付いてトラックが右へ 2px ずれ、幅も 4px 狭くなった（区切りがズレた）。
 *       グリッド線も border-l + border-divider で 4 面復元され 4px 幅の太い線になった。
 * 実装: ヘッダーのグリッド線は本文行と共用 (gridLinesHtml)、ラベルは absolute で同一 % 位置、
 *       下区切り線は #facility-time-header の下面のみ、グリッド線は .grid-line-v（左辺 2px のみ）。
 *
 * 実行: node scripts/test-facility-timeline.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 * 出力: scripts/output/timeline-alignment.png
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

await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);
await page.evaluate(() => document.querySelector('a[data-tab="facility"]').click());
await sleep(1800);

// 広幅（1280px = 実容器 944px）で最初に測り、その後に狭幅（720px = min-w-[880px]）で再測する
await page.setViewport({ width: 1280, height: 900 });
await sleep(400);

const measure = () => page.evaluate(() => {
  const wrap = document.querySelector('.timeline-scroll-container > div');
  const abs = (el) => Math.round(el.getBoundingClientRect().left);
  const cs = (el) => getComputedStyle(el);
  const header = document.getElementById('facility-time-header');
  const hTrack = header.querySelector('.flex-1.relative');
  const hLines = [...hTrack.querySelectorAll('.grid-line-v')];
  const hLabels = [...hTrack.querySelectorAll('[style*="left"]')].filter((d) => d.textContent.trim());
  const row = document.querySelector('#facility-matrix-body > [data-facility-row]');
  const rTrack = row.querySelector('.flex-1.relative');
  const rLines = [...rTrack.querySelectorAll('.grid-line-v')];
  const labelLefts = hLabels.map((d) => abs(d) - abs(wrap));
  const labelRightEdges = hLabels.map((d) => abs(d) + Math.round(d.getBoundingClientRect().width) - abs(wrap));
  // 表の外枠（.timeline-scroll-container）の4面の枠線と横スクロール量
  const frameEl = wrap.parentElement; // .timeline-scroll-container
  const fcs = cs(frameEl);
  const probe = document.createElement('div');
  probe.className = 'border border-main';
  document.body.appendChild(probe);
  const probeColor = getComputedStyle(probe).borderTopColor;
  probe.remove();
  return {
    frameBorders: { t: fcs.borderTopWidth, r: fcs.borderRightWidth, b: fcs.borderBottomWidth, l: fcs.borderLeftWidth },
    frameStyle: fcs.borderTopStyle,
    frameColor: fcs.borderTopColor,
    probeColor,
    frameRadius: fcs.borderTopLeftRadius,
    frameBg: fcs.backgroundColor,
    framePadBottom: fcs.paddingBottom,
    hScrollMax: Math.round(frameEl.scrollWidth - frameEl.clientWidth),
    scrollLeft: Math.round(frameEl.scrollLeft),
    wrapWidth: Math.round(wrap.getBoundingClientRect().width),
    headerLabelW: Math.round(header.querySelector('.w-40').getBoundingClientRect().width),
    rowLabelW: Math.round(row.querySelector('.w-40').getBoundingClientRect().width),
    headerTrackLeft: abs(hTrack) - abs(wrap),
    rowTrackLeft: abs(rTrack) - abs(wrap),
    headerTrackW: Math.round(hTrack.getBoundingClientRect().width),
    rowTrackW: Math.round(rTrack.getBoundingClientRect().width),
    lineDelta: hLines.map((l, i) => abs(l) - abs(rLines[i])),
    labelLineDelta: hLabels.map((d, i) => abs(d) - abs(rLines[i])),
    labelCount: hLabels.length,
    labelTexts: hLabels.map((d) => d.textContent.trim()),
    gridLineWidthHeader: Math.round(hLines[0].getBoundingClientRect().width),
    gridLineWidthRow: Math.round(rLines[0].getBoundingClientRect().width),
    headerRowBorders: { l: cs(header).borderLeftWidth, r: cs(header).borderRightWidth, b: cs(header).borderBottomWidth },
    labelGaps: labelRightEdges.slice(0, -1).map((r, i) => labelLefts[i + 1] - r),
    lastLabelInsideTrack: labelRightEdges[labelRightEdges.length - 1] <= abs(rTrack) - abs(wrap) + Math.round(rTrack.getBoundingClientRect().width),
  };
});

const wide = await measure();
log('timeline@1280', {
  headerTrackLeft: wide.headerTrackLeft, rowTrackLeft: wide.rowTrackLeft,
  headerTrackW: wide.headerTrackW, rowTrackW: wide.rowTrackW,
  lineDelta: wide.lineDelta, labelLineDelta: wide.labelLineDelta,
  labelTexts: wide.labelTexts, gridLineWidthHeader: wide.gridLineWidthHeader,
  gridLineWidthRow: wide.gridLineWidthRow, headerRowBorders: wide.headerRowBorders, labelGaps: wide.labelGaps,
  frameBorders: wide.frameBorders, frameStyle: wide.frameStyle, frameColor: wide.frameColor,
  frameRadius: wide.frameRadius, hScrollMax: wide.hScrollMax,
});

check('ラベル列の幅がヘッダーと本文行で一致（トラック左端が揃う）', wide.headerLabelW === wide.rowLabelW,
  { headerLabelW: wide.headerLabelW, rowLabelW: wide.rowLabelW });
check('ヘッダーと本文のトラック左端・幅が一致',
  wide.headerTrackLeft === wide.rowTrackLeft && wide.headerTrackW === wide.rowTrackW,
  { headerTrackLeft: wide.headerTrackLeft, rowTrackLeft: wide.rowTrackLeft,
    headerTrackW: wide.headerTrackW, rowTrackW: wide.rowTrackW });
check('ヘッダーのグリッド線は本文セルの縦ラインと 1px のズレも無い（11本）',
  wide.lineDelta.every((d) => Math.abs(d) <= 1), { lineDelta: wide.lineDelta });
check('時間ラベル（08:00〜17:00）は本文の縦ラインと同じ位置（10 ラベル）',
  wide.labelCount === 10 && wide.labelLineDelta.every((d) => Math.abs(d) <= 1)
    && wide.labelTexts[0] === '08:00' && wide.labelTexts[9] === '17:00',
  { labelCount: wide.labelCount, labelTexts: wide.labelTexts, labelLineDelta: wide.labelLineDelta });
check('グリッド線は左辺 2px のみ（ヘッダー・本文とも 2px 幅の細い線）',
  wide.gridLineWidthHeader === 2 && wide.gridLineWidthRow === 2,
  { gridLineWidthHeader: wide.gridLineWidthHeader, gridLineWidthRow: wide.gridLineWidthRow });
check('ヘッダー行の枠線は下面のみ（左・右 0px = R2 の 4面復元でトラックがズレない）',
  wide.headerRowBorders.l === '0px' && wide.headerRowBorders.r === '0px' && parseFloat(wide.headerRowBorders.b) >= 2,
  { headerRowBorders: wide.headerRowBorders });
check('隣接する時間ラベルが重なっていない（右端と次ラベル左端の余白が 1px 以上）',
  wide.labelGaps.every((g) => g >= 1), { labelGaps: wide.labelGaps });

const num = (v) => parseFloat(v) || 0;
check('表の外枠が4面とも 2px solid・border-main 色（スクロールバーは枠内の下部余白に収まる）',
  num(wide.frameBorders.t) >= 2 && num(wide.frameBorders.r) >= 2
  && num(wide.frameBorders.b) >= 2 && num(wide.frameBorders.l) >= 2
  && wide.frameStyle === 'solid' && wide.frameColor === wide.probeColor && num(wide.framePadBottom) >= 4,
  { frameBorders: wide.frameBorders, frameStyle: wide.frameStyle, frameColor: wide.frameColor,
    probeColor: wide.probeColor, framePadBottom: wide.framePadBottom });


// 狭幅（min-w-[880px] で水平スクロールする幅）でも同じ % 位置であることを検証
await page.setViewport({ width: 720, height: 900 });
await sleep(500);
const narrow = await measure();
log('timeline@720', {
  wrapWidth: narrow.wrapWidth, headerTrackLeft: narrow.headerTrackLeft, rowTrackLeft: narrow.rowTrackLeft,
  headerTrackW: narrow.headerTrackW, rowTrackW: narrow.rowTrackW,
  lineDelta: narrow.lineDelta, labelLineDelta: narrow.labelLineDelta, labelGaps: narrow.labelGaps,
});
check('狭幅（720px 表示＝min-w-[880px] スクロール）でもラベルと縦ラインは 1px のズレも無い',
  narrow.wrapWidth === 880 && narrow.headerTrackLeft === narrow.rowTrackLeft
    && narrow.headerTrackW === narrow.rowTrackW
    && narrow.lineDelta.every((d) => Math.abs(d) <= 1)
    && narrow.labelLineDelta.every((d) => Math.abs(d) <= 1),
  { wrapWidth: narrow.wrapWidth, headerTrackLeft: narrow.headerTrackLeft, rowTrackLeft: narrow.rowTrackLeft,
    headerTrackW: narrow.headerTrackW, rowTrackW: narrow.rowTrackW,
    lineDelta: narrow.lineDelta, labelLineDelta: narrow.labelLineDelta });
check('狭幅でもラベルが重ならず、17:00 ラベルがトラック内に収まる',
  narrow.labelGaps.every((g) => g >= 1) && narrow.lastLabelInsideTrack,
  { labelGaps: narrow.labelGaps, lastLabelInsideTrack: narrow.lastLabelInsideTrack });

// --- ホイールでの横スクロール検証（カーソルが表上にある間はホイールで左右にスクロール） ---
// document のバブリングで記録するため、モジュールのホイールハンドラ後の defaultPrevented を観察できる
await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  c.scrollLeft = 0;
  window.__wheelLog = [];
  document.addEventListener('wheel', (e) => {
    window.__wheelLog.push({
      prevented: e.defaultPrevented,
      deltaY: Math.round(e.deltaY),
      inTable: c.contains(e.target),
    });
  });
});
const tablePoint = await page.evaluate(() => {
  const r = document.querySelector('.timeline-scroll-container').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.65) };
});
await page.mouse.move(tablePoint.x, tablePoint.y);
await page.mouse.wheel({ deltaY: 240 });
await sleep(250);
const wheelIn = await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  return {
    scrollLeft: Math.round(c.scrollLeft),
    maxScroll: Math.round(c.scrollWidth - c.clientWidth),
    bound: c.dataset.wheelHorizontalBound,
    last: window.__wheelLog[window.__wheelLog.length - 1],
  };
});
log('wheel@720(表上)', wheelIn);
check('狭幅では横スクロールバーが存在し、表上でホイールするとバーが動く（ホイールは横向きに消費）',
  wheelIn.maxScroll > 0 && wheelIn.bound === '1' && wheelIn.scrollLeft > 0
  && wheelIn.last.inTable === true && wheelIn.last.prevented === true,
  { scrollLeft: wheelIn.scrollLeft, maxScroll: wheelIn.maxScroll, bound: wheelIn.bound, last: wheelIn.last });

// 右端に到達した後のホイールは消費せず、ページ縦スクロールへ渡す
await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  c.scrollLeft = c.scrollWidth - c.clientWidth;
});
await page.mouse.move(tablePoint.x, tablePoint.y);
await page.mouse.wheel({ deltaY: 120 });
await sleep(200);
const wheelEdge = await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  return {
    scrollLeft: Math.round(c.scrollLeft),
    maxScroll: Math.round(c.scrollWidth - c.clientWidth),
    last: window.__wheelLog[window.__wheelLog.length - 1],
  };
});
log('wheel@720(右端)', wheelEdge);
check('右端でホイールを続けると枠位置は最大を維持し、ホイールは消費されない（ページ縦スクロールへ渡る）',
  wheelEdge.scrollLeft === wheelEdge.maxScroll && wheelEdge.last.inTable === true
  && wheelEdge.last.prevented === false,
  { scrollLeft: wheelEdge.scrollLeft, maxScroll: wheelEdge.maxScroll, last: wheelEdge.last });

// 表にカーソルが無い場所のホイールは表を動かさない
await page.evaluate(() => { document.querySelector('.timeline-scroll-container').scrollLeft = 0; });
const outsidePoint = await page.evaluate(() => {
  const r = document.querySelector('.timeline-scroll-container').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top - 40) };
});
await page.mouse.move(outsidePoint.x, outsidePoint.y);
await page.mouse.wheel({ deltaY: 200 });
await sleep(200);
const wheelOut = await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  return {
    scrollLeft: Math.round(c.scrollLeft),
    last: window.__wheelLog[window.__wheelLog.length - 1],
  };
});
log('wheel@720(表外)', wheelOut);
check('表にカーソルが無い場所のホイールは表を動かさない（scrollLeft 0 のまま・表側でホイールを消費しない）',
  wheelOut.scrollLeft === 0 && wheelOut.last.inTable === false && wheelOut.last.prevented === false,
  { scrollLeft: wheelOut.scrollLeft, last: wheelOut.last });

// 狭幅（横スクロールバーが枠内の下部に描画される）スクリーンショット
await sleep(300);
const shotNarrow = await page.$('.timeline-scroll-container');
await shotNarrow.screenshot({ path: `${OUT_DIR}/timeline-narrow-frame.png` });

// 広幅（内容が収まり横スクロールが不要）では表上ホイールでもホイールをconsumptionしない
await page.setViewport({ width: 1280, height: 900 });
await sleep(400);
await page.evaluate(() => { document.querySelector('.timeline-scroll-container').scrollLeft = 0; });
const widePoint = await page.evaluate(() => {
  const r = document.querySelector('.timeline-scroll-container').getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height * 0.65) };
});
await page.mouse.move(widePoint.x, widePoint.y);
await page.mouse.wheel({ deltaY: 200 });
await sleep(200);
const wheelWide = await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  return {
    scrollLeft: Math.round(c.scrollLeft),
    maxScroll: Math.round(c.scrollWidth - c.clientWidth),
    last: window.__wheelLog[window.__wheelLog.length - 1],
  };
});
log('wheel@1280(表上)', wheelWide);
// 広幅では 18:00 右端境界線分の 2px だけ擬似 overflow する（実質スクロール不要）ため、ホイールは横向きにconsumptionしない
check('広幅（内容が収まる）では表上ホイールでもホイールをconsumptionしない（ページ縦スクロールが通る）',
  wheelWide.maxScroll <= 4 && wheelWide.scrollLeft === 0 && wheelWide.last.inTable === true
  && wheelWide.last.prevented === false,
  { maxScroll: wheelWide.maxScroll, scrollLeft: wheelWide.scrollLeft, last: wheelWide.last });

// 実ブラウザのスクリーンショット（1280px）を記録
await page.setViewport({ width: 1280, height: 900 });
await sleep(400);
const shot = await page.$('.timeline-scroll-container');
await shot.screenshot({ path: `${OUT_DIR}/timeline-alignment.png` });

await browser.close();

if (failures.length > 0) {
  console.log(`\n${failures.length} FAILURES`);
  process.exit(1);
}
console.log('ALL PASSED');

