/**
 * ページ共通の「枠線ルール」回帰テスト（実ブラウザ検証）
 *
 * ルール（readability.css 第8節 Frames / 第9節 Cursor feedback）:
 *  R1. セクションカード (.card) は記事群を囲む 2px の実枠を描く。トップ3記事カード
 *      (.card--framed) と同一の太さ・色で揃える（影で太さを擬装しない）。
 *      .card-static と背景領域 (bg-*) は枠線を描かない「面」。
 *  R2. 枠線は明示的な border / border-x クラス（リスト項目、チップ、入力欄）にのみ描く。
 *      セクション見出しの仕切り線（タイトルを囲む枠）は描かない。
 *  R3. モダル・チャット・座席表・アプリ骨格 (header / sidebar) と 4セクションの記事カード
 *      (各リスト直下の項目) の枠線は 2px で維持する。セクション群を囲むグループ枠
 *      (.dashboard-grid) は描かない。
 *  R4. クリックできるカード (.card--framed) は枠線＋ホバーリングを維持する。
 *      ダッシュボード 4セクションの記事カード (各リスト直下の項目) も同一の
 *      ホバーリング＋浮き上がりを持つ（セクションカード自体は面なので反応しない）。
 *  R5. サイドバーのホバーリング（outline + offset + スライド）がスクロールコンテナの端で
 *      見切れない余白がある。
 *  R6. 狭幅モード（アイコンのみ）でアイコンがサイドバー箱から見切れない。
 *
 * 必要環境: puppeteer-core と Chrome/Chromium。実行: npm run test:ui:frames
 * 出力: scripts/output/frame-rules-dashboard.png, frame-rules-sidebar-hover.png,
 *       frame-rules-narrow-sidebar.png, frame-rules-narrow-sidebar-hover.png
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'scripts', 'output');
const VIEWPORT = { width: 1280, height: 1100 };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

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

const px = (v) => parseFloat(v) || 0;
const transparent = (v) => v === 'transparent' || v === 'rgba(0, 0, 0, 0)';
const noRing = (v) => v === 'none' || v === 'normal';

const { server, port } = await startServer();
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new', ignoreHTTPSErrors: true,
  protocolTimeout: 60000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors']
});

const page = await browser.newPage();
const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
};
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));

await page.setViewport(VIEWPORT);
await page.goto(`http://127.0.0.1:${port}/scripts/fixtures/dashboard-frames-fixture.html`, { waitUntil: 'networkidle0' });
await page.waitForFunction(() => window.TestApi && window.TestApi.ready, { timeout: 15000 });


// ---- R1: セクションカードは記事群を囲む共通 2px 枠を描く ----
const FRAME_W = 2; // var(--border-width)
const sections = await page.evaluate(() => window.TestApi.sectionCards().map((el) => {
  const cs = getComputedStyle(el);
  return {
    title: (el.querySelector('h3')?.textContent.trim() || el.id),
    widths: [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth],
    color: cs.borderTopColor,
    style: cs.borderTopStyle,
    shadow: cs.boxShadow
  };
}));
check('dashboard section cards exist (優先・重要連絡 / ニュース / 施設予約 / 行事予定)',
  sections.length === 4, sections.map((c) => c.title).join(' / '));
check('section cards draw the unified 2px frame (solid, opaque, no shadow)',
  sections.length === 4 && sections.every((c) => c.widths.every((w) => px(w) === FRAME_W) &&
    c.style === 'solid' && !transparent(c.color) && c.shadow === 'none'),
  sections.map((c) => `${c.title.slice(0, 8)}=${c.widths.join('/')}/${c.style}/${c.shadow === 'none' ? 'no-shadow' : 'shadow'}`).join(' '));

// ---- R4: クリックできるカードはセクションカードと同一の 2px 枠を維持（影で太さを擬装しない） ----
await page.evaluate(() => window.TestApi.injectApprovalCard());
const framed = await page.evaluate(() => window.TestApi.framedCards().map((el) => {
  const cs = getComputedStyle(el);
  return { top: cs.borderTopWidth, color: cs.borderTopColor, cursor: cs.cursor, shadow: cs.boxShadow };
}));
const sectionColor = sections[0]?.color;
check('interactive cards (.card--framed) keep the same 2px frame as section cards, no shadow',
  framed.length >= 4 && framed.every((b) => px(b.top) === FRAME_W && !transparent(b.color) &&
    b.shadow === 'none' && b.color === sectionColor),
  `${framed.length} cards, widths=${framed.map((b) => b.top).join('/')} colors=${[...new Set(framed.map((b) => b.color))].join(',')} sectionColor=${sectionColor}`);

// ---- R1/R2: 背景領域は枠線なし／明示 border を持つ項目は枠線を維持 ----
const bgRegions = await page.evaluate(() => [...document.querySelectorAll('[class*="bg-"]')]
  .filter((el) => !/(^| )border(-|$|[^a-z])/.test(el.className))
  .filter((el) => !el.closest('button, a, input, select, .nav-item, .modal-close'))
  .map((el) => ({ cls: el.className.slice(0, 70), w: parseFloat(getComputedStyle(el).borderTopWidth) })));
const paintedBg = bgRegions.filter((r) => r.w > 0);
check('background regions without an explicit border class draw no frame',
  bgRegions.length >= 2 && paintedBg.length === 0,
  `${bgRegions.length} plain bg regions, painted=${paintedBg.map((r) => `${r.cls}=${r.w}px`).join(' | ') || 'none'}`);

// ---- R3: 4セクションの記事カードはトップ3記事カードと同一の 2px 枠で揃う ----
const items = await page.evaluate(() => [...document.querySelectorAll(
  '#dash-pinned-bulletins > div, #dash-today-facilities > div, #dash-news-summary > div, #dash-today-schedules > div'
)].map((el) => ({
  top: parseFloat(getComputedStyle(el).borderTopWidth),
  style: getComputedStyle(el).borderTopStyle,
  color: getComputedStyle(el).borderTopColor
})));
check('article cards in the 4 sections share the unified 2px frame (same color as top cards)',
  items.length >= 6 && items.every((i) => i.top === FRAME_W && i.style === 'solid' && !transparent(i.color) && i.color === sectionColor),
  `${items.length} items, widths=${items.map((i) => i.top).join('/')} colors=${[...new Set(items.map((i) => i.color))].join(',')}`);

// 入力欄・チップ（border-*-color クラス）は枠線を持つ「合図」として width が復元されること
const colorClassProbe = await page.evaluate(() => {
  const main = document.querySelector('main');
  const mk = (tag, cls) => { const el = document.createElement(tag); el.className = cls; main.appendChild(el); return el; };
  const input = mk('input', 'rounded border-main bg-surface text-accent focus-ring-accent');
  const chip = mk('span', 'badge bg-success-soft border-success-soft px-2');
  const plain = mk('div', 'rounded-lg bg-surface-strong p-3');
  const r = [input, chip, plain].map((el) => ({
    cls: el.className.slice(0, 40),
    w: parseFloat(getComputedStyle(el).borderTopWidth),
    style: getComputedStyle(el).borderTopStyle
  }));
  [input, chip, plain].forEach((el) => el.remove());
  return r;
});
check('input/chip with border-color class draws a frame; plain bg surface draws none',
  colorClassProbe[0].w > 0 && colorClassProbe[0].style === 'solid' &&
  colorClassProbe[1].w > 0 && colorClassProbe[2].w === 0,
  colorClassProbe.map((p) => `${p.cls}=${p.w}px/${p.style}`).join(' | '));

// ---- R2/R3: セクション見出し（タイトルを囲む枠）は仕切り線を描かない ----
const headers = await page.evaluate(() => [...document.querySelectorAll('#view-dashboard h3')]
  .map((h) => parseFloat(getComputedStyle(h.parentElement).borderBottomWidth)));
check('section title blocks draw no divider frame', headers.length >= 4 && headers.every((w) => w === 0),
  `widths=${headers.join('/')}`);

// ---- R3: セクション群全体を囲むグループ枠は描かない。各セクションカードが 2px 枠を持つ ----
const grid = await page.evaluate(() => {
  const el = document.querySelector('.dashboard-grid');
  const cs = getComputedStyle(el);
  return {
    top: parseFloat(cs.borderTopWidth), color: cs.borderTopColor, pad: parseFloat(cs.paddingTop),
    radius: cs.borderTopLeftRadius,
    sections: [...el.querySelectorAll(':scope .card')].map((k) => parseFloat(getComputedStyle(k).borderTopWidth))
  };
});
check('no group frame around the dashboard sections; each section card carries the unified 2px frame',
  grid.top === 0 && grid.sections.length >= 4 && grid.sections.every((w) => w === FRAME_W),
  `grid border=${grid.top} padding=${grid.pad} radius=${grid.radius} section widths=${grid.sections.join('/')}`);

// ---- R3: モダルの枠線は維持 ----
const modal = await page.evaluate(() => {
  const el = document.createElement('div');
  el.className = 'modal-card p-4';
  el.style.position = 'absolute';
  el.textContent = 'probe';
  document.body.appendChild(el);
  const top = parseFloat(getComputedStyle(el).borderTopWidth);
  el.remove();
  return top;
});

// ---- R4/R5: ホバーフィードバック（面は反応しない／枠線カードはリング） ----
const sectionEl = await page.$('#view-dashboard .card:not(.card--framed)');
const sectionRest = await page.evaluate((el) => {
  const cs = getComputedStyle(el);
  return { cursor: cs.cursor, outline: cs.outlineStyle };
}, sectionEl);
await sectionEl.hover();
const sectionHover = await page.evaluate((el) => {
  const cs = getComputedStyle(el);
  return { cursor: cs.cursor, outline: cs.outlineStyle, transform: cs.transform, top: cs.borderTopWidth };
}, sectionEl);
check('section card is not a fake clickable frame (cursor not pointer, no ring/lift on hover, frame stays 2px)',
  sectionRest.cursor !== 'pointer' && noRing(sectionHover.outline) && px(sectionHover.top) === FRAME_W &&
  (sectionHover.transform === 'none' || sectionHover.transform === 'matrix(1, 0, 0, 1, 0, 0)'),
  `cursor=${sectionRest.cursor} outline=${sectionHover.outline} transform=${sectionHover.transform} frame=${sectionHover.top}`);

await page.mouse.move(5, 5);
const framedEl = await page.$('.card--framed');
await framedEl.hover();
const framedHover = await page.evaluate((el) => {
  const cs = getComputedStyle(el);
  return { outline: cs.outlineStyle, top: cs.borderTopWidth, cursor: cs.cursor };
}, framedEl);
check('interactive card keeps frame + hover ring feedback',
  px(framedHover.top) > 0 && framedHover.outline === 'solid',
  `border=${framedHover.top} outline=${framedHover.outline} cursor=${framedHover.cursor}`);

// ---- R4: ダッシュボード 4セクションの記事カードもトップ3記事カードと同じホバーアニメーション ----
const dashArticleSelectors = ['#dash-pinned-bulletins', '#dash-news-summary', '#dash-today-facilities', '#dash-today-schedules'];
const dashArticleHovers = [];
for (const sel of dashArticleSelectors) {
  const el = await page.$(`${sel} > div.rounded-lg`);
  if (!el) { dashArticleHovers.push({ sel, missing: true }); continue; }
  await page.mouse.move(5, 5);
  await el.hover();
  await new Promise((r) => setTimeout(r, 400));
  dashArticleHovers.push(await page.evaluate((node, selName) => {
    const cs = getComputedStyle(node);
    return {
      sel: selName, outline: cs.outlineStyle, transform: cs.transform,
      cursor: cs.cursor, top: parseFloat(cs.borderTopWidth),
      borderColor: cs.borderTopColor
    };
  }, el, sel));
}
const liftedTransform = (t) => /^matrix\(1, 0, 0, 1, 0, -\d+(\.\d+)?\)$/.test(t);
check('article cards in the 4 dashboard sections lift + draw a hover ring like the top article cards',
  dashArticleHovers.length === 4 && dashArticleHovers.every((r) => !r.missing
    && r.outline === 'solid' && liftedTransform(r.transform) && r.cursor === 'pointer' && r.top === FRAME_W),
  dashArticleHovers.map((r) => `${r.sel} outline=${r.outline} transform=${r.transform} cursor=${r.cursor} border=${r.top}`).join(' | '));

await page.mouse.move(5, 5);

// ---- R5: サイドバーのホバーリングがスクロールコンテナの端で見切れない ----
const sidebar = await page.evaluate(() => {
  const nav = document.querySelector('.app-sidebar nav');
  const cs = getComputedStyle(nav);
  const navBox = nav.getBoundingClientRect();
  const first = document.querySelector('.app-sidebar .nav-item');
  const firstBox = first.getBoundingClientRect();
  const vars = getComputedStyle(document.documentElement);
  const ring = parseFloat(vars.getPropertyValue('--ring-width')) || 3;
  const lift = Math.abs(parseFloat(vars.getPropertyValue('--hover-lift')) || 3);
  return {
    padTop: parseFloat(cs.paddingTop),
    gap: firstBox.top - navBox.top,
    ring, lift, overflowY: cs.overflowY
  };
});
const needed = sidebar.ring + 2 /* outline-offset */ + sidebar.lift;
check('sidebar hover ring fits inside the scroll container (padding >= ring+offset+lift)',
  sidebar.padTop >= needed - 0.5 && sidebar.gap >= needed - 0.5,
  `paddingTop=${sidebar.padTop}px gap=${sidebar.gap.toFixed(1)}px needed=${needed}px (ring ${sidebar.ring} + offset 2 + lift ${sidebar.lift})`);

