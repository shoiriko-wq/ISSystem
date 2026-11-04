/**
 * 掲示マスタ・ディテール（左=タイトル列／右=全文ペイン）の実ブラウザ検証
 *
 * 検証項目:
 *  1. 日付選択で左列にタイトルが出右ペインに全文が出る（選択行 = 右ペインの表示）
 *  2. ↑/↓ で選択行が移動し、右ペイン全文が連動。選択行の未読バッジが消える
 *  3. Enter で右ペインへフォーカス
 *  4. ←/→ と ‹ › ボタンは前日/翌日（1日分）ザッピング
 *  5. 中心日は ‹ › の間の固定幅ボタン（‹ [日付] › が同一グループで隣接）。日付クリックでミニカレンダーが
 *     開き、日付を選ぶと閉じる。連打しても › ボタンの位置は動かず、カレンダー単独ボタンは存在しない。
 *     開いているカレンダーの月表示・選択日は中心日に追従（‹ › で月を跨いだら月も変わる）
 *  6. 「詳細」ボタン → 詳細モーダル（投稿日時・掲示期間などの読者向け情報はモーダルに集約。aria-hidden 同期）
 *  7. モバイル（<768px）は縦 stacking、横スクロールなし
 *  8. prefers-reduced-motion ではタイトル移動アニメーションが無効（コンテンツ移動なし）
 * 実行: node scripts/test-bulletin-split.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 * 出力: スクリプト実行ログ + /tmp/bulletin-split-desktop.png / /tmp/bulletin-split-390.png
 *       NG が 1 件でもあれば exit code 1
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const log = (name, val) => {
  const line = `${name} = ${JSON.stringify(val)}`;
  results.push(line);
  console.log(line);
};

/* 検証項目（scripts/test-modal-close.mjs と同じ慣習）。failures は exit code で返す */
const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

/** 2026-11-02 のような YYYY-MM-DD に ±n 日を加えた文字列 */
const shiftDate = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function setup(args = []) {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', ...args],
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
  await sleep(900);
  return { browser, page };
}

/** 左列・右ペイン・日付チップの状態スナップショット */
const snapshot = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const active = document.querySelector('#bulletin-list-container .bulletin-title-row.active');
  const pane = document.getElementById('bulletin-detail-pane');
  const split = document.querySelector('.bulletin-split');
  const titlePane = document.querySelector('.bulletin-title-pane');
  const listEl = document.getElementById('bulletin-list-container');
  const body = pane.querySelector('.bulletin-detail-body');
  const readout = document.getElementById('bulletin-day-current');
  const nextBtn = document.getElementById('bulletin-day-next');
  const prevBtn = document.getElementById('bulletin-day-prev');
  return {
    rows: rows.length,
    activeIdx: rows.indexOf(active),
    activeTitle: active ? active.querySelector('.bulletin-row-title')?.textContent.trim() : null,
    activeSelected: active ? active.getAttribute('aria-selected') : null,
    activeBg: active ? getComputedStyle(active).backgroundColor : null,
    unread: rows.filter((r) => r.textContent.includes('未読')).length,
    titleCount: document.getElementById('bulletin-title-count')?.textContent,
    paneTitle: pane.querySelector('h3') ? pane.querySelector('h3').textContent.trim() : null,
    paneHasBody: !!body,
    paneOverflowX: body ? body.scrollWidth - body.clientWidth : null,
    paneAnimations: pane.getAnimations().length,
    listAnimations: listEl.getAnimations().length,
    paneFocused: document.activeElement === pane,
    centerDate: readout ? readout.dataset.day : null,
    readoutW: readout ? Math.round(readout.getBoundingClientRect().width) : null,
    calToggleGone: !document.getElementById('bulletin-cal-toggle'),
    nextX: nextBtn ? Math.round(nextBtn.getBoundingClientRect().x) : null,
    prevX: prevBtn ? Math.round(prevBtn.getBoundingClientRect().x) : null,
    nextY: nextBtn ? Math.round(nextBtn.getBoundingClientRect().y) : null,
    prevY: prevBtn ? Math.round(prevBtn.getBoundingClientRect().y) : null,
    rootFs: parseFloat(getComputedStyle(document.documentElement).fontSize),
    flexDir: getComputedStyle(split).flexDirection,
    titlePaneW: Math.round(titlePane.getBoundingClientRect().width),
    paneW: Math.round(pane.getBoundingClientRect().width),
    splitH: Math.round(split.getBoundingClientRect().height),
    pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
    overflowEls: [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
      .slice(0, 6)
      .map((el) => `${el.tagName}.${(el.className || '').toString().slice(0, 42)} w=${Math.round(el.getBoundingClientRect().width)}`),
    footerButtons: [...pane.querySelectorAll('button')].map((b) => b.textContent.trim()),
    paneTab: pane.getAttribute('tabindex'),
    paneAriaLive: pane.getAttribute('aria-live'),
    paneHeaderText: (() => {
      const h = pane.querySelector('.pane-header');
      return h ? h.textContent.replace(/\s+/g, ' ').trim() : null;
    })(),
    detailBtnText: (() => {
      const b = pane.querySelector('[data-bulletin-detail]');
      return b ? b.textContent.replace(/\s+/g, ' ').trim() : null;
    })(),
  };
});

