/**
 * 定期考査 基本情報「3. 科目（教科・科目名・略称）× 実施クラス・コース」テーブルの回帰テスト（実ブラウザ検証）
 *
 * ルール（`public/js/modules/exam/exam.basic.ui.js`）:
 *  R1. 実施数列は存在しない（列は 教科・科目名・略称・実施クラス・コース・操作 の 5 列）。
 *      実施数はチップ選択そのものが示す。
 *  R2. 科目名・略称列は実枠 14% / 8%（table-layout:fixed）で、入力欄（実枠）が列幅の 90% 以上ある。
 *  R3. 実施クラス・コース列はチップ内容分の幅（63%）で、チップがコンテナ右端を超えない。
 *      1440px では学年ごとに 1 行（チップ行 = 学年数）で収まる。
 *  R4. カード・テーブル・内容領域に水平スクロールが発生せず、操作列の削除ボタンが列の右端を超えない。
 *  R5. チップをクリックすると選択（bg-accent-soft）になり、選択を終えた（ポインタを離した）瞬間に自動登録（PUT）されて
 *      サーバーへ class_course_ids が届く。ページを再読み込みしても選択が維持される（Shift+クリックで範囲選択、解除して元へ戻す）。
 *  R6. 「行を追加」は未入力の行を表の最上部に足す（未入力の行の top は最初の登録済み行より上）。
 *      「行を追加」ボタンは常に使える（未入力の行の件数で無効にならない）ので、
 *      2回押すと未入力の行が2件並ぶ。自動登録・破棄すると未入力の行は消える。
 *      登録済み行は通常の順（クラス=学年順・教科=登録順・科目=教科順）で並ぶ。
 *  R7. 行に「保存」ボタンは無い（ボタン・title・トースト・説明文に「保存」の語が出ない）。行の編集は
 *      入力欄を書いて焦点が行の外へ移った瞬間に自動登録される。焦点が行内の次の入力欄へ移るだけでは書き込まない
 *      （焦点移動ごとにリクエストが走らない）。ページを再読み込みしても入力内容が行に残る（サーバーへ書き込まれている）。
 *
 * 実行: npm run test:ui:exambasic  （ISSystem サーバーが必要）
 * options: UI_BASE=https://127.0.0.1:3443 UI_USER=T2026001 UI_PASS=password123
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
const VIEWPORTS = [1440, 1280, 1024, 768];

function findChrome() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH を指定してください。');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
};

// テーブルの列幅・チップ配置・はみ出しをまとめて測る（実枠 rect ベース）
const GEOMETRY = () => {
  const tbody = document.getElementById('basic-body-subject');
  if (!tbody) return { err: 'no subject table' };
  const table = tbody.closest('table');
  const card = tbody.closest('.card');
  const row = tbody.querySelector('tr');
  const tds = [...row.querySelectorAll('td')];
  const cellRect = (i) => {
    const r = tds[i]?.getBoundingClientRect();
    return r ? { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) } : null;
  };
  const inputRect = (name) => {
    const el = row.querySelector(`[data-f="${name}"]`);
    const r = el?.getBoundingClientRect();
    return r ? { w: Math.round(r.width), right: Math.round(r.right) } : null;
  };
  const list = row.querySelector('.cc-list');
  const chips = [...row.querySelectorAll('[data-cc]')];
  const lr = list?.getBoundingClientRect();
  const rowsMap = new Map();
  let chipOver = 0;
  for (const c of chips) {
    const r = c.getBoundingClientRect();
    rowsMap.set(Math.round(r.top), (rowsMap.get(Math.round(r.top)) || 0) + 1);
    if (lr && r.right > lr.right + 1) chipOver += 1;
  }
  const buttons = [...row.querySelectorAll('button[data-act="delete"]')].map((b) => Math.round(b.getBoundingClientRect().right));
  const saveBtnCount = row.querySelectorAll('button[data-act="save"]').length;
  const content = document.querySelector('#app-container main') || document.querySelector('main');
  const picker = cellRect(3);
  return {
    heads: [...table.querySelectorAll('thead th')].map((t) => t.textContent.trim()),
    tableW: Math.round(table.getBoundingClientRect().width),
    cardW: Math.round(card.getBoundingClientRect().width),
    cols: tds.map((_, i) => cellRect(i)),
    gradeRows: [...row.querySelectorAll('.cc-list > div')].length,
    pickerW: picker ? picker.w : -1,
    pickerRight: picker ? picker.right : -1,
    listW: lr ? Math.round(lr.width) : -1,
    listRight: lr ? Math.round(lr.right) : -1,
    chips: chips.length,
    chipRows: [...rowsMap.values()],
    chipOver,
    name: inputRect('name'),
    short: inputRect('short_name'),
    saveBtnCount,
    buttonMaxRight: buttons.length ? Math.max(...buttons) : 0,
    actionRight: cellRect(tds.length - 1)?.right ?? -1,
    contentOverflow: content.scrollWidth - content.clientWidth,
    tableOverflow: table.scrollWidth - table.clientWidth,
    rowH: Math.round(row.getBoundingClientRect().height),
  };
};

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') console.log(`  [console error] ${m.text()}`);
});
// 自動登録（POST/PUT）のリクエスト数を数える（焦点移動ごとに走らないことを確認する）
page.on('request', (r) => {
  const m = r.method();
  if (m === 'POST' || m === 'PUT') {
    page.evaluate((u, mm) => { (window.__reqs = window.__reqs || []).push({ url: u, method: mm }); }, r.url(), m);
  }
});

const loginToBasic = async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(900);
  await page.click('[data-tab="exam"]');
  await sleep(1600);
};
// ==========================================================
// セクション編集ロック（既定は読み取り専用、トグルで編集可能 ⇔ 編集ロック）
// ラベルは「押せる動作」を示す: 編集ロック中（読み取り専用）なら「編集可能」、編集可能なら「編集ロック」
// ==========================================================

/** ロックトグルと実枠の操作可能状態をまとめて測る */
const lockUiState = (kind) =>
  page.evaluate((k) => {
    const btn = document.getElementById(`basic-lock-${k}`);
    const rows = [...document.querySelectorAll(`#basic-body-${k} tr[data-kind="${k}"]`)];
    const inputs = rows.flatMap((r) => [...r.querySelectorAll('input, select')]);
    const addBtn = document.getElementById(`basic-add-${k}`);
    return {
      hasLockBtn: !!btn,
      label: btn?.querySelector('span')?.textContent?.trim() ?? '',
      otherLabel: btn?.textContent?.includes('他:') === true,
      primary: btn?.classList.contains('btn-primary') === true,
      addDisabled: addBtn?.disabled === true,
      inputsDisabled: inputs.length > 0 && inputs.every((i) => i.disabled),
    };
  }, kind);