// ---- スクリーンショット（主ページ）：R6 の狭幅ページ開封前に撮影する ----
fs.mkdirSync(OUT_DIR, { recursive: true });
await page.mouse.move(5, 5);
await page.screenshot({ path: path.join(OUT_DIR, 'frame-rules-dashboard.png') });
await page.hover('.app-sidebar .nav-item');
await new Promise((r) => setTimeout(r, 300));
await page.screenshot({
  path: path.join(OUT_DIR, 'frame-rules-sidebar-hover.png'),
  clip: { x: 0, y: 0, width: 240, height: 190 }
});

// ---- R6: 狭幅（アイコンのみ）モードでアイコンが見切れない ----
const narrow = await browser.newPage();
await narrow.setViewport({ width: 1020, height: 750 });
await narrow.goto(`http://127.0.0.1:${port}/scripts/fixtures/dashboard-frames-fixture.html`, { waitUntil: 'networkidle0' });
await narrow.waitForFunction(() => window.TestApi && window.TestApi.ready, { timeout: 15000 });

const iconFit = await narrow.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  const cs = getComputedStyle(sb);
  const sr = sb.getBoundingClientRect();
  const contentLeft = sr.left + parseFloat(cs.borderLeftWidth);
  const contentRight = sr.right - parseFloat(cs.borderRightWidth);
  return [...document.querySelectorAll('.app-sidebar .nav-item')].map((n) => {
    const icon = n.querySelector('svg.lucide, i[data-lucide], i');
    const ir = icon.getBoundingClientRect();
    const label = n.querySelector('.nav-label');
    // 収納時のラベルは display:none にせず「幅0」で隠す（layouts.css §6 の設計）。
    // 幅0はアイコンの幅を奪わないので見切れ起きず、縦ズレも起きない。
    // 旧テストは display:none を期待していたが、現行設計に合わせて「幅0」で判定する。
    const labelWidth = Math.round(label.getBoundingClientRect().width);
    return {
      title: (n.getAttribute('title') || '').slice(0, 6),
      left: Math.round(ir.left), right: Math.round(ir.right),
      clipLeft: Math.round(contentLeft - ir.left), clipRight: Math.round(ir.right - contentRight),
      labelWidth,
      labelHidden: labelWidth <= 1
    };
  });
});
check('collapsed sidebar icons stay fully inside the sidebar box (no clipping)',
  iconFit.length >= 3 && iconFit.every((c) => c.clipLeft <= 0 && c.clipRight <= 0 && c.labelHidden),
  iconFit.map((c) => `${c.title}=${c.left}-${c.right} clipL=${c.clipLeft} clipR=${c.clipRight} labelw=${c.labelWidth}`).join(' '));

