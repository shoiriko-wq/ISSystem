/**
 * 掲示マスタ・ディテール（左=タイトル列／右=全文ペイン）の実ブラウザ検証
 *
 * 検証項目:
 *  1. 日付選択で左列にタイトルが出右ペインに全文が出る（選択行 = 右ペインの表示）
 *  2. ↑/↓ で選択枠(選択行)だけが移動し、左列全体は動かない。右ペイン全文は連動してフェードイン程度
 *     （位置移動・フラッシュなし）。選択行の未読バッジが消える
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
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 本日へ戻る（ツールバーの「本日」ボタンは撤廃済み＝T キーで本日へ。未読表示中は閉じて本日へ）。
 *   入力欄にフォーカスがあると T キーが効かないので、フォーカスを外してから押す */
const pressToday = async (pg) => {
  await pg.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  await pg.keyboard.press('t');
};

// ★ Node 側の通信は CA を明示する（AGENTS.md 第12条・禁则14）
//   素の fetch は自己署名チェーンを SELF_SIGNED_CERT_IN_CHAIN で弾くため、
//   node:https に certs/issystem-ca.crt を渡して叩く。NODE_EXTRA_CA_CERTS は使わない。
const SECURE = BASE.startsWith('https:');
const CA = SECURE ? [fs.readFileSync(path.join(ROOT, 'certs', 'issystem-ca.crt'))] : null;

/** CA を渡す API 呼び出し（fetch と同じ形で status / text / json() を返す） */
function caFetch(url, opts = {}) {
  const u = new URL(url);
  const useHttps = u.protocol === 'https:';
  const mod = useHttps ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    const body = opts.body ? String(opts.body) : null;
    if (body) headers['Content-Length'] = String(Buffer.byteLength(body));
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (useHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
    };
    if (useHttps) reqOpts.ca = CA;
    const r = mod.request(reqOpts, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          text: d,
          json: async () => JSON.parse(d || '{}'),
        })
      );
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

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
    headless: 'new', ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors', ...args],
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
  page.__token = await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251'));
  page.__userId = await page.evaluate(() => (JSON.parse(localStorage.getItem('is_system_user_info_v251') || 'null') || {}).id);
  return { browser, page };
}

/** ページ内で API を叩く（そのページのログイントークンを使う。投稿作成・削除検証用） */
const apiFetch = (page, method, path, body) => page.evaluate(async (tok, m, p, b) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: tok ? `Bearer ${tok}` : '' },
    body: b ? JSON.stringify(b) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 応答 */ }
  return { status: res.status, json };
}, page.__token, method, path, body);

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
    activeRowAnimations: active
      ? document.getAnimations().filter((a) => a.effect && a.effect.target === active &&
          a.effect.getKeyframes().some((f) => /translateY\(-?\d+(?:\.\d+)?px\)/.test(f.transform || ''))).length
      : 0,
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
    rowDeleteButtons: rows.filter((r) => r.querySelector('button')).length,
    paneDeleteButtons: [...pane.querySelectorAll('button')].filter((b) => (b.textContent || '').includes('削除')).length,
    paneTab: pane.getAttribute('tabindex'),
    paneAriaLive: pane.getAttribute('aria-live'),
    paneHeaderText: (() => {
      const h = pane.querySelector('.pane-header');
      return h ? h.textContent.replace(/\s+/g, ' ').trim() : null;
    })(),
    paneAuthorText: (() => {
      const a = pane.querySelector('.pane-author .pane-author-name');
      return a ? a.textContent.trim() : null;
    })(),
    paneAuthorHasIcon: (() => {
      const a = pane.querySelector('.pane-author');
      if (!a) return false;
      const chip = a.querySelector('div.rounded-full');
      return Boolean(chip && (chip.querySelector('img, svg') || chip.textContent.trim().length > 0));
    })(),
    paneAuthorRightGap: (() => {
      const h = pane.querySelector('.pane-header');
      const a = pane.querySelector('.pane-author');
      if (!h || !a) return null;
      return Math.round(h.getBoundingClientRect().right - a.getBoundingClientRect().right);
    })(),
    paneAuthorTitleGap: (() => {
      const h = pane.querySelector('.pane-header');
      const a = pane.querySelector('.pane-author');
      const t = pane.querySelector('.pane-title');
      if (!h || !a || !t) return null;
      return Math.round(a.getBoundingClientRect().left - t.getBoundingClientRect().left);
    })(),
    paneHeaderHasUnread: (() => {
      const h = pane.querySelector('.pane-header');
      return h ? (h.textContent || '').includes('未読') : false;
    })(),
    /* コメント送信ボタン（入力欄幅いっぱいに伸ばさず右端に内容幅。ホバーリングのリングは
       .bulletin-detail-body の padding 内側で描画される＝見切れない） */
    sendBtnW: (() => {
      const b = pane.querySelector('#bulletin-comment-send');
      return b ? Math.round(b.getBoundingClientRect().width) : null;
    })(),
    sendBtnRightGap: (() => {
      const b = pane.querySelector('#bulletin-comment-send');
      const f = pane.querySelector('.comment-form');
      if (!b || !f) return null;
      return Math.round(f.getBoundingClientRect().right - b.getBoundingClientRect().right);
    })(),
    textareaW: (() => {
      const t = pane.querySelector('#bulletin-comment-input');
      return t ? Math.round(t.getBoundingClientRect().width) : null;
    })(),
    /* 枠線の太さ（他の UI と共通の var(--border-width)=2px であることを検証） */
    borderStd: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--border-width')),
    paneBorderW: [getComputedStyle(pane).borderTopWidth, getComputedStyle(pane).borderRightWidth,
      getComputedStyle(pane).borderBottomWidth, getComputedStyle(pane).borderLeftWidth].map((v) => parseFloat(v)),
    titlePaneBorderW: [getComputedStyle(titlePane).borderTopWidth, getComputedStyle(titlePane).borderRightWidth,
      getComputedStyle(titlePane).borderBottomWidth, getComputedStyle(titlePane).borderLeftWidth].map((v) => parseFloat(v)),
    paneHeaderBorderW: pane.querySelector('.pane-header')
      ? parseFloat(getComputedStyle(pane.querySelector('.pane-header')).borderBottomWidth) : null,
    rowBorderW: rows.length ? parseFloat(getComputedStyle(rows[0]).borderBottomWidth) : null,
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
  const hasTodayButton = [...cal.querySelectorAll('button')].some((b) => b.textContent.trim() === '今日');
  const hasAnyDayLabel = [...cal.querySelectorAll('label')].some((l) => l.textContent.includes('任意日'));
  const hasDateInput = !!cal.querySelector('input[type=date]');
  const monthBtns = cal.querySelectorAll('[data-cal-month]').length;
  const dayCells = cal.querySelectorAll('[data-cal-date]').length;
  const base = { opened, expanded, hasTodayButton, hasAnyDayLabel, hasDateInput, monthBtns, dayCells };
  const day = document.querySelector('#bulletin-mini-cal .mini-cal-has[data-cal-date]');
  if (day) {
    const key = day.getAttribute('data-cal-date');
    day.click();
    return { ...base, day: key, closedAfterPick: cal.classList.contains('hidden') };
  }
  return { ...base, day: null, closedAfterPick: cal.classList.contains('hidden') };
});
await sleep(700);
log('pickedDay', pickedDay);
check('‹ › の間の日付クリックでミニカレンダーが開く（aria-expanded=true、日付選択で閉じる）',
  pickedDay.opened === true && pickedDay.expanded === 'true' && pickedDay.closedAfterPick === true,
  pickedDay);
