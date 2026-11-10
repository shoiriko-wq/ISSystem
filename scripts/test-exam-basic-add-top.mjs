/**
 * 定期考査「基本情報の登録」の「行の追加」の配置ルールを実ブラウザで測る回帰テスト
 *
 * ルール（public/js/modules/exam/exam.basic.ui.js）:
 *  R1. 「行の追加」で出る未入力の行は表の最上部に1件だけ（未入力の行の top は最初の保存済み行より上）。
 *  R2. 未入力の行が1件表示されている間は「行の追加」ボタンが無効（disabled・aria-disabled）。2回押しても行は増えない。
 *  R3. 追加の操作で画面はスクロールしない（main の scrollTop は追加前と同じ＝下に移動する手間がない）。
 *  R4. 未入力の行は末尾の保存済み行より上に出る（スクロール距離が最も短くなる）。
 *  R5. 保存（POST 201）で未入力の行は消え、ボタンは元通り使える（部屋・科目・教科）。
 *      部屋=名前順、科目=教科順+名前順、教科=表示順（固定）。
 *  R6. 未入力の行の「削除」は行をUIから破棄し、ボタンは元通り使える（サーバー変更なし）。
 *  R7. クラス名はサーバーの登録制約（初期の29名・学年内の重複不可・初期の行は削除不可）。
 *      重複名での保存は 400 で未入力の行は残り、ボタンは無効のまま。
 *
 * 実行: npm run test:ui:examaddtop  （ISSystem サーバーが必要）
 *  options: UI_BASE=https://127.0.0.1:3443 UI_USER=T2026001 UI_PASS=password123 CHROME_PATH=...
 * 出力: scripts/output/exam-add-top-*.png。NG が1件でもあれば exit code 1
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'scripts', 'output');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log(`  [console error] ${m.text()}`); });
page.on('dialog', (d) => d.accept());   // 削除確認の window.confirm を自動承認
page.on('request', (r) => { if (r.url().includes('/api/basic-info') || r.url().includes('/api/subjects')) console.log(`  [REQ] ${r.method()} ${r.url()} ${r.postData() || ''}`); });
page.on('response', (r) => { if (r.url().includes('/api/basic-info') || r.url().includes('/api/subjects')) console.log(`  [RES] ${r.status()} ${r.url()}`); });

await page.setViewport({ width: 1440, height: 1000 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(900);
await page.click('[data-tab="exam"]');
await sleep(1800);

/** テーブルの状態を px で実測（未入力の行の位置・ボタン状態・スクロール位置） */
const snap = (kind) => page.evaluate((k) => {
  const tbody = document.getElementById(`basic-body-${k}`);
  if (!tbody) return { err: 'no table' };
  const rows = [...tbody.querySelectorAll('tr[data-kind]')];
  const blank = rows.find((r) => !r.dataset.id);
  const firstSaved = rows.find((r) => r.dataset.id);
  const lastSaved = [...rows].reverse().find((r) => r.dataset.id);
  const addBtn = document.getElementById(`basic-add-${k}`);
  const main = document.querySelector('#app-container main') || document.querySelector('main');
  const rOf = (el) => (el ? el.getBoundingClientRect() : null);
  const br = rOf(blank), fsr = rOf(firstSaved), lsr = rOf(lastSaved), mr = main.getBoundingClientRect();
  return {
    rows: rows.length,
    blankCount: rows.filter((r) => !r.dataset.id).length,
    blankIsFirst: tbody.firstElementChild === blank,
    blankTop: br ? Math.round(br.top) : -1,
    firstSavedTop: fsr ? Math.round(fsr.top) : -1,
    lastSavedTop: lsr ? Math.round(lsr.top) : -1,
    mainTop: Math.round(mr.top),
    mainBottom: Math.round(mr.bottom),
    mainScrollTop: Math.round(main.scrollTop),
    blankVisible: br ? (br.top >= mr.top - 1 && br.top <= mr.bottom + 1) : false,
    addDisabled: addBtn.disabled === true,
    addAriaDisabled: addBtn.getAttribute('aria-disabled') === 'true',
  };
}, kind);

/** 「行の追加」ボタンを実マウスで押す（有効なときだけ効く） */
const clickAdd = async (kind) => {
  await page.evaluate((k) => document.getElementById(`basic-add-${k}`).scrollIntoView({ block: 'center' }), kind);
  await page.click(`#basic-add-${kind}`);
  await sleep(350);
};

/** disabled のボタンにも DOM クリックを届けてハンドラの防御確認を見る（実ユーザーは押せない） */
const domClickAdd = async (kind) => {
  await page.evaluate((k) => document.getElementById(`basic-add-${k}`).click(), kind);
  await sleep(350);
};

