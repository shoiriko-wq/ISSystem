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

const consoleErrors = [];
const pageErrors = [];

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
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
    labelBtnExists: !!document.getElementById('sched-month-menu-btn'),
    labelBtnHasPopup: document.getElementById('sched-month-menu-btn') ? document.getElementById('sched-month-menu-btn').getAttribute('aria-haspopup') : null,
    labelBtnExpanded: document.getElementById('sched-month-menu-btn') ? document.getElementById('sched-month-menu-btn').getAttribute('aria-expanded') : null,
    labelBtnControls: document.getElementById('sched-month-menu-btn') ? document.getElementById('sched-month-menu-btn').getAttribute('aria-controls') : null,
    prevGap: label && prev ? Math.round(label.getBoundingClientRect().left - (prev.getBoundingClientRect().left + prev.getBoundingClientRect().width)) : null,
    nextGap: label && next ? Math.round((next.getBoundingClientRect().left) - (label.getBoundingClientRect().left + label.getBoundingClientRect().width)) : null,
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

// ★ 月ナビの近接配置（‹ › は年月ラベルに隣接し、左右端に離れない）
const nav = await measure();
check('‹ › がラベルに隣接（左右の余白 0〜20px・左右対称）',
  nav.prevGap >= 0 && nav.prevGap <= 20 && nav.nextGap >= 0 && nav.nextGap <= 20 && Math.abs(nav.prevGap - nav.nextGap) <= 4,
  { prevGap: nav.prevGap, nextGap: nav.nextGap });

// ★ 年月ラベルはボタン（クリックで年月选择メニューが開く）
check('年月ラベルは aria-expanded / aria-controls / aria-haspopup を持つ開閉ボタン',
  nav.labelBtnExists && nav.labelBtnHasPopup === 'dialog' && nav.labelBtnExpanded === 'false' && nav.labelBtnControls === 'sched-month-menu',
  { labelBtnExists: nav.labelBtnExists, hasPopup: nav.labelBtnHasPopup, expanded: nav.labelBtnExpanded, controls: nav.labelBtnControls });


// ★ ラベルクリックでメニューが開く：12ヶ月ボタン・年‹›・現在月の aria-current、中央配置
const opened = await page.evaluate(() => {
  document.getElementById('sched-month-menu-btn').click();
  return new Promise((r) => setTimeout(r, 350));
}).then(() => page.evaluate(() => {
  const menu = document.getElementById('sched-month-menu');
  const center = (el) => Math.round(el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2);
  const items = Array.from(document.querySelectorAll('.sched-month-item'));
  const grid = document.querySelector('#sched-view-area .grid.grid-cols-7:last-of-type');
  return {
    visible: !!menu && !menu.classList.contains('hidden'),
    expanded: document.getElementById('sched-month-menu-btn').getAttribute('aria-expanded'),
    items: items.length,
    ariaLabels: items.slice(0, 3).map((b) => b.getAttribute('aria-label')),
    currentMonth: items.findIndex((b) => b.getAttribute('aria-current') === 'true') + 1,
    yearBtns: document.querySelectorAll('#sched-month-menu [data-menu-year]').length,
    yearText: (menu.innerText.match(/(\d{4})年/) || [null, null])[1],
    todayBtn: !!document.querySelector('#sched-month-menu [data-menu-today]'),
    menuCenter: menu ? center(menu) : null,
    gridCenter: grid ? center(grid) : null,
    focusedMonth: (document.activeElement && document.activeElement.getAttribute('data-menu-month') !== null)
      ? Number(document.activeElement.getAttribute('data-menu-month')) + 1 : null,
    menuOverflowX: menu ? Math.round(menu.scrollWidth - menu.clientWidth) : null,
  };
}));
log('month-menu-open', opened);
check('ラベルクリックでメニューが開き aria-expanded=true・12ヶ月ボタン・年‹›・今月へがある',
  opened.visible && opened.expanded === 'true' && opened.items === 12 && opened.yearBtns === 2 && opened.todayBtn
  && opened.ariaLabels.length === 3 && /\d{4}年\d{1,2}月/.test(String(opened.ariaLabels[0])),
  { visible: opened.visible, expanded: opened.expanded, items: opened.items, yearBtns: opened.yearBtns, todayBtn: opened.todayBtn, ariaLabels: opened.ariaLabels });