/** トグルを押して編集可能（unlocked=true）⇔ 編集ロック（unlocked=false）へ整える（操作後の実枠状態を返す） */
const setLockMode = async (kind, unlocked) => {
  const st = await lockUiState(kind);
  const isUnlocked = st.label === '編集ロック';   // ラベルが「編集ロック」= 現在は編集可能（押すと読み取り専用へ戻る）
  if (st.hasLockBtn && isUnlocked === unlocked) return st;
  await page.evaluate((k) => document.getElementById(`basic-lock-${k}`)?.scrollIntoView({ block: 'center' }), kind);
  await page.click(`#basic-lock-${kind}`);
  await sleep(900);
  return lockUiState(kind);
};


for (const vw of VIEWPORTS) {
  console.log(`--- ${vw}px ---`);
  await page.setViewport({ width: vw, height: 1000 });
  await loginToBasic();
  const g = await page.evaluate(GEOMETRY);
  if (g.err) {
    check(`${vw}px 科目テーブルが描画される`, false, g.err);
    continue;
  }
  check(`${vw}px 実施数列がない（列は5つ）`, !g.heads.some((h) => h.includes('実施数')) && g.heads.length === 5, g.heads.join('|'));
  check(`${vw}px 科目名列は実枠14%`, Math.abs(g.cols[1].w - 0.14 * g.tableW) <= 3, `${g.cols[1].w}/${Math.round(0.14 * g.tableW)}`);
  check(`${vw}px 略称列は実枠8%`, Math.abs(g.cols[2].w - 0.08 * g.tableW) <= 3, `${g.cols[2].w}/${Math.round(0.08 * g.tableW)}`);
  check(`${vw}px 科目名入力欄が列幅の90%以上`, g.name.w >= g.cols[1].w * 0.9, `${g.name.w}/${g.cols[1].w}`);
  check(`${vw}px 略称入力欄が列幅の90%以上`, g.short.w >= g.cols[2].w * 0.9, `${g.short.w}/${g.cols[2].w}`);
  check(`${vw}px チップが実施クラス・コース列の右端を超えない`, g.chipOver === 0, `over=${g.chipOver} listRight=${g.listRight} pickerRight=${g.pickerRight}`);
  check(`${vw}px 水平スクロールなし（カード・内容領域）`, g.contentOverflow <= 0 && g.tableOverflow <= 0, `content=${g.contentOverflow} table=${g.tableOverflow}`);
  check(`${vw}px 削除ボタンが操作列内に収まる`, g.buttonMaxRight <= g.actionRight + 1, `${g.buttonMaxRight}/${g.actionRight}`);
  check(`${vw}px 行に「保存」ボタンはない（行の編集は自動登録）`, g.saveBtnCount === 0, `save=${g.saveBtnCount}`);
  const lockSt = await lockUiState('subject');
  check(
    `${vw}px 既定は読み取り専用（トグルは「編集可能」で入力欄・チップ・行追加が操作不能）`,
    lockSt.hasLockBtn && lockSt.label === '編集可能' && !lockSt.primary && lockSt.addDisabled && lockSt.inputsDisabled,
    JSON.stringify(lockSt),
  );
  if (vw >= 1440) {
    check('1440px チップは学年ごとに1行（列幅は内容分）', g.chipRows.length === g.gradeRows && g.listW >= g.pickerW * 0.98, `chipRows=${g.chipRows.join(',')} gradeRows=${g.gradeRows} pickerW=${g.pickerW} listW=${g.listW}`);
  }
  await page.evaluate(() => document.getElementById('basic-body-subject')?.scrollIntoView({ block: 'center' }));
  await sleep(200);
  const cardHandle = await page.evaluateHandle(() => document.getElementById('basic-body-subject').closest('.card'));
  const cardEl = cardHandle.asElement();
  await (cardEl ? cardEl.screenshot({ path: path.join(OUT_DIR, `exam-basic-subject-${vw}-card.png`) }) : page.screenshot({ path: path.join(OUT_DIR, `exam-basic-subject-${vw}.png`) }));
}