/** 未入力の行（data-id 空）へ値を入れる */
const fillBlank = (kind, values) => page.evaluate((k, vals) => {
  const row = document.querySelector(`#basic-body-${k} tr[data-kind="${k}"][data-id=""]`);
  for (const [key, val] of Object.entries(vals)) {
    const el = row.querySelector(`[data-f="${key}"]`);
    if (!el) continue;
    if (el.tagName === 'SELECT' && [...el.options].some((o) => o.value === String(val))) el.value = String(val);
    else el.value = String(val);
  }
}, kind, values);

/** 未入力の行の「保存」を押して POST を待つ */
const saveBlank = async (kind) => {
  const resP = page.waitForResponse((r) => r.url().includes(API_PATH[kind]) && r.request().method() === 'POST', { timeout: 6000 });
  await page.evaluate((k) => {
    const btn = document.querySelector(`#basic-body-${k} tr[data-kind="${k}"][data-id=""] [data-act="save"]`);
    btn.scrollIntoView({ block: 'center' });
    btn.click();
  }, kind);
  const res = await resP;
  await sleep(1200);
  return res.status();
};

/** 登録済み行を「削除」して DELETE を待つ（confirm は自動承認） */
const deleteById = async (kind, rowId) => {
  const resP = page.waitForResponse((r) => r.url().includes(API_PATH[kind]) && r.request().method() === 'DELETE', { timeout: 6000 });
  await page.evaluate((k, id) => {
    const btn = document.querySelector(`#basic-body-${k} tr[data-id="${id}"] [data-act="delete"]`);
    btn.scrollIntoView({ block: 'center' });
    btn.click();
  }, kind, rowId);
  const res = await resP;
  await sleep(1200);
  return res.status();
};

/** 名前から行の data-id と表示位置（何番目の行か）を読む */
const rowByName = (kind, name) => page.evaluate((k, nm) => {
  const rows = [...document.querySelectorAll(`#basic-body-${k} tr[data-kind="${k}"]`)];
  const i = rows.findIndex((r) => r.querySelector('[data-f="name"]')?.value === nm);
  return { index: i, id: i >= 0 ? (rows[i].dataset.id || '') : null, count: rows.length };
}, kind, name);

/** クラス列が学年順+名前順で並んでいるか（保存済み行だけで測る） */
const classOrderOk = () => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#basic-body-class tr[data-kind="class"]')].filter((r) => r.dataset.id);
  const items = rows.map((r) => ({
    grade: Number(r.querySelector('[data-f="grade"]')?.value || 0),
    name: r.querySelector('[data-f="name"]')?.value || '',
  }));
  for (let i = 1; i < items.length; i++) {
    const cmp = items[i - 1].grade - items[i].grade || String(items[i - 1].name).localeCompare(String(items[i].name), 'ja');
    if (cmp > 0) return { ok: false, items };
  }
  return { ok: true, n: items.length };
});

const classNames = () => page.evaluate(() =>
  [...document.querySelectorAll('#basic-body-class tr[data-kind="class"]')]
    .filter((r) => r.dataset.id).map((r) => r.querySelector('[data-f="name"]')?.value || ''));
const groupNames = () => page.evaluate(() =>
  [...document.querySelectorAll('#basic-body-group tr[data-kind="group"]')]
    .filter((r) => r.dataset.id).map((r) => r.querySelector('[data-f="name"]')?.value || ''));

// サーバーの登録制約（クラス名は初期の29名・学年内の重複不可・初期の行は削除不可）
// 教科名は9教科の固定、部屋・科目は自由に名前を付けられる（test-exam-basic-columns.mjs と同じ）
const ALLOWED_GROUP_NAMES = ['国語', '地歴公民', '数学', '理科', '保健体育', '芸術', '外国語', '家庭', '情報'];
const API_PATH = { class: '/basic-info/class', group: '/subjects', subject: '/basic-info/subject', room: '/basic-info/room' };

// ── クラス表：未入力の行は最上部・ボタンは無効・スクロールしない ──────────
const classNamesBefore = await classNames();
const groupNamesList = await groupNames();
const groupUnused = ALLOWED_GROUP_NAMES.find((n) => !groupNamesList.includes(n));

const before = await snap('class');
const baseOrder = await classOrderOk();
check('クラス：ベースラインの行は学年順+名前順で並んでいる', baseOrder.ok, { ok: baseOrder.ok, n: baseOrder.n });
await page.evaluate(() => {
  const card = document.querySelector('#basic-table-class')?.closest('.rounded-md.border-main') ||
    document.getElementById('basic-table-class');
  card?.scrollIntoView({ block: 'start' });
});
await sleep(350);
const scrolled = await snap('class');
await clickAdd('class');
const after = await snap('class');

check('クラス：「行の追加」で未入力の行は1件だけ表の最上部に出る',
  after.rows === before.rows + 1 && after.blankCount === 1 && after.blankIsFirst,
  { rows: after.rows, blankCount: after.blankCount, blankIsFirst: after.blankIsFirst });
