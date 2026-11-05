/**
 * ツートンテーマ（cb-* / dc-*）のテキスト・アイコンコントラストスキャナ
 *
 * 各テーマでダッシュボード・全タブ・主要モーダルを順に表示し、可視要素の
 * 文字色と背景合成後の明度差 (WCAG 比) を実測して 4.5/3.0 未満を検出する。
 * Chrome は color-mix()/oklch() を computed で返さないため canvas 1px フィルで sRGB 化。
 *
 * 実行: node scripts/contrast-scan.mjs
 *  SCAN_TARGETS=two-tone(既定) | plain(素の light/dark) | all
 *  options: UI_BASE UI_USER UI_PASS CHROME_PATH ONLY=<themeId substring>
 *  終了コード: コントラスト不合格が 1 件以上あれば 1
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const OUT_DIR = `${import.meta.dirname}/output`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 12 ツートンテーマ（theme.js の SUPPORTED_THEMES と同じ mode / chrome）＋ 素の 12 テーマ
const TWO_TONE = [
  ...['azure', 'forest', 'crimson', 'violet', 'teal', 'slate'].map((s) => ({ id: `cb-${s}`, cls: `theme-cb-${s}`, mode: 'light', chrome: 'saturated' })),
  ...['azure', 'forest', 'rose', 'amber', 'violet', 'slate'].map((s) => ({ id: `dc-${s}`, cls: `theme-dc-${s}`, mode: 'dark', chrome: 'inverted' })),
];

// 素のライト／ダークテーマ（chrome なし）：ツートン改造による退化検出用
const PLAIN = [
  ...['azure', 'forest', 'amber', 'rose', 'slate', 'teal'].map((s) => ({ id: `light-${s}`, cls: `theme-light-${s}`, mode: 'light', chrome: '' })),
  ...['navy', 'emerald', 'plum', 'amber', 'rose', 'slate'].map((s) => ({ id: `dark-${s}`, cls: `theme-dark-${s}`, mode: 'dark', chrome: '' })),
];

const TARGETS = process.env.SCAN_TARGETS === "plain" ? PLAIN
  : process.env.SCAN_TARGETS === "all" ? [...TWO_TONE, ...PLAIN]
  : TWO_TONE;

// ページ内で動くスキャナ（色正規化 + 要素 walk）
const SCANNER = () => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const C = canvas.getContext('2d');
  const norm = (color) => {
    if (!color || color === 'none' || color === 'transparent' || color === 'rgba(0, 0, 0, 0)') return null;
    C.clearRect(0, 0, 1, 1);
    C.fillStyle = '#888888';
    C.fillStyle = color;
    C.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = C.getImageData(0, 0, 1, 1).data;
    if (String(C.fillStyle).toLowerCase().replace(/\s+/g, '') === '#888888') return null; // 解析不能
    if (a === 0) return null;
    return { r, g, b, a };
  };
  const chan = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (p) => 0.2126 * chan(p.r) + 0.7152 * chan(p.g) + 0.0722 * chan(p.b);
  const mix = (x, y, a) => x * a + y * (1 - a);
  const composite = (fg, bg) => {
    const a = fg.a / 255;
    return { r: mix(fg.r, bg.r, a), g: mix(fg.g, bg.g, a), b: mix(fg.b, bg.b, a), a: 255 };
  };
  const ratio = (fg, bg) => {
    const L1 = lum(composite(fg, bg));
    const L2 = lum(bg);
    return (Math.max(L1, L2) + 0.05) / (Math.min(L1, L2) + 0.05);
  };
  const bgOf = (el) => {
    const chain = [];
    let node = el;
    while (node && node !== document.documentElement) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') chain.push({ bg, sel: pathOf(node) });
      node = node.parentElement;
    }
    chain.push({ bg: getComputedStyle(document.documentElement).backgroundColor, sel: 'html' });
    const list = chain.map((c) => norm(c.bg));
    let base = { r: 255, g: 255, b: 255, a: 255 };
    for (let i = list.length - 1; i >= 0; i--) if (list[i]) base = composite(list[i], base);
    return { base, chain: chain.slice(0, 3).map((c) => `${c.sel}=${c.bg.slice(0, 22)}`) };
  };
  const visible = (el) => {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.05) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const pathOf = (el) => {
    const parts = [];
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      const id = node.id ? `#${node.id}` : null;
      const cls = node.className && typeof node.className === 'string'
        ? '.' + node.className.trim().split(/\s+/).slice(0, 3).join('.') : null;
      parts.unshift(id || cls || node.tagName.toLowerCase());
      node = node.parentElement;
    }
    return parts.join(' > ');
  };
  const required = (fontSizePx, fontWeight) =>
    (fontSizePx >= 24 || (fontSizePx >= 18.5 && Number(fontWeight) >= 700)) ? 3.0 : 4.5;

  window.__scan = () => {
    const out = [];
    const seen = new Set();
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el)) continue;
      const cs = getComputedStyle(el);
      const text = [...el.childNodes]
        .filter((n) => n.nodeType === 3 && n.textContent.trim())
        .map((n) => n.textContent.trim().replace(/\s+/g, ' '))
        .join(' | ');
      const tag = el.tagName.toLowerCase();
      const { base: bg, chain } = bgOf(el);
      const size = parseFloat(cs.fontSize) || 16;
      const weight = cs.fontWeight;
      const need = required(size, weight);
      if (text) {
        const fg = norm(cs.color);
        if (fg) {
          const r = Math.round(ratio(fg, bg) * 100) / 100;
          if (r < need) {
            const key = pathOf(el) + '|' + text.slice(0, 24);
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ kind: 'text', ratio: r, need, size, weight, text: text.slice(0, 44),
                path: pathOf(el), color: cs.color.slice(0, 34), bg: `rgb(${bg.r},${bg.g},${bg.b})`, chain });
            }
          }
        }
      }
      if (tag === 'svg' || tag === 'i') {
        const fill = tag === 'svg' ? cs.fill : cs.color;
        const fg = norm(fill);
        if (fg) {
          const r = Math.round(ratio(fg, bg) * 100) / 100;
          if (r < 3.0) {
            const key = pathOf(el) + '|icon';
            if (!seen.has(key)) {
              seen.add(key);
              out.push({ kind: 'icon', ratio: r, need: 3.0, size, weight, text: (el.getAttribute('data-lucide') || tag),
                path: pathOf(el), color: String(fill).slice(0, 34), bg: `rgb(${bg.r},${bg.g},${bg.b})` });
            }
          }
        }
      }
    }
    return out.sort((a, b) => a.ratio - b.ratio);
  };
};

// --- ドライバ ----------------------------------------------------------------
const TABS = ['dashboard', 'bulletin', 'chat', 'mail', 'schedule', 'facility', 'approval', 'seating'];
const MODALS = ['theme-modal', 'absence-modal', 'profile-modal', 'weather-detail-modal',
  'users-manage-modal', 'seating-modal', 'bulletin-modal', 'bulletin-detail-modal'];

function findChrome() {
  const candidates = [CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error(`Chrome が見つかりません: ${CHROME}`);
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1301, height: 1130 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.evaluate(() => document.querySelector('#login-form')?.classList.remove('hidden'));
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 15000 });
await sleep(1500);
await page.evaluate(SCANNER);

const themes = TARGETS.filter((t) => !process.env.ONLY || t.id.includes(process.env.ONLY));
const all = [];
let shots = 0;

for (const theme of themes) {
  const apply = async () => page.evaluate((cls, mode, chrome) => {
    const el = document.documentElement;
    el.className = cls;
    el.dataset.themeMode = mode;
    el.dataset.chrome = chrome;
  }, theme.cls, theme.mode, theme.chrome);

  const scan = () => page.evaluate(() => window.__scan());

  await apply();
  const results = [];

  for (const tab of TABS) {
    const nav = await page.$(`a[data-tab="${tab}"]`);
    if (!nav) continue;
    await nav.evaluate((n) => n.click());
    await sleep(850);
    for (const r of await scan()) results.push({ ...r, tab });

    // モーダル（ui-helpers を動的 import して開く）
    if (tab === 'dashboard') {
      for (const mid of MODALS) {
        await page.evaluate(async (id) => {
          const m = await import('/js/ui-helpers.js');
          m.openModal(id);
        }, mid);
        await sleep(450);
        for (const r of await scan()) results.push({ ...r, tab: `${tab}+${mid}` });
        await page.keyboard.press('Escape');
        await sleep(250);
      }
    }
  }

  const worst = results[0];
  all.push(...results.map((r) => ({ theme: theme.id, ...r })));

  console.log(`\n=== ${theme.id} (${theme.chrome}) failures=${results.length} ===`);
  for (const r of results.slice(0, 12)) {
    console.log(`  ${String(r.ratio).padEnd(5, ' ')} need=${r.need} ${r.kind.padEnd(4)} ${r.tab} | ${r.path} | "${r.text}" | fg=${r.color} bg=${r.bg} | chain=${(r.chain || []).join(' ~ ')}`);
  }

  // 最悪状態のスクリーンショット（テーマごとに dashboard と worst タブ）
  const shotTab = worst ? worst.tab : 'dashboard';
  const baseTab = shotTab.split('+')[0];
  const nav = await page.$(`a[data-tab="${baseTab}"]`);
  if (nav) await nav.evaluate((n) => n.click());
  if (shotTab.includes('+')) {
    await page.evaluate(async (id) => {
      const m = await import('/js/ui-helpers.js');
      m.openModal(id);
    }, shotTab.split('+')[1]);
  }
  await sleep(400);
  const file = `${OUT_DIR}/contrast-${theme.id}-${shotTab.replace('+', '_')}.png`;
  await page.screenshot({ path: file, fullPage: false });
  shots++;
  await page.evaluate(async () => {
    const m = await import('/js/ui-helpers.js');
    for (const el of document.querySelectorAll('.modal-overlay')) m.closeModal(el.id);
  });
}

fs.writeFileSync(`${OUT_DIR}/contrast-scan.json`, JSON.stringify(all, null, 2));
console.log(`\n合計: themes=${themes.length} failures=${all.length} screenshots=${shots}`);

// テーマ横断の構造別集計（path 冒頭 2 段 + kind + tab）
const groups = {};
for (const r of all) {
  const key = `${r.kind} ${r.tab.split('+')[0]} ${r.path.split(' > ').slice(0, 2).join(' > ')}`;
  groups[key] = groups[key] || { n: 0, min: 99, themes: new Set() };
  groups[key].n++;
  groups[key].min = Math.min(groups[key].min, r.ratio);
  groups[key].themes.add(r.theme);
}
console.log('\n--- 構造別（n=件数, min= worst ratio, #themes） ---');
for (const [k, v] of Object.entries(groups).sort((a, b) => a[1].min - b[1].min).slice(0, 40)) {
  console.log(`n=${String(v.n).padStart(3)} min=${v.min} themes=${v.themes.size} | ${k}`);
}

await browser.close();
if (all.length) process.exitCode = 1;


