/**
 * 定期考査 基本情報「3. 科目（教科・科目名・略称）× 実施クラス・コース」テーブルの回帰テスト（実ブラウザ検証）
 *
 * ルール（`public/js/modules/exam/exam.basic.ui.js`）:
 *  R1. 実施数列は存在しない（列は 教科・科目名・略称・実施クラス・コース・操作 の 5 列）。
 *      実施数はチップ選択そのものが示す。
 *  R2. 科目名・略称列は実枠 14% / 8%（table-layout:fixed）で、入力欄（実枠）が列幅の 90% 以上ある。
 *  R3. 実施クラス・コース列はチップ内容分の幅（63%）で、チップがコンテナ右端を超えない。
 *      1440px では学年ごとに 1 行（チップ行 = 学年数）で収まる。
 *  R4. カード・テーブル・内容領域に水平スクロールが発生せず、保存/削除ボタンが操作列の右端を超えない。
 *  R5. チップをクリックすると選択（bg-accent-soft）になり、保存でサーバーへ class_course_ids が届いて
 *      再読み込み後も選択が維持される（Shift+クリックで範囲選択、解除して元へ戻す）。
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
  const buttons = [...row.querySelectorAll('button[data-act]')].map((b) => Math.round(b.getBoundingClientRect().right));
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
  check(`${vw}px 保存/削除ボタンが操作列内に収まる`, g.buttonMaxRight <= g.actionRight + 1, `${g.buttonMaxRight}/${g.actionRight}`);
  if (vw >= 1440) {
    check('1440px チップは学年ごとに1行（列幅は内容分）', g.chipRows.length === g.gradeRows && g.listW >= g.pickerW * 0.98, `chipRows=${g.chipRows.join(',')} gradeRows=${g.gradeRows} pickerW=${g.pickerW} listW=${g.listW}`);
  }
  await page.evaluate(() => document.getElementById('basic-body-subject')?.scrollIntoView({ block: 'center' }));
  await sleep(200);
  const cardHandle = await page.evaluateHandle(() => document.getElementById('basic-body-subject').closest('.card'));
  const cardEl = cardHandle.asElement();
  await (cardEl ? cardEl.screenshot({ path: path.join(OUT_DIR, `exam-basic-subject-${vw}-card.png`) }) : page.screenshot({ path: path.join(OUT_DIR, `exam-basic-subject-${vw}.png`) }));
}

// R5. チップクリック・Shift 範囲選択・保存（サーバー反映）
console.log('--- チップ選択と保存（1440px） ---');
await page.setViewport({ width: 1440, height: 1000 });
await loginToBasic();

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

const saveRow = async () => {
  const resP = page.waitForResponse((r) => r.url().includes('/basic-info/subject/') && r.request().method() === 'PUT', { timeout: 6000 });
  await page.evaluate(() => document.querySelector('#basic-body-subject tr [data-act="save"]').scrollIntoView({ block: 'center' }));
  await page.click('#basic-body-subject tr [data-act="save"]');
  const res = await resP;
  await sleep(1200);
  return res.status();
};

await clickChip(targets.a);
const onA = await page.evaluate((cid) => document.querySelector(`[data-cc="${cid}"]`).classList.contains('bg-accent-soft'), targets.a);
check('チップクリックで選択される', onA);

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
check('Shift+クリックで範囲選択される', rangeOn);

const status = await saveRow();
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
check(`保存（PUT ${status}）後の再読み込みで選択が維持される`, kept.selA && kept.selB, JSON.stringify(kept));

// 選択を元の集合へ戻す（範囲選択で作った追加分を個別に解除 → 保存）
const extras = await page.evaluate(
  (base) => {
    const row = document.querySelector('#basic-body-subject tr');
    return [...row.querySelectorAll('[data-cc].bg-accent-soft')].map((c) => c.dataset.cc).filter((id) => !base.includes(id));
  },
  targets.base
);
for (const id of extras) await clickChip(id);
const status2 = await saveRow();
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
check(`解除して保存（PUT ${status2}）すると選択が元の集合へ戻る`, restored.ok, `sel=${restored.sel} base=${restored.base}`);

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
    const rows = [...document.querySelectorAll(`#basic-body-${k} tr`)];
    const last = rows[rows.length - 1];
    return {
      count: rows.length,
      lastId: last?.dataset.id ?? null,
      hasSave: !!last?.querySelector('[data-act="save"]'),
      hasDelete: !!last?.querySelector('[data-act="delete"]'),
    };
  }, kind);
};

const fillRow = (kind, values) =>
  page.evaluate((k, vals) => {
    const rows = [...document.querySelectorAll(`#basic-body-${k} tr`)];
    const row = rows[rows.length - 1];
    for (const [key, val] of Object.entries(vals)) {
      const el = row.querySelector(`[data-f="${key}"]`);
      if (!el) continue;
      if (el.tagName === 'SELECT' && [...el.options].some((o) => o.value === String(val))) el.value = String(val);
      else el.value = String(val);
    }
  }, kind, values);

const clickButtonInLastRow = async (kind, act, method) => {
  const resP = page.waitForResponse((r) => r.url().includes(API_PATH[kind]) && r.request().method() === method, { timeout: 6000 });
  await page.evaluate((k, a) => {
    const rows = [...document.querySelectorAll(`#basic-body-${k} tr`)];
    const btn = rows[rows.length - 1].querySelector(`[data-act="${a}"]`);
    btn.scrollIntoView({ block: 'center' });
    btn.click();
  }, kind, act);
  const res = await resP;
  await sleep(1200);
  return res.status();
};

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

// 追加→保存→削除に使う未登録名（サーバー側の登録制約に合わせて選ぶ）
const DEFAULT_CLASS_NAMES = [
  '1-1', '1-2', '1-3', '1-4', '1-5', '1-6', '1-7',
  '2-1', '2-2', '2-3', '2-4文', '2-4理', '2-5', '2-6看', '2-6文', '2-7',
  '3-1総', '3-1人', '3-2', '3-3', '3-4人', '3-4数', '3-5', '3-6数', '3-6環',
  '3-7看', '3-7総', '3-7人', '3-8総', '3-8人',
];
// 教科名は登録・改名が固定リスト内のみ（src/services/subject.service.js の DEFAULT_SUBJECT_NAMES）
const ALLOWED_GROUP_NAMES = ['国語', '地歴公民', '数学', '理科', '保健体育', '芸術', '外国語', '家庭', '情報'];

const classNames = (await rowInfo('class')).rows.map((r) => r.name);
const groupNames = (await rowInfo('group')).rows.map((r) => r.name);
const newClass = DEFAULT_CLASS_NAMES.find((n) => !classNames.includes(n));
const newGroup = ALLOWED_GROUP_NAMES.find((n) => !groupNames.includes(n));

const addCases = [
  { kind: 'class', name: newClass, fill: newClass ? { grade: Number(newClass[0]), name: newClass, short_name: newClass } : null },
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
  check(`${c.kind}: 「行を追加」で未保存行（保存・削除ボタン付き）が増える`,
    added.count === before.count + 1 && added.lastId === '' && added.hasSave && added.hasDelete,
    `count=${added.count} lastId="${added.lastId}" del=${added.hasDelete}`);
  await fillRow(c.kind, c.fill);
  const status = await clickButtonInLastRow(c.kind, 'save', 'POST');
  const after = await rowInfo(c.kind);
  const savedId = await findRowId(c.kind, c.name);
  check(`${c.kind}: 行を追加して保存（POST ${status}）すると入力内容が行として一覧に残る`,
    status === 201 && after.count === before.count + 1 && savedId && savedId !== '',
    `count=${after.count} id=${savedId}`);
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
  const rows = [...document.querySelectorAll('#basic-body-room tr')];
  const btn = rows[rows.length - 1].querySelector('[data-act="delete"]');
  btn.scrollIntoView({ block: 'center' });
  btn.click();
});
await sleep(400);
const afterDiscard = await rowInfo('room');
check('未保存行の削除はその行をUIから破棄する（サーバー変更なし）',
  afterDiscard.count === beforeDiscard.count, `count=${afterDiscard.count}`);

await browser.close();
console.log(failures.length ? `\n=== ${failures.length} FAILURES ===\n${failures.join('\n')}` : '\n=== ALL PASSED ===');
if (failures.length) process.exit(1);