check('ミニカレンダーに「今日」ボタンと「任意日へ」入力はない（月送り ‹ › と日付セルのみ。本日へはツールバーの本日/T キー）',
  pickedDay.hasTodayButton === false && pickedDay.hasAnyDayLabel === false && pickedDay.hasDateInput === false
    && pickedDay.monthBtns === 2 && pickedDay.dayCells > 28,
  { hasTodayButton: pickedDay.hasTodayButton, hasAnyDayLabel: pickedDay.hasAnyDayLabel,
    hasDateInput: pickedDay.hasDateInput, monthBtns: pickedDay.monthBtns, dayCells: pickedDay.dayCells });

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
check('左列・右ペインの枠と区切り線は共通の 2px（var(--border-width)。カード・ツールバー・入力欄と同じ太さ）',
  snap1.borderStd === 2 && snap1.paneBorderW.every((w) => w === snap1.borderStd)
    && snap1.titlePaneBorderW.every((w) => w === snap1.borderStd)
    && snap1.paneHeaderBorderW === snap1.borderStd && snap1.rowBorderW === snap1.borderStd,
  { borderStd: snap1.borderStd, paneBorderW: snap1.paneBorderW, titlePaneBorderW: snap1.titlePaneBorderW,
    paneHeaderBorderW: snap1.paneHeaderBorderW, rowBorderW: snap1.rowBorderW });
check('未読バッチは行の右端に揃いて固定（右端からの差が全未読行で同じ）。既読行にバッチなし、バッチは行クリックを邪魔しない',
  rowStyle.badgeRows > 0 && rowStyle.badgeRightGap.every((g) => Math.abs(g - rowStyle.badgeRightGap[0]) <= 1)
    && rowStyle.readHasBadge === false && rowStyle.badgeText.length === 1 && rowStyle.badgePointer === 'none',
  { badgeRightGap: rowStyle.badgeRightGap, readHasBadge: rowStyle.readHasBadge, badgeText: rowStyle.badgeText, badgePointer: rowStyle.badgePointer });
check('全行にシグニファイア › があり、未読行の › は既読行と違うアクセント色（クリック誘導）',
  rowStyle.signifiers === rowStyle.rows && rowStyle.signifierColorUnread.length === 1
    && rowStyle.signifierColorRead.length === 1 && rowStyle.signifierColorUnread[0] !== rowStyle.signifierColorRead[0],
  { signifiers: rowStyle.signifiers, rows: rowStyle.rows, signifierColorUnread: rowStyle.signifierColorUnread, signifierColorRead: rowStyle.signifierColorRead });

// 見出し右の未読バッヂは廃止（2026/11 現行 UI）。未読数はサイドバー #bulletin-unread-count と
// 検索ボックス右の未読ボタン #bulletin-btn-unread だけが出す（全日未読）。見出しはラベルのみ。
const titleBadge = await page.evaluate(() => {
  const h2 = document.querySelector('#view-bulletin h2');
  const titleBadgeEl = document.getElementById('bulletin-title-unread');
  const side = document.getElementById('bulletin-unread-count');
  const unreadRows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')]
    .filter((r) => r.dataset.unread === 'true').length;
  return {
    headText: h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : null,
    titleBadgeExists: !!titleBadgeEl,
    sideText: side ? side.textContent.trim() : null,
    sideHidden: side ? side.classList.contains('hidden') : null,
    unreadRows,
    listCount: document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]').length,
  };
});
log('title-unread-badge', titleBadge);
check('見出しは「職員掲示板」ラベルのみ（見出しバッヂは廃止・未読数はサイドバーと未読ボタンだけ）',
  titleBadge.headText && titleBadge.headText.includes('職員掲示板') && titleBadge.titleBadgeExists === false,
  { headText: titleBadge.headText, titleBadgeExists: titleBadge.titleBadgeExists });
