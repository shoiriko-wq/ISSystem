#!/usr/bin/env node
/**
 * 掲示「未読（全日）」・全日表示・検索・キー操作・サイドバーのバッヂをヘッドレス Chrome で数値実測する（UI 十条の規則3・10）
 *
 * 現行実装（2026-11 改版）の実測どおりに期待値を作っている：
 *  1. ツールバーの未読ボタンで左列が全日の未読一覧（対象日見出し付き）になる。readout は「未読」、
 *     ‹ ›・中心日クリック・年月選択ボタン・未読ボタンは止まる。ミニカレンダーは自動では開かない。
 *     未読の最新1件（対象日降順→投稿日時降順）は自動選択で右ペインに出るだけ＝表示だけでは既読にならない
 *     （その行は未読バッヂと data-unread=true を残す）。既読はタイトル行をクリック（↑/↓ 選択も）して初めて付く。
 *  2. 列表の行クリック＝既読化（行は列表に残り、未読バッヂだけ消える）。列表の件数は減らず、ラベルとサイドバーの未読件数だけ1減る。
 *     全件読むと未読表示は閉じて本日列表へ自動復帰する。
 *  3. ←/→ は本日列表で中心日を±1日動かす。全日表示・未読表示では止まる。T キーは未読表示を閉じて本日へ戻る。
 *     C キーはミニカレンダーの開閉（未読表示・検索中は止まる）。N キーは現行実装に無い＝中心日を動かさない。
 *  4. 検索語の入力中は全日表示（readout「全日」、‹ ›・日付クリック・C 停止、行クリックは中心日を動かさない）。
 *     検索語を消すと本日列表へ戻る。
 *  5. ミニカレンダーの年月ラベル（‹ › の間）クリックで年月選択メニュー（年 ‹ ›・12ヶ月・「本日へ」）が開く。中心日は動かさない。
 * 期待値は API（/api/bulletins）と DB（bulletins_ack を全消し、kyomu01 の登録日 created_at）から計算する。
 */
import { readFileSync } from 'fs';
import https from 'node:https';
import puppeteer from 'puppeteer-core';
import { query, pool } from '../config/database.js';

const BASE = 'https://localhost:3443';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Node 側の API 呼び出しは certs/issystem-ca.crt を ca に渡して https で叩く（NODE_EXTRA_CA_CERTS は npm script に埋めない）
const CA = [readFileSync(new URL('../certs/issystem-ca.crt', import.meta.url), 'utf8')];
const caFetch = (path, opts = {}) => new Promise((resolve, reject) => {
  const u = new URL(path, BASE);
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  const req = https.request({
    method: opts.method || 'GET', hostname: u.hostname, port: u.port, path: u.pathname + u.search,
    headers, ca: CA, rejectUnauthorized: true,
  }, (res) => {
    let d = '';
    res.on('data', (c) => { d += c; });
    res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: () => JSON.parse(d) }));
  });
  req.on('error', reject);
  if (opts.body) req.write(opts.body);
  req.end();
});

/** JST の当日 YYYY-MM-DD */
const todayJst = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const today = todayJst();
// 本日年月（2026/11 は30日、2025/3 と 2026/10 と 2026/5 は31日、2026/9 は30日）
const year = Number(today.slice(0, 4));
const month = Number(today.slice(5, 7)) - 1;

/** 'YYYY-MM-DD' を n 日ずらす */
const shiftDate = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};

/** 'YYYY-MM-DD' を readout と同じ 'MM/DD (曜)' へ */
const mmdd = (ymd) => {
  const names = ['日', '月', '火', '水', '木', '金', '土'];
  const [y, m, d] = ymd.split('-').map(Number);
  const wd = names[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return String(m).padStart(2, '0') + '/' + String(d).padStart(2, '0') + ' (' + wd + ')';
};

/** ISO 日時を JST 日 YYYY-MM-DD に（モジュールの toJstDay と同じ） */
const jstDay = (iso) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
};

/* モジュールと同じ判定（期待値を Node 側で計算する） */
const targetOf = (b) => String(b.targetDate || b.target_date || '');
const startOf = (b) => String(b.displayStart || b.display_start_date || b.display_start || '');
const endOf = (b) => String(b.displayEnd || b.display_end_date || b.display_end || '');
const postedOf = (b) => b.postedAt || b.posted_at || b.createdAt || b.created_at;
const postedMs = (b) => new Date(postedOf(b)).getTime();

// 月末日を数える helper（2026/11 は 30日、2025/3 と 2026/10 と 2026/5 は 31日、2026/9 は 30日）
const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();

/** 掲示期間が day で有効か（モジュールの isDisplayActiveOn と同じ） */
const isActiveOn = (b, day) => {
  const s = startOf(b), e = endOf(b);
  if (s && s > day) return false;
  if (e && e < day) return false;
  return true;
};

/** 未読判定（モジュールの isUnreadForMe と同じ：ackStatus、登録日以後の投稿、掲示期間、全対象 scope） */
const isUnreadFor = (b, regDay) => {
  const st = String(b.ackStatus || b.ack_status || b.ackstatus || 'UNREAD');
  if (b.isRead === true || st === 'READ' || st === 'APPROVED') return false;
  const pd = jstDay(postedOf(b));
  if (regDay && pd && pd < regDay) return false;
  if (!isActiveOn(b, today)) return false;
  const sc = b.targetScope || b.target_scope;
  if (sc) {
    const g = String(sc.grade ?? 'ALL');
    const dp = String(sc.department ?? 'ALL');
    if (g !== 'ALL' || dp !== 'ALL') return false;  // テストのシード掲示は全対象
  }
  return true;
};

/** 検索語に該当するか（モジュールの matchesQuery と同じ：タイトル・本文・投稿者名） */
const matchesQ = (b, q) => {
  const t = String(b.title || '').toLowerCase();
  const c = String(b.content || '').toLowerCase();
  const a = String(b.authorName || b.author_name || b.authorname || '').toLowerCase();
  return t.includes(q) || c.includes(q) || a.includes(q);
};

/** 対象日降順 → 投稿日時降順（モジュールの全日表示と同じ並び） */
const sortFull = (arr) => arr.slice().sort((a, b) => {
  const da = targetOf(a), db = targetOf(b);
  if (da !== db) return da < db ? 1 : -1;
  return postedMs(b) - postedMs(a);
});

const results = [];
const failures = [];
const log = (name, val) => { const line = name + ' = ' + JSON.stringify(val); results.push(line); console.log(line); };
const check = (name, cond, detail = null) => {
  if (cond) log('PASS - ' + name, detail);
  else { log('FAIL - ' + name, detail); failures.push(name); }
};

