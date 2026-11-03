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
  return {
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