// サイドバーのバッヂは数字のみ（全日未読）。見出しに数はない。数値で一致を検証する
const sideNum = Number((titleBadge.sideText || '').replace(/\D/g, ''));
check('サイドバーバッヂは全日未読数（数字のみ。当日列表の未読行数以上・列表件数以下）',
  /^\d+$|^99\+$/.test(titleBadge.sideText || '') &&
  sideNum >= titleBadge.unreadRows && sideNum <= titleBadge.listCount,
  { side: titleBadge.sideText, sideNum, unreadRows: titleBadge.unreadRows, listCount: titleBadge.listCount });
check('全日未読 0 ならサイドバーバッヂは hidden',
  (sideNum === 0) === titleBadge.sideHidden,
  { sideHidden: titleBadge.sideHidden, sideNum });
check('未読バッヂは 100 以上の数字を出さない（100 件超は 99+ へ。999 のような未キャップ表示がない）',
  !(sideNum >= 100),
  { side: titleBadge.sideText });

// 右ペインヘッダーは読者向けに不要な情報（投稿日時・掲示期間）を出さない。全文開きボタンは「詳細」
check('右ペインヘッダーに投稿日時・掲示期間の表記がない',
  !/\d{4}\/\d{2}\/\d{2}/.test(snap1.paneHeaderText || '') && !(snap1.paneHeaderText || '').includes('掲示期間'),
  { paneHeaderText: snap1.paneHeaderText });
check('全文開きボタンは「詳細」にリネーム（右ペインヘッダーの右端）', (snap1.detailBtnText || '').includes('詳細'), { detailBtnText: snap1.detailBtnText });
check('左列タイトル行に削除ボタンがない（削除は詳細モーダル内のみ）',
  snap1.rows > 0 && snap1.rowDeleteButtons === 0, { rowDeleteButtons: snap1.rowDeleteButtons, rows: snap1.rows });
check('右ペイン（ヘッダー・本文）に削除ボタンがない',
  snap1.paneDeleteButtons === 0, { paneDeleteButtons: snap1.paneDeleteButtons, footerButtons: snap1.footerButtons });

/* ★ コメント送信ボタン：入力欄幅いっぱいに伸ばさない（column flex の stretch 対策）。
   チャット送信ボタンと同一デザイン（btn-primary・42px 高・send アイコン・ラベル「送信」）で、
   右端に内容幅として揃える。 */
const sendStyle = await page.evaluate(() => {
  const btn = document.getElementById('bulletin-comment-send');
  const ta = document.getElementById('bulletin-comment-input');
  const form = document.querySelector('.comment-form');
  const chatSend = document.querySelector('#chat-send-form button[type="submit"]');
  if (!btn || !ta || !form) return { missing: true };
  const br = btn.getBoundingClientRect();
  const cs = getComputedStyle(btn);
  return {
    cls: btn.className,
    chatSendCls: chatSend ? chatSend.className : null,
    w: Math.round(br.width), h: Math.round(br.height),
    textareaW: Math.round(ta.getBoundingClientRect().width),
    rightGap: Math.round(form.getBoundingClientRect().right - br.right),
    isPrimary: btn.classList.contains('btn-primary'),
    bg: cs.backgroundColor, color: cs.color, fontWeight: cs.fontWeight,
    icon: Boolean(btn.querySelector('svg')),
    label: btn.textContent.replace(/\s+/g, ' ').trim(),
  };
});
log('comment-send', sendStyle);
check('コメント送信は入力欄の幅いっぱいに広がらない（入力欄の 60% 以下・内容幅で右端揃え）',
  sendStyle.w !== null && sendStyle.w <= sendStyle.textareaW * 0.6 && sendStyle.w <= 140 && sendStyle.rightGap <= 2,
  { w: sendStyle.w, textareaW: sendStyle.textareaW, rightGap: sendStyle.rightGap });
check('コメント送信は送信系ボタンの統一デザイン（btn-primary・42px 高・太字・白文字・send アイコン・ラベル「送信」）',
  sendStyle.isPrimary && sendStyle.h >= 40 && sendStyle.h <= 46 && Number(sendStyle.fontWeight) >= 700
    && sendStyle.icon && sendStyle.label === '送信' && sendStyle.color === 'rgb(255, 255, 255)',
  { isPrimary: sendStyle.isPrimary, h: sendStyle.h, fontWeight: sendStyle.fontWeight, icon: sendStyle.icon,
    label: sendStyle.label, color: sendStyle.color });
check('コメント送信はチャット送信ボタンと同一のクラス設計（デザイン統一）',
  sendStyle.cls === sendStyle.chatSendCls, { cls: sendStyle.cls, chatSendCls: sendStyle.chatSendCls });

/* ★ ホバーリングで枠リング（box-shadow 0 0 0 4px）が見切れないか。
   右ペイン本文コンテナはスクロールコンテナ（overflow-x hidden / overflow-y auto）で、
   影は padding box の外側で clip される。実ホバー時の影と上昇（translateY）から、
   上下左右にリング分の余白があることを実測する。 */