/** ツールバー・列表・ラベル・サイドバー・ミニカレンダー・内部状態（window.__bulletinSnap）を読む */
const snapshot = (p) => p.evaluate(() => {
  const q = (s) => document.querySelector(s);
  const rowsEl = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const cal = q('#bulletin-mini-cal');
  const menu = q('#bulletin-month-menu');
  const menuBtn = q('#bulletin-month-menu-btn');
  const readout = q('#bulletin-day-current');
  const unreadBtn = q('#view-bulletin #bulletin-btn-unread');
  const badge = q('#bulletin-unread-count');
  const label = q('#bulletin-day-label');
  const sel = cal ? cal.querySelector('.mini-cal-selected') : null;
  const actTitle = q('#bulletin-list-container .bulletin-title-row.active .bulletin-row-title');
  const pane = q('#bulletin-detail-pane .pane-title');
  return {
    readoutText: readout ? readout.textContent.trim() : null,
    centerDate: readout ? (readout.dataset.day || '') : null,
    prevDisabled: q('#bulletin-day-prev') ? q('#bulletin-day-prev').disabled === true : null,
    nextDisabled: q('#bulletin-day-next') ? q('#bulletin-day-next').disabled === true : null,
    dayBtnDisabled: readout ? readout.disabled === true : null,
    menuBtnDisabled: menuBtn ? menuBtn.disabled === true : null,
    monthLabel: menuBtn ? menuBtn.textContent.trim().replace(/\s+/g, ' ') : null,
    menuOpen: menu ? !menu.classList.contains('hidden') : false,
    menuYearBtns: menu ? menu.querySelectorAll('[data-menu-year]').length : 0,
    menuMonthBtns: menu ? menu.querySelectorAll('[data-menu-month]').length : 0,
    menuTodayBtns: menu ? menu.querySelectorAll('[data-menu-today]').length : 0,
    menuYearLabel: menu ? (menu.querySelector('span') ? menu.querySelector('span').textContent.trim() : '') : null,
    menuCurrent: menu ? (menu.querySelector('[aria-current="true"]') ? Number(menu.querySelector('[aria-current="true"]').getAttribute('data-menu-month')) + 1 : null) : null,
    menuBtnExpanded: menuBtn ? menuBtn.getAttribute('aria-expanded') : null,
    menuBtnLabel: menuBtn ? menuBtn.textContent.trim().replace(/\s+/g, ' ') : null,
    calOpen: cal ? !cal.classList.contains('hidden') : false,
    calDayBtns: cal ? cal.querySelectorAll('[data-cal-date]').length : 0,
    calSelected: sel ? (sel.getAttribute('data-cal-date') || '') : null,
    calToday: cal ? Boolean(cal.querySelector('.mini-cal-today')) : false,
    countText: q('#bulletin-title-count') ? q('#bulletin-title-count').textContent.trim() : null,
    rows: rowsEl.length,
    rowIds: rowsEl.map((r) => r.getAttribute('data-bulletin-toggle')),
    rowDays: rowsEl.map((r) => r.getAttribute('data-target-day') || ''),
    rowUnread: rowsEl.map((r) => r.getAttribute('data-unread')),
    badgeRows: rowsEl.filter((r) => r.querySelector('.bulletin-unread-badge')).length,
    baseBadgeRows: rowsEl.filter((r) => r.querySelector('.bulletin-unread-badge') && !(r.getAttribute('data-target-day') || '')).length,
    seps: [...document.querySelectorAll('#bulletin-list-container .bulletin-day-sep')].length,
    activeTitle: actTitle ? actTitle.textContent.trim() : null,
    paneTitle: pane ? pane.textContent.trim() : null,
    listText: q('#bulletin-list-container') ? q('#bulletin-list-container').textContent.replace(/\s+/g, ' ').trim() : null,
    label: label ? label.textContent.trim() : null,
    labelHidden: label ? label.classList.contains('hidden') : null,
    sidebarText: badge ? badge.textContent.trim() : null,
    sidebarCount: badge ? Number(badge.textContent.trim()) : null,
    sidebarHidden: badge ? badge.classList.contains('hidden') : null,
    unreadText: unreadBtn ? unreadBtn.textContent.trim() : null,
    unreadDisabled: unreadBtn ? unreadBtn.disabled === true : null,
    unreadPressed: unreadBtn ? unreadBtn.getAttribute('aria-pressed') : null,
    unreadHidden: unreadBtn ? unreadBtn.classList.contains('hidden') : null,
    searchValue: q('#bulletin-search-input') ? q('#bulletin-search-input').value : null,
    activeId: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    state: window.__bulletinSnap ? window.__bulletinSnap() : null,
  };
});

/** 列表の idx 行目をクリックして { id, title } を返す */
const clickRow = (p, idx) => p.evaluate((i) => {
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const r = rows[i];
  if (!r) return null;
  const t = r.querySelector('.bulletin-row-title');
  r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { id: r.getAttribute('data-bulletin-toggle'), title: t ? t.textContent.trim() : null };
}, idx);

/** 未読バッヂの行（列表の上から1件目）をクリックして { id, title } を返す（行はクリック後も列表に残る） */
const clickUnreadRow = (p) => p.evaluate(() => {
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const r = rows.find((x) => x.getAttribute('data-unread') === 'true');
  if (!r) return null;
  const t = r.querySelector('.bulletin-row-title');
  r.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return { id: r.getAttribute('data-bulletin-toggle'), title: t ? t.textContent.trim() : null };
});

/** 検索語を入力（打字と同じ input イベント）→ 空なら消して本日列表へ戻す */
const setSearch = (p, val) => p.evaluate((v) => {
  const input = document.getElementById('bulletin-search-input');
  if (!input) return false;
  input.value = v;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
}, val);

/** 列表のキー操作（フォーカスを列表へ戻して押す） */
const press = async (p, key) => {
  await p.evaluate(() => {
    const r = document.querySelector('#bulletin-list-container [data-bulletin-toggle]');
    if (r) r.focus(); else document.body.focus();
  });
  await p.keyboard.press(key);
  await sleep(300);
};

// ===== 0. 固定データ投入（このテストが自前で14件の掲示を作る）＋既読リセット（ack 全消し）と期待値計算 =====
// 掲示台は posts テーブル、既読は post_acknowledgements テーブル（status='READ'/'APPROVED'）。
const FIXTURES = [
  ['uit-b1', 'A1(全日1件目)', '本文A1', '2026-04-22', true],
  ['uit-b2', 'B(本日列表1件目)', '本文B', today, false],
  ['uit-b3', 'C(本日列表2件目)', '本文C', today, false],
  ['uit-b4', 'D(本日列表3件目)', '本文D', today, false],
  ['uit-b5', 'E(明日列表1件目)', '本文E', shiftDate(today, 1), false],
  ['uit-b6', 'F(明日列表2件目)', '本文F', shiftDate(today, 1), false],
  ['uit-b7', 'G(全日2件目)', '本文G', shiftDate(today, 7), true],
  ['uit-b8', 'H(全日3件目)', '本文H', '2026-09-15', true],
  ['uit-b9', 'I(全日4件目)', '本文I', '2026-09-15', true],
  ['uit-b10', 'J(全日5件目)', '本文J', shiftDate(today, 1), false],
  ['uit-b11', 'K(全日6件目)', '本文K', today, false],
  ['uit-b12', 'L(全日7件目)', '本文L', '2027-01-15', false],
  ['uit-b13', 'M(全日8件目)', '本文M', today, false],
  ['uit-b14', 'Z(本日列表4件目)', '本文Z', today, false],
];

// 掲示期間（display_start/end）は全部「本日有効」にする（客户端キャッシュの除外規則を通すため）
const fixRows = FIXTURES.map(([id, title, content, target, search], i) => {
  const posted = target + ' 09:' + String(i).padStart(2, '0') + ':00';  // 同一目標日では投稿時刻で並ぶ（09:00〜09:13 の固有時刻）
  return [id, title, content, target, shiftDate(target, -20), shiftDate(target, 30), posted, search];
});

await query("DELETE FROM posts WHERE id LIKE 'uit-b%'");
for (const [id, title, content, target, start, end, posted, search] of fixRows) {
  await query(
    `INSERT INTO posts (id, title, content, author_id, target_scope, attachments, is_deleted, created_at, updated_at, posted_at, display_start_date, display_end_date, target_date)
     VALUES ($1,$2,$3,'kyomu01','{"grade":"ALL","department":"ALL"}','[]',0,$7,$7,$7,$5,$6,$4)`,
    [id, title, content, target, start, end, posted]
  );
}

await query('DELETE FROM post_acknowledgements');
const ackLeft = (await query('SELECT COUNT(*) AS c FROM post_acknowledgements')).rows[0].c;
log('db-reset', { fixtures: fixRows.length, ackLeft: Number(ackLeft) });
check('既読リセットで post_acknowledgements が 0 件（全掲示が未読に戻る）', Number(ackLeft) === 0, { ackLeft: Number(ackLeft) });

const loginRes = await caFetch('/api/auth/login', { method: 'POST', body: JSON.stringify({ staff_code: 'kyomu01', password: 'password123' }) });
check('API ログイン（kyomu01）', loginRes.ok, { status: loginRes.status });
const token = (await loginRes.json()).token;
const bulletsRes = await caFetch('/api/bulletins?count=100', { headers: { Authorization: 'Bearer ' + token } });
check('API 掲示一覧（kyomu01）', bulletsRes.ok, { status: bulletsRes.status });
const items = (await bulletsRes.json()).bulletins || [];

