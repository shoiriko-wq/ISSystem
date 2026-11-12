/**
 * EXAM-COMPLETE-REGRESSION-TEST 追加画面の行の追加位置
 * 目的: 未入力の行の「追加位置」が UI テスト仕様（basic-ui-test-design L136-138）どおりか測る。
 * 測定対象: 行の DOM の top をピクセルで実測し、表の先頭（最初の登録済み行より上）であることを検証する。
 * 期待: 「行の追加」で未入力の行は表の最上部に出る（下にスクロールして書かない）。ボタンは常時使える（未入力の行の件数で無効にならない）ので連続で複数行を追加できる。
 *       各行の「削除」は未入力の行をUIから破棄する（サーバーには何も送らない）。
 * 前提: サーバー（PORT 3333）が起動し、実DBへ初期データ（クラス30・教科9・科目98・教室14）のシーディングが終わっていること。
 * 削除の検証: クラス表で自由な名前の行を作り（クラスコードは自動採番）、DELETE で消す（サーバー側は初期名を固定しない）。
 * 副作用: 自動登録→DELETE でテスト専用の行を作り最後に消す（残さない）。使用中の行には触らない。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = 'http://localhost:3333';
const OUT_DIR = 'screenshots/basic-ui';
const STAMP = 'Z' + String(Date.now()).slice(-4);

const failures = [];
const logLines = [];
const check = (name, cond, detail) => {
  const line = `${cond ? 'ok' : 'FAIL'} - ${name} | ${detail}`;
  logLines.push(line);
  console.log(line);
  if (!cond) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 一般ユーザー（exam_operator）でログインして一般権限の権限マップを持たせる */
const login = async () => {
  const browser = await chromium.launch({
    headless: false,
    args: ['--disable-search-engine-choice-screen', '--lang=ja-JP'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 950 } });
  await ctx.addInitScript((u) => { localStorage.setItem('is_system_url_v251', u); }, BASE_URL);
  const page = await ctx.newPage();
  await page.goto(`${BASE_URL}/?next=exam`);
  const status = await page.evaluate(async () => {
    const r = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'user1', password: 'user1234' }),
    });
    const j = await r.json().catch(() => null);
    return { status: r.status, token: j?.token, permission_map: j?.permission_map ?? null };
  });
  if (status.status !== 200 || !status.token) {
    console.log(`login status=${status.status}`);
    await browser.close();
    process.exit(1);
  }
  const map = status.permission_map
    ? (status.permission_map.super_admin ? 'super_admin' : 'exam_operator')
    : 'admin';
  await page.evaluate((vals) => {
    localStorage.setItem('is_system_jwt_token_v251', vals.token);
    localStorage.setItem('is_system_user_info_v251', JSON.stringify({ username: 'user1', role: 'user', token: vals.token }));
    localStorage.setItem('is_system_permission_map_v251', JSON.stringify(vals.map));
  }, { token: status.token, map });
  return { browser, page };
};

/** 指定表の「行の追加」ボタン（行の追加は追加ボタンだけ＝未入力の行をUIに出すだけ＝サーバーには何も送らない） */
const addButton = (kind) => `#basic-table-${kind} [data-act="add-row"]`;

const clickAdd = (kind) => page.click(addButton(kind));
const domClickAdd = (kind) => page.evaluate((sel) => document.querySelector(sel)?.click(), addButton(kind));

