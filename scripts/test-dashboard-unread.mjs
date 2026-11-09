/**
 * ダッシュボード「本日の連絡」未読バッヂの実ブラウザ検証 (v3.1)
 *
 * 検証項目:
 *  1. 「本日の連絡」カードは対象日が本日の掲示のみ（既読・未読問わず）。未読カードに未読マーカー、既読カードにマーカーなし。
 *     ヘッダー右 #dash-today-bulletin-unread = 本日未読数、カードは button 要素
 *  2. カードクリックで PUT /api/bulletins/:id/read が発火し、本日バッヂが 1 減りマーカーが消え、
 *     サイドバー・タイトルバッヂも連動する
 *  3. カードクリックでタブは切り替わらずモーダルも開かない。既読カードの再クリックは API を叩かない（冪等）
 *  4. サイドバー #bulletin-unread-count（数字のみ）＝タイトル #bulletin-title-unread（未読 N）＝全日未読数
 *  5. 未読 100 件超は 99+ にキャップ（サイドバー 99+ ／タイトル・ダッシュボード 未読 99+。100 を出さない）。
 *     客户端キャッシュは最新 100 件が上限なので擬似キャッシュ (CAPSIM) で 100 件未読を再現する。
 *     実 DB で 110 件作ると掲示初期化 (autoSelect＝全文表示時点で既読化) が 1 件を既読化して 99 になるため使わない。
 *     擬似キャッシュ後は実キャッシュへ復帰して DOM バッジが実データへ追従することも検証する
 *  6. 登録日より古い記事（掲示期間が本日有効で対象日が本日でも）はバッヂに含めない。
 *     掲示開始前・掲示終了記事もバッヂに含めない
 *
 * 期待値はページ内の bulletin.module と同一インスタンスから算出する（DOM と客户端ロジックの一致を検証）。
 * 実行: npm run test:ui:unread  （ISSystem サーバーが必要 / 3443。検証用投稿は CAPSIM 擬似キャッシュ中心で実 DB は本日記事と登録日前記事のみ）
 *  options: UI_BASE=https://127.0.0.1:3443 UI_USER=T2026001 UI_PASS=password123 CHROME_PATH=...
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const CA = fs.readFileSync(path.join(ROOT, 'certs', 'issystem-ca.crt'), 'utf8');
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

/** 本日キー (JST 'YYYY-MM-DD') */
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

/** バッジ文字列（'5' / '99+' / '未読 5' / '未読 99+'）から数値を取り出す（99+ は 100 以上の意味） */
const badgeNum = (t) => {
  if (t === null || t === undefined) return null;
  if (String(t).includes('+')) return 100;
  const m = String(t).match(/\d+/);
  return m ? Number(m[0]) : null;
};

/** 未読 N ラベル表記（99+ キャップ） */
const fmt = (n) => (n >= 100 ? '99+' : String(n));
const fmtLabel = (n) => `未読 ${n >= 100 ? '99+' : n}`;

async function api(pathname, { method = 'GET', body, token } = {}) {
  const u = new URL(BASE + pathname);
  const headers = {
    'Content-Type': 'application/json',
    ...(body ? { 'Content-Length': String(Buffer.byteLength(JSON.stringify(body))) } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers,
        ca: [CA],
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    if (body) req.end(JSON.stringify(body));
    else req.end();
  });
}

// ===== サーバー側データ（登録日・掲示開始前の件数） =====
const loginRes = await api('/api/auth/login', { method: 'POST', body: { staff_code: USER, password: PASS } });
const token = loginRes.token;
const me = await api('/api/auth/me', { token });
const regDay = String(me.user.created_at || '').slice(0, 10);
const serverList = (await api('/api/bulletins?limit=100', { token })).data;
const futureCount = serverList.filter((b) => b.displayStart && b.displayStart > todayJst()).length;