const userRes = await query("SELECT created_at FROM users WHERE id='kyomu01'");
const regDay = jstDay(userRes.rows[0].created_at);
log('registered-day', regDay);

// 期待値の宇宙（universe）はログイン後にアプリが実際にキャッシュしている掲示 id（window.__bulletinSnap().cache）。
// サーバ一覧は掲示期間・スコープで絞り込まれるため、API 全件をそのまま期待値にしない。
const q = '全日';  // 固定データはこの語を含むタイトルを持つ

// ===== 1. 教務で画面ログインして掲示タブを開く =====
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.setDefaultTimeout(45000);
page.setDefaultNavigationTimeout(45000);

await page.goto(BASE + '/dashboard.html', { waitUntil: 'networkidle2' });
await page.type('#login-userid', 'kyomu01');
await page.type('#login-password', 'password123');
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 15000 });
await sleep(1000);
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);

// 掲示タブをクリック（サイドバーのナビ項目）
await page.evaluate(() => { const a = document.querySelector('a[data-tab="bulletin"]'); if (a) a.click(); });
await sleep(800);

const start = await snapshot(page);

// アプリが実際にキャッシュしている掲示 id を宇宙にする（DOM と同じ土台で期待値を作る）
const cacheIds = (start.state ? start.state.cache : []).map(String);
const universe = cacheIds.map((id) => items.find((b) => String(b.id) === id)).filter(Boolean);
const unreadItems = universe.filter((b) => isUnreadFor(b, regDay));
const N = unreadItems.length;
const startRowsApi = universe.filter((b) => isActiveOn(b, today) && targetOf(b) === today).sort((a, b) => postedMs(b) - postedMs(a));
// ★ 右ペインに表示されるだけでは既読にならない（本日列表の最上位が自動選択されても未読のまま）
const baseUnreadRows = startRowsApi.filter((b) => isUnreadFor(b, regDay)).length;
// 全日未読の期待集合（base-mode と同じ土台）。対象日降順→投稿日時降順に並べる
const sortedUnread = sortFull(unreadItems);
const newestUnread = sortedUnread[0];
const startCount = startRowsApi.length;
const searchApi = sortFull(universe.filter((b) => matchesQ(b, q)));
const searchCount = searchApi.length;
const searchGroups = new Set(searchApi.map(targetOf)).size;
log('api-expect', {
  apiItems: items.length, cacheItems: cacheIds.length, universe: universe.length,
  N, startCount, startIds: startRowsApi.map((b) => b.id),
  baseUnreadRows, newestUnreadId: newestUnread ? newestUnread.id : null, searchCount, searchGroups,
});
check('期待値が成立（未読 N >= 2、本日列表 startCount >= 1、宇宙 cache は N 以上、本日列表の未読行 baseUnreadRows >= 1）',
  N >= 2 && startCount >= 1 && universe.length >= N && baseUnreadRows >= 1,
  { N, startCount, universe: universe.length, baseUnreadRows });

log('start', { readoutText: start.readoutText, centerDate: start.centerDate, countText: start.countText, rows: start.rows, rowIds: start.rowIds, seps: start.seps, label: start.label, labelHidden: start.labelHidden, sidebarText: start.sidebarText, sidebarHidden: start.sidebarHidden, unreadText: start.unreadText, unreadHidden: start.unreadHidden, unreadPressed: start.unreadPressed, unreadDisabled: start.unreadDisabled, calOpen: start.calOpen, paneTitle: start.paneTitle, activeTitle: start.activeTitle, badgeRows: start.badgeRows });

check('掲示タブが開いて列表が本日列表（rows == startCount、件数表示「N 件」、中心日 readout は本日の日付、控件は enabled）',
  start.rows === startCount && start.countText === startCount + ' 件'
  && String(start.readoutText).startsWith(mmdd(today)) && start.centerDate === today
  && start.prevDisabled === false && start.nextDisabled === false && start.dayBtnDisabled === false,
  { rows: start.rows, countText: start.countText, readoutText: start.readoutText, centerDate: start.centerDate, prevDisabled: start.prevDisabled, nextDisabled: start.nextDisabled, dayBtnDisabled: start.dayBtnDisabled });

// 行ごとの未読計算（UI のバッヂと突き合わせて调试するため生データを出す）
log('start-rows-calc', startRowsApi.map((b) => ({
  id: b.id,
  target: targetOf(b),
  posted: postedOf(b),
  postedDay: jstDay(postedOf(b)),
  regDay,
  ack: b.ackStatus || b.ack_status,
  start: startOf(b),
  end: endOf(b),
  unreadCalc: isUnreadFor(b, regDay),
})));

check('初期状態で未読ボタンとサイドバーのバッヂは全日未読 N（右ペインの自動選択では既読化しないので N のまま、両方 visible、件数一致）、未読ボタンは pressed false・enabled・非 hidden、ミニカレンダーは閉じている',
  start.unreadText === '未読 ' + N && start.unreadHidden === false
  && start.sidebarCount === N && start.sidebarHidden === false
  && start.unreadPressed === 'false' && start.unreadDisabled === false
  && start.calOpen === false,
  { unreadText: start.unreadText, unreadHidden: start.unreadHidden, sidebarCount: start.sidebarCount, sidebarHidden: start.sidebarHidden, unreadPressed: start.unreadPressed, unreadDisabled: start.unreadDisabled, calOpen: start.calOpen, N });

check('本日列表の行に data-target-day チップは付かない（day モード）、見出し区切りは出ない、未読バッヂの行数は本日列表の未読行と一致（右ペインの自動選択で既読化しないので全未読行に残る）',
  start.rowDays.every((d) => d === '') && start.seps === 0
  && start.badgeRows === baseUnreadRows,
  { rowDays: start.rowDays, seps: start.seps, badgeRows: start.badgeRows, expectBadge: baseUnreadRows });

check('自動選択で右ペインのタイトルは本日列表の最新行（投稿日時降順1件目）、列表の active も同じ行で、その行は未読のまま（表示だけでは既読にならない＝data-unread=true・バッヂあり）',
  start.paneTitle === startRowsApi[0].title && start.activeTitle === startRowsApi[0].title
  && start.rowIds[0] === String(startRowsApi[0].id)
  && start.rowUnread[0] === 'true' && start.state.selectedId === String(startRowsApi[0].id),
  { paneTitle: start.paneTitle, activeTitle: start.activeTitle, expectTitle: startRowsApi[0].title,
    rowIds: start.rowIds, rowUnread: start.rowUnread, selectedId: start.state.selectedId });

// ===== 2. 未読ボタンクリック（全日の未読一覧＋readout「未読」、控件は止まる、ミニカレンダーは自動で開かない） =====
await page.evaluate(() => { const b = document.querySelector('#view-bulletin #bulletin-btn-unread'); if (b) b.click(); });
await sleep(600);
const u = await snapshot(page);
log('unread-click', { readoutText: u.readoutText, centerDate: u.centerDate, prevDisabled: u.prevDisabled, nextDisabled: u.nextDisabled, dayBtnDisabled: u.dayBtnDisabled, menuBtnDisabled: u.menuBtnDisabled, calOpen: u.calOpen, rows: u.rows, rowIds: u.rowIds, rowUnread: u.rowUnread, rowDays: u.rowDays, seps: u.seps, badgeRows: u.badgeRows, sidebarText: u.sidebarText, label: u.label, labelHidden: u.labelHidden, unreadDisabled: u.unreadDisabled, unreadPressed: u.unreadPressed, unreadText: u.unreadText, unreadHidden: u.unreadHidden, paneTitle: u.paneTitle, countText: u.countText, unreadMode: u.state.unreadMode });