/* ============ 通常ビュー（1280x900） ============ */
const { browser, page } = await setup();
await page.setViewport({ width: 1280, height: 900 });

// ‹ › の間の日付をクリックしてミニカレンダーを開き、投稿数のある日を選択（選択で閉じる）
const pickedDay = await page.evaluate(() => {
  const read = document.getElementById('bulletin-day-current');
  read.click();
  const cal = document.getElementById('bulletin-mini-cal');
  const opened = !cal.classList.contains('hidden');
  const expanded = read.getAttribute('aria-expanded');
  const day = document.querySelector('#bulletin-mini-cal .mini-cal-has[data-cal-date]');
  if (day) {
    const key = day.getAttribute('data-cal-date');
    day.click();
    return { day: key, opened, expanded, closedAfterPick: cal.classList.contains('hidden') };
  }
  return { day: null, opened, expanded, closedAfterPick: cal.classList.contains('hidden') };
});
await sleep(700);
log('pickedDay', pickedDay);
check('‹ › の間の日付クリックでミニカレンダーが開く（aria-expanded=true、日付選択で閉じる）',
  pickedDay.opened === true && pickedDay.expanded === 'true' && pickedDay.closedAfterPick === true,
  pickedDay);

const snap1 = await snapshot(page);
log('after-day-select', snap1);
check('カレンダー単独ボタンは撤廃（#bulletin-cal-toggle は存在しない）',
  snap1.calToggleGone === true, { calToggleGone: snap1.calToggleGone });
check('左右分割（左列 = 16rem 固定、右ペイン余り。ルートの font-size が変わっても rem 基準）',
  snap1.flexDir === 'row'
    && snap1.titlePaneW >= snap1.rootFs * 15.5
    && snap1.titlePaneW <= snap1.rootFs * 16.5
    && snap1.paneW > snap1.titlePaneW,
  { titlePaneW: snap1.titlePaneW, paneW: snap1.paneW, rootFs: snap1.rootFs, expectedRem16: snap1.rootFs * 16 });
check('1件目が選択され右ペインに全文が出る（aria-selected=true）',
  snap1.rows > 0 && snap1.activeIdx === 0 && snap1.activeSelected === 'true' && snap1.paneTitle === snap1.activeTitle,
  { activeTitle: snap1.activeTitle, paneTitle: snap1.paneTitle });