const hoverRingRoom = async (selector) => {
  await page.hover(selector);
  await sleep(350);
  const room = await page.evaluate((sel) => {
    const btn = document.querySelector(sel);
    if (!btn) return { missing: sel };
    const cs = getComputedStyle(btn);
    const shadows = cs.boxShadow.split(/,(?![^(]*\))/).map((s) => s.trim()).filter((p) => p !== 'none')
      .map((p) => {
        const n = (p.match(/-?\d+(?:\.\d+)?px/g) || []).map((v) => parseFloat(v.replace('px', '')));
        return n[3] || 0;
      });
    const spread = Math.max(0, ...shadows);
    const mt = cs.transform.match(/matrix\(([^)]*)\)/);
    const lift = mt ? -(parseFloat(mt[1].split(',')[5]) || 0) : 0; // 上昇分（px）
    const roomOf = (container) => {
      const c = getComputedStyle(container);
      const cr = container.getBoundingClientRect();
      const padBox = {
        top: cr.top + parseFloat(c.borderTopWidth), right: cr.right - parseFloat(c.borderRightWidth),
        bottom: cr.bottom - parseFloat(c.borderBottomWidth), left: cr.left + parseFloat(c.borderLeftWidth),
      };
      const b = btn.getBoundingClientRect();
      return {
        top: Math.round(b.top - padBox.top - lift),
        right: Math.round(padBox.right - b.right),
        left: Math.round(b.left - padBox.left),
        bottom: Math.round(padBox.bottom - b.bottom + lift),
      };
    };
    return {
      spread, lift, shadow: cs.boxShadow.slice(0, 60),
      bodyRoom: roomOf(document.querySelector('#bulletin-detail-pane .bulletin-detail-body')),
      paneRoom: roomOf(document.getElementById('bulletin-detail-pane')),
    };
  }, selector);
  await page.mouse.move(2, 2); // ホバーを外す（後続の計測に影響させない）
  await sleep(120);
  return room;
};
const ringOk = (r) => Boolean(r && r.spread > 0)
  && [r.bodyRoom, r.paneRoom].every((c) => c.top >= r.spread && c.right >= r.spread
    && c.left >= r.spread && c.bottom >= r.spread);

const detailRing = await hoverRingRoom('#bulletin-detail-pane [data-bulletin-detail]');
log('detail-hover-ring', detailRing);
check('「詳細」ボタンはホバリングで枠リングが見切れない（上下左右の余白がリング分以上）',
  ringOk(detailRing), detailRing);
const sendRing = await hoverRingRoom('#bulletin-comment-send');
log('send-hover-ring', sendRing);
check('コメント送信ボタンはホバリングで枠リングが見切れない（上下左右の余白がリング分以上）',
  ringOk(sendRing), sendRing);



// ★ 右ペインタイトル行の投稿者（アバターアイコン＋投稿者名、右寄せ）。行内の未読バッジは撤去済み
check('右ペインタイトル行に投稿者名とアバターアイコンが表示されている',
  Boolean(snap1.paneAuthorText) && snap1.paneAuthorText.length > 0 && snap1.paneAuthorHasIcon === true,
  { paneAuthorText: snap1.paneAuthorText, icon: snap1.paneAuthorHasIcon });
// 収容サイドバー（せり出しオーバーレイ）で右ペインが広くなると、未読バッジと「詳細」が
// ヘッダーの 1 行目に収まり、投稿者はその左寄せになる（幅 94+87+gap 18 ≒ 199px）。
// 狭い pane ではバッジ/詳細が 2 行目へ折返し、投稿者はヘッダー右端に付く（差 0）。
// よって「タイトルより右＝右側」と「右端との差はバッジ+詳細が収まる 220px 以内」で判定する。
check('投稿者表示はタイトル行の右側へ右寄せ（ヘッダー右端との差 220px 以内・タイトルより右）',
  snap1.paneAuthorRightGap !== null && snap1.paneAuthorRightGap <= 220 && snap1.paneAuthorTitleGap > 40,
  { paneAuthorRightGap: snap1.paneAuthorRightGap, paneAuthorTitleGap: snap1.paneAuthorTitleGap });
check('右ペインタイトル行の未読バッジは撤去（左列タイトル行の未読バッジは残る）',
  snap1.paneHeaderHasUnread === false && rowStyle.badgeRows > 0 && rowStyle.readHasBadge === false,
  { paneHeaderHasUnread: snap1.paneHeaderHasUnread, leftBadgeRows: rowStyle.badgeRows, leftUnread: snap1.unread });

// 表示記事の投稿者名は API の実データ（authorName）と一致
const authorMatch = await page.evaluate(async () => {
  const tok = localStorage.getItem('is_system_jwt_token_v251');
  const res = await fetch('/api/bulletins', { headers: { Authorization: tok ? `Bearer ${tok}` : '' } });
  const json = await res.json();
  const list = json.bulletins || (Array.isArray(json) ? json : []);
  const paneTitle = document.querySelector('#bulletin-detail-pane .pane-title')?.textContent.trim();
  const paneAuthor = document.querySelector('#bulletin-detail-pane .pane-author .pane-author-name')?.textContent.trim();
  const item = list.find((b) => String(b.title || '').trim() === paneTitle);
  const real = item ? String(item.authorName || item.author_name || '') : null;
  return { paneTitle, paneAuthor, real, found: Boolean(item), ok: Boolean(real) && real === paneAuthor };
});
log('pane-author-data', authorMatch);
check('右ペインの投稿者名は表示記事の実際の投稿者名と一致', authorMatch.ok, authorMatch);