// R5. チップクリック・Shift 範囲選択・自動登録（選択を終えた瞬間の PUT でサーバー反映）
console.log('--- チップ選択と自動登録（1440px） ---');
await page.setViewport({ width: 1440, height: 1000 });
await loginToBasic();

// チップ選択・自動登録は編集可能モードでしか効かない（既定は読み取り専用）→ トグルで編集可能へ
const subjLock = await setLockMode('subject', true);
check(
  '科目セクションのトグルで編集可能モードへ（トグルは「編集ロック」表示・入力欄・チップ・行追加が操作可能）',
  subjLock.label === '編集ロック' && subjLock.primary && !subjLock.addDisabled && !subjLock.inputsDisabled,
  JSON.stringify(subjLock),
);

const targets = await page.evaluate(() => {
  const row = document.querySelector('#basic-body-subject tr');
  const chips = [...row.querySelectorAll('[data-cc]')];
  const off = chips.filter((c) => !c.classList.contains('bg-accent-soft'));
  window.__sid = row.dataset.id;
  const base = chips.filter((c) => c.classList.contains('bg-accent-soft')).map((c) => c.dataset.cc);
  return { id: row.dataset.id, a: off[0]?.dataset.cc, b: off[2]?.dataset.cc, n: off.length, base };
});
check('未選択チップが3つ以上ある', targets.n >= 3, `n=${targets.n}`);