check('選択行は強調背景（accent）', !!snap1.activeBg && snap1.activeBg !== 'rgba(0, 0, 0, 0)', snap1.activeBg);
check('右ペインは tabindex=0 / aria-live=polite', snap1.paneTab === '0' && snap1.paneAriaLive === 'polite', { paneTab: snap1.paneTab, paneAriaLive: snap1.paneAriaLive });
check('右ペイン・ページに横スクロールなし', snap1.paneOverflowX === 0 && snap1.pageOverflowX === 0, { paneOverflowX: snap1.paneOverflowX, pageOverflowX: snap1.pageOverflowX });
// === 左列タイトル行の表記（1行・時間なし・行右端の未読バッチ・シグニファイア ›）===
const rowStyle = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const timeIn = (row) => {
    const t = row.querySelector('.bulletin-row-title').textContent;
    return /\d{1,2}:\d{2}/.test(row.textContent.replace(t, ''));
  };
  const badgeRows = rows.filter((r) => r.querySelector('.bulletin-unread-badge'));
  return {
    rows: rows.length,
    timeInRow: rows.map(timeIn),
    badgeRows: badgeRows.length,
    badgeRightGap: badgeRows.map((r) => {
      const rr = r.getBoundingClientRect();
      const bb = r.querySelector('.bulletin-unread-badge').getBoundingClientRect();
      return Math.round(rr.right - bb.right);
    }),
    rowH: rows.map((r) => Math.round(r.getBoundingClientRect().height)),
    titleH: rows.map((r) => Math.round(r.querySelector('.bulletin-row-title').getBoundingClientRect().height)),
    signifiers: rows.filter((r) => r.querySelector('.bulletin-row-signifier svg')).length,
    signifierColorUnread: [...new Set(rows.filter((r) => r.dataset.unread === 'true')
      .map((r) => getComputedStyle(r.querySelector('.bulletin-row-signifier')).color))],
    signifierColorRead: [...new Set(rows.filter((r) => r.dataset.unread === 'false')
      .map((r) => getComputedStyle(r.querySelector('.bulletin-row-signifier')).color))],
    readHasBadge: rows.filter((r) => r.dataset.unread === 'false').some((r) => r.querySelector('.bulletin-unread-badge')),
    badgeText: [...new Set(badgeRows.map((r) => r.querySelector('.bulletin-unread-badge').textContent.trim()))],
    badgePointer: badgeRows.length ? getComputedStyle(badgeRows[0].querySelector('.bulletin-unread-badge')).pointerEvents : null,
  };
});
log('title-row-style', rowStyle);
check('左列タイトル行に時間の表記がない（タイトル文字列以外に HH:MM なし）',
  rowStyle.rows > 0 && rowStyle.timeInRow.every((x) => x === false), rowStyle.timeInRow);
check('左列タイトル行は常に1行（行高<=40px、タイトルは1行分）',
  rowStyle.rowH.every((h) => h <= 40) && rowStyle.titleH.every((h) => h <= 24), { rowH: rowStyle.rowH, titleH: rowStyle.titleH });
check('未読バッチは行の右端に揃いて固定（右端からの差が全未読行で同じ）。既読行にバッチなし、バッチは行クリックを邪魔しない',
  rowStyle.badgeRows > 0 && rowStyle.badgeRightGap.every((g) => Math.abs(g - rowStyle.badgeRightGap[0]) <= 1)
    && rowStyle.readHasBadge === false && rowStyle.badgeText.length === 1 && rowStyle.badgePointer === 'none',
  { badgeRightGap: rowStyle.badgeRightGap, readHasBadge: rowStyle.readHasBadge, badgeText: rowStyle.badgeText, badgePointer: rowStyle.badgePointer });
check('全行にシグニファイア › があり、未読行の › は既読行と違うアクセント色（クリック誘導）',
  rowStyle.signifiers === rowStyle.rows && rowStyle.signifierColorUnread.length === 1
    && rowStyle.signifierColorRead.length === 1 && rowStyle.signifierColorUnread[0] !== rowStyle.signifierColorRead[0],
  { signifiers: rowStyle.signifiers, rows: rowStyle.rows, signifierColorUnread: rowStyle.signifierColorUnread, signifierColorRead: rowStyle.signifierColorRead });

// 右ペインヘッダーは読者向けに不要な情報（投稿日時・掲示期間）を出さない。全文開きボタンは「詳細」
check('右ペインヘッダーに投稿日時・掲示期間の表記がない',
  !/\d{4}\/\d{2}\/\d{2}/.test(snap1.paneHeaderText || '') && !(snap1.paneHeaderText || '').includes('掲示期間'),
  { paneHeaderText: snap1.paneHeaderText });
check('全文開きボタンは「詳細」にリネーム（右ペインヘッダーの右端）', (snap1.detailBtnText || '').includes('詳細'), { detailBtnText: snap1.detailBtnText });