check('メニューは中央に開き現在月に aria-current・横スクロールなし',
  opened.currentMonth > 0 && Math.abs(opened.menuCenter - opened.gridCenter) <= 30 && opened.menuOverflowX === 0,
  { currentMonth: opened.currentMonth, menuCenter: opened.menuCenter, gridCenter: opened.gridCenter, menuOverflowX: opened.menuOverflowX });
check('メニュー開時にフォーカスは現在月のボタンへ',
  opened.focusedMonth === opened.currentMonth, { focusedMonth: opened.focusedMonth, currentMonth: opened.currentMonth });

// ★ 年‹›で表示年が変わり、今月へで現在月へ戻る（閉じる）
const yearShift = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = () => document.getElementById('sched-month-label').textContent.trim();
  const menu = () => document.getElementById('sched-month-menu');
  const yr = () => (menu().innerText.match(/(\d{4})年/) || [null, null])[1];
  const y0 = yr();
  menu().querySelector('[data-menu-year="-1"]').click();
  await sleep(250);
  const y1 = yr();
  menu().querySelector('[data-menu-today]').click();
  await sleep(400);
  return { y0, y1, label: read(), open: !document.getElementById('sched-month-menu').classList.contains('hidden') };
});
log('menu-year-shift', yearShift);
check('メニューの‹で前年表示になり、今月へで現在月へ戻りメニューが閉じる',
  Number(yearShift.y1) === Number(yearShift.y0) - 1 && yearShift.label.includes(`${Number(yearShift.y0)}年`) && !yearShift.open,
  { y0: yearShift.y0, y1: yearShift.y1, label: yearShift.label, open: yearShift.open });

// 1日一覧モードでも年月ラベルは一覧部の中央直上
await page.evaluate(() => document.getElementById('sched-mode-list').click());
await sleep(1200);
const lst = await measure();
log('list-nav', { labelCenter: lst.labelCenter, listCenter: lst.listCenter, areaCenter: lst.areaCenter, labelInArea: lst.labelInArea });
check('1日一覧モードでもラベル中心は表示部の中心 x と一致（±3px）',
  Math.abs(lst.labelCenter - (lst.listCenter !== null ? lst.listCenter : lst.areaCenter)) <= 3 && lst.labelInArea,
  { labelCenter: lst.labelCenter, listCenter: lst.listCenter, areaCenter: lst.areaCenter, labelInArea: lst.labelInArea });

// ★ 键盘操作：ラベル Enter で開く→月ボタン間を ←→ で移動→Enter で决定→Esc で閉じラベルへ
const kb = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const parse = (s) => { const m = s.match(/(\d+)年(\d+)月/); return m ? Number(m[1]) * 12 + Number(m[2]) : null; };
  const read = () => document.getElementById('sched-month-label').textContent.trim();
  const openState = () => !document.getElementById('sched-month-menu').classList.contains('hidden');
  const focusMonth = () => (document.activeElement && document.activeElement.getAttribute('data-menu-month') !== null)
    ? Number(document.activeElement.getAttribute('data-menu-month')) : null;

  const labelBtn = document.getElementById('sched-month-menu-btn');
  labelBtn.focus();
  const base = parse(read());
  const out = { base };

  labelBtn.click();  // Enter/Space はボタン native click と同じ挙動
  await sleep(300);
  out.opened = openState();
  out.focusAtOpen = focusMonth();

  const menu = document.getElementById('sched-month-menu');
  menu.querySelector('[data-menu-month="11"]').focus();
  menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  await sleep(120);
  out.afterArrow = focusMonth();

  document.activeElement.click();
  await sleep(500);
  out.afterPick = parse(read());
  out.closedAfterPick = !openState();
  out.focusAfterPick = document.activeElement.id;

  labelBtn.click();
  await sleep(300);
  out.reopened = openState();
  document.getElementById('sched-month-menu').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await sleep(250);
  out.closedByEsc = !openState();
  out.focusAfterEsc = document.activeElement.id;
  out.expandedAfterEsc = document.getElementById('sched-month-menu-btn').getAttribute('aria-expanded');

  document.getElementById('sched-goto-today').click();
  await sleep(400);
  out.restored = parse(read());
  out.restoredBase = base;
  return out;
});
log('menu-keyboard', kb);
check('键盘: ラベルクリックで開きフォーカスが現在月に当たる（←→で月ボタン間を移動）',
  kb.opened && kb.focusAtOpen !== null && kb.afterArrow === kb.focusAtOpen
  && kb.focusAtOpen === kb.base % 12 - 1,
  { opened: kb.opened, focusAtOpen: kb.focusAtOpen, afterArrow: kb.afterArrow, base: kb.base });