const clickChip = async (id, shift = false) => {
  const box = await page.evaluate((cid) => {
    const el = document.querySelector(`#basic-body-subject tr [data-cc="${cid}"]`);
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2);
    const y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, cc: hit?.dataset?.cc || null };
  }, id);
  if (box.cc !== id) return false;
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.click(box.x, box.y);
  await sleep(120);
  if (shift) await page.keyboard.up('Shift');
  return true;
};

/** チップ選択を終えた瞬間（ポインタを離した瞬間）に走る自動登録（PUT）のレスポンスを待つ */
const putAfterChip = () => page.waitForResponse(
  (r) => r.url().includes('/basic-info/subject/') && r.request().method() === 'PUT', { timeout: 6000 }
);

const pA = putAfterChip();
await clickChip(targets.a);
const stA = (await pA).status();
const onA = await page.evaluate((cid) => document.querySelector(`[data-cc="${cid}"]`).classList.contains('bg-accent-soft'), targets.a);
check(`チップクリックで選択され、選択を終えた瞬間に自動登録（PUT ${stA}）される`, stA === 200 && onA, `status=${stA} on=${onA}`);

const pB = putAfterChip();
await clickChip(targets.b, true);
const rangeOn = await page.evaluate(
  (a, b) => {
    const chips = [...document.querySelector('#basic-body-subject tr').querySelectorAll('[data-cc]')];
    const i = chips.findIndex((c) => c.dataset.cc === a);
    const j = chips.findIndex((c) => c.dataset.cc === b);
    const [lo, hi] = i <= j ? [i, j] : [j, i];
    return chips.slice(lo, hi + 1).every((c) => c.classList.contains('bg-accent-soft'));
  },
  targets.a,
  targets.b
);
const stB = (await pB).status();
check(`Shift+クリックで範囲選択され、選択を終えた瞬間に自動登録（PUT ${stB}）される`, stB === 200 && rangeOn, `status=${stB}`);

const kept = await page.evaluate(
  (a, b) => {
    const row = [...document.querySelectorAll('#basic-body-subject tr')].find((r) => r.dataset.id === window.__sid);
    if (!row) return { err: 'row missing' };
    const sel = [...row.querySelectorAll('[data-cc].bg-accent-soft')].map((c) => c.dataset.cc);
    return { selA: sel.includes(a), selB: sel.includes(b), n: sel.length };
  },
  targets.a,
  targets.b
);
check(`チップクリック時の自動登録（PUT ${stA}）が行の選択として残っている`, kept.selA && kept.selB, JSON.stringify(kept));

// 選択を元の集合へ戻す（範囲選択で作った追加分を個別に解除 → 解除のたびに自動登録される）
const extras = await page.evaluate(
  (base) => {
    const row = document.querySelector('#basic-body-subject tr');
    return [...row.querySelectorAll('[data-cc].bg-accent-soft')].map((c) => c.dataset.cc).filter((id) => !base.includes(id));
  },
  targets.base
);
for (const id of extras) {
  const pExtra = putAfterChip();
  await clickChip(id);
  await pExtra;
  await sleep(400);
}
const restored = await page.evaluate(
  (a, b, base) => {
    const row = [...document.querySelectorAll('#basic-body-subject tr')].find((r) => r.dataset.id === window.__sid);
    const sel = [...(row?.querySelectorAll('[data-cc].bg-accent-soft') || [])].map((c) => c.dataset.cc).sort();
    return { ok: sel.join(',') === [...base].sort().join(','), sel: sel.join(','), base: [...base].sort().join(',') };
  },
  targets.a,
  targets.b,
  targets.base
);
check('解除して自動登録すると選択が元の集合へ戻る', restored.ok, `sel=${restored.sel} base=${restored.base}`);