// 長いタイトルは1行のまま未読バッチの下に潜って省略される（合成行で寸法を検証）
const longRow = await page.evaluate(() => {
  const host = document.getElementById('bulletin-list-container');
  const proto = host.querySelector('[data-bulletin-toggle]');
  if (!proto) return null;
  const row = proto.cloneNode(true);
  row.setAttribute('data-bulletin-toggle', 'tmp-long-row');
  row.setAttribute('data-unread', 'true');
  row.setAttribute('aria-selected', 'false');
  row.classList.remove('active');
  const span = row.querySelector('.bulletin-row-title');
  span.textContent = '極めて長いタイトルです'.repeat(8);
  const badge = document.createElement('span');
  badge.className = 'bulletin-unread-badge';
  badge.textContent = '未読';
  row.appendChild(badge);
  host.appendChild(row);
  const rr = row.getBoundingClientRect();
  const tr = span.getBoundingClientRect();
  const br = row.querySelector('.bulletin-unread-badge').getBoundingClientRect();
  const out = {
    rowH: Math.round(rr.height),
    truncated: span.scrollWidth > span.clientWidth,
    titleEndsUnderBadge: tr.right > br.left,
    badgeOpaque: getComputedStyle(row.querySelector('.bulletin-unread-badge')).backgroundColor !== 'rgba(0, 0, 0, 0)',
    titleRightGap: Math.round(rr.right - tr.right),
    badgeRightGap: Math.round(rr.right - br.right),
  };
  row.remove();
  return out;
});
log('long-title-row', longRow);
check('長いタイトルは1行のまま右端バッチの下に潜って省略表示（行高1行・バッチは不透明）',
  longRow && longRow.truncated && longRow.titleEndsUnderBadge && longRow.rowH <= 40 && longRow.badgeOpaque, longRow);

/* 左列の幅はタイトル内容で広がらない（flex の min-width:auto 解除。長いタイトルは truncate） */
const longTitleW = await page.evaluate(() => {
  const row = document.querySelector('.bulletin-title-row');
  const label = row?.querySelector('.bulletin-row-title');
  if (!label) return null;
  label.textContent = '極めて長いタイトルです'.repeat(8);
  const w = Math.round(document.querySelector('.bulletin-title-pane').getBoundingClientRect().width);
  const listW = Math.round(document.getElementById('bulletin-list-container').clientWidth);
  return { paneW: w, listW, rootFs: parseFloat(getComputedStyle(document.documentElement).fontSize) };
});
check('長いタイトルでも左列は 16rem のまま（列が押し広げられない）',
  longTitleW && longTitleW.paneW >= longTitleW.rootFs * 15.5 && longTitleW.paneW <= longTitleW.rootFs * 16.5,
  longTitleW);

await page.screenshot({ path: '/tmp/bulletin-split-desktop.png' });