// 本日未読カードが存在しない DB 状態ではクリック検証できないため、検証用の本日記事を作る
let extraTodayId = null;
const todayUnreadServer = serverList.filter(
  (b) => (b.targetDate || String(b.postedAt).slice(0, 10)) === todayJst() &&
    (b.ackStatus || 'UNREAD') === 'UNREAD' &&
    (!b.displayStart || b.displayStart <= todayJst()) &&
    (!b.displayEnd || b.displayEnd >= todayJst())
);
if (todayUnreadServer.length === 0) {
  const r = await api('/api/bulletins', {
    method: 'POST',
    token,
    body: {
      title: 'UIREADCHK 検証用の本日記事',
      content: '本日未読カードのクリック検証用です。',
      target_date: todayJst(),
      display_start_date: todayJst(),
      display_end_date: todayJst(),
      // DB の NOW() がホスト時計と1日ズレることがあるため投稿日時はクライアント基準の本日で明示する
      posted_at: `${todayJst()} 12:00:00`,
      created_at: `${todayJst()} 12:00:00`,
    },
  });
  if (r.success && r.data && r.data.id) extraTodayId = r.data.id;
}

// ===== 実ブラウザ検証 =====
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));

// カードクリックで発火する既読 API を記録する
const readReqs = [];
page.on('request', (req) => {
  if (/\/api\/bulletins\/[^/]+\/read/.test(req.url())) readReqs.push(`${req.method()} ${req.url()}`);
});

/**
 * 客户端キャッシュを API(latest 100) と同期し、DOM と客户端期待値を一度に読む。
 * ページ内でアプリと同じ bulletin.module / api.js インスタンスを import するため、
 * DOM が客户端ロジック（登録日・掲示期間・既読状態）と一致していることを検証できる。
 */