// ★ 投稿者表示のスクリーンショット（タイトル行を切り出し）
const headerBox = await page.evaluate(() => {
  const h = document.querySelector('#bulletin-detail-pane .pane-header');
  if (!h) return null;
  const r = h.getBoundingClientRect();
  return { x: Math.round(r.x) - 8, y: Math.round(r.y) - 8, width: Math.round(r.width) + 16, height: Math.round(r.height) + 16 };
});
if (headerBox) await page.screenshot({ path: 'scripts/output/bulletin-pane-author.png', clip: headerBox });

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
await sleep(5);   // press 直後：右ペインのフェード(150ms)が生きていないと計測できない
const snapDown = await snapshot(page);
log('after-ArrowDown', snapDown);
log('rowIds', rowIds);
check('↑/↓ で選択行が移動し右ペイン全文が連動', snapDown.activeIdx === 1 && snapDown.paneTitle === snapDown.activeTitle, { activeIdx: snapDown.activeIdx, paneTitle: snapDown.paneTitle });
check('選択切替は左列全体を動かさず右ペインはフェード1回',
  snapDown.listAnimations === 0 && snapDown.paneAnimations === 1,
  { listAnimations: snapDown.listAnimations, paneAnimations: snapDown.paneAnimations });

// 選択枠の移動は translateY のスライドだけ（上移動なら下から滑り込み、最終位置で0・左列全体は動かない）
await page.keyboard.press('ArrowUp');
await sleep(5);
const snapUp = await snapshot(page);
const rowAnim = await page.evaluate(() => {
  const active = document.querySelector('#bulletin-list-container .bulletin-title-row.active');
  const anims = document.getAnimations().filter((a) =>
    a.effect && a.effect.target === active &&
    a.effect.getKeyframes().some((f) => /translateY\(-?\d+(?:\.\d+)?px\)/.test(f.transform || '')));
  if (!anims.length) return null;
  const tx = anims[0].effect.getKeyframes().map((t) => {
    const m = /translateY\((-?\d+(?:\.\d+)?)px\)/.exec(t.transform);
    return m ? parseFloat(m[1]) : 0;
  });
  return {
    start: tx[0],
    end: tx[tx.length - 1],
    listElTransform: (() => {
      const listAnims = document.getElementById('bulletin-list-container').getAnimations()
        .filter((a) => !(window.CSSTransition && a instanceof window.CSSTransition));
      return listAnims.length === 0;
    })(),
  };
});
log('after-ArrowUp', snapUp);
log('active-row-anim', rowAnim);
check('↑ で先頭行へ戻り右ペインも連動', snapUp.activeIdx === 0 && snapUp.paneTitle === snapUp.activeTitle, { activeIdx: snapUp.activeIdx, paneTitle: snapUp.paneTitle });
check('選択枠は translateY スライドで移動（上移動は下から滑り込み、終点0・左列全体は動かない）',
  rowAnim && rowAnim.start > 0 && rowAnim.end === 0 && rowAnim.listElTransform === true, rowAnim);
/* 選択行の未読バッジが消える（未読状態はテスト間で消費されることがあるため、
   田中先生（T2026002）に未読の掲示を作ってもらい、その行を実際に選択して1減ることを実測する。
   作った掲示は最後に削除して元へ戻す＝後片付け。Node 側通信は CA を明示（禁则14）。 */