// ページを再読み込みしても自動登録した選択が元の集合のまま（サーバーへ書き込まれており、未保存の選択は消えない）
await loginToBasic();
const selAfterReload = await page.evaluate(
  (sid, base) => {
    const row = [...document.querySelectorAll('#basic-body-subject tr')].find((r) => r.dataset.id === sid);
    const sel = [...(row?.querySelectorAll('[data-cc].bg-accent-soft') || [])].map((c) => c.dataset.cc).sort();
    return { ok: sel.join(',') === [...base].sort().join(','), sel: sel.join(','), base: [...base].sort().join(',') };
  },
  targets.id,
  targets.base
);
check('ページを再読み込みしてもチップ選択は元の集合のまま（自動登録がサーバーへ書き込まれている＝未保存テキスト消失がない）', selAfterReload.ok, `sel=${selAfterReload.sel} base=${selAfterReload.base}`);

// 編集可能モードをトグルで閉じる（読み取り専用へ戻る・入力欄と行追加が操作不能へ）
const subjRelock = await setLockMode('subject', false);
check(
  'トグルをもう一度押すと読み取り専用へ戻る（トグルは「編集可能」表示・入力欄と行追加が操作不能）',
  subjRelock.label === '編集可能' && !subjRelock.primary && subjRelock.addDisabled && subjRelock.inputsDisabled,
  JSON.stringify(subjRelock),
);

// ==========================================================
// 行の追加・保存・削除（クラス・教科・科目・教室の全テーブル）
// ==========================================================

const API_PATH = { class: '/basic-info/class', group: '/subjects', subject: '/basic-info/subject', room: '/basic-info/room' };

// 削除確認 (window.confirm) を自動承認する
page.on('dialog', (d) => d.accept());

const rowInfo = (kind) =>
  page.evaluate((k) => {
    const rows = [...document.querySelectorAll(`#basic-body-${k} tr`)];
    return {
      count: rows.length,
      rows: rows.map((r) => ({ id: r.dataset.id ?? '', name: r.querySelector('[data-f="name"]')?.value ?? '' })),
    };
  }, kind);

const addRow = async (kind) => {
  await page.evaluate((k) => document.getElementById(`basic-add-${k}`).scrollIntoView({ block: 'center' }), kind);
  await page.click(`#basic-add-${kind}`);
  await sleep(300);
  return page.evaluate((k) => {
    const tbody = document.getElementById(`basic-body-${k}`);
    const rows = [...tbody.querySelectorAll('tr')];
    const blank = rows.find((r) => r.dataset.kind && !r.dataset.id);
    const firstSaved = rows.find((r) => r.dataset.kind && r.dataset.id);
    const topOf = (r) => (r ? Math.round(r.getBoundingClientRect().top) : -1);
    const addBtn = document.getElementById(`basic-add-${k}`);
    return {
      count: rows.length,
      blankCount: rows.filter((r) => r.dataset.kind && !r.dataset.id).length,
      blankIsFirst: tbody.firstElementChild === blank,
      blankTop: topOf(blank),
      firstSavedTop: topOf(firstSaved),
      hasSaveBtn: !!blank?.querySelector('[data-act="save"]'),
      hasDelete: !!blank?.querySelector('[data-act="delete"]'),
      addDisabled: addBtn.disabled === true,
      addAriaDisabled: addBtn.getAttribute('aria-disabled') === 'true',
    };
  }, kind);
};