check('クラス：未入力の行の top は最初の保存済み行より上（px 実測）',
  after.blankTop >= 0 && after.firstSavedTop >= 0 && after.blankTop < after.firstSavedTop,
  { blankTop: after.blankTop, firstSavedTop: after.firstSavedTop });
check('クラス：未入力の行は末尾の保存済み行より上（下にスクロールして書かない）',
  after.lastSavedTop > 0 && after.blankTop < after.lastSavedTop,
  { blankTop: after.blankTop, lastSavedTop: after.lastSavedTop });
check('クラス：未入力の行は表示中の画面内に見える（px 実測）',
  after.blankVisible, { blankTop: after.blankTop, mainTop: after.mainTop, mainBottom: after.mainBottom });
check('クラス：追加で画面はスクロールしない（main.scrollTop は追加前と同じ）',
  scrolled.mainScrollTop === after.mainScrollTop,
  { before: scrolled.mainScrollTop, after: after.mainScrollTop });
check('クラス：未入力の行を表示中は「行の追加」ボタンが無効（disabled・aria-disabled）',
  after.addDisabled && after.addAriaDisabled,
  { addDisabled: after.addDisabled, ariaDisabled: after.addAriaDisabled });

await domClickAdd('class');
const twice = await snap('class');
check('クラス：未入力の行がある間は「行の追加」を2回押しても行は増えない',
  twice.rows === after.rows && twice.blankCount === 1 && twice.addDisabled,
  { rows: twice.rows, blankCount: twice.blankCount, addDisabled: twice.addDisabled });

// 未入力の行が最上部に出ている様子をカードごとスクリーンショットで残す
const classCard = await page.evaluate(() => {
  const card = document.querySelector('#basic-table-class')?.closest('.rounded-md.border-main');
  if (!card) return null;
  const r = card.getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) };
});
if (classCard) {
  await page.screenshot({
    path: path.join(OUT_DIR, 'exam-add-top-class-blank.png'),
    clip: {
      x: Math.max(0, classCard.x - 4),
      y: Math.max(0, classCard.y - 48),
      width: classCard.width + 8,
      height: Math.min(classCard.height + 52, 900),
    },
  });
}

// クラス名はサーバーの登録制約（初期の29名・学年内の重複不可）で固定されている。
// 重複名で保存すると 409 が返り、未入力の行は残る（ボタンは無効のまま）。
await fillBlank('class', { name: '1-3', grade: '1' });
const dupStatus = await saveBlank('class');
const afterDup = await snap('class');
check('クラス：初期データの名前を重複保存すると 409 で未入力の行は残りボタンは無効のまま',
  dupStatus === 409 && afterDup.rows === after.rows && afterDup.blankCount === 1 && afterDup.addDisabled,
  { status: dupStatus, rows: afterDup.rows, blank: afterDup.blankCount, addDisabled: afterDup.addDisabled });

// 未入力の行の「削除」は行をUIから破棄し「行の追加」は元通り使える（サーバー変更なし）
await page.evaluate(() => {
  const btn = document.querySelector('#basic-body-class tr[data-kind=\"class\"][data-id=\"\"] [data-act=\"delete\"]');
  btn.scrollIntoView({ block: 'center' });
  btn.click();
});
await sleep(400);
const afterDiscardClass = await snap('class');
check('クラス：未入力の行の「削除」は行をUIから破棄し「行の追加」は元通り使える',
  afterDiscardClass.rows === before.rows && afterDiscardClass.blankCount === 0 && !afterDiscardClass.addDisabled,
  { rows: afterDiscardClass.rows, blank: afterDiscardClass.blankCount, addDisabled: afterDiscardClass.addDisabled });

// 使用中のクラス行の「削除」ボタンは使用状況を照会して弾く（DELETE を送らない・行は残る）
const classTarget = await page.evaluate(() => {
  const rows = [...document.querySelectorAll('#basic-body-class tr[data-kind=\"class\"]')].filter((r) => r.dataset.id);
  const row = rows[0];
  return row ? { id: row.dataset.id, name: row.querySelector('[data-f=\"name\"]').value } : null;
});
const deleteReqs = [];
const onRequest = (r) => { if (r.method() === 'DELETE' && r.url().includes('/api/basic-info/class')) deleteReqs.push(r.url()); };
page.on('request', onRequest);
await page.evaluate((id) => {
  const btn = document.querySelector(`#basic-body-class tr[data-id=\"${id}\"] [data-act=\"delete\"]`);
  btn.scrollIntoView({ block: 'center' });
  btn.click();
}, classTarget.id);
await sleep(1600);
const afterUiDel = await snap('class');
check(`クラス：使用中の行（${classTarget.name}）の「削除」は DELETE を送らず行は残る`,
  deleteReqs.length === 0 && afterUiDel.rows === before.rows,
  { deleteReqs: deleteReqs.length, rows: afterUiDel.rows });
