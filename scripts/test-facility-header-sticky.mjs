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

// ヘッダー操作群の高さ・フォント（日付読み上げは職員掲示板と同一寸法）、sticky ヘッダー、スクロール挙動
const geom = await page.evaluate(() => {
  const cs = (el) => getComputedStyle(el);
  const header = document.getElementById('facility-time-header');
  const cont = document.querySelector('.timeline-scroll-container');
  const title = document.querySelector('#view-facility h2');
  const readout = document.getElementById('facility-day-current');
  const prevBtn = document.getElementById('facility-prev-day');
  const nextBtn = document.getElementById('facility-next-day');
  const createBtn = document.getElementById('facility-btn-create');
  const manageBtn = document.getElementById('facility-btn-manage');
  const cal = document.getElementById('facility-mini-cal');
  const group = document.getElementById('facility-day-group');
  return {
    titleFs: cs(title).fontSize,
    readoutH: Math.round(readout.getBoundingClientRect().height),
    readoutW: Math.round(readout.getBoundingClientRect().width),
    readoutFs: cs(readout).fontSize,
    readoutText: readout.textContent.trim(),
    readoutControls: readout.getAttribute('aria-controls'),
    readoutExpanded: readout.getAttribute('aria-expanded'),
    readoutBw: [cs(readout).borderTopWidth, cs(readout).borderBottomWidth],
    groupH: Math.round(group.getBoundingClientRect().height),
    groupBorder: cs(group).borderTopWidth,
    prevH: Math.round(prevBtn.getBoundingClientRect().height),
    prevW: Math.round(prevBtn.getBoundingClientRect().width),
    nextH: Math.round(nextBtn.getBoundingClientRect().height),
    nextW: Math.round(nextBtn.getBoundingClientRect().width),
    createH: Math.round(createBtn.getBoundingClientRect().height),
    createFs: cs(createBtn).fontSize,
    manageH: manageBtn ? Math.round(manageBtn.getBoundingClientRect().height) : 42,
    dateInputExists: !!document.getElementById('facility-date-picker'),
    todayBtnExists: !!document.getElementById('facility-btn-today'),
    calExists: !!cal,
    calHidden: cal ? cal.classList.contains('hidden') : null,
    hintEl: cs(document.querySelector('#view-facility .card span.text-muted')).fontSize,
    contMaxH: cs(cont).maxHeight,
    contOverflowY: cs(cont).overflowY,
    headerPos: cs(header).position,
    headerZ: cs(header).zIndex,
    headerLabelFs: cs(header.querySelector('[style*="left"]')).fontSize,
  };
});
log('facility-geom', geom);
check('ヘッダーの操作群（日付読み上げ・日付ナビ・新規予約・施設管理）の高さが 2.4rem(42px) で揃い、日付読み上げは 5.4rem(95px) 幅・1.02rem(17.85px) 文字、新規予約も同じ文字、時間ラベル・説明文も 1.0rem(17.5px) 文字',
  geom.readoutH === 42 && geom.readoutW === 95 && geom.prevH === 42 && geom.prevW === 42
  && geom.nextH === 42 && geom.nextW === 42 && geom.createH === 42 && geom.manageH === 42
  && geom.groupH === 42 && geom.readoutFs === '17.85px' && geom.createFs === '17.85px'
  && geom.headerLabelFs === '17.5px' && geom.hintEl === '17.5px', geom);
check('日付読み上げは MM/DD (曜) 表記で aria-controls がミニカレンダー、aria-expanded=false、‹ [日付読み上げ] › を囲むグループが 2px 実線枠（border-main）',
  /^\d{2}\/\d{2} \([日月火水木金土]\)$/.test(geom.readoutText)
  && geom.readoutControls === 'facility-mini-cal' && geom.readoutExpanded === 'false'
  && geom.groupBorder === '2px', geom);
check('native date input とツールバーの「本日」ボタンは撤廃済み、ミニカレンダーはinitial非表示（日付クリック・C キーで開く）',
  geom.dateInputExists === false && geom.todayBtnExists === false
  && geom.calExists === true && geom.calHidden === true,
  { dateInputExists: geom.dateInputExists, todayBtnExists: geom.todayBtnExists, calExists: geom.calExists, calHidden: geom.calHidden });
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