/** 未入力の行が1件表示中のときに「行を追加」をもう一度押す（機能してはいけない） */
const clickAddAgain = async (kind) => {
  await page.evaluate((k) => {
    const b = document.getElementById(`basic-add-${k}`);
    b.scrollIntoView({ block: 'center' });
    b.click();   // disabled でも DOM のクリックは届く → ハンドラの防御確認も見る
  }, kind);
  await sleep(300);
  return page.evaluate((k) => {
    const rows = [...document.querySelectorAll(`#basic-body-${k} tr`)];
    const addBtn = document.getElementById(`basic-add-${k}`);
    return {
      count: rows.length,
      blankCount: rows.filter((r) => r.dataset.kind && !r.dataset.id).length,
      addDisabled: addBtn.disabled === true,
    };
  }, kind);
};

/** テーブルの未入力の行数と「行を追加」ボタンの有効状態 */
const basicState = (kind) =>
  page.evaluate((k) => {
    const rows = [...document.querySelectorAll(`#basic-body-${k} tr`)];
    const addBtn = document.getElementById(`basic-add-${k}`);
    return {
      count: rows.length,
      blankCount: rows.filter((r) => r.dataset.kind && !r.dataset.id).length,
      addDisabled: addBtn.disabled === true,
    };
  }, kind);