check('未読ボタンクリックで readout は「未読」、中心日は本日、‹ ›・中心日クリックは disabled（年月選択ボタンは閉じたミニカレンダー側に在らない＝null）、ミニカレンダーは自動で開かない、未読ボタンは pressed true で enabled（未読表示中ももう一度押して復帰できる）',
  u.readoutText === '未読' && u.centerDate === today
  && u.prevDisabled === true && u.nextDisabled === true && u.dayBtnDisabled === true
  && u.menuBtnDisabled === null && u.calOpen === false
  && u.unreadDisabled === false && u.unreadPressed === 'true'
  && u.state.unreadMode === true,
  { readoutText: u.readoutText, centerDate: u.centerDate, prevDisabled: u.prevDisabled, nextDisabled: u.nextDisabled, dayBtnDisabled: u.dayBtnDisabled, menuBtnDisabled: u.menuBtnDisabled, calOpen: u.calOpen, unreadDisabled: u.unreadDisabled, unreadPressed: u.unreadPressed, unreadHidden: u.unreadHidden });

// ★ 未読列表は未読ボタンを押した時点の未読 N 件をピン留めする（右ペインの自動選択では既読化しないので N 件そのまま）。
//   列表の並びは対象日降順→投稿日時降順。ピン留め Set は cache 順で持たれるので集合として突き合わせる
const pinnedIds = sortedUnread.map((b) => String(b.id));
const sortedJoin = (arr) => arr.map(String).slice().sort().join(',');
check('未読列表はピン留めした N 件（未読ボタンを押した時点の未読全部）。右ペインの自動選択は既読化しないので全行が data-unread=true・未読バッヂあり、data-target-day チップと対象日見出し、ラベルとサイドバーは N',
  u.rows === N && u.countText === N + ' 件'
  && u.rowIds.join(',') === pinnedIds.join(',')
  && sortedJoin(u.state.pinnedUnread) === sortedJoin(pinnedIds)
  && u.rowUnread.every((v) => v === 'true')
  && u.badgeRows === N
  && u.rowDays.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
  && u.seps === new Set(sortedUnread.map(targetOf)).size
  && u.unreadText === '未読 ' + N && u.unreadHidden === false
  && u.sidebarCount === N && u.sidebarHidden === false,
  { rows: u.rows, countText: u.countText, rowIds: u.rowIds, pinnedIds, pinned: u.state.pinnedUnread, rowUnread: u.rowUnread, badgeRows: u.badgeRows, rowDays: u.rowDays, seps: u.seps, unreadText: u.unreadText, sidebarCount: u.sidebarCount });

// ★ 右ペインは未読表示に入る前に出ていた行（本日列表の最上位）の全文のまま。その行はピン留めリストに残り、未読バッヂも残る
const startSelectedId = String(start.state.selectedId);
check('未読表示に入ると右ペインは未読列表に残っている選択行（本日列表の最上位）の全文のまま＝表示だけでは既読にならない（その行は data-unread=true・バッヂあり、列表の active も同じ行）',
  u.paneTitle === start.paneTitle && u.activeTitle === start.paneTitle
  && String(u.state.selectedId) === startSelectedId
  && u.rowIds.includes(startSelectedId)
  && u.rowUnread[u.rowIds.indexOf(startSelectedId)] === 'true',
  { paneTitle: u.paneTitle, activeTitle: u.activeTitle, startPaneTitle: start.paneTitle,
    startSelectedId, selectedId: u.state.selectedId, rowIds: u.rowIds, rowUnread: u.rowUnread });

// ===== 2b. タイトル行クリックで既読化（左列の行は消えない＝バッヂだけ消える）。既読行の再クリックは状態を変えない =====
const k0row = await clickRow(page, 0);   // 右ペインに自動選択されている「未読」の行をクリックして既読化する（表示だけでは既読にならない）
await sleep(400);
const k1 = await snapshot(page);
log('row-click-read', { clickedId: k0row.id, rows: k1.rows, badgeRows: k1.badgeRows, sidebarCount: k1.sidebarCount, unreadText: k1.unreadText, paneTitle: k1.paneTitle, rowUnread: k1.rowUnread });
check('タイトル行をクリックすると行は列表に残り、バッヂ・ラベル・サイドバーだけ 1 減る（右ペインはその行の全文、クリックした行だけ data-unread=false）',
  k1.rows === N && k1.rowIds.join(',') === pinnedIds.join(',') && k1.badgeRows === N - 1
  && k1.sidebarCount === N - 1 && k1.unreadText === '未読 ' + (N - 1)
  && k1.rowUnread[k1.rowIds.indexOf(k0row.id)] === 'false' && k1.paneTitle === k0row.title,
  { clickedId: k0row.id, rows: k1.rows, badgeRows: k1.badgeRows, sidebarCount: k1.sidebarCount, unreadText: k1.unreadText, paneTitle: k1.paneTitle, rowUnread: k1.rowUnread });

// ★ DB 実測（post_acknowledgements）: 行クリックで初めて既読レコード 1 件（右ペイン表示だけでは 0 件のままだった）
const acks1 = Number((await query("SELECT COUNT(*) AS c FROM post_acknowledgements WHERE user_id = 'kyomu01'")).rows[0].c);
log('acks-after-first-click', { acks1, N });
check('タイトル行クリックで DB の既読レコードが 1 件（右ペイン表示だけの時点では既読レコード 0 件＝サイドバーは未読 N）', acks1 === 1, { acks1, N });

await clickRow(page, 0);   // 既読行を再クリック（既読カードの再クリックは API を叩かない＝冪等）
await sleep(400);
const k1b = await snapshot(page);
log('row-reclick', { rows: k1b.rows, badgeRows: k1b.badgeRows, sidebarCount: k1b.sidebarCount, unreadText: k1b.unreadText, paneTitle: k1b.paneTitle });
check('既読行を再クリックしても列表のピン留め N 件・バッヂ N-1・サイドバー N-1 はそのまま（未読バッヂの行は消えない）',
  k1b.rows === N && k1b.rowIds.join(',') === pinnedIds.join(',') && k1b.badgeRows === N - 1 && k1b.sidebarCount === N - 1,
  { rows: k1b.rows, badgeRows: k1b.badgeRows, sidebarCount: k1b.sidebarCount, unreadText: k1b.unreadText });

const k2row = await clickUnreadRow(page);   // 未読バッヂの行をクリックして全文を右ペインに出す（＝既読化）
await sleep(500);
const k2 = await snapshot(page);
log('row-read-keep', { clickedId: k2row.id, rows: k2.rows, badgeRows: k2.badgeRows, sidebarCount: k2.sidebarCount, unreadText: k2.unreadText, paneTitle: k2.paneTitle });
check('未読行をクリックすると行は列表に残り、バッヂだけ消えてラベルとサイドバーが1減る（右ペインはその行の全文）',
  k2.rows === N && k2.rowIds.includes(k2row.id) && k2.badgeRows === N - 2
  && k2.sidebarCount === N - 2 && k2.unreadText === '未読 ' + (N - 2) && k2.paneTitle === k2row.title,
  { clickedId: k2row.id, rows: k2.rows, badgeRows: k2.badgeRows, sidebarCount: k2.sidebarCount, unreadText: k2.unreadText, paneTitle: k2.paneTitle, rowIds: k2.rowIds });

// ===== 3. 未読ボタンをもう一度押して日付表示へ復帰する（未読行が残っていても復帰できる） =====
await page.evaluate(() => { const b = document.querySelector('#view-bulletin #bulletin-btn-unread'); if (b) b.click(); });
await sleep(500);
const back = await snapshot(page);
log('unread-button-exit', { readoutText: back.readoutText, centerDate: back.centerDate, rows: back.rows, countText: back.countText, unreadPressed: back.unreadPressed, unreadDisabled: back.unreadDisabled, unreadText: back.unreadText, sidebarCount: back.sidebarCount, pinned: back.state.pinnedUnread, unreadMode: back.state.unreadMode, prevDisabled: back.prevDisabled, nextDisabled: back.nextDisabled });
check('未読表示中は未読ボタンが enabled で、もう一度押すと未読行（N-2 件）が残っていても日付表示へ復帰する（readout は本日、列表は本日列表 startCount 件、pressed=false、ピン留めは空、‹ › は enabled、ラベルとサイドバーは未読 N-2 で visible）',
  back.state.unreadMode === false && back.state.pinnedUnread.length === 0
  && String(back.readoutText).startsWith(mmdd(today)) && back.centerDate === today
  && back.rows === startCount && back.countText === startCount + ' 件'
  && back.unreadPressed === 'false' && back.unreadDisabled === false
  && back.sidebarCount === N - 2 && back.unreadText === '未読 ' + (N - 2) && back.sidebarHidden === false
  && back.prevDisabled === false && back.nextDisabled === false && back.calOpen === false,
  { readoutText: back.readoutText, centerDate: back.centerDate, rows: back.rows, pinned: back.state.pinnedUnread, unreadPressed: back.unreadPressed, unreadDisabled: back.unreadDisabled, sidebarCount: back.sidebarCount, startCount, N });

