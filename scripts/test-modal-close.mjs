/**
 * モーダル「背景クリックで閉じる」挙動の回帰テスト（実ブラウザ検証）
 *
 * 検証ルール（全モーダル共通・ui-helpers.js の initModalListeners）:
 *  1. モーダル内でマウスを押し開始し、背景で離す → 閉じない（テキスト選択ドラッグ等のストレス回避）
 *  2. 背景で押し開始し、背景で離す → 閉じる
 *  3. 背景で押し開始し、モーダル内で離す → 閉じる（押下開始が背景）
 *  4. .modal-close ボタン（右上 X / フッター「閉じる」）を押して離す → 閉じる
 *  5. 動的生成モーダルでも 1〜4 が同じく効く
 *  6. ESC キーで最前面のモーダルが閉じる
 *
 * 必要環境: puppeteer-core（devDependencies）と Chrome/Chromium バイナリ。
 * 実行: node scripts/test-modal-close.mjs   （CHROME_PATH でバイナリ指定可）
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'modal-close-fixture.html');
const VIEWPORT = { width: 1280, height: 800 };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

/** リポジトリ直下を公開する最小の静的サーバ */
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

const { server, port } = await startServer();
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors']
});

const page = await browser.newPage();
const failures = [];
const check = (name, ok) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}`);
};
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));

await page.setViewport(VIEWPORT);
await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/modal-close-fixture.html`, { waitUntil: 'networkidle0' });

const isOpen = (id) => page.evaluate((id) => window.TestApi.isOpen(id), id);
const open = (id) => page.evaluate((id) => window.TestApi.open(id), id);
const boxOf = async (sel) => {
  const b = await (await page.$(sel)).boundingBox();
  return { x: b.x, y: b.y, w: b.width, h: b.height, cx: b.x + b.width / 2, cy: b.y + b.height / 2 };
};
const press = async (x, y) => { await page.mouse.move(x, y); await page.mouse.down(); };
const release = async (x, y) => { await page.mouse.move(x, y); await page.mouse.up(); };

// ---- 静的モーダル ----
await open('test-modal');
const ta = await boxOf('#ta');
const card = await boxOf('.modal-card');
const bg = { x: card.x + card.w + 40, y: Math.round(VIEWPORT.height / 2) };

// 1) 内部で押し開始 → 背景で離す：閉じない
await press(ta.cx, ta.cy);
await release(bg.x, bg.y);
const staysOpen = await isOpen('test-modal');
check('press inside textarea, release on backdrop -> stays open', staysOpen);

// 2) 背景で押し開始 → 背景で離す：閉じる
if (!staysOpen) await open('test-modal');
await press(bg.x, bg.y);
await release(bg.x, bg.y);
check('press+release on backdrop -> closes', !(await isOpen('test-modal')));

// 3) 背景で押し開始 → モーダル内で離す：閉じる
await open('test-modal');
await press(bg.x, bg.y);
await release(ta.cx, ta.cy);
check('press on backdrop, release inside modal -> closes', !(await isOpen('test-modal')));

// 4) 閉じるボタンを押して離す：閉じる
await open('test-modal');
const fb = await boxOf('#footer-close');
await press(fb.cx, fb.cy);
await release(fb.cx, fb.cy);
check('press+release on close button -> closes', !(await isOpen('test-modal')));

// ---- 動的生成モーダル ----
await page.evaluate(() => window.TestApi.addDynamic());
const dynCard = await boxOf('#dyn-modal .modal-card');
const dynBg = { x: dynCard.x + dynCard.w + 40, y: Math.round(VIEWPORT.height / 2) };
const dynInput = await boxOf('#dyn-input');

// 5) 動的モーダル：内部で押し開始 → 背景で離す：閉じない
await press(dynInput.cx, dynInput.cy);
await release(dynBg.x, dynBg.y);
const dynStaysOpen = await isOpen('dyn-modal');
check('dynamic modal: press inside input, release on backdrop -> stays open', dynStaysOpen);

// 6) 動的モーダル：背景で押し開始 → 背景で離す：閉じる
if (!dynStaysOpen) await open('dyn-modal');
await press(dynBg.x, dynBg.y);
await release(dynBg.x, dynBg.y);
check('dynamic modal: press+release on backdrop -> closes', !(await isOpen('dyn-modal')));

// 7) ESC キー：最前面のモーダルが閉じる
await open('test-modal');
await page.keyboard.press('Escape');
check('Escape closes topmost modal', !(await isOpen('test-modal')));

await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILURES`}`);
process.exit(failures.length === 0 ? 0 : 1);
