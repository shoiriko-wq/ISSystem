/**
 * 全タブ横断スキャン：クリックできる面（cursor:pointer）なのに枠線が無い要素を拾い出す。
 * 設計ルール「クリックできる項目は枠線を持つ」の遵守確認用（手動レビュー用レポート）。
 * 実行: npm run test:ui:scan   （サーバーが必要 UI_BASE / UI_USER / UI_PASS）
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const TABS = ['dashboard', 'bulletin', 'chat', 'facility', 'schedule', 'approval', 'seating', 'exam'];
const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH 環境変数でパスを指定してください。');
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
});
const page = await browser.newPage();
await page.setViewport({ width: 1301, height: 1130 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

// CSS 構文チェック：readability.css がブラウザで正しく解析されているか（解析ルール数で確認）
const parsed = await page.evaluate(async () => {
  const css = await fetch('/css/readability.css').then((r) => r.text());
  const sheet = new CSSStyleSheet();
  try { sheet.replaceSync(css); } catch (e) { return { error: e.message }; }
  const rules = [...sheet.cssRules];
  return { total: rules.length, frameRules: rules.filter((r) => r.selectorText && /\.card|\.bg-|\.border/.test(r.selectorText)).length };
});
console.log(`readability.css: rules=${parsed.total} frameRules=${parsed.frameRules}`);

for (const tab of TABS) {
  const nav = await page.$(`a[data-tab="${tab}"]`);
  if (!nav) { console.log(`${tab}: nav not found`); continue; }
  await nav.click();
  await sleep(900);
  const offenders = await page.evaluate(() => [...document.querySelectorAll('main .card, main [class*="bg-"]')]
    .filter((el) => !el.closest('button, a, .nav-item, .card--framed, .seat-card, .modal-card'))
    .filter((el) => !['checkbox', 'radio'].includes(el.type))
    .filter((el) => getComputedStyle(el).cursor === 'pointer')
    .filter((el) => parseFloat(getComputedStyle(el).borderTopWidth) === 0)
    .map((el) => `${el.tagName}.${String(el.className).slice(0, 58)}`));
  console.log(`${tab}: ${offenders.length ? offenders.join('\n    ') : 'OK'}`);
}

await browser.close();