const posterLogin = await caFetch(`${BASE}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ staff_code: 'T2026002', password: PASS }),
}).then((r) => r.json());
const posterToken = posterLogin.token;
const unreadTitle = 'UI検証バッジ用掲示';  // タイトルに「未読」の文字を入れるとバッジ数と混ざるので使わない
const madePost = await caFetch(`${BASE}/api/bulletins`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', Authorization: `Bearer ${posterToken}` },
  body: JSON.stringify({
    title: unreadTitle,
    content: '未読バッジ検証用（行の選択で既読化されることを実測し、検証後に削除される）。',
    target_date: snapUp.centerDate,
    display_start_date: snapUp.centerDate,
  }),
}).then((r) => r.json());
const madeId = (madePost.data && madePost.data.id) || (madePost.bulletin && madePost.bulletin.id) || null;

// 本日へ戻して新掲示の行をさがす（作った掲示は閲覧者にとって未読＝バッジが付く。「本日」ボタンは撤廃＝T キー）
await pressToday(page);
await sleep(700);
const beforeUnread = await snapshot(page);
const unreadRow = await page.evaluate((t) => {
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  return { found: rows.some((r) => r.getAttribute('data-bulletin-toggle') === t), rows: rows.length };
}, madeId);
// 行を選択（クリック）して未読バッジが1減ることを数える
await page.evaluate((t) => {
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const row = rows.find((r) => r.getAttribute('data-bulletin-toggle') === t);
  if (row) row.click();
}, madeId);
await sleep(500);
const afterUnread = await snapshot(page);
log('unread-badge-flow', {
  madeId, before: beforeUnread.unread, after: afterUnread.unread,
  activeTitle: afterUnread.activeTitle, rowFound: unreadRow.found,
});
check('選択行の未読バッジが消える（未読の掲示を選択するとバッジが1減り・選択行のバッジも消える）',
  Boolean(madeId) && unreadRow.found === true
    && beforeUnread.unread - afterUnread.unread === 1
    && afterUnread.activeTitle === unreadTitle,
  { before: beforeUnread.unread, after: afterUnread.unread, activeTitle: afterUnread.activeTitle, rowFound: unreadRow.found });

// 後片付け: 田中先生が作った掲示を削除する。
// 一覧はキャッシュ描画なので、削除後はページを再読込してサーバーの実データへ追従させる。
const delRes = await caFetch(`${BASE}/api/bulletins/${madeId}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${posterToken}` },
});
const goneCheck = await caFetch(`${BASE}/api/bulletins/${madeId}`, {
  headers: { Authorization: `Bearer ${posterToken}` },
});
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);
await page.evaluate(() => document.querySelector('a[data-tab="bulletin"]').click());
await sleep(900);
const afterCleanup = await snapshot(page);
log('unread-badge-cleanup', { delStatus: delRes.status, goneStatus: goneCheck.status, rowsBefore: beforeUnread.rows, rowsAfter: afterCleanup.rows });
check('検証用掲示を削除して後片付けできる（API は 200→404、再読込した画面の行数が作成前の数へ戻る）',
  delRes.status === 200 && goneCheck.status === 404 && afterCleanup.rows === beforeUnread.rows - 1,
  { delStatus: delRes.status, goneStatus: goneCheck.status, rowsBefore: beforeUnread.rows, rowsAfter: afterCleanup.rows });

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
// 直前の long zapping で中心日が動いているため本日へ戻し、右ペインに選択記事がある状態で開く（「本日」ボタンは撤廃＝T キー）
await pressToday(page);
await sleep(500);

const detailModal = await page.evaluate(async (myId) => {
  const b = document.querySelector('#bulletin-detail-pane [data-bulletin-detail]');
  if (!b) return { open: 'no-button' };
  b.click();
  const m = document.getElementById('bulletin-detail-modal');
  const meta = document.getElementById('detail-bulletin-meta');
  const content = document.getElementById('detail-bulletin-content');
  const attach = document.getElementById('detail-bulletin-attachments');
  const title = document.getElementById('detail-bulletin-title');
  const footer = document.getElementById('detail-bulletin-actions');
  const metaText = (meta ? meta.textContent : '').replace(/\s+/g, ' ');
  const day = document.getElementById('bulletin-day-current').dataset.day;
  const tok = localStorage.getItem('is_system_jwt_token_v251');
  const res = await fetch(`/api/bulletins?postedDay=${day}`, { headers: { Authorization: `Bearer ${tok}` } });
  const json = await res.json();
  const items = json.bulletins || json.data || [];
  const openTitle = (title ? title.textContent : '').trim();
  const item = items.find((i) => String(i.title).trim() === openTitle) || null;
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
    isAuthor: item === null ? null : String(item.authorId) === String(myId),
    hasDelete: !!footer.querySelector('#btn-detail-delete'),
    footerButtons: [...footer.querySelectorAll('button')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
  };
}, page.__userId);
log('detail-modal', detailModal);
check('「詳細」ボタンで詳細モーダルが開く（aria-hidden=false）', detailModal.open === true, detailModal.open);
check('詳細モーダルに投稿日時・掲示期間・投稿者・本文・添付の情報が揃う',
  detailModal.hasDate && detailModal.hasTime && detailModal.hasPeriod && detailModal.hasAuthor
    && detailModal.contentLen > 0 && (detailModal.attachText || '').includes('添付'),
  { hasDate: detailModal.hasDate, hasTime: detailModal.hasTime, hasPeriod: detailModal.hasPeriod,
    hasAuthor: detailModal.hasAuthor, contentLen: detailModal.contentLen, attachText: detailModal.attachText });
check('他人の投稿の詳細モーダルに「削除」が出ない（フッターは 補足・コメント/閉じる の2つ）',
  detailModal.isAuthor === false && detailModal.hasDelete === false && detailModal.footerButtons.length === 2,
  { isAuthor: detailModal.isAuthor, hasDelete: detailModal.hasDelete, footerButtons: detailModal.footerButtons });

/* ESC で閉じ、aria-hidden が同期すること（閉じた内容を支援技術に渡さない） */
await page.keyboard.press('Escape');
await sleep(250);
const modalClosed = await page.evaluate(() => {
  const m = document.getElementById('bulletin-detail-modal');
  return m.classList.contains('hidden') && m.getAttribute('aria-hidden') === 'true';
});
log('modal-closed-via-ESC', modalClosed);
check('ESC で閉じ aria-hidden も同期', modalClosed === true, modalClosed);

// 自分の投稿（投稿者 = ログインユーザー）の詳細モーダルにだけ「削除」が出る
const authorModal = await page.evaluate(async (myId) => {
  const day = document.getElementById('bulletin-day-current').dataset.day;
  const tok = localStorage.getItem('is_system_jwt_token_v251');
  const res = await fetch(`/api/bulletins?postedDay=${day}`, { headers: { Authorization: `Bearer ${tok}` } });
  const json = await res.json();
  const items = json.bulletins || json.data || [];
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const rowFor = (t) => rows.find((r) => r.querySelector('.bulletin-row-title').textContent.trim() === String(t).trim());
  const mine = items.map((i) => ({ i, r: rowFor(i.title) })).filter((x) => String(x.i.authorId) === String(myId) && x.r);
  if (!mine.length) return { found: false };
  mine[0].r.click();
  const b = document.querySelector('#bulletin-detail-pane [data-bulletin-detail]');
  if (!b) return { found: true, open: false };
  b.click();
  const footer = document.getElementById('detail-bulletin-actions');
  const del = footer.querySelector('#btn-detail-delete');
  return {
    found: true,
    open: !document.getElementById('bulletin-detail-modal').classList.contains('hidden'),
    mineTitle: String(mine[0].i.title).trim().slice(0, 24),
    hasDelete: !!del,
    deleteLabel: del ? del.textContent.replace(/\s+/g, ' ').trim() : null,
    rowDeleteButtons: rows.filter((r) => r.querySelector('button')).length,
  };
}, page.__userId);
await sleep(300);
log('author-modal', authorModal);
check('自分の投稿の詳細モーダルにだけ「削除」が出る（モーダル内・投稿者のみ）',
  authorModal.found === true && authorModal.open === true && authorModal.hasDelete === true
    && (authorModal.deleteLabel || '').includes('削除') && authorModal.rowDeleteButtons === 0,
  authorModal);

/* 詳細モーダルの「削除」で自分の投稿が消える E2E（confirm は受理。作った投稿は削除して元へ戻す） */
const created = await apiFetch(page, 'POST', '/bulletins', {
  title: 'UI検証削除用掲示',
  content: '削除ボタン検証用に作成した掲示（検証後に削除される）。',
  author_id: page.__userId,
});
const createdId = (created.json && created.json.data && created.json.data.id)
  || (created.json && created.json.bulletin && created.json.bulletin.id) || null;
await pressToday(page);   // 「本日」ボタンは撤廃済み＝T キーで本日へ
await sleep(650);
const createdRow = await page.evaluate((t) => {
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const row = rows.find((r) => r.querySelector('.bulletin-row-title').textContent.trim() === t);
  if (row) row.click();
  return { rowFound: !!row, rows: rows.length, paneTitle: document.querySelector('#bulletin-detail-pane h3')?.textContent.trim() };
}, 'UI検証削除用掲示');
log('created-post', { createdId, rowFound: createdRow.rowFound, rows: createdRow.rows });

check('自分の新投稿が左列に並ぶ（削除 E2E の準備）', Boolean(createdId) && createdRow.rowFound === true,
  { createdId, rowFound: createdRow.rowFound, rows: createdRow.rows });

/* ★ コメント送信 E2E（右ペインのその場で送信：委譲で即ローカル描画 → 成功トースト → API 201 → 永続化）。
   bulletin_comments に保存され、他行→自分の投稿へ選択し直す（＝まっさらな再取得）後も一覧に残ることを検証する。
   コメントは上で作った投稿に付けるため、後の投稿削除で CASCADE され検証後に DB から消える。 */
const postSeen = [];
page.on('response', async (r) => {
  if (r.url().includes('/comments')) {
    let body = '';
    try { body = (await r.text()).slice(0, 150); } catch (e) { /* ignore */ }
    postSeen.push({ status: r.status(), body: body.replace(/\s+/g, ' ') });
  }
});
const sendTarget = await page.evaluate(() => {
  const b = document.getElementById('bulletin-comment-send');
  const ta = document.getElementById('bulletin-comment-input');
  if (!b || !ta) return { missing: true };
  const before = document.querySelectorAll('.comment-list .comment-item').length;
  ta.value = 'UI検証：送信ボタンからの補足コメント';
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  b.click();  // ペイン側の委譲（[data-bulletin-comment]）で送信される
  const local = document.querySelectorAll('.comment-list .comment-item').length;
  return { id: b.getAttribute('data-bulletin-comment'), before, local };
});
await sleep(900);
const sendUi = await page.evaluate(() => ({
  toasts: [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
  inputCleared: (document.getElementById('bulletin-comment-input')?.value || '') === '',
  itemsAfter: document.querySelectorAll('.comment-list .comment-item').length,
  heading: (document.querySelector('.comment-heading')?.textContent || '').replace(/\s+/g, ' ').trim(),
  paneText: (document.querySelector('.comment-list')?.textContent || '').replace(/\s+/g, ' '),
}));
log('comment-post', postSeen);
const detailAfter = await apiFetch(page, 'GET', `/bulletins/${sendTarget.id}`);
const persisted = (detailAfter.json?.data?.comments || [])
  .some((c) => String(c.comment_text || '').includes('UI検証：送信ボタンからの補足コメント'));
/* 他行 → 自分の投稿へ選択し直す（loadComments は選択時に走る＝まっさらな再取得。ローコピーは破棄される） */
const reselect = await page.evaluate(async (id) => {
  window.__bulletinDebug = [];
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const other = rows.find((r) => r.getAttribute('data-bulletin-toggle') !== String(id));
  if (other) other.click();
  await new Promise((r) => setTimeout(r, 450));
  // selectBulletin → renderRows が innerHTML を作り直すため、上記で捕捉した行参照は DOM から切り離される。
  // 同じ行を再取得してクリックする（切れた参照のクリックは委譲リスナーに届かない）
  const mine = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')]
    .find((r) => r.getAttribute('data-bulletin-toggle') === String(id));
  if (mine) mine.click();
  await new Promise((r) => setTimeout(r, 700));
  return { items: document.querySelectorAll('.comment-list .comment-item').length, dbg: window.__bulletinDebug };
}, sendTarget.id);
log('comment-send-e2e', {
  id: sendTarget.id, before: sendTarget.before, local: sendTarget.local, itemsAfter: sendUi.itemsAfter,
  heading: sendUi.heading, reselect, detailStatus: detailAfter.status, persisted,
});
check('コメント送信ボタンで送信が走る（即ローカル描画・成功トースト・入力欄は再描画で空）',
  sendTarget.local === sendTarget.before + 1
    && sendUi.toasts.some((t) => t.includes('コメントを送信しました')) && sendUi.inputCleared,
  { before: sendTarget.before, local: sendTarget.local, toasts: sendUi.toasts });
check('コメントは永続化される（API 詳細の comments に返り、右ペインの件数 1 と本文表示・選択し直しても残る）',
  detailAfter.status === 200 && persisted
    && sendUi.itemsAfter === sendTarget.before + 1
    && sendUi.paneText.includes('UI検証：送信ボタン')
    && sendUi.heading.includes('(1)') && reselect.items === sendTarget.before + 1,
  { before: sendTarget.before, itemsAfter: sendUi.itemsAfter, heading: sendUi.heading, reselect,
    detailStatus: detailAfter.status, persisted });

page.on('dialog', (d) => d.accept());   // window.confirm を受理する
const deleteUi = await page.evaluate(() => {
  const b = document.querySelector('#bulletin-detail-pane [data-bulletin-detail]');
  if (!b) return { modal: false, hasDelete: false };
  b.click();
  const del = document.getElementById('btn-detail-delete');
  return {
    modal: !document.getElementById('bulletin-detail-modal').classList.contains('hidden'),
    hasDelete: !!del,
    actions: (document.getElementById('detail-bulletin-actions')?.textContent || '').replace(/\s+/g, ' ').trim(),
    meta: (document.getElementById('detail-bulletin-meta')?.textContent || '').replace(/\s+/g, ' ').trim(),
    storedUser: JSON.parse(localStorage.getItem('is_system_user_info_v251') || 'null'),
    paneId: document.getElementById('bulletin-detail-pane')?.getAttribute('data-detail-post-id') || null,
  };
});
await page.evaluate(() => { const d = document.getElementById('btn-detail-delete'); if (d) d.click(); });
await sleep(900);
const afterDelete = await snapshot(page);
const toasts = await page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')]
  .map((t) => t.textContent.replace(/\s+/g, ' ').trim()));
const apiGone = await apiFetch(page, 'GET', `/bulletins/${createdId}`);
log('after-delete', { modal: deleteUi.modal, hasDelete: deleteUi.hasDelete, rows: afterDelete.rows, toasts, apiStatus: apiGone.status,
  uiUser: page.__userId, apiAuthor: apiGone.json?.data?.authorId ?? apiGone.json?.data?.author_id ?? null,
  actions: deleteUi.actions, meta: deleteUi.meta, storedUser: deleteUi.storedUser, paneId: deleteUi.paneId });
check('詳細モーダルの「削除」で自分の掲示が消える（トースト・行数・API が全て消えた状態）',
  deleteUi.modal === true && deleteUi.hasDelete === true && createdRow.rows - afterDelete.rows === 1
    && toasts.some((t) => t.includes('削除しました')) && apiGone.status === 404,
  { hasDelete: deleteUi.hasDelete, rowsBefore: createdRow.rows, rowsAfter: afterDelete.rows,
    toasts, apiStatus: apiGone.status });

// サーバー側でも投稿者以外は削除できない（UI は出さないだけでなく API も 403 で拒否。他人の投稿は残る）
const otherDelete = await apiFetch(page, 'DELETE', '/bulletins/post_2');
const otherStill = await apiFetch(page, 'GET', '/bulletins/post_2');
log('server-authority', { status: otherDelete.status, message: otherDelete.json?.message, post2Status: otherStill.status });
check('他人の投稿の DELETE は 403 で拒否され投稿は残る（削除権限は投稿者本人）',
  otherDelete.status === 403 && (otherDelete.json?.message || '').includes('投稿者') && otherStill.status === 200,
  { status: otherDelete.status, message: otherDelete.json?.message, post2Status: otherStill.status });

// モバイル（縦 stacking・横スクロールなし）
await page.setViewport({ width: 390, height: 844 });
await sleep(300);
const m390 = await snapshot(page);
log('mobile-390', m390);
check('モバイル（390）は縦 stacking', m390.flexDir === 'column', m390.flexDir);
check('モバイル（390）で横スクロールなし（ページ・右ペイン）', m390.pageOverflowX === 0 && m390.paneOverflowX === 0, { pageOverflowX: m390.pageOverflowX, paneOverflowX: m390.paneOverflowX });
check('モバイル（390）でもコメント送信は入力欄幅いっぱいに広がらない（右端に内容幅）',
  m390.sendBtnW !== null && m390.sendBtnW <= m390.textareaW && m390.sendBtnW <= 140 && m390.sendBtnRightGap <= 2,
  { sendBtnW: m390.sendBtnW, textareaW: m390.textareaW, rightGap: m390.sendBtnRightGap });
check('モバイル（390）の左列は全幅でタイトルが 1 行に絞られる', m390.titlePaneW >= m390.paneW && m390.rows > 0, { titlePaneW: m390.titlePaneW, paneW: m390.paneW });
check('モバイル（390）でも ‹ › は同じ行に隣接（ツールバーが ‹ › を分けて折り返さない）',
  m390.prevY === m390.nextY && m390.nextX > m390.prevX, { prevX: m390.prevX, nextX: m390.nextX, prevY: m390.prevY, nextY: m390.nextY });
await page.screenshot({ path: '/tmp/bulletin-split-390.png' });

await page.setViewport({ width: 320, height: 700 });
await sleep(300);
const m320 = await snapshot(page);
log('mobile-320', m320);
check('モバイル（320）も縦 stacking・右ペイン内横スクロールなし', m320.flexDir === 'column' && m320.paneOverflowX === 0, { flexDir: m320.flexDir, paneOverflowX: m320.paneOverflowX });
check('モバイル（320）でもコメント送信は入力欄幅いっぱいに広がらない（右端に内容幅）',
  m320.sendBtnW !== null && m320.sendBtnW <= m320.textareaW && m320.sendBtnW <= 140 && m320.sendBtnRightGap <= 2,
  { sendBtnW: m320.sendBtnW, textareaW: m320.textareaW, rightGap: m320.sendBtnRightGap });
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