// ---- R6b: アイコンのみモードの選択背景（アクティブの塗り）は正方形タイル ----
const squareTiles = await narrow.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  const cs = getComputedStyle(sb);
  const sr = sb.getBoundingClientRect();
  const contentLeft = sr.left + parseFloat(cs.borderLeftWidth);
  const contentRight = sr.right - parseFloat(cs.borderRightWidth);
  return [...document.querySelectorAll('.app-sidebar .nav-item')].map((n) => {
    const r = n.getBoundingClientRect();
    const icon = n.querySelector('svg.lucide, i[data-lucide], i');
    const ir = icon.getBoundingClientRect();
    return {
      title: (n.getAttribute('title') || '').slice(0, 6),
      w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
      offset: Math.round(((ir.left + ir.right) / 2 - (r.left + r.right) / 2) * 10) / 10,
      inside: r.left >= contentLeft - 1 && r.right <= contentRight + 1
    };
  });
});
check('icon-only sidebar selection tiles are square and centered (not elongated)',
  squareTiles.length >= 3 && squareTiles.every((t) => Math.abs(t.w - t.h) <= 1.5 && Math.abs(t.offset) <= 1.5 && t.inside),
  squareTiles.map((t) => `${t.title}=${t.w}x${t.h} offset=${t.offset} inside=${t.inside}`).join(' '));