// ↑/↓ で選択移動 → 右ペイン全文が連動、選択行が未読バッジを消す
const rowIds = await page.evaluate(() =>
  [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')].map((r) => r.getAttribute('data-bulletin-toggle')));
await page.evaluate(() => document.querySelector('#bulletin-list-container [data-bulletin-toggle]').focus());
await page.keyboard.press('ArrowDown');
await sleep(120);
const snapDown = await snapshot(page);
log('after-ArrowDown', snapDown);
log('rowIds', rowIds);
check('↑/↓ で選択行が移動し右ペイン全文が連動', snapDown.activeIdx === 1 && snapDown.paneTitle === snapDown.activeTitle, { activeIdx: snapDown.activeIdx, paneTitle: snapDown.paneTitle });
check('選択切替で左列・右ペインが 1 回ずつスライド（WAAPI）', snapDown.listAnimations === 1 && snapDown.paneAnimations === 1, { listAnimations: snapDown.listAnimations, paneAnimations: snapDown.paneAnimations });
check('選択行の未読バッジが消える', snap1.unread - snapDown.unread === 1, { before: snap1.unread, after: snapDown.unread });

await page.keyboard.press('ArrowUp');
await sleep(120);
const snapUp = await snapshot(page);
log('after-ArrowUp', snapUp);
check('↑ で先頭行へ戻り右ペインも連動', snapUp.activeIdx === 0 && snapUp.paneTitle === snapUp.activeTitle, { activeIdx: snapUp.activeIdx, paneTitle: snapUp.paneTitle });

// Enter → 右ペインへフォーカス
await page.keyboard.press('Enter');
await sleep(150);
const paneFocused = (await snapshot(page)).paneFocused;
log('Enter-paneFocused', paneFocused);
check('Enter で右ペイン（全文）へフォーカス', paneFocused === true);

// ←/→ と ‹ › ボタンは ±1日（中心日が1日ずつ移動し、往復で元に戻る）
const c0 = (await snapshot(page)).centerDate;
await page.keyboard.press('ArrowRight'); await sleep(420);
const c1 = (await snapshot(page)).centerDate;
await page.keyboard.press('ArrowLeft'); await sleep(420);
const c2 = (await snapshot(page)).centerDate;
await page.click('#bulletin-day-next'); await sleep(420);
const c3 = (await snapshot(page)).centerDate;
await page.click('#bulletin-day-prev'); await sleep(420);
const c4 = (await snapshot(page)).centerDate;
log('dateShift', { c0, c1, c2, c3, c4 });
check('←/→ キーは前日/翌日（1日分）ザッピング', c1 === shiftDate(c0, 1) && c2 === c0, { c0, c1, c2 });
check('› ‹ ボタンも 1日分ザッピング（中心日が1日ずつ移動）', c3 === shiftDate(c2, 1) && c4 === c2, { c2, c3, c4 });

// 中心日は ‹ › の間の固定幅ボタン（‹ [日付] › が同一グループで隣接）。クリックでカレンダーが開く
const domOrder = await page.evaluate(() => {
  const read = document.getElementById('bulletin-day-current');
  const prev = document.getElementById('bulletin-day-prev');
  const next = document.getElementById('bulletin-day-next');
  return {
    prevNextIsRead: prev.nextElementSibling === read,
    readNextIsNext: read.nextElementSibling === next,
    sameGroup: prev.parentElement === read.parentElement && read.parentElement === next.parentElement,
    readIsButton: read.tagName === 'BUTTON',
    ariaControls: read.getAttribute('aria-controls'),
    calToggleGone: !document.getElementById('bulletin-cal-toggle'),
  };
});
log('toolbar-order', domOrder);
check('中心日は ‹ › の間にある（‹ [日付] › が同一グループで隣接、日付はカレンダーを開くボタン）',
  domOrder.prevNextIsRead && domOrder.readNextIsNext && domOrder.sameGroup
    && domOrder.readIsButton && domOrder.ariaControls === 'bulletin-mini-cal' && domOrder.calToggleGone,
  domOrder);

const rapid = await page.evaluate(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextXs = [];
  const readoutWs = [];
  const sample = () => {
    nextXs.push(Math.round(document.getElementById('bulletin-day-next').getBoundingClientRect().x));
    readoutWs.push(Math.round(document.getElementById('bulletin-day-current').getBoundingClientRect().width));
  };
  for (let i = 0; i < 5; i++) { document.getElementById('bulletin-day-next').click(); await nap(160); sample(); }
  for (let i = 0; i < 5; i++) { document.getElementById('bulletin-day-prev').click(); await nap(160); sample(); }
  return { nextXs, readoutWs, day: document.getElementById('bulletin-day-current').dataset.day };
});
log('rapid-click', rapid);
const uniqX = [...new Set(rapid.nextXs)];
const uniqW = [...new Set(rapid.readoutWs)];
check('› を 10 回連打しても › の x 位置は 1px も動かず、中心日表示の幅も一定',
  uniqX.length === 1 && uniqW.length === 1, { uniqX, uniqW });
check('5 日進・5 日戻りの連打で中心日は元の日に戻る', rapid.day === c4, { c4, day: rapid.day });

// 開いているカレンダーは中心日に追従（‹ › で月を跨ぐと月表示と選択日が中心日と同じ月・同じ日）
const calFollow = await page.evaluate(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = document.getElementById('bulletin-day-current');
  const start = read.dataset.day;
  read.click();   // 日付クリックで開く
  for (let i = 0; i < 40; i++) { document.getElementById('bulletin-day-next').click(); await nap(70); }
  const center = read.dataset.day;
  const header = document.querySelector('#bulletin-mini-cal .text-sm')?.textContent.trim();
  const sel = document.querySelector('#bulletin-mini-cal .mini-cal-selected')?.getAttribute('data-cal-date');
  for (let i = 0; i < 40; i++) { document.getElementById('bulletin-day-prev').click(); await nap(70); }
  read.click();   // 閉じる（中心日は検証用の日に戻す）
  const [y, m] = center.split('-');
  return { center, header, sel, restored: read.dataset.day === start,
    expandedAfterClose: read.getAttribute('aria-expanded'),
    expected: `${y}年${Number(m)}月` };
});
log('cal-follow', calFollow);
check('‹ › で月を跨ぐと開いているカレンダーの月表示・選択日が中心日に追従（日付クリックで閉じ、中心日は元へ）',
  calFollow.header === calFollow.expected && calFollow.sel === calFollow.center
    && calFollow.restored === true && calFollow.expandedAfterClose === 'false', calFollow);
