import puppeteer from 'puppeteer-core';
const BASE = 'https://127.0.0.1:3443', USER = 'T2026001', PASS = 'password123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const today = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

const login = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staff_code: USER, password: PASS }) });
const token = (await login.json()).token;
const created = await fetch(BASE + '/api/bulletins', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ title: 'DBG 本日未読カード', content: 'debug', target_date: today, display_start_date: today, display_end_date: today }) });
const cid = (await created.json()).data.id;
console.log('CREATED', cid);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: 'new',
  ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[page js error]', e.message));
const reqs = [];
page.on('request', (r) => { if (r.url().includes('/api/bulletins')) reqs.push(r.method() + ' ' + r.url()); });

await page.setViewport({ width: 1280, height: 900 });
await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await page.evaluate(() => document.querySelector('a[data-tab="dashboard"]')?.click());
await sleep(1600);

const before = await page.evaluate((id) => {
  const el = document.querySelector('[data-bulletin-read="' + id + '"]');
  return {
    found: !!el,
    tag: el && el.tagName,
    marker: !!(el && el.querySelector('.dash-news-unread-marker')),
    dash: document.getElementById('dash-today-bulletin-unread') && document.getElementById('dash-today-bulletin-unread').textContent.trim(),
    side: document.getElementById('bulletin-unread-count') && document.getElementById('bulletin-unread-count').textContent.trim(),
    list: document.getElementById('dash-pinned-bulletins') && document.getElementById('dash-pinned-bulletins').childElementCount,
  };
}, cid);
console.log('BEFORE', JSON.stringify(before));

await page.evaluate((id) => { document.querySelector('[data-bulletin-read="' + id + '"]').click(); }, cid);
await sleep(1700);

const after = await page.evaluate((id) => {
  const el = document.querySelector('[data-bulletin-read="' + id + '"]');
  return {
    marker: !!(el && el.querySelector('.dash-news-unread-marker')),
    dash: document.getElementById('dash-today-bulletin-unread') && document.getElementById('dash-today-bulletin-unread').textContent.trim(),
    side: document.getElementById('bulletin-unread-count') && document.getElementById('bulletin-unread-count').textContent.trim(),
    title: document.getElementById('bulletin-title-unread') && document.getElementById('bulletin-title-unread').textContent.trim(),
    tab: document.querySelector('.nav-item.active') && document.querySelector('.nav-item.active').getAttribute('data-tab'),
    modal: [...document.querySelectorAll('.modal')].filter((m) => !m.classList.contains('hidden') && getComputedStyle(m).display !== 'none').length,
  };
}, cid);
console.log('AFTER', JSON.stringify(after));
console.log('REQS', JSON.stringify(reqs));

await fetch(BASE + '/api/bulletins/' + cid, { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } });
await browser.close();