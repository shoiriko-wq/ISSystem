/**
 * 入れ条件グリッド（クラス行 × 日・時限）と配置ドラッグの回帰テスト（実ブラウザ検証）
 *
 * 検証ルール:
 *  1. 時間割タブにコマ組みの条件グリッドが描画され、生成／作成／検証ボタンがある
 *  2. ○ マスをクリック → PUT /exam/:id/block-conditions/:shapeId（そのマスの allowed:false）で × になる
 *     × をクリック → 条件解除（conditions 0 件）で ○ に戻る
 *  3. ●（配置済み）をドラッグして同一クラス行の他マスをドロップ → PUT /exam/:id/block-shapes/:shapeId/placements
 *     （rows = 全クラス行の配置案）が送信され、マークが移動する
 *  4. クラス行を跨ぐドロップ・入れ条件で × のマスへのドロップは配置されない（サーバー検証で弾かれる）
 *  5. 教務編集権限がない（editable.timetable=false）とグリッドは編集対象にならない
 *
 * 必要環境: puppeteer-core（devDependencies）と Chrome/Chromium バイナリ
 * 実行: node scripts/test-block-ui.mjs（CHROME_PATH でパス指定可）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = '/scripts/fixtures/block-cond-fixture.html';
const SHAPE = 'blk:理科基礎';
const BUTTON_IDS = ['exam-blk-cmds', 'exam-blk-shapes', 'exam-blk-groups', 'exam-blk-solve', 'exam-blk-validate'];
const cellSel = (row, day, slot) =>
  `[data-cond-cell][data-cond-shape="${SHAPE}"][data-cond-row="${row}"][data-cond-day="${day}"][data-cond-slot="${slot}"]`;
const srcSel = (row, day, slot) =>
  `[data-place-src][data-place-shape="${SHAPE}"][data-place-row="${row}"][data-place-day="${day}"][data-place-slot="${slot}"]`;
const dropSel = (row, day, slot) =>
  `[data-place-drop][data-cond-row="${row}"][data-cond-day="${day}"][data-cond-slot="${slot}"]`;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css' };

function startServer() {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH 環境変数でパスを指定してください。');
}

const failures = [];
const check = (name, ok) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}`);
};

const { server, port } = await startServer();
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));
await page.setViewport({ width: 1280, height: 900 });
await page.goto(`http://127.0.0.1:${port}${FIXTURE}`, { waitUntil: 'networkidle0' });

const calls = () => page.evaluate(() => window.TestApi.calls());
const puts = async () => (await calls()).filter((c) => c.method === 'put');
const lastPut = async (frag) => (await puts()).filter((c) => String(c.ep).includes(frag)).at(-1) || {};
const mark = (sel) => page.evaluate((s) => window.TestApi.mark(s), sel);
const drag = (from, to) => page.evaluate((f, t) => window.TestApi.drag(f, t), from, to);
const pollMark = async (sel, want, ms = 4000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await mark(sel);
    if (v === want) return true;
    await new Promise((r) => setTimeout(r, 60));
  }
  return false;
};

await page.evaluate(() => window.TestApi.render());

// 1. 描画
const grid = await page.waitForSelector(cellSel('cls-1-1', 2, 2), { timeout: 5000 }).catch(() => null);
check('入れ条件グリッドが描画される', !!grid);
const buttonIds = await page.evaluate(() => window.TestApi.buttons());
check('生成・作成・検証ボタンが描画される', BUTTON_IDS.every((id) => buttonIds.includes(id)));
check('配置済みマスは ●', (await mark(cellSel('cls-1-1', 1, 1))) === '●');
check('未配置・条件なしのマスは ○', (await mark(cellSel('cls-1-1', 2, 2))) === '○');

// 2. 入れ条件トグル（○ → × → ○）
await page.click(cellSel('cls-1-1', 2, 2));
const cond1 = await pollMark(cellSel('cls-1-1', 2, 2), '×');
const put1 = await lastPut('/block-conditions/');
const body1 = put1.body?.conditions || [];
check('○ クリックで × になり PUT される', cond1);
check('PUT は block-conditions/:shapeId', String(put1.ep || '').endsWith('/block-conditions/blk:理科基礎'));
check(
  'PUT 条件は cls-1-1 / 2日目2限 / allowed:false',
  body1.length === 1 &&
    String(body1[0].class_course_id) === 'cls-1-1' &&
    Number(body1[0].day_number) === 2 &&
    Number(body1[0].slot_number) === 2 &&
    body1[0].allowed === false
);
await page.click(cellSel('cls-1-1', 2, 2));
const cond2 = await pollMark(cellSel('cls-1-1', 2, 2), '○');
const put2 = await lastPut('/block-conditions/');
check('× クリックで解除（条件 0 件）して ○ に戻る', cond2 && (put2.body?.conditions || []).length === 0);

// 3. 配置ドラッグ（同一クラス行内）
const putsBeforeMove = (await puts()).length;
const moved = await drag(srcSel('cls-1-1', 1, 1), dropSel('cls-1-1', 1, 2));
const movedMark = await pollMark(cellSel('cls-1-1', 1, 2), '●');
const put3 = await lastPut('/placements');
const rows3 = put3.body?.rows || [];
const hasAt = (rows, rid, d, s) => rows.some((r) => String(r.class_course_id) === rid && Number(r.day_number) === d && Number(r.slot_number) === s);
check('ドラッグで配置が移動する', moved && movedMark);
check(
  'PUT は placements（配置案の全クラス行）',
  String(put3.ep || '').endsWith('/block-shapes/blk:理科基礎/placements') &&
    rows3.length === 2 &&
    hasAt(rows3, 'cls-1-1', 1, 2) &&
    hasAt(rows3, 'cls-1-2', 1, 1)
);
check('移動元マスは ○ に戻る', (await mark(cellSel('cls-1-1', 1, 1))) === '○');

// 4a. クラス行を跨ぐドラッグは弾かれる
await drag(srcSel('cls-1-1', 1, 2), dropSel('cls-1-2', 1, 2));
await new Promise((r) => setTimeout(r, 500));
const putsAfterCross = (await puts()).length;
check('クラス行跨ぎのドロップは配置されない', putsAfterCross === putsBeforeMove + 1 && (await mark(cellSel('cls-1-2', 1, 2))) === '○');

// 4b. 入れ条件 × へのドロップは弾かれる（UI が条件を見て止め、サーバー検証も HARD で弾く）
await page.click(cellSel('cls-1-1', 3, 1));
const forbMark = await pollMark(cellSel('cls-1-1', 3, 1), '×');
const putsBeforeForbiddenDrop = (await puts()).length;
await drag(srcSel('cls-1-1', 1, 2), dropSel('cls-1-1', 3, 1));
await new Promise((r) => setTimeout(r, 500));
check('入れ条件 × のマスマークが維持される', forbMark && (await mark(cellSel('cls-1-1', 1, 2))) === '●');
check(
  '× マスへのドロップは配置されない（PUT 送信なし）',
  (await puts()).length === putsBeforeForbiddenDrop && (await mark(cellSel('cls-1-1', 3, 1))) === '×'
);

// 5. 非編集モード
const putsBefore = (await puts()).length;
await page.evaluate(() => window.TestApi.setEditable(false));
const editableGrid = await page.evaluate((s) => !!document.querySelector(s), cellSel('cls-1-1', 1, 2));
if (editableGrid) {
  await page.click(cellSel('cls-1-1', 1, 2));
  await new Promise((r) => setTimeout(r, 500));
}
check('教務編集不可ではグリッドが編集対象にならず PUT もしない', !editableGrid && (await puts()).length === putsBefore);

console.log(`\n=== 結果: ${failures.length} 件の失敗 ===`);
for (const f of failures) console.log(` - ${f}`);

await browser.close();
server.close();
process.exit(failures.length ? 1 : 0);