// --- 横向きにスライドした際、施設名称列が左端に固定される（時間トラックだけが滑る）検証 ---
// 狭幅（720px = min-w-[880px] で横スクロールする幅）で scrollLeft を動かし、名称列の位置を測る
const nameSnap = (sl) => page.evaluate(async (scrollLeft) => {
  const cont = document.querySelector('.timeline-scroll-container');
  cont.scrollLeft = scrollLeft;
  await new Promise((r) => requestAnimationFrame(r));
  await new Promise((r) => requestAnimationFrame(r));
  const abs = (el) => Math.round(el.getBoundingClientRect().left);
  const frameLeft = abs(cont);
  const header = document.getElementById('facility-time-header');
  const headCell = header.querySelector('.facility-name-cell');
  const cells = [...document.querySelectorAll('#facility-matrix-body [data-facility-row] > .facility-name-cell')];
  const alpha = (s) => { const n = (s.match(/[.\d]+/g) || []).map(Number); return n.length < 4 ? 1 : n[3]; };
  const label = [...header.querySelectorAll('.flex-1.relative [style*="left"]')].find((d) => d.textContent.trim() === '13:00');
  return {
    scrollLeft: Math.round(cont.scrollLeft),
    maxScrollX: Math.round(cont.scrollWidth - cont.clientWidth),
    headCellLeft: abs(headCell) - frameLeft,
    headCellW: Math.round(headCell.getBoundingClientRect().width),
    rowCellLefts: [...new Set(cells.map((el) => abs(el) - frameLeft))],
    trackLeft: abs(header.querySelector('.flex-1.relative')) - frameLeft,
    labelLeft: label ? abs(label) - frameLeft : -999,
    headPos: getComputedStyle(headCell).position,
    headLeftCss: getComputedStyle(headCell).left,
    headZ: getComputedStyle(headCell).zIndex,
    rowPos: getComputedStyle(cells[0]).position,
    rowLeftCss: getComputedStyle(cells[0]).left,
    rowZ: getComputedStyle(cells[0]).zIndex,
    headAlpha: alpha(getComputedStyle(headCell).backgroundColor),
    rowAlpha: alpha(getComputedStyle(cells[0]).backgroundColor),
  };
}, sl);

await page.evaluate(async () => { const m = await import('/js/theme.js'); m.applyTheme('cb-teal'); });
await page.setViewport({ width: 720, height: 900 });
await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  c.style.maxHeight = '240px';
  c.scrollTop = 0;
  c.scrollLeft = 0;
});
await sleep(450);
const at0 = await nameSnap(0);
const slid = await nameSnap(200);
log('name-column@scrollLeft0', at0);
log('name-column@scrollLeft200', slid);
check('施設名称列のセルは sticky / left 0（本文 z-45・ヘッダー z-60）で不透明背景（下に滑るバンド・グリッド線が透けない）',
  at0.headPos === 'sticky' && at0.headLeftCss === '0px' && at0.headZ === '60'
  && at0.rowPos === 'sticky' && at0.rowLeftCss === '0px' && at0.rowZ === '45'
  && at0.headAlpha === 1 && at0.rowAlpha === 1,
  { headPos: at0.headPos, headLeftCss: at0.headLeftCss, headZ: at0.headZ, rowPos: at0.rowPos,
    rowLeftCss: at0.rowLeftCss, rowZ: at0.rowZ, headAlpha: at0.headAlpha, rowAlpha: at0.rowAlpha });
check('横向きにスライドしても施設名称列は枠左端に固定（ヘッダーと全本文行が同じ左位置＝枠線 2px の内側）',
  slid.maxScrollX >= 200 && slid.scrollLeft === 200
  && Math.abs(at0.headCellLeft - slid.headCellLeft) <= 1
  && slid.rowCellLefts.length === 1 && Math.abs(slid.rowCellLefts[0] - slid.headCellLeft) <= 1
  && slid.headCellLeft >= 1 && slid.headCellLeft <= 4,
  { maxScrollX: slid.maxScrollX, scrollLeft: slid.scrollLeft, headCellLeft: slid.headCellLeft,
    rowCellLefts: slid.rowCellLefts, at0HeadCellLeft: at0.headCellLeft });
check('時間トラックとラベルはスライド分だけ左へ動く（固定された名称列がトラックの左端を覆い、名称列とトラックの間に隙間が出ない）',
  Math.abs((at0.labelLeft - slid.labelLeft) - slid.scrollLeft) <= 1
  && Math.abs((at0.trackLeft - slid.trackLeft) - slid.scrollLeft) <= 1
  && slid.trackLeft <= slid.headCellLeft + slid.headCellW
  && at0.trackLeft === at0.headCellLeft + at0.headCellW,
  { at0LabelLeft: at0.labelLeft, slidLabelLeft: slid.labelLeft, scrollLeft: slid.scrollLeft,
    at0TrackLeft: at0.trackLeft, slidTrackLeft: slid.trackLeft,
    headCellLeft: slid.headCellLeft, headCellW: slid.headCellW });

// 横向きスライド状態で施設名称列が固定されているスクリーンショット（狭幅・scrollLeft 200・縦スクロール併用）
await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  c.scrollTop = 100;
  c.scrollLeft = 200;
});
await sleep(350);
const slidShot = await page.$('.timeline-scroll-container');
await slidShot.screenshot({ path: `${import.meta.dirname}/output/facility-name-column-sticky.png` });

// 既存のヘッダー固定スクリーンショットは広幅で撮るため、幅とスクロール状態と枠高さを戻す
await page.evaluate(() => {
  const c = document.querySelector('.timeline-scroll-container');
  c.style.maxHeight = '';
  c.scrollTop = 0;
  c.scrollLeft = 0;
});
await page.setViewport({ width: 1280, height: 900 });
await sleep(300);

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