await narrow.hover('.app-sidebar');
await new Promise((r) => setTimeout(r, 400));
const expanded = await narrow.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  const cs = getComputedStyle(sb);
  const sr = sb.getBoundingClientRect();
  return [...document.querySelectorAll('.app-sidebar .nav-item')].map((n) => {
    const icon = n.querySelector('svg.lucide, i[data-lucide], i');
    const ir = icon.getBoundingClientRect();
    const label = n.querySelector('.nav-label');
    const lr = label.getBoundingClientRect();
    return {
      title: (n.getAttribute('title') || '').slice(0, 6),
      iconLeft: Math.round(ir.left),
      labelRight: Math.round(lr.right),
      boxRight: Math.round(sr.right - parseFloat(cs.borderRightWidth)),
      labelShown: getComputedStyle(label).display !== 'none'
    };
  });
});
check('expanded sidebar reveals labels with icons and labels kept inside the box',
  expanded.every((c) => c.labelShown && c.iconLeft >= 0 && c.labelRight <= c.boxRight),
  expanded.map((c) => `${c.title} icon=${c.iconLeft} labelRight=${c.labelRight} boxRight=${c.boxRight}`).join(' '));

fs.mkdirSync(OUT_DIR, { recursive: true });
await narrow.screenshot({ path: path.join(OUT_DIR, 'frame-rules-narrow-sidebar.png'), clip: { x: 0, y: 0, width: 220, height: 430 } });
await narrow.screenshot({ path: path.join(OUT_DIR, 'frame-rules-narrow-sidebar-hover.png'), clip: { x: 0, y: 0, width: 220, height: 430 } });

