import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
const logs = [];
page.on('console', (m) => { const t = m.text(); if (t.includes('[Facility]')) logs.push(t); });
page.on('pageerror', (e) => logs.push(`[page js error] ${e.message}`));

await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

const api = (path, method, body) => page.evaluate(async (p, m, b) => {
  const keys = Object.keys(localStorage).filter((k) => /token/i.test(k));
  const tok = keys.map((k) => localStorage.getItem(k)).find((v) => v && v.split('.').length === 3);
  const r = await fetch('/api' + p, { method: m, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok }, body: b ? JSON.stringify(b) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
}, path, method, body);

const d = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const today = d(0), tomorrow = d(1), dayAfter = d(2);

const facsRes = await api('/facilities', 'GET');
const facs = facsRes.json?.facilities || facsRes.json?.data || [];
console.log('FACILITIES', facs.length, facs[0]?.id, facs[0]?.name);

const seeded = {};
for (const [label, date] of [['A', today], ['B', tomorrow], ['C', dayAfter]]) {
  const r = await api('/facilities/reservations', 'POST', {
    facility_id: facs[0].id, resource_id: facs[0].id,
    target_date: date,
    title: `DayProbe${label}`,
    start_time: `${date} 09:00:00`,
    end_time: `${date} 10:00:00`,
  });
  const id = r.json?.data?.id || r.json?.reservation?.id || r.json?.id;
  seeded[date] = { label, status: r.status, id };
  console.log('SEED', label, date, 'status=', r.status, 'id=', id);
}

const chips = () => page.evaluate(() => {
  const list = [...document.querySelectorAll('#facility-matrix-body [data-res-id]')];
  return list.map((c) => ({
    id: c.getAttribute('data-res-id'),
    title: c.getAttribute('title'),
    text: c.textContent.replace(/\s+/g, ' ').trim().slice(0, 30),
    picker: document.getElementById('facility-date-picker')?.value,
  }));
});

const openDay = (date) => page.evaluate((d) => {
  const p = document.getElementById('facility-date-picker');
  p.value = d;
  p.dispatchEvent(new Event('change'));
}, date);

await page.evaluate(() => document.querySelector('a[data-tab="facility"]').click());
await sleep(1500);

console.log('TODAY_CHIPS', JSON.stringify(await chips()));

await openDay(tomorrow);
await sleep(1200);
const tmr = await chips();
console.log('TOMORROW_CHIPS', JSON.stringify(tmr));
console.log('TOMORROW_HAS_B', tmr.some((c) => c.title?.includes('DayProbeB')) ? 'YES' : 'NO');

await openDay(dayAfter);
await sleep(1200);
const d3 = await chips();
console.log('DAY3_CHIPS', JSON.stringify(d3));
console.log('DAY3_HAS_C', d3.some((c) => c.title?.includes('DayProbeC')) ? 'YES' : 'NO');

// --- モーダル表示チェック (投稿者本人にのみ変更・削除メニュー) ---
const openDetailFor = (resId) => page.evaluate((id) => {
  const chip = document.querySelector(`#facility-matrix-body [data-res-id="${id}"]`);
  if (chip) chip.click();
  return Boolean(chip);
}, resId);

const modalState = () => page.evaluate(() => {
  const m = document.getElementById('facility-detail-modal');
  return {
    open: Boolean(m && !m.classList.contains('hidden')),
    menu: document.getElementById('facility-detail-menu')?.classList.contains('hidden') === false,
    notice: document.getElementById('facility-detail-notice')?.classList.contains('hidden') === false,
    facility: document.getElementById('facility-detail-facility')?.textContent,
    purpose: document.getElementById('facility-detail-purpose')?.textContent,
    poster: (document.getElementById('facility-detail-poster')?.textContent || '').trim(),
  };
});

const bId = seeded[tomorrow].id;
await openDay(tomorrow);
await sleep(1200);
const clickedB = await openDetailFor(bId);
await sleep(400);
console.log('MODAL_AUTHOR', JSON.stringify({ clicked: clickedB, ...(await modalState()) }));

// --- 他人の予約 (投稿者が現ユーザー以外) を開くとメニューは隠れるはず ---
const myId = await page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => /user_info/i.test(k));
  try { return String(JSON.parse(localStorage.getItem(key)).id || ''); } catch { return ''; }
});

let foreign = null;
for (let n = -20; n <= 6 && !foreign; n++) {
  const date = d(n);
  const ov = await api(`/facilities/daily-overview?date=${date}`, 'GET');
  const items = ov.json?.facilitiesOverview || ov.json?.data || [];
  for (const f of items) {
    for (const r of (f.reservations || [])) {
      if (String(r.user_id) !== myId && !String(r.title || '').startsWith('DayProbe')) {
        foreign = { date, id: r.id, user: r.user_name, title: r.title };
        break;
      }
    }
    if (foreign) break;
  }
}
console.log('FOREIGN_RES', JSON.stringify(foreign), 'MY_ID', myId);

if (foreign) {
  await openDay(foreign.date);
  await sleep(1200);
  const clickedF = await openDetailFor(foreign.id);
  await sleep(400);
  console.log('MODAL_FOREIGN', JSON.stringify({ clicked: clickedF, ...(await modalState()) }));
}

// --- 作者による PUT 更新 ---
const putSelf = await api(`/facilities/reservations/${bId}`, 'PUT', {
  facility_id: facs[0].id,
  target_date: tomorrow,
  start_time: '10:30',
  end_time: '11:30',
  title: 'DayProbeB-UPD',
});
console.log('PUT_AUTHOR', putSelf.status, JSON.stringify(putSelf.json?.message || ''));

// --- 非作者による PUT / DELETE は 403 ---
const asOther = await (async () => {
  const base = 'http://127.0.0.1:3000/api';
  const l = await fetch(base + '/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staff_code: 'T2026002', password: 'password123' }),
  });
  const j = await l.json();
  const tok = j.token;
  const p = await fetch(`${base}/facilities/reservations/${bId}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
    body: JSON.stringify({ target_date: tomorrow, start_time: '10:30', end_time: '11:30', title: 'x' }),
  });
  const pj = await p.json().catch(() => null);
  const d = await fetch(`${base}/facilities/reservations/${bId}`, {
    method: 'DELETE', headers: { Authorization: 'Bearer ' + tok },
  });
  const dj = await d.json().catch(() => null);
  return { put: p.status, putMsg: pj?.message, del: d.status, delMsg: dj?.message };
})();
console.log('NON_AUTHOR', JSON.stringify(asOther));

for (const date of [today, tomorrow, dayAfter]) {
  const ov = await api(`/facilities/daily-overview?date=${date}`, 'GET');
  const items = ov.json?.facilitiesOverview || ov.json?.data || [];
  for (const f of items) {
    for (const r of (f.reservations || [])) {
      if (String(r.title || r.purpose || '').startsWith('DayProbe')) {
        await api(`/facilities/reservations/${r.id}`, 'DELETE');
      }
    }
  }
}

console.log('CONSOLE_LOGS', JSON.stringify(logs.slice(0, 10)));
await browser.close();
