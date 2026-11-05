/**
 * 施設・備品マスタの並び順入れ替え (▲▼) の実ブラウザ検証
 *
 * 検証項目:
 *  1. マスタ管理の各行に行番号・▲▼ があり、先頭行の▲と末尾行の▼は無効
 *  2. マスタ行順・タイムライン行順・予約フォーム select 順が一致する
 *  3. 第2行を▲で最上位へ移動すると 3箇所すべてが入れ替わりトーストが出る
 *  4. ページ再読み込み後も新順が続く (サーバーの sort_order に永続化)
 *  5. 教務部以外 (TEACHER) には管理ボタンが出ず、同じ並び順で表示される
 *  6. socket 通知で TEACHER のタイムライン順が自動更新され「並び順を変更」トーストが出る
 *  7. 並び順 API は未知 ID (404)・重複 (400)・空 (400)・TEACHER (403) を拒否する
 *  8. 元順へ復元できる (基準順へ戻して終える)
 * 実行: node scripts/test-facility-order.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123  UI_TEACHER=T2026002  CHROME_PATH=...
 * 出力: scripts/output/facility-order-modal.png
 *       scripts/output/facility-order-1280.png
 *       scripts/output/facility-order-390.png
 *       NG が 1 件でもあれば exit code 1 (テスト後に基準順へ復元する)
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const TEACHER = process.env.UI_TEACHER || 'T2026002';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const OUT_DIR = `${import.meta.dirname}/output`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const log = (name, val) => console.log(`${name} = ${JSON.stringify(val)}`);
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

/** マスタ行順・タイムライン行順・select 順・▲▼ 状態・トーストのスナップショット */
const snapshot = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#facility-master-list .facility-master-row')];
  const matrix = [...document.querySelectorAll('#facility-matrix-body [data-facility-row]')];
  const modal = document.getElementById('facility-master-modal');
  return {
    masterRows: rows.length,
    masterNames: rows.map((r) => r.querySelector('[data-field=name]').value.trim()),
    masterPositions: rows.map((r) => Number(r.querySelector('[data-pos]')?.textContent)),
    upDisabled: rows.map((r) => r.querySelector('[data-action=up]')?.disabled === true),
    downDisabled: rows.map((r) => r.querySelector('[data-action=down]')?.disabled === true),
    matrixNames: matrix.map((r) => r.querySelector('span')?.textContent.trim()),
    selectOptions: [...document.querySelectorAll('#facility-select option')].map((o) => o.textContent.trim()),
    modalHidden: modal ? modal.classList.contains('hidden') : null,
    hasManageBtn: !!document.getElementById('facility-btn-manage'),
    toastTexts: [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
  };
});

/** ページを開いてログインし、施設タブへ移動する */
async function setup(browser, user) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  // 前ページのセッション (localStorage) を消して未ログイン状態から開始する (ページ間共有対策)
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(400);
  await page.type('#login-userid', user);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(1200);
  page.__token = await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251'));
  page.__userJson = await page.evaluate(() => localStorage.getItem('is_system_user_info_v251'));
  await page.evaluate(() => document.querySelector('a[data-tab="facility"]').click());
  await sleep(1600);
  return page;
}

/** 自ページのセッションへ戻して再読み込みする (localStorage はページ間で共有されるため) */
const reloadAs = async (page) => {
  await page.evaluate((tok, user) => {
    if (tok) localStorage.setItem('is_system_jwt_token_v251', tok);
    if (user) localStorage.setItem('is_system_user_info_v251', user);
  }, page.__token, page.__userJson);
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(1800);
  await gotoFacilityTab(page);
  await sleep(1500);
};

/** タイムラインの枠 (scroll container) と本文横スクロールの状態 */
const matrixMetrics = (page) => page.evaluate(() => {
  const box = document.querySelector('#view-facility .timeline-scroll-container');
  const frame = box ? Math.round(box.getBoundingClientRect().width) : -1;
  return {
    bodyOverflowX: document.documentElement.scrollWidth <= window.innerWidth + 1,
    frameWidth: frame,
    frameWithinViewport: frame >= 0 && frame <= window.innerWidth,
    contentMinWidth: (box?.scrollWidth || 0) >= 880,
  };
});

/** マスタ管理モーダルを開く (教務部) */
const openAdmin = (page) => page.evaluate(() => document.getElementById('facility-btn-manage')?.click());

/** 施設タブへ移動する */
const gotoFacilityTab = (page) => page.evaluate(() => document.querySelector('a[data-tab="facility"]')?.click());