// ===== 4. 未読表示へ戻して全件を読む（列表の行は消えない。全件読むと未読表示は自動で閉じて本日列表へ復帰する） =====
await page.evaluate(() => { const b = document.querySelector('#view-bulletin #bulletin-btn-unread'); if (b) b.click(); });
await sleep(500);
const u2 = await snapshot(page);
const pinned2 = u2.state.pinnedUnread.map(String);
log('unread-reenter', { rows: u2.rows, pinned: pinned2, badgeRows: u2.badgeRows, sidebarCount: u2.sidebarCount, unreadText: u2.unreadText });
check('未読表示へ戻すと現在の未読 N-2 件をピン留めして列表に出す（右ペインの自動選択は既読化しない＝バッヂとサイドバーは N-2、列表の行は N-2 件で全行 data-unread=true）',
  u2.rows === N - 2 && u2.rowIds.join(',') === pinned2.join(',') && u2.badgeRows === N - 2
  && u2.rowUnread.every((v) => v === 'true')
  && u2.sidebarCount === N - 2 && u2.unreadText === '未読 ' + (N - 2),
  { rows: u2.rows, pinned: pinned2, badgeRows: u2.badgeRows, sidebarCount: u2.sidebarCount, unreadText: u2.unreadText, rowUnread: u2.rowUnread });

// 再入りでも右ペインは未読列表に残っている選択行の全文のまま（表示だけでは既読にならない）
const u2Auto = items.find((b) => String(b.id) === String(u2.state.selectedId));
check('未読表示への再入りの自動選択は既読化しない（右ペインのタイトルは選択行の全文で、その行は data-unread=true・バッヂありのまま）',
  u2Auto && u2.paneTitle === u2Auto.title && u2.activeTitle === u2Auto.title
  && u2.rowIds.includes(String(u2.state.selectedId))
  && u2.rowUnread[u2.rowIds.indexOf(String(u2.state.selectedId))] === 'true',
  { paneTitle: u2.paneTitle, activeTitle: u2.activeTitle, expectTitle: u2Auto ? u2Auto.title : null, selectedId: u2.state.selectedId, rowUnread: u2.rowUnread });

// ===== 5. 列表の行クリック＝既読化（行は消えない。バッヂとラベル・サイドバーだけが1件ずつ減る）。全件読むと未読表示は閉じて本日列表へ自動復帰 =====
const consumed = [k0row, k2row];   // クリックで既読化した行（k0row = 未読列表の最新1件＝右ペインに自動選択されていた行）。表示だけの自動選択は既読化しない
let guard = 0;
let cur = u2;
while (cur.badgeRows > 0 && cur.state.unreadMode === true && guard < N) {
  guard += 1;
  const row = await clickUnreadRow(page);
  await sleep(500);
  const s = await snapshot(page);
  consumed.push(items.find((b) => String(b.id) === row.id));
  log('row-click-' + guard, { clickedId: row.id, badgesBefore: cur.badgeRows, badgesAfter: s.badgeRows, rows: s.rows, sidebarCount: s.sidebarCount, unreadText: s.unreadText, paneTitle: s.paneTitle, unreadMode: s.state.unreadMode });
  const last = cur.badgeRows === 1;
  // 右ペインは読んだ行の全文を出す（クリックした行のまま＝行は列表に残る）。最後の1件を読むと未読表示は閉じて本日列表へ自動復帰する。
  //   復帰した本日列表に読んだ行が残る（＝対象日が本日）なら右ペインはその行のまま。
  //   残らない（対象日が本日でない）なら本日列表の最上位が自動選択される。
  const paneExpect = last
    ? (startRowsApi.some((b) => String(b.id) === row.id) ? row.title : startRowsApi[0].title)
    : row.title;
  check('行クリック ' + guard + ': クリックした行は列表に残る（未読バッヂの行は左列から消えない）。バッヂ・ラベル・サイドバーだけ1減り、右ペインは読んだ行の全文（最後の1件を読むと未読表示は閉じて本日列表へ自動復帰し、右ペインは本日列表の最上位）',
    (last ? (s.rows === startCount && s.state.unreadMode === false)
          : (s.rows === cur.rows && s.rowIds.includes(row.id)))
    && s.badgeRows === cur.badgeRows - 1
    && s.sidebarCount === cur.sidebarCount - 1
    && s.unreadText === '未読 ' + (cur.badgeRows - 1)
    && s.paneTitle === paneExpect,
    { clickedId: row.id, badgesBefore: cur.badgeRows, badgesAfter: s.badgeRows, rowsBefore: cur.rows, rowsAfter: s.rows,
      sidebarCount: s.sidebarCount, unreadText: s.unreadText, paneTitle: s.paneTitle, expectPane: paneExpect,
      unreadMode: s.state.unreadMode, last });
  cur = s;
}
check('未読全件（N 件）が行クリックで既読化された（2b のクリック 2 件＋列表クリック ' + guard + ' 件。右ペイン表示の自動選択は既読化しない）。列表の行は最後まで消えない', consumed.length === N && Number(start.sidebarCount) === N && cur.rows === startCount, { consumedIds: consumed.map((b) => b && b.id), N, uiCount: Number(start.sidebarCount), rowsAtEnd: cur.rows, clicks: guard });

const z = await snapshot(page);
log('unread-zero-exit', { readoutText: z.readoutText, centerDate: z.centerDate, countText: z.countText, rows: z.rows, unreadText: z.unreadText, unreadHidden: z.unreadHidden, sidebarHidden: z.sidebarHidden, sidebarCount: z.sidebarCount, unreadDisabled: z.unreadDisabled, unreadPressed: z.unreadPressed, prevDisabled: z.prevDisabled, nextDisabled: z.nextDisabled, calOpen: z.calOpen, unreadMode: z.state.unreadMode });

check('全件読むと未読表示は閉じて本日列表へ自動復帰（readout は本日の日付、控件は enabled、ラベルとサイドバーは未読 0 で hidden、列表は本日の列表、ミニカレンダーは閉じたまま）',
  z.rows === startCount && z.countText === startCount + ' 件'
  && String(z.readoutText).startsWith(mmdd(today)) && z.centerDate === today
  && z.prevDisabled === false && z.nextDisabled === false && z.dayBtnDisabled === false
  && z.unreadDisabled === false && z.unreadPressed === 'false' && z.unreadHidden === true
  && z.unreadText === '未読 0'
  && z.sidebarHidden === true && z.sidebarCount === 0
  && z.baseBadgeRows === 0
  && z.state.unreadMode === false && z.calOpen === false,
  { readoutText: z.readoutText, centerDate: z.centerDate, countText: z.countText, rows: z.rows, unreadText: z.unreadText, unreadHidden: z.unreadHidden, sidebarHidden: z.sidebarHidden, sidebarCount: z.sidebarCount, baseBadgeRows: z.baseBadgeRows, unreadDisabled: z.unreadDisabled, unreadPressed: z.unreadPressed, calOpen: z.calOpen });

check('本日列表の行の data-target-day チップは付かない（day モードに戻った）、見出し区切りは出ない',
  z.rowDays.every((d) => d === '') && z.seps === 0,
  { rowDays: z.rowDays, seps: z.seps });

// ===== 4. ←/→ キーと ‹ › ボタン（本日列表では中心日が±1日動く） =====
await press(page, 'ArrowRight');
const r1 = await snapshot(page);
log('arrow-right', { centerDate: r1.centerDate, readoutText: r1.readoutText });
check('→ キーで中心日が翌日へ（readout は翌日の日付、列表はその日の列表）',
  r1.centerDate === shiftDate(today, 1) && String(r1.readoutText).startsWith(mmdd(shiftDate(today, 1))),
  { centerDate: r1.centerDate, expect: shiftDate(today, 1), readoutText: r1.readoutText });