// === 1日ずれのアニメーションは小刻み（1日移動に見合った小ささ）===
const dayAnim = await page.evaluate(async () => {
  // CSS transition（hover 用など）は除き、WAAPI のスライドだけを測る
  const probe = (el) => {
    const anims = el.getAnimations().filter((a) => !(window.CSSTransition && a instanceof window.CSSTransition));
    if (!anims.length) return null;
    const frames = anims[0].effect.getKeyframes();
    const px = frames.map((f) => {
      const m = /translate[XY]\((-?\d+(?:\.\d+)?)px\)/.exec(f.transform);
      return m ? Math.abs(parseFloat(m[1])) : 0;
    });
    const op = frames.map((f) => parseFloat(f.opacity)).filter((v) => !Number.isNaN(v));
    return { maxPx: Math.max(...px), minOpacity: Math.min(...op), duration: anims[0].effect.getTiming().duration };
  };
  document.getElementById('bulletin-day-next').click();
  return {
    readout: probe(document.getElementById('bulletin-day-current')),
    list: probe(document.getElementById('bulletin-list-container')),
    pane: probe(document.getElementById('bulletin-detail-pane')),
  };
});
const smallAnim = (a, maxPx) => a && a.maxPx <= maxPx && a.minOpacity >= 0.5 && a.duration <= 200;
check('1日ずれ（›）のアニメーションは小刻み（中心日<=6px・内容<=12px・薄くしすぎない・200ms以内）',
  smallAnim(dayAnim.readout, 6) && smallAnim(dayAnim.list, 12) && smallAnim(dayAnim.pane, 12), dayAnim);


const posDesktop = await snapshot(page);
log('arrow-pos-desktop', { prevX: posDesktop.prevX, prevY: posDesktop.prevY, nextX: posDesktop.nextX, nextY: posDesktop.nextY });
check('‹ › は同じ行に隣接して並び、連打できる', posDesktop.prevY === posDesktop.nextY && posDesktop.nextX > posDesktop.prevX,
  { prevX: posDesktop.prevX, prevY: posDesktop.prevY, nextX: posDesktop.nextX, nextY: posDesktop.nextY });

// 右ペインヘッダーの「詳細」ボタン → 詳細モーダル（読者向けの情報を全部載せる）
const detailModal = await page.evaluate(() => {
  const b = document.querySelector('#bulletin-detail-pane [data-bulletin-detail]');
  if (!b) return { open: 'no-button' };
  b.click();
  const m = document.getElementById('bulletin-detail-modal');
  const meta = document.getElementById('detail-bulletin-meta');
  const content = document.getElementById('detail-bulletin-content');
  const attach = document.getElementById('detail-bulletin-attachments');
  const title = document.getElementById('detail-bulletin-title');
  const metaText = (meta ? meta.textContent : '').replace(/\s+/g, ' ');
  return {
    open: !!(m && !m.classList.contains('hidden') && m.getAttribute('aria-hidden') === 'false'),
    modalTitle: title ? title.textContent.trim() : null,
    metaText: metaText.trim().slice(0, 120),
    hasDate: /\d{4}\/\d{2}\/\d{2}/.test(metaText),
    hasTime: /\d{2}:\d{2}/.test(metaText),
    hasPeriod: metaText.includes('掲示期間'),
    hasAuthor: metaText.includes('投稿者'),
    contentLen: content ? content.textContent.trim().length : 0,
    attachText: attach ? attach.textContent.replace(/\s+/g, ' ').trim().slice(0, 40) : null,
  };
});
log('detail-modal', detailModal);
check('「詳細」ボタンで詳細モーダルが開く（aria-hidden=false）', detailModal.open === true, detailModal.open);
check('詳細モーダルに投稿日時・掲示期間・投稿者・本文・添付の情報が揃う',
  detailModal.hasDate && detailModal.hasTime && detailModal.hasPeriod && detailModal.hasAuthor
    && detailModal.contentLen > 0 && (detailModal.attachText || '').includes('添付'),
  { hasDate: detailModal.hasDate, hasTime: detailModal.hasTime, hasPeriod: detailModal.hasPeriod,
    hasAuthor: detailModal.hasAuthor, contentLen: detailModal.contentLen, attachText: detailModal.attachText });

/* ESC で閉じ、aria-hidden が同期すること（閉じた内容を支援技術に渡さない） */
await page.keyboard.press('Escape');
await sleep(250);
const modalClosed = await page.evaluate(() => {
  const m = document.getElementById('bulletin-detail-modal');
  return m.classList.contains('hidden') && m.getAttribute('aria-hidden') === 'true';
});
log('modal-closed-via-ESC', modalClosed);
check('ESC で閉じ aria-hidden も同期', modalClosed === true, modalClosed);

