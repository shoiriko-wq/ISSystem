/**
 * 詳細モーダル前の pane 状態probe（既存テスト末尾の long zapping 後に今日へ戻すと rows/詳細ボタンが戻るか）
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1000);
await page.evaluate(() => document.querySelector('a[data-tab="bulletin"]').click());
await sleep(900);

const readState = () => page.evaluate(() => ({
  day: document.getElementById('bulletin-day-current')?.dataset.day,
  rows: document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]').length,
  paneDetailBtn: !!document.querySelector('#bulletin-detail-pane [data-bulletin-detail]'),
  paneText: (document.getElementById('bulletin-detail-pane')?.textContent || '').replace(/\s+/g, ' ').slice(0, 70),
}));

// 中心日を calendar で選択（テストと同じ）
await page.evaluate(() => {
  document.getElementById('bulletin-day-current').click();
  const hit = document.querySelector('#bulletin-mini-cal .mini-cal-has[data-cal-date]');
  if (hit) hit.click();
});
await sleep(700);
console.log('start', JSON.stringify(await readState()));

// 長いタイトル行のクローン検証（テスト lines 222-268 と同じ。DOM を永続的に汚す）
await page.evaluate(() => {
  const host = document.getElementById('bulletin-list-container');
  const proto = host.querySelector('[data-bulletin-toggle]');
  const row = proto.cloneNode(true);
  row.setAttribute('data-bulletin-toggle', 'tmp-long-row');
  host.appendChild(row);
  row.querySelector('.bulletin-row-title').textContent = '極めて長いタイトルです'.repeat(8);
  const badge = document.createElement('span');
  badge.className = 'bulletin-unread-badge';
  badge.textContent = '未読';
  row.appendChild(badge);
  row.remove();
});
await page.evaluate(() => {
  const row = document.querySelector('.bulletin-title-row');
  const label = row?.querySelector('.bulletin-row-title');
  if (label) label.textContent = '極めて長いタイトルです'.repeat(8);
});
await sleep(120);
console.log('after-long-title', JSON.stringify(await readState()));

// ArrowDown / ArrowUp / Enter（テスト lines 273-322 と同じ）
await page.evaluate(() => document.querySelector('#bulletin-list-container [data-bulletin-toggle]').focus());
await page.keyboard.press('ArrowDown');
await sleep(5);
console.log('after-ArrowDown', JSON.stringify(await readState()));
await page.keyboard.press('ArrowUp');
await sleep(5);
console.log('after-ArrowUp', JSON.stringify(await readState()));
await page.keyboard.press('Enter');
await sleep(150);
console.log('after-Enter', JSON.stringify(await readState()));

// ←/→ キー + ‹ › クリック（テスト lines 324-336 と同じ）
for (const k of ['ArrowRight', 'ArrowLeft']) { await page.keyboard.press(k); await sleep(420); }
for (const id of ['#bulletin-day-next', '#bulletin-day-prev']) { await page.click(id); await sleep(420); }

// rapid（テスト lines 358-369 と同じ page.click 版）
await page.evaluate(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 5; i++) { document.getElementById('bulletin-day-next').click(); await nap(160); }
  for (let i = 0; i < 5; i++) { document.getElementById('bulletin-day-prev').click(); await nap(160); }
});
await sleep(300);
console.log('after-rapid', JSON.stringify(await readState()));

// cal-follow（テスト lines 378-393 と同じ）
await page.evaluate(async () => {
  const nap = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = document.getElementById('bulletin-day-current');
  read.click();
  for (let i = 0; i < 40; i++) { document.getElementById('bulletin-day-next').click(); await nap(70); }
  for (let i = 0; i < 40; i++) { document.getElementById('bulletin-day-prev').click(); await nap(70); }
  read.click();
});
await sleep(400);
console.log('after-zapping', JSON.stringify(await readState()));

await page.evaluate(() => document.getElementById('bulletin-btn-today').click());
await sleep(700);
console.log('after-today', JSON.stringify(await readState()));

// 詳細ボタンがある状態でモーダルを開き、フッターのボタンを確認
const modal = await page.evaluate(() => {
  const b = document.querySelector('#bulletin-detail-pane [data-bulletin-detail]');
  if (!b) return { open: 'no-button' };
  b.click();
  const footer = document.getElementById('detail-bulletin-actions');
  return {
    open: !document.getElementById('bulletin-detail-modal').classList.contains('hidden'),
    footerButtons: [...footer.querySelectorAll('button')].map((x) => x.textContent.replace(/\s+/g, ' ').trim()),
    hasDelete: !!footer.querySelector('#btn-detail-delete'),
  };
});
console.log('modal', JSON.stringify(modal));

const userJson = await page.evaluate(() => localStorage.getItem('is_system_user_info_v251'));
console.log('user', userJson);

const api = await page.evaluate(async (tok) => {
  const res = await fetch('/api/bulletins?postedDay=2026-11-05', { headers: { Authorization: `Bearer ${tok}` } });
  const json = await res.json();
  const items = json.bulletins || json.data || json.posts || [];
  return { status: res.status, keys: Object.keys(json), items: items.slice(0, 4).map((i) => ({ id: i.id, title: (i.title || '').slice(0, 16), authorId: i.authorId })) };
}, await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251')));
console.log('api', JSON.stringify(api));

await browser.close();