const snap = () => page.evaluate(async () => {
  const mod = await import('/js/modules/bulletin.module.js');
  const { apiGet } = await import('/js/api.js');
  const res = await apiGet('/bulletins', { limit: 100 });
  mod.setBulletinCache(res.data || res.bulletins || []);
  mod.recomputeUnreadBadges();
  const cache = mod.bulletinsSnapshot();
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const unreadAll = cache.filter((b) => mod.isUnreadForMe(b));
  const read = (id) => {
    const el = document.getElementById(id);
    return el ? { text: el.textContent.trim(), hidden: el.classList.contains('hidden') } : null;
  };
  return {
    dash: read('dash-today-bulletin-unread'),
    side: read('bulletin-unread-count'),
    title: read('bulletin-title-unread'),
    cards: [...document.querySelectorAll('#dash-pinned-bulletins [data-bulletin-read]')].map((el) => ({
      id: el.getAttribute('data-bulletin-read'),
      tag: el.tagName,
      marker: !!el.querySelector('.dash-news-unread-marker'),
    })),
    activeTab: document.querySelector('.nav-item.active') ? document.querySelector('.nav-item.active').getAttribute('data-tab') : null,
    modalOpen: [...document.querySelectorAll('.modal')].filter((m) => !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none').length,
    cacheLen: cache.length,
    unreadAll: unreadAll.length,
    todayCards: cache.filter((b) => mod.targetDayOf(b) === today && mod.isDisplayActiveOn(b, today)).length,
    todayUnread: unreadAll.filter((b) => mod.targetDayOf(b) === today).length,
    futureFlags: cache
      .filter((b) => (b.displayStart || b.display_start) && (b.displayStart || b.display_start) > today)
      .map((b) => ({ start: b.displayStart || b.display_start, unread: mod.isUnreadForMe(b) })),
    cache: cache.map((b) => ({
      id: String(b.id),
      postedAt: b.postedAt,
      target: mod.targetDayOf(b),
      activeToday: mod.isDisplayActiveOn(b, today),
      unread: mod.isUnreadForMe(b),
    })),
    nonUnread: cache.filter((b) => !mod.isUnreadForMe(b)).slice(0, 4).map((b) => ({
      id: String(b.id),
      postedAt: b.postedAt,
      ack: b.ackStatus,
      isRead: !!b.isRead,
      target: mod.targetDayOf(b),
      activeToday: mod.isDisplayActiveOn(b, today),
    })),
  };
});

await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await page.evaluate(() => document.querySelector('a[data-tab="dashboard"]').click());
await sleep(1600);
const first = await snap();
console.log(`登録日=${regDay} 本日=${todayJst()} サーバー記事数=${serverList.length} 掲示開始前=${futureCount} 客户端cache=${first.cacheLen} 客户端全日未読=${first.unreadAll} 本日カード=${first.todayCards} 本日未読=${first.todayUnread}`);

// 1. カード = 対象日が本日の掲示のみ、マーカーは未読カードのみ、ダッシュバッヂ = 本日未読数
check('1: 「本日の連絡」カードは対象日が本日の掲示のみ（客户端キャッシュと件数一致）',
  first.cards.length === first.todayCards, { cards: first.cards.length, clientTodayCards: first.todayCards });
check('1: 未読カードに未読マーカー・既読カードにマーカーなし（マーカー数＝客户端本日未読数）',
  first.cards.filter((c) => c.marker).length === first.todayUnread,
  { markers: first.cards.filter((c) => c.marker).length, clientTodayUnread: first.todayUnread });
check('1: ヘッダー右の「本日の連絡」バッヂ＝本日未読数（未読 N ラベル）',
  first.dash.text === fmtLabel(first.todayUnread), { dash: first.dash.text, clientTodayUnread: first.todayUnread });

// 4. サイドバー（数字のみ）＝タイトル（未読 N）＝全日未読数
check('4: サイドバー＝タイトル＝全日未読数（サイドバーは数字のみ、タイトルは「未読 N」）',
  /^\d+$/.test(first.side.text) &&
  Number(first.side.text) === first.unreadAll &&
  first.title.text === fmtLabel(first.unreadAll),
  { side: first.side.text, title: first.title.text, clientUnreadAll: first.unreadAll });

// 2. カードクリック：PUT read 発火 → 本日バッヂ 1 減・マーカー消去・サイドバー/タイトル追従
const unreadCard = first.cards.find((c) => c.marker);
let after = first;
check('1: 本日の未読カードは button 要素（クリックで既読が付く）',
  Boolean(unreadCard) && unreadCard.tag === 'BUTTON',
  { tag: unreadCard && unreadCard.tag, markers: first.cards.filter((c) => c.marker).length });

if (!unreadCard) {
  check('2: 本日未読カードが無い DB 状態（クリック検証を執行できない）', false, { cards: first.cards.length });
} else {
  const clickedId = unreadCard.id;
  readReqs.length = 0;
  await page.evaluate((id) => document.querySelector(`[data-bulletin-read="${id}"]`).click(), clickedId);
  await sleep(1400);
  after = await snap();
  check('2: カードクリックで PUT /api/bulletins/:id/read（クリックしたカードの id）',
    readReqs.length === 1 && readReqs[0].startsWith('PUT') && readReqs[0].includes(`/api/bulletins/${clickedId}/read`),
    { readReqs, clickedId });
  check('2: 本日バッヂが 1 減り、クリックしたカードの未読マーカーが消える',
    after.dash.text === fmtLabel(after.todayUnread) && after.todayUnread === first.todayUnread - 1 &&
      after.cards.find((c) => c.id === clickedId).marker === false,
    { dash: after.dash.text, clientTodayUnread: after.todayUnread, expected: first.todayUnread - 1 });
  check('2: サイドバー・タイトルバッヂも 1 減（全日バッヂが連動）',
    Number(after.side.text) === after.unreadAll && after.unreadAll === first.unreadAll - 1 &&
      after.title.text === fmtLabel(after.unreadAll),
    { side: after.side.text, title: after.title.text, clientUnreadAll: after.unreadAll, expected: first.unreadAll - 1 });

  // 3. クリックでタブは切り替わらない・モーダルは開かない。既読カードの再クリックは API を叩かない（冪等）
  check('3: カードクリックでタブは切り替わらない（ダッシュボードのまま）',
    after.activeTab === 'dashboard', { activeTab: after.activeTab });
  check('3: カードクリックで掲示モーダルは開かない', after.modalOpen === 0, { modalOpen: after.modalOpen });
  readReqs.length = 0;
  await page.evaluate((id) => document.querySelector(`[data-bulletin-read="${id}"]`).click(), clickedId);
  await sleep(800);
  const after2 = await snap();
  check('3: 既読カードの再クリックは既読 API を叩かない（冪等・マーカーなし維持）',
    readReqs.length === 0 && after2.cards.find((c) => c.id === clickedId).marker === false,
    { readReqs, marker: after2.cards.find((c) => c.id === clickedId).marker });
}


// 検証用の本日記事を削除し、キャッシュを削除後（後入れの記事が新着として先頭に来る状態）へ整える
if (extraTodayId) await api(`/api/bulletins/${extraTodayId}`, { method: 'DELETE', token });
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await page.evaluate(() => document.querySelector('a[data-tab="dashboard"]').click());
await sleep(1600);
const base = await snap();
check('3: 検証用本日記事の削除後はバッヂがクリック分だけ減った状態になる',
  base.side.text === fmt(base.unreadAll) && base.title.text === fmtLabel(base.unreadAll) &&
    base.unreadAll === first.unreadAll - 1,
  { side: base.side.text, title: base.title.text, clientUnreadAll: base.unreadAll, expected: first.unreadAll - 1 });

// 6. 登録日より古い記事は未読バッヂに含めない
// 登録日より古い posted_at の記事は客户端キャッシュ（最新 100 件）に挟まれないため、
// 登録日が本日である管理者アカウントで「登録日より古い・対象日=本日・掲示期間本日有効」の記事を作成して検証する。
const admin = process.env.ADMIN_USERNAME || 'sys-admin';
const adminPass = process.env.ADMIN_PASSWORD || 'password123';
const adminLogin = await api('/api/auth/login', { method: 'POST', body: { staff_code: admin, password: adminPass } });
const adminToken = adminLogin.token;
const adminMe = await api('/api/auth/me', { token: adminToken });
const adminRegDay = String(adminMe.user.created_at || '').slice(0, 10);
const oldDay = new Date(new Date(`${adminRegDay}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10);
const oldTitle = 'UIOLD 登録日前の記事';
const oldCreated = await api('/api/bulletins', { method: 'POST', token: adminToken, body: {
  title: oldTitle,
  content: '登録日より前に投稿された記事は未読数に含めない。',
  target_scope: { grade: 'ALL', department: 'ALL' },
  target_date: todayJst(),
  display_start_date: oldDay,
  display_end_date: null,
  posted_at: `${oldDay} 09:00:00`,
  created_at: `${oldDay} 09:00:00` } });
const oldId = String(oldCreated?.id || oldCreated?.post?.id || oldCreated?.data?.id || '');
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await page.evaluate(() => document.querySelector('a[data-tab="dashboard"]').click());
await sleep(1800);
const withOld = await snap();
const old = withOld.cache.find((b) => String(b.id) === oldId) || null;
check('6: 登録日より古い記事は未読バッヂに含めない（本日有効・対象日=本日でも未読数外・マーカーなし）',
  Boolean(old) && String(old.postedAt).slice(0, 10) === oldDay && oldDay < regDay &&
    old.activeToday === true && old.unread === false &&
    withOld.unreadAll === base.unreadAll &&
    withOld.side.text === fmt(base.unreadAll) && withOld.title.text === fmtLabel(base.unreadAll) &&
    withOld.cards.filter((c) => c.marker).length === base.todayUnread &&
    withOld.cards.length === base.cards.length + 1,
  { old, regDay, oldDay, clientUnreadAll: withOld.unreadAll, expected: base.unreadAll,
    side: withOld.side.text, title: withOld.title.text, cards: withOld.cards.length,
    expectedCards: base.cards.length + 1, oldId });

// 6. 掲示開始前・掲示終了記事はバッヂに数えない（キャッシュ上の掲示開始前全件が未読数外）
check('6: 掲示開始前記事は未読バッヂに数えない（掲示期間が本日有効な記事だけを数える）',
  withOld.futureFlags.length > 0 && withOld.futureFlags.every((f) => f.unread === false) &&
    withOld.futureFlags.length === futureCount &&
    withOld.unreadAll < withOld.cacheLen,
  { futureFlags: withOld.futureFlags, serverFutureCount: futureCount,
    clientUnreadAll: withOld.unreadAll, cacheLen: withOld.cacheLen });

// 5. 未読 100 件超は 99+（客户端キャッシュは latest 100 が上限なので、実 DB を汚さず擬似キャッシュで 100 件未読を再現する）
// 実 DB で 110 件作ると、ページの掲示初期化（autoSelect＝全文表示時点で既読化）が 1 件を既読化して 99 になるため、
// 99+ キャップは擬似キャッシュで DOM 表記を検証し、実キャッシュ復帰でバッヂが実データへ追従することも見る
const capSim = await page.evaluate(async () => {
  const mod = await import('/js/modules/bulletin.module.js');
  const { apiGet } = await import('/js/api.js');
  const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const fake = Array.from({ length: 100 }, (_, i) => ({
    id: `cap_sim_${i}`,
    title: `CAPSIM 未読キャップ ${String(i).padStart(3, '0')}`,
    content: '未読 99+ キャップ検証用の擬似キャッシュです。',
    postedAt: `${today} 12:00:00`,
    targetDate: today,
    displayStart: today,
    displayEnd: today,
    ackStatus: 'UNREAD',
    targetScope: { grade: 'ALL', department: 'ALL' },
  }));
  mod.setBulletinCache(fake);
  const g = (id) => {
    const el = document.getElementById(id);
    return el ? el.textContent.trim() : null;
  };
  const out = {
    cacheLen: mod.bulletinsSnapshot().length,
    unreadAll: mod.bulletinsSnapshot().filter((b) => mod.isUnreadForMe(b)).length,
    side: g('bulletin-unread-count'),
    title: g('bulletin-title-unread'),
    dash: g('dash-today-bulletin-unread'),
  };
  // 実キャッシュへ復帰して DOM バッジが実データへ追従するか
  const res = await apiGet('/bulletins', { limit: 100 });
  mod.setBulletinCache(res.data || res.bulletins || []);
  out.restoredSide = g('bulletin-unread-count');
  out.restoredTitle = g('bulletin-title-unread');
  out.restoredDash = g('dash-today-bulletin-unread');
  return out;
});
check('5: 客户端キャッシュ 100 件が未読ならサイドバー 99+・タイトル/ダッシュボード 未読 99+（100 を出さない）',
  capSim.cacheLen === 100 && capSim.unreadAll >= 100 &&
    capSim.side === '99+' && capSim.title === '未読 99+' && capSim.dash === '未読 99+',
  { cacheLen: capSim.cacheLen, unreadAll: capSim.unreadAll, side: capSim.side,
    title: capSim.title, dash: capSim.dash });
check('5: 擬似キャッシュ後は実キャッシュへ復帰して DOM バッジが実データへ追従する',
  capSim.restoredSide === fmt(base.unreadAll) && capSim.restoredTitle === fmtLabel(base.unreadAll)
    && capSim.restoredDash === fmtLabel(base.todayUnread),
  { restoredSide: capSim.restoredSide, restoredTitle: capSim.restoredTitle, restoredDash: capSim.restoredDash,
    expectedSide: fmt(base.unreadAll), expectedDash: fmtLabel(base.todayUnread) });

// 後片付け: 検証用の登録日前の記事 (oldId) を削除してバッヂとカードを元に戻す
if (oldId) await api(`/api/bulletins/${oldId}`, { method: 'DELETE', token: adminToken });
await page.reload({ waitUntil: 'networkidle2' });
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await page.evaluate(() => document.querySelector('a[data-tab="dashboard"]').click());
await sleep(1600);
const restored = await snap();
check('5: 検証用投稿 (登録日前記事) の削除後はバッヂとカードが元に戻る',
  restored.side.text === fmt(restored.unreadAll) &&
    restored.title.text === fmtLabel(restored.unreadAll) &&
    restored.unreadAll === base.unreadAll &&
    restored.cards.length === base.cards.length,
  { side: restored.side.text, title: restored.title.text,
    clientUnreadAll: restored.unreadAll, expected: base.unreadAll,
    cards: restored.cards.length, expectedCards: base.cards.length });

await page.screenshot({ path: path.join(ROOT, 'scripts', 'output', 'dashboard-unread.png') });
await browser.close();

console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILURES`}`);
process.exit(failures.length === 0 ? 0 : 1);