await press(page, 'ArrowLeft');
await press(page, 'ArrowLeft');
const r2 = await snapshot(page);
log('arrow-left2', { centerDate: r2.centerDate });
check('← キー2回で中心日が前日へ', r2.centerDate === shiftDate(today, -1), { centerDate: r2.centerDate, expect: shiftDate(today, -1) });

await press(page, 'ArrowRight');
const r3 = await snapshot(page);
check('→ キーで本日へ戻る（中心日と readout は本日の日付、列表は本日の列表）',
  r3.centerDate === today && String(r3.readoutText).startsWith(mmdd(today)) && r3.rows === startCount,
  { centerDate: r3.centerDate, readoutText: r3.readoutText, rows: r3.rows });

// ‹ › ボタンクリックでも中心日が動く
await page.evaluate(() => document.getElementById('bulletin-day-next').click());
await sleep(300);
const b1 = await snapshot(page);
await page.evaluate(() => document.getElementById('bulletin-day-prev').click());
await sleep(300);
const b2 = await snapshot(page);
log('day-buttons', { next: b1.centerDate, prev: b2.centerDate });
check('› ボタンで翌日、‹ ボタンで本日へ戻る', b1.centerDate === shiftDate(today, 1) && b2.centerDate === today, { next: b1.centerDate, prev: b2.centerDate });

// ===== 5. T キー（未読表示を閉じて本日へ、ミニカレンダーは閉じたまま） =====
await press(page, 'ArrowRight');  // 翌日へ
const t1 = await snapshot(page);
await press(page, 't');
const t2 = await snapshot(page);
log('t-key', { before: t1.centerDate, after: t2.centerDate, readoutText: t2.readoutText, rows: t2.rows, calOpen: t2.calOpen, labelHidden: t2.labelHidden, sidebarHidden: t2.sidebarHidden, unreadMode: t2.state.unreadMode });
check('T キーで中心日が本日へ戻る（readout は本日の日付、列表は本日の列表、ミニカレンダーは閉じたまま、未読ボタンとサイドバーのバッヂは未読 0 で hidden）',
  t2.centerDate === today && String(t2.readoutText).startsWith(mmdd(today)) && t2.rows === startCount
  && t2.calOpen === false && t2.unreadHidden === true && t2.sidebarHidden === true
  && t2.state.unreadMode === false,
  { before: t1.centerDate, after: t2.centerDate, readoutText: t2.readoutText, rows: t2.rows, calOpen: t2.calOpen, unreadHidden: t2.unreadHidden, sidebarHidden: t2.sidebarHidden });

// ===== 6. C キー（ミニカレンダー開閉。本日列表では開く、未読表示・検索中は止まる） =====
await press(page, 'c');
const c1 = await snapshot(page);
log('c-open', { calOpen: c1.calOpen, monthLabel: c1.monthLabel, calSelected: c1.calSelected, calToday: c1.calToday, calDayBtns: c1.calDayBtns, menuBtnDisabled: c1.menuBtnDisabled, readoutText: c1.readoutText });
check('C キーでミニカレンダーが開く（今月の日数ぶんだけの日ボタン、中心日セルが selected、本日セルに mini-cal-today、年月ラベルは 2026年11月で enabled、readout は本日の日付のまま）',
  c1.calOpen === true && c1.calDayBtns === daysInMonth(year, month) && c1.calSelected === today && c1.calToday === true
  && c1.menuBtnDisabled === false && /^2026年11月\s*$/u.test(String(c1.monthLabel))
  && String(c1.readoutText).startsWith(mmdd(today)),
  { calOpen: c1.calOpen, calDayBtns: c1.calDayBtns, calSelected: c1.calSelected, calToday: c1.calToday, monthLabel: c1.monthLabel, menuBtnDisabled: c1.menuBtnDisabled });

await press(page, 'c');
const c2 = await snapshot(page);
check('C キーでミニカレンダーが閉じる（ラベルボタンは DOM に残り enabled で expanded=false）', c2.calOpen === false && c2.menuBtnDisabled === false, { calOpen: c2.calOpen, menuBtnDisabled: c2.menuBtnDisabled });

// ===== 7. 未読 0 件で未読ボタン（hidden）を JS クリック → readout「未読」・列表 0 件・C キーは止まる・T キーで本日へ =====
await page.evaluate(() => { const b = document.querySelector('#view-bulletin #bulletin-btn-unread'); if (b) b.click(); });
await sleep(500);
const z1 = await snapshot(page);
log('unread-zero-mode', { readoutText: z1.readoutText, centerDate: z1.centerDate, rows: z1.rows, prevDisabled: z1.prevDisabled, nextDisabled: z1.nextDisabled, dayBtnDisabled: z1.dayBtnDisabled, unreadDisabled: z1.unreadDisabled, unreadPressed: z1.unreadPressed, calOpen: z1.calOpen, listText: z1.listText.slice(0, 40), unreadMode: z1.state.unreadMode });
check('未読 0 件で未読表示に入ると readout「未読」、列表 0 件（未読無しメッセージ）、‹ › と中心日クリックは disabled、未読ボタンは enabled（もう一度押して日付表示へ戻れる）、ミニカレンダーは閉じたまま',
  z1.readoutText === '未読' && z1.rows === 0 && z1.listText.includes('未読')
  && z1.prevDisabled === true && z1.nextDisabled === true && z1.dayBtnDisabled === true
  && z1.unreadDisabled === false && z1.unreadPressed === 'true' && z1.calOpen === false,
  { readoutText: z1.readoutText, rows: z1.rows, listText: z1.listText.slice(0, 40), prevDisabled: z1.prevDisabled, dayBtnDisabled: z1.dayBtnDisabled, unreadPressed: z1.unreadPressed, unreadDisabled: z1.unreadDisabled, calOpen: z1.calOpen });

// 未読 0 件でも未読ボタンをもう一度押して日付表示へ復帰できる
await page.evaluate(() => { const b = document.querySelector('#view-bulletin #bulletin-btn-unread'); if (b) b.click(); });
await sleep(400);
const z1b = await snapshot(page);
log('unread-zero-exit-btn', { readoutText: z1b.readoutText, centerDate: z1b.centerDate, rows: z1b.rows, unreadPressed: z1b.unreadPressed, unreadMode: z1b.state.unreadMode });
check('未読 0 件表示で未読ボタンをもう一度押すと日付表示へ復帰する（readout は本日の日付、列表は本日列表、pressed false）',
  z1b.state.unreadMode === false && String(z1b.readoutText).startsWith(mmdd(today)) && z1b.centerDate === today
  && z1b.rows === startCount && z1b.unreadPressed === 'false',
  { readoutText: z1b.readoutText, centerDate: z1b.centerDate, rows: z1b.rows, unreadPressed: z1b.unreadPressed });

// 未読 0 件を未読表示へ戻して ←/→・C キーが止まることを測る
await page.evaluate(() => { const b = document.querySelector('#view-bulletin #bulletin-btn-unread'); if (b) b.click(); });
await sleep(400);

// 未読表示中は ←/→・C キーが止まる
await press(page, 'ArrowRight');
const z2 = await snapshot(page);
await press(page, 'c');
const z3 = await snapshot(page);
log('unread-zero-blocked', { centerDate: z2.centerDate, readoutText: z2.readoutText, calOpen: z3.calOpen });
check('未読表示中は → キーも C キーも止まる（中心日は本日、readout「未読」、ミニカレンダーは開かない）',
  z2.centerDate === today && z2.readoutText === '未読' && z3.calOpen === false && z3.readoutText === '未読',
  { centerDate: z2.centerDate, readoutText: z2.readoutText, calOpen: z3.calOpen });