const clickDeleteById = async (kind, rowId) => {
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

/** 未入力の行（data-id 空）へ実タイピングで値を入れる（入力欄をクリックして焦点を当てる＝書き始め、選択欄は page.select） */
const typeRow = async (kind, values) => {
  for (const [key, val] of Object.entries(values)) {
    const sel = `#basic-body-${kind} tr[data-kind="${kind}"][data-id=""] [data-f="${key}"]`;
    const isSelect = await page.evaluate((s) => document.querySelector(s)?.tagName === 'SELECT', sel);
    await page.click(sel);
    await sleep(150);
    if (isSelect) await page.select(sel, String(val));
    else await page.type(sel, String(val));
    await sleep(150);
  }
};

/** 焦点を行の外（別テーブルの登録済み行の入力欄）へ移す selector（書き終えた瞬間を再現する） */
const BLUR_TARGET = (kind) => (kind === 'room'
  ? '#basic-body-class tr[data-kind="class"][data-id]:not([data-id=""]) [data-f="name"]'
  : '#basic-body-room tr[data-kind="room"][data-id]:not([data-id=""]) [data-f="name"]');

/** 焦点を行の外へ移す = 書き終えた瞬間。自動登録のリクエストを待つ */
const autoSaveBlank = async (kind, method = 'POST') => {
  const resP = page.waitForResponse((r) => r.url().includes(API_PATH[kind]) && r.request().method() === method, { timeout: 6000 });
  await page.focus(BLUR_TARGET(kind));
  const res = await resP;
  await sleep(1200);
  return res.status();
};

const countReq = (kind, method) => page.evaluate((k, m) =>
  window.__reqs.filter((r) => r.url.includes(API_PATH[k]) && r.method === m).length, kind, method);

/** 行内の入力欄から別の入力欄へ焦点を移す（行内の移動は自動登録の条件ではない） */
const focusWithin = (kind, rowId, fields) => page.evaluate((k, id, fs) => {
  const row = document.querySelector(`#basic-body-${k} tr[data-id="${id}"]`);
  row.querySelector(`[data-f="${fs[0]}"]`).focus();
  row.querySelector(`[data-f="${fs[1]}"]`).focus();
}, kind, rowId, fields);

/** 焦点を行の外（別テーブルの登録済み行の入力欄）へ移す（= 書き終えた瞬間） */
const focusOutside = (kind) => page.focus(BLUR_TARGET(kind));

const findRowId = (kind, name) =>
  page.evaluate((k, nm) => {
    const row = [...document.querySelectorAll(`#basic-body-${k} tr`)].find((r) => r.querySelector('[data-f="name"]')?.value === nm);
    return row ? row.dataset.id ?? '' : null;
  }, kind, name);


const allRowsHaveButtons = await page.evaluate((kinds) => {
  const out = {};
  for (const k of kinds) {
    const rows = [...document.querySelectorAll(`#basic-body-${k} tr`)];
    out[k] = rows.length > 0 && rows.every((r) => r.querySelector('[data-act="save"]') && r.querySelector('[data-act="delete"]'));
    out[`${k}Count`] = rows.length;
  }
  return out;
}, Object.keys(API_PATH));

const missingBtns = Object.keys(API_PATH).filter((k) => allRowsHaveButtons[`${k}Count`] > 0 && !allRowsHaveButtons[k]);
check('すべての行に保存・削除ボタンがある（4テーブル）', missingBtns.length === 0, missingBtns.join(',') || '');

// 追加→自動登録→削除に使う名前（サーバー側は初期名を固定せず、クラス名・教科名も自由に付けられる）
// このテストが作り、最後に削除する一意な名前を使う
const classNames = (await rowInfo('class')).rows.map((r) => r.name);
const groupNames = (await rowInfo('group')).rows.map((r) => r.name);
const makeUnique = (base, taken) => {
  let n = base;
  let i = 2;
  while (taken.includes(n)) n = base + i++;
  return n;
};
const STAMP = 'Z' + String(Date.now()).slice(-4);
const newClass = makeUnique(`1-9${STAMP}`, classNames);
const newGroup = makeUnique(`追加テスト教科${STAMP}`, groupNames);

// 行の追加・自動登録・削除は編集可能モードでしか効かない → 4セクションを編集可能へ（焦点を外す実枠も他セクションの編集可能が要る）
const unlockedAll = {};
for (const k of Object.keys(API_PATH)) unlockedAll[k] = await setLockMode(k, true);
check(
  '4セクションを編集可能モードへ（トグルは「編集ロック」表示・行追加と入力欄が使える）',
  Object.keys(API_PATH).every((k) => unlockedAll[k].label === '編集ロック' && unlockedAll[k].primary && !unlockedAll[k].addDisabled && !unlockedAll[k].inputsDisabled),
  JSON.stringify(unlockedAll),
);

const addCases = [
  { kind: 'class', name: newClass, fill: newClass ? { grade: Number(newClass[0]), name: newClass } : null },
  { kind: 'group', name: newGroup, fill: newGroup ? { name: newGroup } : null },
  { kind: 'subject', name: 'テスト科目Z', fill: { name: 'テスト科目Z', short_name: 'テストZ' } },
  { kind: 'room', name: '試験教室Z9', fill: { name: '試験教室Z9', seats: '30', notes: '回帰テスト' } },
];

for (const c of addCases) {
  if (!c.fill) {
    check(`${c.kind}: 登録可能な未登録名がないため追加テストはスキップ`, true, 'skip');
    continue;
  }
  const before = await rowInfo(c.kind);
  const added = await addRow(c.kind);
  check(`${c.kind}: 「行を追加」で未入力の行が最上部に出る（「保存」ボタンは無く削除ボタンだけ・ボタンは常に使える）`,
    added.count === before.count + 1 && added.blankCount === 1 && added.blankIsFirst &&
    added.blankTop < added.firstSavedTop && !added.hasSaveBtn && added.hasDelete &&
    !added.addDisabled && !added.addAriaDisabled,
    `count=${added.count} blank=${added.blankCount} first=${added.blankIsFirst} top=${added.blankTop}/${added.firstSavedTop} save=${added.hasSaveBtn} del=${added.hasDelete} disabled=${added.addDisabled}`);
  const again = await clickAddAgain(c.kind);
  check(`${c.kind}: 「行の追加」を連続で押すと未入力の行が2件並ぶ（ボタンは常に使える）`,
    again.count === added.count + 1 && again.blankCount === 2 && !again.addDisabled,
    `count=${again.count} blank=${again.blankCount} disabled=${again.addDisabled}`);
  // 余分な未入力の行を1件破棄して未入力の行を1件に戻す（未登録行の削除は UI から行を破棄するだけ）
  await page.evaluate((k) => {
    const rows = [...document.querySelectorAll(`#basic-body-${k} tr[data-kind="${k}"][data-id=""]`)];
    const btn = rows[rows.length - 1].querySelector('[data-act="delete"]');
    btn.scrollIntoView({ block: 'center' });
    btn.click();
  }, c.kind);
  await sleep(400);
  const afterExtraDiscard = await basicState(c.kind);
  check(`${c.kind}: 余分な未入力の行の「削除」はその行をUIから破棄する（未入力の行は1件残る）`,
    afterExtraDiscard.count === added.count && afterExtraDiscard.blankCount === 1 && !afterExtraDiscard.addDisabled,
    `count=${afterExtraDiscard.count} blank=${afterExtraDiscard.blankCount} disabled=${afterExtraDiscard.addDisabled}`);
  await typeRow(c.kind, c.fill);
  const status = await autoSaveBlank(c.kind, 'POST');
  const after = await rowInfo(c.kind);
  const savedId = await findRowId(c.kind, c.name);
  const afterSave = await basicState(c.kind);
  check(`${c.kind}: 行を追加して入力し、焦点が行の外へ移ると自動登録（POST ${status}）されて行として一覧に残る`,
    status === 201 && after.count === before.count + 1 && savedId && savedId !== '',
    `count=${after.count} id=${savedId}`);
  check(`${c.kind}: 自動登録後は未入力の行が消え「行を追加」が使えるようになる`,
    afterSave.blankCount === 0 && afterSave.addDisabled === false,
    `blank=${afterSave.blankCount} disabled=${afterSave.addDisabled}`);
  const delStatus = await clickDeleteById(c.kind, savedId);
  const back = await rowInfo(c.kind);
  const gone = await findRowId(c.kind, c.name);
  check(`${c.kind}: 削除で行がUIから消える（DELETE ${delStatus}・ベースラインへ復元）`,
    delStatus === 200 && back.count === before.count && gone === null,
    `count=${back.count} name=${c.name}`);
}

// 未保存行の「削除」は行をUIから破棄する（サーバー変更なし）
const beforeDiscard = await rowInfo('room');
await addRow('room');
await page.evaluate(() => {
  const btn = document.querySelector('#basic-body-room tr[data-kind="room"][data-id=""] [data-act="delete"]');
  btn.scrollIntoView({ block: 'center' });
  btn.click();
});
await sleep(400);
const afterDiscard = await basicState('room');
check('未保存行の削除はその行をUIから破棄する（サーバー変更なし・行を追加は元通り使える）',
  afterDiscard.count === beforeDiscard.count && afterDiscard.blankCount === 0 && afterDiscard.addDisabled === false,
  `count=${afterDiscard.count} blank=${afterDiscard.blankCount} disabled=${afterDiscard.addDisabled}`);

// テスト終了後に編集可能モードを閉じる（読み取り専用へ戻してロックを他教員へ渡す）
const relockedAll = {};
for (const k of Object.keys(API_PATH)) relockedAll[k] = await setLockMode(k, false);
check(
  '4セクションを読み取り専用へ戻す（トグルは「編集可能」表示・行追加と入力欄が操作不能）',
  Object.keys(API_PATH).every((k) => relockedAll[k].label === '編集可能' && !relockedAll[k].primary && relockedAll[k].addDisabled && relockedAll[k].inputsDisabled),
  JSON.stringify(relockedAll),
);

await browser.close();
console.log(failures.length ? `\n=== ${failures.length} FAILURES ===\n${failures.join('\n')}` : '\n=== ALL PASSED ===');
if (failures.length) process.exit(1);