// ---- R6c: 狭幅（画面下バー）の選択背景も正方形タイル ----
const mobile = await browser.newPage();
await mobile.setViewport({ width: 390, height: 800 });
await mobile.goto(`http://127.0.0.1:${port}/scripts/fixtures/dashboard-frames-fixture.html`, { waitUntil: 'networkidle0' });
await mobile.waitForFunction(() => window.TestApi && window.TestApi.ready, { timeout: 15000 });
const mobileTiles = await mobile.evaluate(() => {
  return [...document.querySelectorAll('.app-sidebar .nav-item')].map((n) => {
    const r = n.getBoundingClientRect();
    const icon = n.querySelector('svg.lucide, i[data-lucide], i');
    const ir = icon.getBoundingClientRect();
    return {
      title: (n.getAttribute('title') || '').slice(0, 6),
      w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10,
      iconInside: ir.left >= r.left - 1 && ir.right <= r.right + 1,
      labelShown: getComputedStyle(n.querySelector('.nav-label')).display !== 'none'
    };
  });
});
check('bottom bar selection tiles stay square with labels hidden on narrow screens',
  mobileTiles.length >= 3 && mobileTiles.every((t) => Math.abs(t.w - t.h) <= 1.5 && t.iconInside && !t.labelShown),
  mobileTiles.map((t) => `${t.title}=${t.w}x${t.h} iconInside=${t.iconInside}`).join(' '));
await mobile.screenshot({ path: path.join(OUT_DIR, 'frame-rules-bottom-bar.png'), clip: { x: 0, y: 730, width: 390, height: 70 } });
await mobile.close();

// ---- R3: モダルの枠線は維持 ----
check('modal-card keeps its frame', modal > 0, `width=${modal}`);

await browser.close();
server.close();

console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILURES`}`);
process.exit(failures.length === 0 ? 0 : 1);
