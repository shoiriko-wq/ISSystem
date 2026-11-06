import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const BASE = 'https://127.0.0.1:3443';

const browser = await puppeteer.launch({
  headless: 'shell',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--ignore-certificate-errors',
    '--ignore-https-errors',
    '--allow-insecure-localhost',
    '--sslverify=false',
    '--test-type',
    '--user-data-dir=' + path.join(root, '.kilo', 'pup-profile-1518251772879185')],
});
const page = await browser.newPage();
page.on('console', (m) => {
  const t = m.text();
  if (t.includes('API') || t.includes('[Auth') || t.includes('net::')) console.log('P> ' + t.slice(0, 160));
});
page.on('requestfailed', (r) => console.log('REQFAIL ' + r.url().slice(0, 110) + ' ' + (r.failure() && r.failure().errorText)));
page.on('response', async (r) => {
  if (r.url().includes('/api/bulletins')) {
    let body = '';
    try { body = (await r.text()).slice(0, 120); } catch (e) {}
    console.log('RES ' + r.status() + ' ' + r.url().slice(0, 110) + ' ' + body.replace(/\s+/g, ' '));
  }
});

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle2' });
await new Promise((r) => setTimeout(r, 700));

await page.evaluate(() => {
  const form = document.getElementById('login-form');
  const ins = [...form.querySelectorAll('input')];
  ins[0].value = 'T2026001';
  ins[1].value = 'testpass123';
  ins[0].dispatchEvent(new Event('input', { bubbles: true }));
  ins[1].dispatchEvent(new Event('input', { bubbles: true }));
  form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
});
await new Promise((r) => setTimeout(r, 1200));

/* UI で掲示を作り、その投稿に UI の apiPost 経路でコメントを送る */
const created = await page.evaluate(async (tok) => {
  const r = await fetch('/api/bulletins', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ title: 'ブラウザPOST確認', content: 'x', target_date: '2026-11-06' }),
  });
  const j = await r.json();
  return { status: r.status, id: j.data?.id, keys: Object.keys(j.data || {}) };
}, (await page.evaluate(() => localStorage.getItem('is_system_user_info_v251') ? JSON.parse(localStorage.getItem('is_system_user_info_v251')).token : null)));

console.log('created=', JSON.stringify(created));

const postRes = await page.evaluate(async (tok, id) => {
  const r = await fetch('/api/bulletins/' + id + '/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ comment: 'ブラウザPOST確認コメント' }),
  });
  const j = await r.json();
  return { status: r.status, url: r.url, keys: Object.keys(j) };
}, (await page.evaluate(() => JSON.parse(localStorage.getItem('is_system_user_info_v251')).token)), created.id);

console.log('postRes=', JSON.stringify(postRes));

const detail = await page.evaluate(async (tok, id) => {
  const r = await fetch('/api/bulletins/' + id, { headers: { Authorization: 'Bearer ' + tok } });
  const j = await r.json();
  return { comments: (j.data?.comments || []).map((c) => [c.id, c.comment_text]) };
}, (await page.evaluate(() => JSON.parse(localStorage.getItem('is_system_user_info_v251')).token)), created.id);

console.log('detail=', JSON.stringify(detail));

await browser.close();