/** 状態実測: 行数・未入力の行数・未入力の行の top・先頭/末尾の登録済み行の top・ボタン有効状態・main の scrollTop */
const snap = (kind) => page.evaluate((k) => {
  const trs = [...document.querySelectorAll(`#basic-body-${k} tr[data-kind="${k}"]`)];
  const blank = trs.filter((r) => r.dataset.id === '');
  const saved = trs.filter((r) => r.dataset.id !== '');
  const main = document.getElementById('main-scroll');
  const mainRect = main.getBoundingClientRect();
  const card = document.querySelector(`#basic-table-${k}`)?.closest('.rounded-md.border-main');
  const cardRect = card.getBoundingClientRect();
  const firstBlank = blank[0];
  const bt = firstBlank ? firstBlank.getBoundingClientRect().top : -1;
  return {
    rows: trs.length,
    blankCount: blank.length,
    blanksLeading: blank.length && trs[0].dataset.id === '' && blank.every((r) => trs.indexOf(r) < saved.length),
    blankIsFirst: trs[0] === firstBlank,
    blankTop: Math.round(bt),
    firstSavedTop: saved.length ? Math.round(saved[0].getBoundingClientRect().top) : -1,
    lastSavedTop: saved.length ? Math.round(saved[saved.length - 1].getBoundingClientRect().top) : -1,
    blankVisible: bt >= mainRect.top && bt <= mainRect.bottom &&
      bt >= cardRect.top && bt <= cardRect.bottom,
    mainTop: Math.round(mainRect.top),
    mainBottom: Math.round(mainRect.bottom),
    mainScrollTop: Math.round(main.scrollTop),
    addDisabled: document.querySelector(`#basic-table-${k} [data-act="add-row"]`)?.disabled,
    addAriaDisabled: document.querySelector(`#basic-table-${k} [data-act="add-row"]`)?.getAttribute('aria-disabled') === 'true',
  };
}, kind);

