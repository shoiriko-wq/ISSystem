import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const TABS = ['dashboard', 'absence', 'facility', 'exam', 'grades', 'attendance', 'student', 'bulletin', 'user', 'chat', 'approval', 'settings', 'print'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  headless: 'new',
  executablePath: CHROME,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1100 });

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

const greeting = await page.evaluate(() => document.getElementById('dash-greeting')?.textContent || '');
console.log('GREETING', greeting.slice(0, 120));

const scan = () => page.evaluate(() => {
  const oklchToRgb = (Lpct, C, H, alpha = 1) => {
    const l = Lpct / 100;
    const a = C * Math.cos(H * Math.PI / 180);
    const b = C * Math.sin(H * Math.PI / 180);
    const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
    const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
    const r = 3.2413774638 * L - 1.5371034869 * M - 0.4988316107 * S;
    const g = -0.9692431766 * L + 1.8760108038 * M + 0.0415556061 * S;
    const bl = 0.0556309628 * L - 0.2040269690 * M + 1.0572251888 * S;
    const f = (v) => Math.max(0, Math.min(255, (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055) * 255));
    return [f(r), f(g), f(bl), alpha];
  };

  const parse = (raw) => {
    const s = String(raw || '');
    let m = s.match(/^rgba?\(([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s]+([\d.]+))?\)$/);
    if (m) return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4] === undefined ? 1 : parseFloat(m[4])];
    m = s.match(/^#([0-9a-f]{6})$/i);
    if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 1];
    m = s.match(/^color\(srgb ([\d.]+)[\s]+([\d.]+)[\s]+([\d.]+)(?:[\s]+([\d.]+))?\)$/);
    if (m) return [255 * parseFloat(m[1]), 255 * parseFloat(m[2]), 255 * parseFloat(m[3]), m[4] === undefined ? 1 : parseFloat(m[4])];
    m = s.match(/^oklch\(([\d.]+)%[\s]+([\d.]+)[\s]+([\d.]+)(?:[\s]+([\d.]+))?\)$/);
    if (m) return oklchToRgb(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4] === undefined ? 1 : parseFloat(m[4]));
    m = s.match(/^color\(oklch ([\d.]+)%[\s]+([\d.]+)[\s]+([\d.]+)(?:[\s]+([\d.]+))?\)$/);
    if (m) return oklchToRgb(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4] === undefined ? 1 : parseFloat(m[4]));
    return null;
  };
  const lum = (p) => {
    const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]);
  };
  const effBg = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c[3] > 0.05) return c;
      n = n.parentElement;
    }
    return [255, 255, 255, 1];
  };
  const isHidden = (el) => {
    let n = el;
    while (n && n !== document.documentElement) {
      const cs = getComputedStyle(n);
      if (n.hidden || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return true;
      n = n.parentElement;
    }
    return false;
  };
  const sel = (el) => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
    return s;
  };

  const offenders = [];
  const active = [...document.querySelectorAll('[id^="view-"]')]
    .find((v) => v.offsetParent !== null)?.id.replace('view-', '') || 'none';
  const scope = document.getElementById('view-' + active) || document.body;

  const tw = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = tw.nextNode(); node; node = tw.nextNode()) {
    const txt = node.textContent.replace(/\s+/g, '');
    if (!txt) continue;
    const el = node.parentElement;
    if (!el || isHidden(el) || el.closest('.chartjs')) continue;
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const fg = parse(cs.color);
    if (!fg) continue;
    const bg = effBg(el);
    const l1 = lum(fg), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const need = (size >= 24 || (size >= 18.5 && weight >= 700)) ? 3 : 4.5;
    if (ratio < need) offenders.push({ kind: 'text', tab: active, sel: sel(el), size, weight, fg: cs.color, bg: `rgb(${bg[0]},${bg[1]},${bg[2]})`, ratio: Math.round(ratio * 10) / 10, sample: txt.slice(0, 22) });
  }

  const btns = [...scope.querySelectorAll('button, .btn-primary, .btn-secondary, .btn-danger, .tab-item')];
  for (const b of btns) {
    if (isHidden(b) || b.disabled) continue;
    const cs = getComputedStyle(b);
    const fg = parse(cs.color);
    const bg = parse(cs.backgroundColor);
    if (!fg || !bg || bg[3] < 0.05) continue;
    const l1 = lum(fg), l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const rect = b.getBoundingClientRect();
    if (ratio < 4.5) offenders.push({ kind: 'button', tab: active, sel: sel(b), fg: cs.color, bg: `rgb(${bg[0]},${bg[1]},${bg[2]})`, ratio: Math.round(ratio * 10) / 10, w: Math.round(rect.width), h: Math.round(rect.height), label: (b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20) });
  }
  return offenders;
});