page.off('request', onRequest);

// サーバー側でも初期データのクラス名は削除できない（直接 DELETE で 409、行は残る）
const delStatus = await page.evaluate(async (id) => {
  const tok = localStorage.getItem('is_system_jwt_token_v251')
    || (JSON.parse(localStorage.getItem('is_system_user_info_v251') || '{}').token);
  const r = await fetch(`/api/basic-info/class/${id}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${tok}` },
  });
  return r.status;
}, classTarget.id);
const afterDel = await snap('class');
check('クラス：初期データのクラス名の行は DELETE 409 で削除できない（行は残る）',
  delStatus === 409 && afterDel.rows === before.rows, { status: delStatus, rows: afterDel.rows });

const orderAfter = await classOrderOk();
check('クラス：追加・破棄・削除試行後も順序と行数は崩れない',
  orderAfter.ok && orderAfter.n === baseOrder.n, { ok: orderAfter.ok, n: orderAfter.n, base: baseOrder.n });


/** 科目行の教科セレクトの現在値（教科id） */
const firstGroupId = () => page.evaluate(() =>
  document.querySelector('#basic-body-subject tr[data-kind="subject"][data-id=""] [data-f="group_id"]')?.value || '');

// ── 教科・科目・教室：同じルール（最上部・無効・保存で復活） ───────────────
const cases = [];
if (groupUnused) cases.push({ kind: 'group', name: groupUnused, fill: { name: groupUnused, subject: 'A' } });
cases.push({ kind: 'room', name: '追加位置Z9教室', fill: { name: '追加位置Z9教室', room_type: 'CLASS', seats: '30', grades: '1' } });
cases.push({ kind: 'subject', name: '追加位置テスト科目', fill: { name: '追加位置テスト科目', short_name: '追Z' } });

for (const c of cases) {
  const b = await snap(c.kind);
  await clickAdd(c.kind);
  const a = await snap(c.kind);
  check(`${c.kind}: 未入力の行は1件だけ表の最上部に出る（「行の追加」は無効）`,
    a.rows === b.rows + 1 && a.blankCount === 1 && a.blankIsFirst &&
    a.blankTop < a.firstSavedTop && a.addDisabled && a.addAriaDisabled,
    { rows: a.rows, blankCount: a.blankCount, blankTop: a.blankTop, firstSavedTop: a.firstSavedTop, addDisabled: a.addDisabled });
  await domClickAdd(c.kind);
  const t = await snap(c.kind);
  check(`${c.kind}: 未入力の行がある間は「行の追加」を2回押しても行は増えない`,
    t.rows === a.rows && t.blankCount === 1, { rows: t.rows, blankCount: t.blankCount });

  const fill = { ...c.fill };
  if (c.kind === 'subject') fill.group_id = await firstGroupId();
  await fillBlank(c.kind, fill);
  const st = await saveBlank(c.kind);
  const row = await rowByName(c.kind, c.name);
  const as = await snap(c.kind);
  check(`${c.kind}: 保存（POST ${st}）で未入力の行は消え「行の追加」は元通り使える`,
    st === 201 && as.blankCount === 0 && !as.addDisabled && row.index >= 0,
    { status: st, blankCount: as.blankCount, addDisabled: as.addDisabled, index: row.index });
  const ds = await deleteById(c.kind, row.id);
  const gone = await rowByName(c.kind, c.name);
  check(`${c.kind}: 削除（DELETE ${ds}）でベースラインへ復元`, ds === 200 && gone.index === -1, { index: gone.index });
}

// ── 未入力の行の「削除」は行を破棄してボタンは元通り使える ──────────────────
const beforeDiscard = await snap('room');
await clickAdd('room');
await page.evaluate(() => {
  const btn = document.querySelector('#basic-body-room tr[data-kind="room"][data-id=""] [data-act="delete"]');
  btn.scrollIntoView({ block: 'center' });
  btn.click();
});
await sleep(500);
const afterDiscard = await snap('room');
check('未入力の行の「削除」はその行をUIから破棄し「行の追加」は元通り使える',
  afterDiscard.rows === beforeDiscard.rows && afterDiscard.blankCount === 0 && !afterDiscard.addDisabled,
  { rows: afterDiscard.rows, blankCount: afterDiscard.blankCount, addDisabled: afterDiscard.addDisabled });

await page.screenshot({ path: path.join(OUT_DIR, 'exam-add-top-final.png') });

await browser.close();

const failed = failures.length;
console.log(`\n===== 行の追加の最上部配置テスト: ${failed} failures =====`);
process.exit(failed > 0 ? 1 : 0);