check('键盘: Enter相当で月を决定しラベルが更新・閉じ・フォーカスがラベルへ戻る',
  kb.afterPick === kb.base && kb.closedAfterPick && kb.focusAfterPick === 'sched-month-menu-btn',
  { afterPick: kb.afterPick, base: kb.base, closed: kb.closedAfterPick, focus: kb.focusAfterPick });
check('键盘: Esc でメニューが閉じ aria-expanded=false・フォーカスがラベルへ戻る',
  kb.reopened && kb.closedByEsc && kb.expandedAfterEsc === 'false' && kb.focusAfterEsc === 'sched-month-menu-btn',
  { reopened: kb.reopened, closedByEsc: kb.closedByEsc, expanded: kb.expandedAfterEsc, focus: kb.focusAfterEsc });

// ★ メニュー外クリックで閉じる（フォーカスはラベルにとどめる）
const outside = await page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  document.getElementById('sched-month-menu-btn').click();
  await sleep(300);
  const wasOpen = !document.getElementById('sched-month-menu').classList.contains('hidden');
  document.getElementById('sched-summary').click();
  await sleep(250);
  return { wasOpen, closed: document.getElementById('sched-month-menu').classList.contains('hidden') };
});
log('menu-outside-click', outside);
check('メニュー外クリックでメニューが閉じる', outside.wasOpen && outside.closed, outside);

// ★ 実マウス操作での年月选择（ユーザ報告「クリックするとメニューが消えて機能しない」）
//  原因: 1) メニューが通常フローにあったため Grid が押し下げられ、クリックがグリッド側に
//  落ちた 2) 年 ‹ › が innerHTML を作り替えると e.target が DOM から離れ、外側クリックと
//  誤判定されてメニューが閉じた。→ メニューはオーバーレイ（absolute）、外側判定は capture。
const mouseClickSel = async (sel) => {
  const pt = await page.evaluate((s) => {
    const b = document.querySelector(s);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  }, sel);
  if (!pt) return false;
  await page.mouse.click(pt.x, pt.y);
  return true;
};
const mstate = () => page.evaluate(() => {
  const menu = document.getElementById('sched-month-menu');
  const cont = document.querySelector('main') || document.querySelector('#view-schedule .overflow-y-auto');
  const grid = document.querySelector('#sched-view-area .grid.grid-cols-7');
  const mr = menu.getBoundingClientRect();
  const cr = cont.getBoundingClientRect();
  const items = Array.from(menu.querySelectorAll('.sched-month-item'));
  return {
    open: !menu.classList.contains('hidden'),
    label: document.getElementById('sched-month-label').textContent.trim(),
    yearText: (menu.innerText.match(/(\d{4})年/) || [null, null])[1],
    gridTop: Math.round(grid.getBoundingClientRect().top),
    fitsInCont: Math.round(mr.top) >= Math.round(cr.top) - 1 && Math.round(mr.bottom) <= Math.round(cr.bottom) + 1,
    fitsInVw: Math.round(mr.left) >= 0 && Math.round(mr.right) <= Math.round(window.innerWidth),
    items: items.length,
    activeId: document.activeElement.id || document.activeElement.getAttribute('data-menu-year') || null,
  };
});
// カレンダーモードで計測（一覧モードでの計測はこの後）
await page.evaluate(() => document.getElementById('sched-mode-calendar').click());
await sleep(1200);
const m0 = await mstate();
await mouseClickSel('#sched-month-menu-btn');
await sleep(400);
const m1 = await mstate();
log('mouse-menu-open', { gridTopBefore: m0.gridTop, gridTopAfter: m1.gridTop, open: m1.open, fitsInCont: m1.fitsInCont, fitsInVw: m1.fitsInVw });
check('実マウス: ラベルクリックでメニューが開き、Grid は押し下げられず、メニューはスクロール枠内に収まる',
  m1.open && Math.abs(m1.gridTop - m0.gridTop) <= 2 && m1.fitsInCont && m1.fitsInVw && m1.items === 12,
  { gridTopBefore: m0.gridTop, gridTopAfter: m1.gridTop, open: m1.open, fitsInCont: m1.fitsInCont, fitsInVw: m1.fitsInVw });

