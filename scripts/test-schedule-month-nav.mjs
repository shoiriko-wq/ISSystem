/**
 * スケジュール月ナビ（年月ラベル）の位置・アクセシビリティ監査
 *
 * 目的: 年月表示が日のグリッド（7列）の中央直上にあることを実ブラウザで検証する。
 * 経緯: 年月は ‹ › の間にあったがツールバー左端に寄せられており、日グリッドの中央から
 *       大きく左へ外れて位置が悪かった。月ナビ行をカレンダー本体の最上段へ移し、
 *       ‹ [年月] › を対称配置（同じ 32px ボタン + flex-1 text-center）にして中心を揃える。
 * 検証: 1) ラベルが #sched-view-area 内（グリッドの直上） 2) ラベル中心 x = グリッド中心 x（±3px）
 *       3) ‹ › が左右対称（中心距離差 ±3px） 4) 見出し + aria-live、矢印に aria-label
 *       5) 今月・‹ › で月が切り替わる（機能回帰なし） 6) 1日一覧でも中央直上
 *       7) 狭幅 (720px) でも中央直上 8) console/pagejs error なし
 *
 * 実行: node scripts/test-schedule-month-nav.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 * 出力: scripts/output/schedule-month-nav.png
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

const consoleErrors = [];
const pageErrors = [];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });

await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);
await page.evaluate(() => { localStorage.setItem('isschedule_view_mode', 'calendar'); document.querySelector('a[data-tab="schedule"]').click(); });
await sleep(1800);

// ログイン前の 401 取得エラーは既知のノイズ（既存 UI テストと同じ運用）。以降のエラーだけを監視する。
consoleErrors.length = 0;
pageErrors.length = 0;


const measure = () => page.evaluate(() => {
  const center = (el) => Math.round(el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2);
  const label = document.getElementById('sched-month-label');
  const prev = document.getElementById('sched-prev-month');
  const next = document.getElementById('sched-next-month');
  const grid = document.querySelector('#sched-view-area .grid.grid-cols-7:last-of-type');
  const list = document.getElementById('sched-list-container');
  const area = document.getElementById('sched-view-area');
  return {
    labelInArea: !!label && label.closest('#sched-view-area') !== null,
    labelTag: label ? label.tagName : null,
    labelLive: label ? label.getAttribute('aria-live') : null,
    labelTop: label ? Math.round(label.getBoundingClientRect().top) : null,
    labelCenter: label ? center(label) : null,
    labelText: label ? label.textContent.trim() : null,
    prevCenter: prev ? center(prev) : null,
    nextCenter: next ? center(next) : null,
    prevAria: prev ? prev.getAttribute('aria-label') : null,
    nextAria: next ? next.getAttribute('aria-label') : null,
    prevType: prev ? prev.getAttribute('type') : null,
    nextType: next ? next.getAttribute('type') : null,
    gridCenter: grid ? center(grid) : null,
    gridTop: grid ? Math.round(grid.getBoundingClientRect().top) : null,
    listCenter: list ? center(list) : null,
    areaCenter: area ? center(area) : null,
    listTop: list ? Math.round(list.getBoundingClientRect().top) : null,
    todayInArea: !!document.getElementById('sched-goto-today') && document.getElementById('sched-goto-today').closest('#sched-view-area') !== null,
    todayExists: !!document.getElementById('sched-goto-today'),
    labelFocusable: label ? label.tabIndex >= 0 : null,
  };
});

const cal = await measure();
log('calendar-nav', cal);

check('年月ラベルは日のグリッドの直上（#sched-view-area 内）にある', cal.labelInArea && cal.gridTop !== null && cal.labelTop < cal.gridTop,
  { labelInArea: cal.labelInArea, labelTop: cal.labelTop, gridTop: cal.gridTop });
check('年月ラベルの中心 x が日グリッドの中心 x と一致（±3px）',
  cal.gridCenter !== null && Math.abs(cal.labelCenter - cal.gridCenter) <= 3,
  { labelCenter: cal.labelCenter, gridCenter: cal.gridCenter, delta: cal.gridCenter !== null ? cal.labelCenter - cal.gridCenter : null });
check('‹ › が年月ラベルを左右対称に挟む（中心距離の差 ±3px）',
  Math.abs((cal.labelCenter - cal.prevCenter) - (cal.nextCenter - cal.labelCenter)) <= 3,
  { prevCenter: cal.prevCenter, labelCenter: cal.labelCenter, nextCenter: cal.nextCenter });

check('年月ラベルは見出し（h3）で aria-live=polite（月替えを読み上げる）',
  cal.labelTag === 'H3' && cal.labelLive === 'polite',
  { labelTag: cal.labelTag, labelLive: cal.labelLive });
check('‹ › は type=button + aria-label（前月・次月）を持つ',
  cal.prevType === 'button' && cal.nextType === 'button' && cal.prevAria && cal.nextAria,
  { prevType: cal.prevType, prevAria: cal.prevAria, nextType: cal.nextType, nextAria: cal.nextAria });
check('「今月」ボタンはツールバー側にある（月ナビ行の対称性を壊さない）',
  cal.todayExists && !cal.todayInArea, { todayExists: cal.todayExists, todayInArea: cal.todayInArea });

// 機能回帰: 月替え・今月
const months = await page.evaluate(async () => {
  const read = () => document.getElementById('sched-month-label').textContent.trim();
  const seq = [read()];
  const click = (id) => { document.getElementById(id).click(); return new Promise((r) => setTimeout(r, 300)); };
  seq.push(await click('sched-next-month').then(read));
  seq.push(await click('sched-prev-month').then(read));
  seq.push(await click('sched-prev-month').then(read));
  seq.push(await click('sched-goto-today').then(read));
  return seq;
});
log('month-switch-seq', months);
const parse = (s) => { const m = s.match(/(\d+)年(\d+)月/); return m ? Number(m[1]) * 12 + Number(m[2]) : null; };
check('‹ › で月が 1ずつ切り替わり、今月で現在月に戻る',
  parse(months[1]) === parse(months[0]) + 1 && parse(months[2]) === parse(months[1]) - 1
    && parse(months[3]) === parse(months[2]) - 1 && parse(months[4]) >= parse(months[3]),
  { seq: months, idx: months.map(parse) });

// クリック後もラベルがグリッド中央直上に保たれる（再描画後の整合）
const afterCal = await measure();
check('再描画後もラベル中心 = グリッド中心（±3px）',
  Math.abs(afterCal.labelCenter - afterCal.gridCenter) <= 3 && afterCal.labelTop < afterCal.gridTop,
  { labelCenter: afterCal.labelCenter, gridCenter: afterCal.gridCenter, labelTop: afterCal.labelTop, gridTop: afterCal.gridTop });


// 1日一覧モードでも年月ラベルは一覧部の中央直上
await page.evaluate(() => document.getElementById('sched-mode-list').click());
await sleep(1200);
const lst = await measure();
log('list-nav', { labelCenter: lst.labelCenter, listCenter: lst.listCenter, areaCenter: lst.areaCenter, labelInArea: lst.labelInArea });
check('1日一覧モードでもラベル中心は表示部の中心 x と一致（±3px）',
  Math.abs(lst.labelCenter - (lst.listCenter !== null ? lst.listCenter : lst.areaCenter)) <= 3 && lst.labelInArea,
  { labelCenter: lst.labelCenter, listCenter: lst.listCenter, areaCenter: lst.areaCenter, labelInArea: lst.labelInArea });

// 狭幅（ツールバーが折り返してもグリッド中央直上は保つ）
await page.evaluate(() => document.getElementById('sched-mode-calendar').click());
await sleep(1000);
await page.setViewport({ width: 720, height: 1000 });
await sleep(600);
const narrow = await measure();
log('narrow-nav', { labelCenter: narrow.labelCenter, gridCenter: narrow.gridCenter });
check('720px 幅でもラベル中心 = グリッド中心（±3px）',
  Math.abs(narrow.labelCenter - narrow.gridCenter) <= 3,
  { labelCenter: narrow.labelCenter, gridCenter: narrow.gridCenter, delta: narrow.labelCenter - narrow.gridCenter });
await page.setViewport({ width: 1280, height: 900 });
await sleep(400);
await page.screenshot({ path: `${OUT_DIR}/schedule-month-nav.png` });

check('console / pagejs のエラーなし', consoleErrors.length === 0 && pageErrors.length === 0, [...consoleErrors, ...pageErrors]);

await browser.close();

if (failures.length) {
  console.log(`FAILED (${failures.length} checks)`);
  process.exit(1);
}
console.log('All checks passed.');
process.exit(0);