// T キーで未読表示を閉じて本日へ
await press(page, 't');
const z4 = await snapshot(page);
log('t-exit-zero', { readoutText: z4.readoutText, centerDate: z4.centerDate, rows: z4.rows, prevDisabled: z4.prevDisabled, unreadPressed: z4.unreadPressed, unreadMode: z4.state.unreadMode });
check('T キーで未読 0 件表示を閉じて本日列表へ復帰（readout は本日の日付、控件 enabled、未読ボタン pressed false）',
  z4.readoutText && String(z4.readoutText).startsWith(mmdd(today)) && z4.centerDate === today && z4.rows === startCount
  && z4.prevDisabled === false && z4.nextDisabled === false && z4.unreadPressed === 'false' && z4.state.unreadMode === false,
  { readoutText: z4.readoutText, centerDate: z4.centerDate, rows: z4.rows, prevDisabled: z4.prevDisabled, unreadPressed: z4.unreadPressed });

// ===== 8. 検索語入力（全日表示。readout「全日」、←/→・C 停止、行クリックは中心日を動かさない、語を消して本日へ） =====
await setSearch(page, q);
await sleep(500);
const s1 = await snapshot(page);
log('search', { readoutText: s1.readoutText, centerDate: s1.centerDate, countText: s1.countText, rows: s1.rows, rowIds: s1.rowIds, rowDays: s1.rowDays, seps: s1.seps, paneTitle: s1.paneTitle, activeTitle: s1.activeTitle, prevDisabled: s1.prevDisabled, nextDisabled: s1.nextDisabled, dayBtnDisabled: s1.dayBtnDisabled, menuBtnDisabled: s1.menuBtnDisabled, calOpen: s1.calOpen, unreadHidden: s1.unreadHidden, sidebarHidden: s1.sidebarHidden, searchValue: s1.searchValue, currentSearch: s1.state.currentSearch, unreadMode: s1.state.unreadMode });

check('検索語入力中は全日表示（readout「全日」、‹ ›・中心日クリック・年月選択ボタン disabled、ミニカレンダーは閉じている、列表は検索該当全件、data-target-day チップと対象日見出し、件数表示とラベル/サイドバーは未読 0 で hidden、内部状態 currentSearch と filtered）',
  s1.readoutText === '全日' && s1.centerDate === today
  && s1.rows === searchCount && s1.countText === searchCount + ' 件'
  && s1.rowIds.join(',') === searchApi.map((b) => String(b.id)).join(',')
  && s1.rowDays.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) && s1.seps === searchGroups
  && s1.prevDisabled === true && s1.nextDisabled === true && s1.dayBtnDisabled === true
  && s1.menuBtnDisabled === true && s1.calOpen === false
  && s1.state.currentSearch === q && s1.state.filtered.length === searchCount
  && s1.unreadHidden === true && s1.sidebarHidden === true && s1.searchValue === q,
  { readoutText: s1.readoutText, centerDate: s1.centerDate, rows: s1.rows, countText: s1.countText, rowIds: s1.rowIds, expectIds: searchApi.map((b) => String(b.id)), seps: s1.seps, searchGroups, prevDisabled: s1.prevDisabled, dayBtnDisabled: s1.dayBtnDisabled, menuBtnDisabled: s1.menuBtnDisabled, calOpen: s1.calOpen, currentSearch: s1.state.currentSearch, unreadHidden: s1.unreadHidden });

// 検索中の自動選択で右ペインは検索1件目（対象日降順→投稿日時降順）
check('検索中の右ペインのタイトルは検索該当の1件目、列表の active も同じ行',
  s1.paneTitle === searchApi[0].title && s1.activeTitle === searchApi[0].title,
  { paneTitle: s1.paneTitle, expectTitle: searchApi[0].title, activeTitle: s1.activeTitle });

// ←/→ は中心日を動かさない（検索語入力中は入力のフォーカスから止まる）
await page.evaluate(() => document.getElementById('bulletin-search-input').focus());
await page.keyboard.press('ArrowRight');
await sleep(300);
const s2 = await snapshot(page);
log('search-arrow-blocked', { centerDate: s2.centerDate, readoutText: s2.readoutText, rows: s2.rows });
check('検索語入力中は → キーが中心日を動かさない（readout「全日」のまま、列表は検索該当のまま）',
  s2.centerDate === today && s2.readoutText === '全日' && s2.rows === searchCount,
  { centerDate: s2.centerDate, readoutText: s2.readoutText, rows: s2.rows });

// 検索中の行クリックは中心日を動かさず、右ペインだけその行の全文へ
const rowS = await clickRow(page, 1);
await sleep(400);
const s3 = await snapshot(page);
log('search-row-click', { clickedId: rowS.id, centerDate: s3.centerDate, readoutText: s3.readoutText, paneTitle: s3.paneTitle, activeTitle: s3.activeTitle });
check('検索中の行クリックは中心日を動かさない（readout「全日」、中心日 data-day は本日、右ペインと active はクリックした行）',
  s3.centerDate === today && s3.readoutText === '全日' && s3.paneTitle === rowS.title
  && s3.activeTitle === rowS.title && s3.rows === searchCount,
  { clickedId: rowS.id, centerDate: s3.centerDate, readoutText: s3.readoutText, paneTitle: s3.paneTitle, activeTitle: s3.activeTitle });

// N キーは現行実装に無い（中心日も列表も変化しない）
await press(page, 'n');
const s4 = await snapshot(page);
log('n-key', { centerDate: s4.centerDate, readoutText: s4.readoutText, rows: s4.rows });
check('N キーは現行実装に無い＝検索語入力中は中心日・列表を変えない（readout「全日」、中心日 data-day は本日、列表は検索該当のまま）',
  s4.centerDate === today && s4.readoutText === '全日' && s4.rows === searchCount && s4.calOpen === false,
  { centerDate: s4.centerDate, readoutText: s4.readoutText, rows: s4.rows, calOpen: s4.calOpen });

// C キーは検索中は止まる
await press(page, 'c');
const s5 = await snapshot(page);
check('検索語入力中は C キーでミニカレンダーが開かない', s5.calOpen === false && s5.readoutText === '全日', { calOpen: s5.calOpen, readoutText: s5.readoutText });

// 検索語を消すと本日列表へ戻る
await setSearch(page, '');
await sleep(400);
const s6 = await snapshot(page);
log('search-clear', { readoutText: s6.readoutText, centerDate: s6.centerDate, rows: s6.rows, countText: s6.countText, searchValue: s6.searchValue, prevDisabled: s6.prevDisabled, dayBtnDisabled: s6.dayBtnDisabled });
check('検索語を消すと本日列表へ復帰（readout は本日の日付、列表は本日の列表、控件 enabled、searchValue は空）',
  String(s6.readoutText).startsWith(mmdd(today)) && s6.centerDate === today && s6.rows === startCount
  && s6.countText === startCount + ' 件' && s6.searchValue === ''
  && s6.prevDisabled === false && s6.nextDisabled === false && s6.dayBtnDisabled === false,
  { readoutText: s6.readoutText, centerDate: s6.centerDate, rows: s6.rows, countText: s6.countText, searchValue: s6.searchValue, prevDisabled: s6.prevDisabled });

// ===== 9. ミニカレンダーの年月選択ボタン（C で開いて年月選択・本日へ・‹ ›） =====
const openCal = async () => {
  await page.evaluate(() => { const b = document.querySelector('#view-bulletin #bulletin-day-current'); if (b) b.click(); });
  await sleep(400);
};
const openMenu = async () => {
  await page.evaluate(() => { const b = document.getElementById('bulletin-month-menu-btn'); if (b) b.click(); });
  await sleep(300);
};
// 年の ‹ › は data-menu-year="-1" / "1"（1回ぶんだけ押す、アンカーは年月ラベルの月）、月は data-menu-month が 0 始まり（3月は 2）
const chooseYear = async (delta) => {
  await page.evaluate((d) => { const b = document.querySelector('#bulletin-month-menu button[data-menu-year="' + d + '"]'); if (b) b.click(); }, delta);
  await sleep(200);
};
const chooseMonth = async (idx) => {
  await page.evaluate((i) => { const b = document.querySelector('#bulletin-month-menu button[data-menu-month="' + i + '"]'); if (b) b.click(); }, idx);
  await sleep(400);
};
const pickToday = async () => {
  await page.evaluate(() => { const b = document.querySelector('#bulletin-month-menu button[data-menu-today]'); if (b) b.click(); });
  await sleep(500);
};
const stepMonth = async (delta) => {
  await page.evaluate((d) => { const b = document.querySelector(d < 0 ? '#bulletin-cal-prev' : '#bulletin-cal-next'); if (b) b.click(); }, delta);
  await sleep(400);
};