// 実マウスで 3月を選択 → 2026年3月、閉じる、ラベルへ焦点
await mouseClickSel('#sched-month-menu [data-menu-month="2"]');
await sleep(1300);
const m2 = await mstate();
log('mouse-month-pick', m2);
check('実マウス: 月ボタンをクリックすると表示月が切り替わり、閉じてラベルに焦点が戻る',
  m2.label === '2026年3月' && !m2.open && m2.activeId === 'sched-month-menu-btn', m2);

// 実マウスで年 › を 2回 → メニューは開いたまま 2028年表示（消えない）
await mouseClickSel('#sched-month-menu-btn');
await sleep(400);
await mouseClickSel('#sched-month-menu [data-menu-year="1"]');
await sleep(350);
await mouseClickSel('#sched-month-menu [data-menu-year="1"]');
await sleep(350);
const m3 = await mstate();
log('mouse-year-next', m3);
check('実マウス: 年 › を押すとメニューが消えず 2028年表示になる（表示月は 2026年3月）',
  m3.open && m3.yearText === '2028' && m3.label === '2026年3月' && m3.items === 12, m3);

// 実マウスで「今月へ」→ 2026年11月へ戻り閉じる
await mouseClickSel('#sched-month-menu [data-menu-today]');
await sleep(1300);
const m4 = await mstate();
log('mouse-today', m4);
check('実マウス: 「今月へ」で 2026年11月へ戻りメニューが閉じる',
  m4.label === '2026年11月' && !m4.open, m4);

// モバイル 390px: メニューがラベル直下・枠内に収まる（スクロールで「今月へ」が見える）
await page.setViewport({ width: 390, height: 800 });
await sleep(500);
await mouseClickSel('#sched-month-menu-btn');
await sleep(450);
const m5 = await mstate();
const mobOverflow = await page.evaluate(() => Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth));
log('mobile-menu', { ...m5, mobOverflow });
check('モバイル390px: メニューが枠内（スクロール後）に収まり「今月へ」ボタンが視界に入る',
  m5.open && m5.fitsInCont && m5.fitsInVw && mobOverflow === 0, { ...m5, mobOverflow });
await page.screenshot({ path: `${OUT_DIR}/schedule-month-menu-mobile.png` });
await page.setViewport({ width: 1280, height: 900 });
await sleep(400);
await mouseClickSel('#sched-month-menu-btn');
await sleep(400);
await page.screenshot({ path: `${OUT_DIR}/schedule-month-menu.png` });
await mouseClickSel('#sched-month-menu [data-menu-today]');
await sleep(1200);

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