const all = [];
for (const tab of TABS) {
  await page.evaluate((t) => {
    const a = document.querySelector(`a[data-tab="${t}"]`) || document.querySelector(`[data-tab="${t}"]`);
    if (a) a.click();
  }, tab);
  await sleep(1000);
  const o = await scan();
  all.push(...o);
}

const byTab = {};
for (const o of all) { byTab[o.tab] = (byTab[o.tab] || 0) + 1; }
console.log('COUNT_BY_TAB ' + JSON.stringify(byTab));

all.sort((a, b) => a.ratio - b.ratio);
for (const o of all.slice(0, 30)) {
  console.log('OFF ' + o.tab + ' r=' + o.ratio + ' ' + o.kind + ' ' + o.sel + ' size=' + o.size + ' fg=' + o.fg + ' bg=' + o.bg + ' ' + (o.label || o.sample || '').slice(0, 14));
}

// ===== 欠席コメント送信ボタンの検証 =====
const d = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
const date = d(3);
const myId = await page.evaluate(() => {
  const key = Object.keys(localStorage).find((k) => /user_info/i.test(k));
  try { return String(JSON.parse(localStorage.getItem(key)).id || ''); } catch { return ''; }
});

const seeded = await api('/absence/records', 'POST', { user_id: myId, record_date: date, record_type: 'ABSENCE', reason: 'ProbeAll' });
const sid = seeded.json?.data?.id || seeded.json?.record?.id || seeded.json?.id;
console.log('SEED_ABSENCE', myId, seeded.status, sid);

await page.evaluate(() => {
  const a = document.querySelector('a[data-tab="absence"]') || document.querySelector('[data-tab="absence"]');
  if (a) a.click();
});
await sleep(1500);

const rowProbe = await page.evaluate((dstr) => {
  const row = document.querySelector(`#absence-grid [data-record-id^="${dstr}"]`);
  if (!row) return { found: false, rows: [...document.querySelectorAll('#absence-grid [data-record-id]')].map((r) => r.getAttribute('data-record-id')).slice(0, 6) };
  const act = row.querySelector('.absence-cell-action');
  if (act) act.click();
  return { found: true, key: row.getAttribute('data-record-id') };
}, date);
await sleep(600);

const openComment = await page.evaluate(() => {
  const open = document.getElementById('absence-comment-open');
  const disabled = open ? open.disabled : null;
  if (open && !disabled) open.click();
  return { exists: Boolean(open), disabled };
});
await sleep(700);

const commentBtn = await page.evaluate(() => {
  const modal = document.getElementById('absence-comment-modal');
  const b = modal ? modal.querySelector('.modal-footer .btn-primary') : null;
  if (!b) return { missing: true, modalOpen: modal && !modal.classList.contains('hidden') };
  const cs = getComputedStyle(b);
  const rect = b.getBoundingClientRect();
  return {
    modalOpen: !modal.classList.contains('hidden'),
    visible: rect.width > 0 && rect.height > 0,
    disabled: b.disabled,
    text: b.textContent.replace(/\s+/g, ' ').trim(),
    color: cs.color, bg: cs.backgroundColor, fontSize: cs.fontSize,
    w: Math.round(rect.width), h: Math.round(rect.height),
  };
});
console.log('ABSENT_ROW ' + JSON.stringify(rowProbe) + ' OPEN_COMMENT ' + JSON.stringify(openComment) + ' COMMENT_BTN ' + JSON.stringify(commentBtn));

// ===== 掲示板フォントサイズ =====
await page.evaluate(() => {
  const a = document.querySelector('a[data-tab="bulletin"]') || document.querySelector('[data-tab="bulletin"]');
  if (a) a.click();
});
await sleep(1200);
const bulletinSizes = await page.evaluate(() => {
  const scope = document.getElementById('view-bulletin');
  const sizes = [...scope.querySelectorAll('p, span, div, li, h1, h2, h3, h4, h5, button, a')]
    .filter((el) => el.textContent.replace(/\s+/g, '').length > 0 && el.offsetHeight > 0)
    .map((el) => parseFloat(getComputedStyle(el).fontSize));
  const uniq = [...new Set(sizes.map((s) => Math.round(s)))].sort((a, b) => a - b);
  const dist = uniq.map((s) => `${s}px:${sizes.filter((x) => Math.round(x) === s).length}`);
  return { min: uniq[0], max: uniq[uniq.length - 1], dist: dist.slice(0, 14) };
});
console.log('BULLETIN_FONT', JSON.stringify(bulletinSizes));

console.log('CONSOLE_LOGS', JSON.stringify(logs.slice(0, 6)));
await browser.close();