// モバイル（縦 stacking・横スクロールなし）
await page.setViewport({ width: 390, height: 844 });
await sleep(300);
const m390 = await snapshot(page);
log('mobile-390', m390);
check('モバイル（390）は縦 stacking', m390.flexDir === 'column', m390.flexDir);
check('モバイル（390）で横スクロールなし（ページ・右ペイン）', m390.pageOverflowX === 0 && m390.paneOverflowX === 0, { pageOverflowX: m390.pageOverflowX, paneOverflowX: m390.paneOverflowX });
check('モバイル（390）の左列は全幅でタイトルが 1 行に絞られる', m390.titlePaneW >= m390.paneW && m390.rows > 0, { titlePaneW: m390.titlePaneW, paneW: m390.paneW });
check('モバイル（390）でも ‹ › は同じ行に隣接（ツールバーが ‹ › を分けて折り返さない）',
  m390.prevY === m390.nextY && m390.nextX > m390.prevX, { prevX: m390.prevX, nextX: m390.nextX, prevY: m390.prevY, nextY: m390.nextY });
await page.screenshot({ path: '/tmp/bulletin-split-390.png' });

await page.setViewport({ width: 320, height: 700 });
await sleep(300);
const m320 = await snapshot(page);
log('mobile-320', m320);
check('モバイル（320）も縦 stacking・右ペイン内横スクロールなし', m320.flexDir === 'column' && m320.paneOverflowX === 0, { flexDir: m320.flexDir, paneOverflowX: m320.paneOverflowX });
check('モバイル（320）でも ‹ › は同じ行に隣接', m320.prevY === m320.nextY && m320.nextX > m320.prevX,
  { prevX: m320.prevX, nextX: m320.nextX, prevY: m320.prevY, nextY: m320.nextY });
// 320 の横オーバーフローが既存アプリ（ヘッダー等）由来かを確認（ダッシュボード基準値）
await page.evaluate(() => document.querySelector('a[data-tab="dashboard"]').click());
await sleep(500);
const base320 = await page.evaluate(() => ({
  pageOverflowX: document.documentElement.scrollWidth - window.innerWidth,
  overflowEls: [...document.querySelectorAll('*')]
    .filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
    .slice(0, 5)
    .map((el) => `${el.tagName}.${(el.className || '').toString().slice(0, 40)} w=${Math.round(el.getBoundingClientRect().width)}`),
}));
log('baseline-320-dashboard', base320);
check('320 の横スクロールは既存アプリ起因（掲示の分割レイアウトで増えない）',
  m320.pageOverflowX <= base320.pageOverflowX, { bulletin: m320.pageOverflowX, dashboard: base320.pageOverflowX });

await browser.close();

/* ============ prefers-reduced-motion（タイトル移動アニメーション無効） ============ */
const { browser: b2, page: p2 } = await setup(['--force-prefers-reduced-motion']);
await p2.evaluate(() => document.querySelector('a[data-tab="bulletin"]').click());
await sleep(700);
await p2.evaluate(() => {
  document.getElementById('bulletin-day-current').click();
  const hit = document.querySelector('#bulletin-mini-cal .mini-cal-has[data-cal-date]');
  if (hit) hit.click();
});
await sleep(600);
await p2.evaluate(() => document.querySelector('#bulletin-list-container [data-bulletin-toggle]')?.focus());
await p2.keyboard.press('ArrowDown');
await sleep(140);
const rm = await p2.evaluate(() => {
  const pane = document.getElementById('bulletin-detail-pane');
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  return {
    mq: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    paneAnimations: pane.getAnimations().length,
    listAnimations: document.getElementById('bulletin-list-container').getAnimations().length,
    activeIdx: rows.indexOf(document.querySelector('#bulletin-list-container .bulletin-title-row.active')),
    paneTitle: pane.querySelector('h3')?.textContent.trim(),
  };
});
log('reduced-motion', rm);
check('prefers-reduced-motion ではスライド移動なし（コンテンツ切り替えのみ）',
  rm.mq === true && rm.paneAnimations === 0 && rm.listAnimations === 0 && rm.activeIdx === 1, rm);
await b2.close();

console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILURES`}`);
process.exit(failures.length === 0 ? 0 : 1);