/** 名前を指定してマスタ行の▲▼をクリックする (行が無ければ NOT_FOUND、無効ボタンなら DISABLED) */
const moveRow = (page, name, action) => page.evaluate((n, a) => {
  const rows = [...document.querySelectorAll('#facility-master-list .facility-master-row')];
  const row = rows.find((r) => r.querySelector('[data-field=name]').value.trim() === n);
  if (!row) return 'NOT_FOUND';
  const btn = row.querySelector(`[data-action=${a}]`);
  if (!btn) return 'NO_BUTTON';
  if (btn.disabled) return 'DISABLED';
  btn.click();
  return row.dataset.facilityMasterId;
}, name, action);

/** ページ内で API を叩く (並び順 API の検証用)。そのページのログイントークンを渡す */
const apiFetch = (page, method, path, body) => page.evaluate(async (tok, m, p, b) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: tok ? `Bearer ${tok}` : '' },
    body: b ? JSON.stringify(b) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* flash レスポンス等 */ }
  return { status: res.status, json };
}, page.__token, method, path, body);

/** list の i 番目と j 番目を入れ替えた配列 */
const swap = (list, i, j) => {
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

const kyomu = await setup(browser, USER);
const teacher = await setup(browser, TEACHER);

await kyomu.setViewport({ width: 1280, height: 900 });
await teacher.setViewport({ width: 1280, height: 900 });

// ---- 基準順 (ソート未設定 = カテゴリ・名称順) を測る ----
await openAdmin(kyomu);
await sleep(700);
const base = await snapshot(kyomu);
const n = base.masterRows;
log('baseline', { masterRows: n, matrixRows: base.matrixNames.length, selectCount: base.selectOptions.length, order: base.masterNames });

check('マスタ管理モーダルが開く (教務部)', base.modalHidden === false, { modalHidden: base.modalHidden });
check('教務部以外 (TEACHER) に施設管理ボタンは出ない', (await snapshot(teacher)).hasManageBtn === false, { hasManageBtn: (await snapshot(teacher)).hasManageBtn });
check('各行に行番号 1..n が振られる',
  base.masterPositions.length === n && base.masterPositions.every((p, i) => p === i + 1),
  { masterPositions: base.masterPositions });
check('先頭行の▲と末尾行の▼が無効、他は有効',
  base.upDisabled[0] === true && base.downDisabled[n - 1] === true
  && base.upDisabled.slice(1).every((d) => d === false)
  && base.downDisabled.slice(0, n - 1).every((d) => d === false),
  { upDisabled: base.upDisabled, downDisabled: base.downDisabled });
check('マスタ・タイムライン・select の並び順が一致',
  JSON.stringify(base.masterNames) === JSON.stringify(base.matrixNames)
  && JSON.stringify(base.masterNames) === JSON.stringify(base.selectOptions),
  { masterNames: base.masterNames, matrixNames: base.matrixNames });

// ---- 第2行を▲で最上位へ ----
const movedName = base.masterNames[1];
const expected = swap(base.masterNames, 0, 1);
const moveId = await moveRow(kyomu, movedName, 'up');
await sleep(1600);
const afterMove = await snapshot(kyomu);
check('第2行の▲でマスタ・タイムライン・select がすべて入れ替わる',
  moveId !== 'NOT_FOUND' && JSON.stringify(afterMove.masterNames) === JSON.stringify(expected)
  && JSON.stringify(afterMove.matrixNames) === JSON.stringify(expected)
  && JSON.stringify(afterMove.selectOptions) === JSON.stringify(expected),
  { master: afterMove.masterNames, matrix: afterMove.matrixNames });
check('移動トースト (第 1 行目へ移動)',
  afterMove.toastTexts.some((t) => t.includes(movedName) && t.includes('第 1 行目')),
  { toastTexts: afterMove.toastTexts.slice(0, 2) });
await kyomu.screenshot({ path: `${OUT_DIR}/facility-order-modal.png` });

// ---- ページ再読み込み後も新順が続く (sort_order 永続化) ----
await reloadAs(kyomu);
await openAdmin(kyomu);
await sleep(700);
const afterReload = await snapshot(kyomu);
check('再読み込み後も新順が続く (サーバー永続化)',
  JSON.stringify(afterReload.masterNames) === JSON.stringify(expected)
  && JSON.stringify(afterReload.matrixNames) === JSON.stringify(expected),
  { afterReload: afterReload.masterNames });

// ---- TEACHER は同じ並び順で表示 (管理ボタン無し) ----
await reloadAs(teacher);
const teacherCustom = await snapshot(teacher);
check('TEACHER にも同じ並び順でタイムライン表示される',
  JSON.stringify(teacherCustom.matrixNames) === JSON.stringify(expected) && teacherCustom.hasManageBtn === false,
  { teacherMatrix: teacherCustom.matrixNames });

// ---- socket 通知で他クライアントへ自動反映 ----
const socketBefore = await snapshot(teacher);
const backId = await moveRow(kyomu, expected[0], 'down');
await sleep(2000);
const socketAfter = await snapshot(teacher);
check('socket 通知で TEACHER のタイムライン順が基準順へ戻る',
  backId !== 'NOT_FOUND' && JSON.stringify(socketAfter.matrixNames) === JSON.stringify(base.masterNames),
  { before: socketBefore.matrixNames.slice(0, 3), after: socketAfter.matrixNames.slice(0, 3) });
check('socket 通知トースト (TEACHER: 並び順を変更)',
  socketAfter.toastTexts.some((t) => t.includes('並び順')),
  { toastTexts: socketAfter.toastTexts.slice(0, 3) });

// ---- 並び順 API の検証 (不正は拒否され基準順は変わらない) ----
const listRes = await apiFetch(kyomu, 'GET', '/facilities');
const facList = listRes.json?.facilities || listRes.json?.data || [];
const idOf = (name) => String((facList.find((f) => (f.name || f.facility_name) === name) || {}).id);
const baseIds = base.masterNames.map((name) => idOf(name));
const badUnknown = await apiFetch(kyomu, 'PUT', '/facilities/order', { ids: [...baseIds.slice(1), 'fac_not_exist'] });
const badDup = await apiFetch(kyomu, 'PUT', '/facilities/order', { ids: [...baseIds.slice(0, -1), baseIds[0]] });
const badEmpty = await apiFetch(kyomu, 'PUT', '/facilities/order', { ids: [] });
const teacherOrder = await apiFetch(teacher, 'PUT', '/facilities/order', { ids: baseIds });
log('order-api', {
  unknown: `${badUnknown.status}: ${(badUnknown.json?.message || '').slice(0, 44)}`,
  dup: `${badDup.status}: ${(badDup.json?.message || '').slice(0, 44)}`,
  empty: `${badEmpty.status}`,
  teacher: teacherOrder.status,
});
check('未知 ID を含む並び順は 404 で拒否', badUnknown.status === 404, { status: badUnknown.status });
check('重複する並び順 (全件不足) は 400 で拒否', badDup.status === 400, { status: badDup.status });
check('空の並び順は 400 で拒否', badEmpty.status === 400, { status: badEmpty.status });
check('TEACHER の並び順変更は 403', teacherOrder.status === 403, { status: teacherOrder.status });

// ---- 基準順への復元 ----
const restore = await apiFetch(kyomu, 'PUT', '/facilities/order', { ids: baseIds });
await sleep(1300);
await reloadAs(kyomu);
await openAdmin(kyomu);
await sleep(700);
const restored = await snapshot(kyomu);
const teacherRestored = await snapshot(teacher);
check('基準順へ復元できる (マスタ・タイムライン・select)',
  restore.status === 200 && JSON.stringify(restored.masterNames) === JSON.stringify(base.masterNames)
  && JSON.stringify(restored.matrixNames) === JSON.stringify(base.masterNames)
  && JSON.stringify(restored.selectOptions) === JSON.stringify(base.masterNames),
  { restored: restored.masterNames });
check('復元した基準順が TEACHER へも反映される',
  JSON.stringify(teacherRestored.matrixNames) === JSON.stringify(base.masterNames),
  { teacherMatrix: teacherRestored.matrixNames });

// ---- 画面確認 (1280px / 390px で本文の横スクロール溢出なし・タイムライン枠は viewport 内) ----
await kyomu.setViewport({ width: 1280, height: 900 });
await sleep(600);
const wide = await matrixMetrics(kyomu);
check('1280px で body 横スクロールなし・タイムライン枠は viewport 内で 880px 内容を持てる',
  wide.bodyOverflowX === true && wide.frameWithinViewport === true && wide.contentMinWidth === true,
  { ...wide });
await kyomu.screenshot({ path: `${OUT_DIR}/facility-order-1280.png` });

await kyomu.setViewport({ width: 390, height: 844 });
await sleep(600);
const narrow = await matrixMetrics(kyomu);
check('390px (モバイル) でも body 横スクロールなし・タイムライン枠は viewport 内で 880px 内容を持てる',
  narrow.bodyOverflowX === true && narrow.frameWithinViewport === true && narrow.contentMinWidth === true,
  { ...narrow });
await kyomu.screenshot({ path: `${OUT_DIR}/facility-order-390.png` });

// ---- 復元後のマスタ管理 (▲▼・行番号) のスクリーンショット ----
await kyomu.setViewport({ width: 1280, height: 900 });
await openAdmin(kyomu);
await sleep(700);
await kyomu.screenshot({ path: `${OUT_DIR}/facility-order-modal-base.png` });

await browser.close();
console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILURES`}`);
process.exit(failures.length === 0 ? 0 : 1);