const todayMonthLabel = year + '年' + (month + 1) + '月';

/** 今日から n 日ずれの日付キー YYYY-MM-DD（日付の期待値を今日基準で組み立て、カレンダー日が進むと落ちるようにしないため） */
const shiftKey = (k, n) => {
  const [y, m, d] = k.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
};
/** 日付キーの年月ラベル（例 2026年11月） */
const labelOfKey = (k) => {
  const [y, m] = k.split('-').map(Number);
  return y + '年' + m + '月';
};
/** 日付キーの月の日数 */
const daysOfKey = (k) => {
  const [y, m] = k.split('-').map(Number);
  return daysInMonth(y, m - 1);
};
const prevDay = shiftKey(today, -1);   // ‹（前日ボタン）で中心日が動く日

await openCal();
const m0 = await snapshot(page);
check('C キーでミニカレンダーが開く（メニューは閉じ、今月のボタンは aria-expanded="false"、今日が選択、今月ぶんだけの日ボタン、ラベルは本日月、readout は本日の日付）',
  m0.calOpen && m0.menuOpen === false && m0.monthLabel === todayMonthLabel &&
  m0.calDayBtns === daysInMonth(year, month) && m0.calSelected === today &&
  m0.menuBtnExpanded === 'false' && m0.menuBtnDisabled === false &&
  m0.centerDate === today, m0);

await openMenu();
const m1 = await snapshot(page);
check('年月選択ボタンでメニューが開く（年ラベルはアンカーの年 2026年、月ボタン12個、現在月 11月に aria-current、readout と center は据えたまま、ラベルボタン aria-expanded="true"）',
  m1.calOpen && m1.menuOpen && m1.monthLabel === todayMonthLabel &&
  m1.menuYearLabel === year + '年' && m1.menuMonthBtns === 12 &&
  m1.menuCurrent === month + 1 && m1.centerDate === today &&
  m1.menuBtnExpanded === 'true', m1);

// 2026年を ‹ 1回（2025年）→ 3月（data-menu-month="2"）へ
await chooseYear(-1);
await chooseMonth(2);
const m2 = await snapshot(page);
check('2025年3月を選ぶ（ラベルが 2025年3月 になり、readout の日付（2026-11-10）は据える、メニューは閉じる）',
  m2.monthLabel === '2025年3月' && m2.calOpen && m2.menuOpen === false &&
  m2.centerDate === today && m2.menuBtnExpanded === 'false', m2);

await pickToday();
const m3 = await snapshot(page);
check('年月選択の「本日へ」（readout と center は本日のまま、カレンダーは開いたまま、アンカーのラベルは 2025年3月、メニューは閉じる）',
  m3.centerDate === today && m3.calOpen === true && m3.monthLabel === '2025年3月' &&
  m3.menuOpen === false && m3.menuBtnExpanded === 'false', m3);

// C キーで閉じる
await press(page, 'c');
const m4 = await snapshot(page);
check('C キーでミニカレンダーが閉じる（center は本日のまま、ラベルは 2025年3月、ラベルボタンは aria-expanded=false で enabled）',
  m4.calOpen === false && m4.centerDate === today && m4.monthLabel === '2025年3月' &&
  m4.menuBtnExpanded === 'false' && m4.menuBtnDisabled === false, m4);

// 中心日クリックもミニカレンダーのトグル（開く・閉じる）
await openCal();
const m5 = await snapshot(page);
check('中心日クリックでミニカレンダーが開く（アンカーは本日へリセットされ、ラベルは本日月 2026年11月、center は本日のまま、30日ぶんのセル、今日が選択セル）',
  m5.calOpen === true && m5.centerDate === today && m5.monthLabel === todayMonthLabel &&
  m5.calDayBtns === daysInMonth(year, month) && m5.calSelected === today, m5);

await openCal();
const m6 = await snapshot(page);
check('中心日クリックでミニカレンダーが閉じる（center は本日のまま）',
  m6.calOpen === false && m6.centerDate === today, m6);

// C キーで開く（ラベルは 2025年3月、center は本日のまま、メニューは閉じる）
await press(page, 'c');
const m7 = await snapshot(page);
check('C キーでミニカレンダーが開く（アンカーは本日へリセットされ、ラベルは本日月 2026年11月、center は本日のまま、メニューは閉じる）',
  m7.calOpen === true && m7.centerDate === today && m7.monthLabel === todayMonthLabel && m7.menuOpen === false, m7);

// ‹（前日ボタン）は1日前へ動く（月は中心日を追う。‹ › は月の移動ではない）
await page.evaluate(() => { const b = document.querySelector('#view-bulletin #bulletin-day-prev'); if (b) b.click(); });
await sleep(400);
const m8 = await snapshot(page);
check('‹（前日ボタン）で中心日が1日前へ（center は前日、ラベルは中心日の月、選択セルは前日、当月ぶんのセル、カレンダーは開いたまま）',
  m8.centerDate === prevDay && m8.monthLabel === labelOfKey(prevDay) &&
  m8.calSelected === prevDay && m8.calDayBtns === daysOfKey(prevDay) &&
  m8.calOpen === true, m8);

// C キーで閉じてから T キーで本日へ戻す（section 10 は本日列表で受ける）
await press(page, 'c');
const m9 = await snapshot(page);
check('C キーでミニカレンダーが閉じる（center は前日のまま、ラベルは前日の月、ラベルボタン expanded=false）',
  m9.calOpen === false && m9.centerDate === prevDay && m9.monthLabel === labelOfKey(prevDay) &&
  m9.menuBtnExpanded === 'false', m9);

await press(page, 't');
const m10 = await snapshot(page);
check('T キーで中心日が本日へ戻る（center は本日、readout は本日の日付、列表は本日列表、ミニカレンダーは閉じたまま）',
  m10.centerDate === today && String(m10.readoutText).startsWith(mmdd(today)) && m10.rows === startCount && m10.calOpen === false, m10);

log('mini-cal-month-selection', m0, m1, m2, m3, m4, m5, m6, m7, m8, m9, m10);
// ===== 10. 既読の記録（全件読んだ後は未読ボタンとサイドバーのバッヂが閉じたままで、未読ボタンは enabled） =====
const f = await snapshot(page);
log('final', { unreadText: f.unreadText, unreadHidden: f.unreadHidden, sidebarHidden: f.sidebarHidden, sidebarCount: f.sidebarCount, unreadDisabled: f.unreadDisabled, centerDate: f.centerDate });
check('全件読んだ後は未読ボタンとサイドバーのバッヂが閉じている（未読 0・hidden）、未読ボタンは enabled（読み切ったので disabled にはしない）',
  f.unreadText === '未読 0' && f.unreadHidden === true && f.sidebarHidden === true && f.sidebarCount === 0
  && f.unreadDisabled === false,
  { unreadText: f.unreadText, unreadHidden: f.unreadHidden, sidebarHidden: f.sidebarHidden, sidebarCount: f.sidebarCount, unreadDisabled: f.unreadDisabled });

const ackCount = (await query("SELECT COUNT(*) AS c FROM post_acknowledgements WHERE user_id = 'kyomu01'")).rows[0].c;
check('未読全件が行クリックで既読化された＝DB の既読レコードが N 件', Number(ackCount) === N, { ackCount: Number(ackCount), N });

await browser.close();
await pool.end();

console.log('\n===== 全検証結果 =====');
console.log(`合計 ${results.length} 項目、成功 ${results.length - failures.length}、失敗 ${failures.length}`);
if (failures.length) {
  failures.forEach((name) => console.log('FAIL', name));
  console.log('FAILURES');
  process.exit(1);
}
console.log('ALL PASS');
process.exit(0);