/** 未入力の行（1件目）へ入力して焦点を行の外へ移すと自動登録（POST）される */
const fillBlank = (kind, fields, index = 0) => page.evaluate((k, fs2, i) => {
  const rows = [...document.querySelectorAll(`#basic-body-${k} tr[data-kind="${k}"][data-id=""]`)];
  const row = rows[i];
  for (const [f, v] of Object.entries(fs2)) {
    const el = row.querySelector(`[data-f="${f}"]`);
    if (!el) continue;
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  const first = row.querySelector('[data-f="name"]');
  first.focus();
  first.dispatchEvent(new Event('blur', { bubbles: true }));
}, kind, fields, index);

/** 自動登録（POST）の応答を捕まえる。未入力の行が消える＝自動登録成功を待つ */
const autoSaveBlank = (kind, method = 'POST') => page.waitForResponse(
  (r) => r.url().includes(`/api${API_PATH[kind]}`) && r.request().method() === method &&
    r.request().url().replace(/[?].*$/, '') === `/api${API_PATH[kind]}`,
  { timeout: 10000 }
);

/** 行の「削除」ボタン（未入力の行＝未登録の行をUIから破棄する／登録済み行＝サーバーから削除する） */
const deleteRow = (kind, id = '') => page.evaluate((k, rid) => {
  const row = document.querySelector(`#basic-body-${k} tr[data-kind="${k}"][data-id="${rid}"]`);
  const btn = row.querySelector('[data-act="delete"]');
  btn.scrollIntoView({ block: 'center' });
  btn.click();
}, kind, id);

const discardBlank = (kind, index = 0) => page.evaluate((k, i) => {
  const rows = [...document.querySelectorAll(`#basic-body-${k} tr[data-kind="${k}"][data-id=""]`)];
  const btn = rows[i].querySelector('[data-act="delete"]');
  btn.scrollIntoView({ block: 'center' });
  btn.click();
}, kind, index);

/** 登録済み行の「削除」で DELETE の応答を捕まえる（使用中なら DELETE は送られない） */
const deleteById = (kind, id) => page.waitForResponse(
  (r) => r.url().replace(/[?].*$/, '') === `/api${API_PATH[kind]}/${id}` && r.request().method() === 'DELETE',
  { timeout: 10000 }
).then((r) => r.status());

/** クラス表で名前に一致する行の index と id を読む */
const rowByName = (kind, name) => page.evaluate((k, n) => {
  const rows = [...document.querySelectorAll(`#basic-body-${k} tr[data-kind="${k}"]`)];
  const i = rows.findIndex((r) => r.querySelector('[data-f="name"]')?.value === n);
  return { index: i, id: i >= 0 ? rows[i].dataset.id : null };
}, kind, name);

/** クラス表が学年順+名前順（登録済み行）で並んでいるか */
const classOrderOk = () => page.evaluate(() => {
  const items = [...document.querySelectorAll('#basic-body-class tr[data-kind="class"]')]
    .filter((r) => r.dataset.id)
    .map((r) => ({
      grade: Number(r.querySelector('[data-f="grade"]')?.value || 1),
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

const API_PATH = { class: '/basic-info/class', group: '/subjects', subject: '/basic-info/subject', room: '/basic-info/room' };

// サーバー側は初期名を固定しない（クラス名・教科名も自由に登録でき、初期データ行も使用状況の照会を通れば削除できる）。
// 学年内のクラス名の重複だけが制約（409）として残る。

/** 科目行の教科セレクトの現在値（教科id） */
const firstGroupId = () => page.evaluate(() =>
  document.querySelector('#basic-body-subject tr[data-kind="subject"][data-id=""] [data-f="subject_id"]')?.value || '');

/** セッショントークン（localStorage）でサーバーの使用状況を照会し、使用中/非使用中の行を選ぶ */
const pickByUsage = (kind, wantUsed) => page.evaluate(async (k, used) => {
  const tok = localStorage.getItem('is_system_jwt_token_v251')
    || (JSON.parse(localStorage.getItem('is_system_user_info_v251') || '{}').token);
  const rows = [...document.querySelectorAll(`#basic-body-${k} tr[data-kind="${k}"]`)].filter((r) => r.dataset.id);
  for (const r of rows) {
    const id = r.dataset.id;
    const res = await fetch(`/api/basic-info/usage/${k}/${id}`, { headers: { Authorization: `Bearer ${tok}` } });
    const j = await res.json().catch(() => null);
    const total = j?.usage?.total ?? j?.total ?? 0;
    if ((used && total > 0) || (!used && total === 0)) {
      return {
        id,
        name: r.querySelector('[data-f="name"]')?.value || '',
        grade: Number(r.querySelector('[data-f="grade"]')?.value || 1),
        total,
      };
    }
  }
  return null;
}, kind, wantUsed);

// ── クラス表：未入力の行は最上部・ボタンは常時有効・連続で複数追加できる ──────
const classNamesBefore = await classNames();
const before = await snap('class');
const baseOrder = await classOrderOk();
check('クラス：ベースラインの行は学年順+名前順で並んでいる', baseOrder.ok, { ok: baseOrder.ok, n: baseOrder.n });

await page.evaluate(() => {
  const card = document.querySelector('#basic-table-class')?.closest('.rounded-md.border-main');
  card?.scrollIntoView({ block: 'start' });
});
await sleep(350);
const scrolled = await snap('class');
await clickAdd('class');
const after = await snap('class');

check('クラス：「行の追加」で未入力の行は表の最上部に足す',
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
check('クラス：「行の追加」ボタンは常時使える（未入力の行があっても disabled・aria-disabled にならない）',
  !after.addDisabled && !after.addAriaDisabled,
  { addDisabled: after.addDisabled, ariaDisabled: after.addAriaDisabled });

await domClickAdd('class');
const twice = await snap('class');
check('クラス：「行の追加」を連続で押すと未入力の行が2件並ぶ（ボタンは使えたまま）',
  twice.rows === after.rows + 1 && twice.blankCount === 2 && twice.blanksLeading === 2 && !twice.addDisabled,
  { rows: twice.rows, blankCount: twice.blankCount, blanksLeading: twice.blanksLeading, addDisabled: twice.addDisabled });

// 未入力の行が最上部に2件並んでいる様子をカードごとスクリーンショットで残す
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

// 未入力の行の「削除」は行をUIから破棄する（サーバー変更なし）
await discardBlank('class', 0);
const midDiscard = await snap('class');
check('クラス：未入力の行の「削除」はその行をUIから破棄する（1件消える）',
  midDiscard.rows === after.rows && midDiscard.blankCount === 1,
  { rows: midDiscard.rows, blank: midDiscard.blankCount });
await discardBlank('class', 0);
const afterDiscard = await snap('class');
check('クラス：未入力の行を連続で破棄するとベースラインの行数へ戻る（サーバー変更なし）',
  afterDiscard.rows === before.rows && afterDiscard.blankCount === 0,
  { rows: afterDiscard.rows, blank: afterDiscard.blankCount });


// 自由なクラス名で最上部の未入力の行を登録し、その行を DELETE で消す（コード側に初期名を固定しない）
const takenClasses = await classNames();
const takenGroups = await groupNames();
const makeUnique = (base, taken) => {
  let n = base;
  let i = 2;
  while (taken.includes(n)) n = base + i++;
  return n;
};
const newClass = makeUnique(`1-9${STAMP}`, takenClasses);   // 1年のテスト専用クラス名（最後に削除する）
const newGroup = makeUnique(`追加テスト教科${STAMP}`, takenGroups);

await clickAdd('class');
await fillBlank('class', { grade: '1', name: newClass });
const createStatus = await autoSaveBlank('class');
const created = await rowByName('class', newClass);
const afterCreate = await snap('class');
check(`クラス：自由な名前「${newClass}」を最上部の未入力の行へ入力して焦点を外すと自動登録（POST ${createStatus}）される`,
  createStatus === 201 && created.index >= 0 && afterCreate.rows === before.rows + 1 && afterCreate.blankCount === 0,
  { status: createStatus, index: created.index, rows: afterCreate.rows, blank: afterCreate.blankCount });
const createDelStatus = await deleteById('class', created.id);
const afterCreateDel = await snap('class');
check(`クラス：テストで作った行「${newClass}」の「削除」は DELETE ${createDelStatus} で行が消えベースラインへ復元する`,
  createDelStatus === 200 && afterCreateDel.rows === before.rows && afterCreateDel.blankCount === 0,
  { status: createDelStatus, rows: afterCreateDel.rows, blank: afterCreateDel.blankCount });

// 学年内の重複名はサーバーの重複チェックで 409（未入力の行は残る＝ボタンは使える）
await clickAdd('class');
await fillBlank('class', { grade: '1', name: classNamesBefore[0] });
const dupStatus = await autoSaveBlank('class');
const afterDup = await snap('class');
check(`クラス：1年に既存の名前「${classNamesBefore[0]}」を重複登録しようとすると 409 で未入力の行は残りボタンは使える`,
  dupStatus === 409 && afterDup.rows === before.rows + 1 && afterDup.blankCount === 1 && !afterDup.addDisabled,
  { status: dupStatus, rows: afterDup.rows, blank: afterDup.blankCount, addDisabled: afterDup.addDisabled });
await discardBlank('class', 0);
const afterDupDiscard = await snap('class');
check('クラス：重複で残った未入力の行の「削除」は行をUIから破棄する',
  afterDupDiscard.rows === before.rows && afterDupDiscard.blankCount === 0,
  { rows: afterDupDiscard.rows, blank: afterDupDiscard.blankCount });

// 使用中のクラス行の「削除」ボタンは使用状況を照会して弾く（DELETE を送らない・行は残る）
const usedClass = await pickByUsage('class', true);
check(`使用中のクラス行が1件以上ある（${usedClass ? usedClass.name : 'なし'}）`, Boolean(usedClass), usedClass);
const deleteReqs = [];
const onRequest = (r) => { if (r.method() === 'DELETE' && r.url().includes('/api/basic-info/class')) deleteReqs.push(r.url()); };
page.on('request', onRequest);
if (usedClass) {
  await page.evaluate((id) => {
    const btn = document.querySelector(`#basic-body-class tr[data-id="${id}"] [data-act="delete"]`);
    btn.scrollIntoView({ block: 'center' });
    btn.click();
  }, usedClass.id);
  await sleep(1600);
}
const afterUiDel = await snap('class');
check(`クラス：使用中の行（${usedClass ? usedClass.name : '-'}）の「削除」は DELETE を送らず行は残る`,
  deleteReqs.length === 0 && afterUiDel.rows === before.rows,
  { deleteReqs: deleteReqs.length, rows: afterUiDel.rows });
page.off('request', onRequest);

// 使用中でない初期データの行は「削除」できる（サーバー側は初期名を固定しない＝初期データ行も DELETE 200）
const freeClass = await pickByUsage('class', false);
check(`使用中でない初期データのクラス行が1件以上ある（${freeClass ? freeClass.name : 'なし'}）`, Boolean(freeClass), freeClass);
if (freeClass) {
  const freeDelStatus = await deleteById('class', freeClass.id);
  const afterFreeDel = await snap('class');
  check(`クラス：使用中でない初期データの行「${freeClass.name}」の「削除」は DELETE ${freeDelStatus} で行が消える`,
    freeDelStatus === 200 && afterFreeDel.rows === before.rows - 1,
    { status: freeDelStatus, rows: afterFreeDel.rows });
  // 同じ学年・名前で作り直してベースラインへ復元する（自由な名前が登録できることも同時に測る）
  await clickAdd('class');
  await fillBlank('class', { grade: String(freeClass.grade), name: freeClass.name });
  const restoreStatus = await autoSaveBlank('class');
  const restored = await rowByName('class', freeClass.name);
  const afterRestore = await snap('class');
  const restoreOrder = await classOrderOk();
  check(`クラス：削除した行「${freeClass.name}」を同じ学年・名前で作り直してベースラインへ復元する（POST ${restoreStatus}）`,
    restoreStatus === 201 && restored.index >= 0 && afterRestore.rows === before.rows &&
    restoreOrder.ok && restoreOrder.n === baseOrder.n,
    { status: restoreStatus, index: restored.index, rows: afterRestore.rows, n: restoreOrder.n });
}


// ── 教科・教室・科目：同じルール（最上部・常時有効・連続追加・自動登録・削除） ──
const cases = [
  { kind: 'group', name: newGroup, fill: { name: newGroup } },
  { kind: 'room', name: `追加位置${STAMP}教室`, fill: { name: `追加位置${STAMP}教室`, seats: '30', notes: '回帰テスト' } },
  { kind: 'subject', name: `追加位置${STAMP}科目`, fill: { name: `追加位置${STAMP}科目`, short_name: '追Z' } },
];

for (const c of cases) {
  const b = await snap(c.kind);
  await clickAdd(c.kind);
  const a = await snap(c.kind);
  check(`${c.kind}: 未入力の行は最上部に足す（「保存」ボタンは無く削除ボタンだけ・ボタンは常時有効）`,
    a.rows === b.rows + 1 && a.blankCount === 1 && a.blankIsFirst &&
    a.blankTop < a.firstSavedTop && !a.addDisabled,
    { rows: a.rows, blankCount: a.blankCount, blankTop: a.blankTop, firstSavedTop: a.firstSavedTop, addDisabled: a.addDisabled });
  await domClickAdd(c.kind);
  const t = await snap(c.kind);
  check(`${c.kind}: 「行の追加」を連続で押すと未入力の行が2件並ぶ`,
    t.rows === a.rows + 1 && t.blankCount === 2 && t.blanksLeading === 2,
    { rows: t.rows, blankCount: t.blankCount, blanksLeading: t.blanksLeading });

  const fill = { ...c.fill };
  if (c.kind === 'subject') fill.subject_id = await firstGroupId();
  await fillBlank(c.kind, fill, 0);
  const st = await autoSaveBlank(c.kind);
  const row = await rowByName(c.kind, c.name);
  const as = await snap(c.kind);
  check(`${c.kind}: 未入力の行へ入力して焦点を行の外へ移すと自動登録（POST ${st}）され、未入力の行は消える`,
    st === 201 && as.blankCount === 0 && row.index >= 0,
    { status: st, blankCount: as.blankCount, index: row.index });
  const ds = await deleteById(c.kind, row.id);
  const gone = await rowByName(c.kind, c.name);
  const back = await snap(c.kind);
  check(`${c.kind}: 削除（DELETE ${ds}）でベースラインへ復元`,
    ds === 200 && gone.index === -1 && back.rows === b.rows,
    { status: ds, index: gone.index, rows: back.rows });
}

// クラス表の並び順は追加・登録・削除の操作後も崩れない
const finalOrder = await classOrderOk();
check('クラス：追加・登録・削除の操作後も学年順+名前順と行数は崩れない',
  finalOrder.ok && finalOrder.n === baseOrder.n, { ok: finalOrder.ok, n: finalOrder.n, base: baseOrder.n });

await page.screenshot({ path: path.join(OUT_DIR, 'exam-add-top-final.png') });

await browser.close();

const failed = failures.length;
console.log(`\n===== 行の追加の最上部配置テスト: ${failed} failures =====`);
process.exit(failed > 0 ? 1 : 0);

