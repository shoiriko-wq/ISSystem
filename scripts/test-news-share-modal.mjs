/**
 * ダッシュボード「記事を共有」機能の回帰テスト（実ブラウザ + サーバー実データ検証）
 *
 * 検証ルール:
 *  1. ピックアップ教育ニュースの「すべて見る」ボタン（dash-btn-news-more）は撤廃済み
 *  2. 「記事を共有」ボタン（dash-btn-news-share）が同じ位置に存在する
 *  3. クリックで #news-share-modal（モーダル規約: modal-overlay > modal-card > modal-header + modal-form + modal-footer）が開く
 *  4. モーダルの入力欄は記事URLだけ（タイトル・ひとこと・共有先・チャンネル選択・掲示対象日は撤廃）
 *  5. モーダル内に常設説明文はない（p 要素0・本文はラベルだけ／UI十条9 と禁则6: トースト・title・プレースホルダーのみ）
 *  6. URL入力は7条件（type・id・name・autocomplete・aria-label・label[for]・border-main 2px実線）＝UI十条3・禁则8。
 *     URLの補完規則はプレースホルダーと title だけで伝える
 *  7. 記事URLが空では送信しない（エラートースト表示、モーダルは開いたまま、POST 発生なし）
 *  8. URL入力 → POST /api/news/links へ共有（スキーマ無しは https:// を補完、送信は url 1項目だけ）
 *  9. 共有の行き先はピノックアップ教育ニュース（news_links）だけ＝職員チャットへの投稿は発生しない（v3.1.7・禁则16の運用）
 * 10. 共有後はモーダルが閉じ、成功トースト「ピノックアップ教育ニュースへ…」が出てダッシュボードに残り、サーバー実データ（news_links）にも登録される
 *     ※ URLは実行ごとに一意なクエリを付けて共有済み(409)を防ぎ、最後に共有リンクを掃除する
 * 11. フッター「閉じる」と ESC キーで閉じられる（全モーダル共通規約）
 * 12. 背景クリック規則: モーダル内で押し開始→背景で離すと閉じない、背景で押し開始→閉じる
 * 13. ボタン・モーダルの Lucide アイコンが SVG として実描画される
 * 14. カードは1行表示（タイトルリンク＋右端の小さな日付）。px実測で1行（リンク高19px・カード高38px以下・nowrap+ellipsis）、
 *     ホバーで全文（title属性＝リンクの全文）、ドメインバッチ・共有者名・下線・二重リングは出ない、リンクは新タブ（target/rel）
 * 17. 一覧は1列（本日の連絡と同一の flex 列・カード幅は全カード同一＝2列にならない）
 * 15. サーバー実データ: title_source（title/h1/og/domain）が記録され、ページタイトルが取れた時はタイトルがドメイン名でない
 * 16. 後片付け: このテストが作った共有リンクは掃除され、掃除後の API に出ない（DB にテストの残りを溜めない）
 *
 * 実行: node scripts/test-news-share-modal.mjs  （ISSystem サーバーが必要）
 *  options: UI_BASE=https://127.0.0.1:3443  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { query } from '../config/database.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// CA の信頼は OS の証明書ストアで一度だけ登録する（NODE_EXTRA_CA_CERTS はコードに書かない＝第12条）。
// 実測は headless Chrome の ignoreHTTPSErrors と --ignore-certificate-errors で TLS を通す。
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 実行ごとに一意なURL（同一URLの共有は server が 409 で拒否するためクエリで一意化し、最後に掃除する）
const RUN_TAG = Date.now();
const TYPED_URL = `mext.go.jp/b_menu/happou/20261107.html?uictl=${RUN_TAG}`;
const EXPECT_URL = `https://mext.go.jp/b_menu/happou/20261107.html?uictl=${RUN_TAG}`;
// このテストが作った共有リンクだけ掃除する（テストの残りを DB に溜めない）
const CLEAN_PREFIX = 'https://mext.go.jp/b_menu/happou/20261107.html?uictl=%';
const cleanNewsLinks = async () => (await query('DELETE FROM news_links WHERE lower(url) LIKE ?', [CLEAN_PREFIX])).rowCount;
// server はページタイトルを取りに行く（最大8秒）ので固定sleepでは落とす。条件が揃うまで待つ
const waitFor = async (fn, timeoutMs = 12000, stepMs = 200) => {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) return v;
    await sleep(stepMs);
  }
};

// 前実行の残りを掃除してから走る（共有済みURLの蓄積で 409 にならないため）
console.log(`掃除(開始前): 共有リンク ${await cleanNewsLinks()} 件`);

const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));

// 共有 POST を記録する（/api/news/links が行き先。チャット POST は「出ないこと」を確認するため捕まえる）
const posts = [];
page.on('request', (req) => {
  const url = req.url();
  if (req.method() !== 'POST') return;
  if (/\/api\/news\/links$/.test(url) || /\/api\/chat\/channels\/[^/]+\/messages$/.test(url) || /\/api\/bulletins$/.test(url)) {
    let body = null;
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = null; }
    posts.push({ endpoint: url.replace(BASE, ''), body });
  }
});
/**
 * ダッシュボードタブへ戻ってから「記事を共有」ボタンを実クリックする
 * （共有後に他タブへ遷移するとダッシュボードのウィジェットが非表示になり、直接クリックできないため）
 */
async function openShare() {
  await page.evaluate(() => document.querySelector('.app-sidebar .nav-item[data-tab="dashboard"]').click());
  await sleep(400);
  await page.click('#dash-btn-news-share');
  await sleep(500);
}


await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

// ---- 1,2. ボタンの撤廃と新設 ----
const btnInfo = await page.evaluate(() => {
  const share = document.getElementById('dash-btn-news-share');
  return {
    moreExists: !!document.getElementById('dash-btn-news-more'),
    shareExists: !!share,
    shareText: (share?.textContent || '').replace(/\s+/g, ' ').trim(),
    modalExists: !!document.getElementById('news-share-modal'),
    hasCloseX: !!document.querySelector('#news-share-modal .modal-close-x'),
    footerCloseCount: document.querySelectorAll('#news-share-modal .modal-footer .modal-close').length,
  };
});
check('「すべて見る」ボタン（dash-btn-news-more）は撤廃済み', !btnInfo.moreExists, btnInfo);
check('「記事を共有」ボタンが同じ位置に存在する', btnInfo.shareExists && btnInfo.shareText.includes('記事を共有'), btnInfo);
check('モーダル規約（X・フッター閉じる）が揃っている', btnInfo.modalExists && btnInfo.hasCloseX && btnInfo.footerCloseCount >= 1, btnInfo);

// ---- 3,4. クリックでモーダルが開き、入力欄は記事URLだけ ----
await page.click('#dash-btn-news-share');
await sleep(600);
const opened = await page.evaluate(() => ({
  open: !document.getElementById('news-share-modal').classList.contains('hidden'),
  urlPlaceholder: document.getElementById('news-share-url')?.placeholder,
  inputIds: [...document.querySelectorAll('#news-share-form input, #news-share-form select, #news-share-form textarea')].map((e) => e.id),
  submitCount: document.querySelectorAll('#news-share-form button[type="submit"]').length,
  focusedId: document.activeElement?.id,
}));
check('クリックで共有モーダルが開く', opened.open, opened);
check('URL入力欄がフォーカスされる', !!opened.urlPlaceholder && opened.focusedId === 'news-share-url', opened);
check('入力欄は記事URLだけ（タイトル・ひとこと・共有先・チャンネル選択・掲示対象日は撤廃）',
  opened.inputIds.length === 1 && opened.inputIds[0] === 'news-share-url' && opened.submitCount === 1, opened);

// ---- 4b. モーダル内に常設説明文はない（UI十条9・禁则6）、URL入力は7条件（UI十条3・禁则8） ----
const formShape = await page.evaluate(() => {
  const form = document.getElementById('news-share-form');
  const input = document.getElementById('news-share-url');
  const cs = getComputedStyle(input);
  return {
    pCount: form.querySelectorAll('p').length,
    bodyText: (form.querySelector('.modal-body')?.textContent || '').replace(/\s+/g, ' ').trim(),
    type: input.type,
    id: input.id,
    name: input.getAttribute('name'),
    autocomplete: input.getAttribute('autocomplete'),
    ariaLabel: input.getAttribute('aria-label'),
    labelFor: !!document.querySelector('label[for="news-share-url"]'),
    borderW: cs.borderTopWidth,
    borderS: cs.borderTopStyle,
    placeholder: input.placeholder,
    title: input.getAttribute('title'),
  };
});
check('モーダル内に常設説明文がない（p 要素0・本文はラベル「記事URL」だけ）',
  formShape.pCount === 0 && formShape.bodyText === '記事URL *', formShape);
check('URL入力は7条件（type / id / name / autocomplete / aria-label / label[for] / border-main 2px実線）',
  formShape.type === 'url' && formShape.id === 'news-share-url' && formShape.name === 'news-share-url'
  && formShape.autocomplete === 'off' && formShape.ariaLabel === '記事URL' && formShape.labelFor
  && formShape.borderW === '2px' && formShape.borderS === 'solid', formShape);
check('URLの補完規則はプレースホルダーと title でだけ伝える',
  formShape.placeholder.includes('https://') && (formShape.title || '').includes('補完'), formShape);

// ---- 5. URL 空の送信は禁止 ----
await page.click('#news-share-form button[type="submit"]');
await sleep(600);
const afterEmpty = await page.evaluate(() => ({
  open: !document.getElementById('news-share-modal').classList.contains('hidden'),
  toasts: [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
}));
check('URL 空では POST が発生しない', posts.length === 0, posts);
check('URL 空ではエラートースト表示、モーダルは開いたまま', afterEmpty.open && afterEmpty.toasts.some((t) => t.includes('URL')), afterEmpty);


// ---- 8,9,10. ピノックアップ教育ニュースへ共有（https:// 補完・リンク1件だけ・チャット投稿はしない） ----
await page.type('#news-share-url', TYPED_URL);
await page.click('#news-share-form button[type="submit"]');

// server はページタイトルを取りに行く（最大8秒）ので、モーダルが閉じるまで待つ
const afterShare = await waitFor(() => page.evaluate(() => {
  if (document.getElementById('news-share-modal').classList.contains('hidden')) {
    return {
      activeView: document.querySelector('.tab-view:not(.hidden)')?.id,
      toasts: [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
    };
  }
  return null;
}), 12000);

const newsPost = posts.find((p) => p.endpoint === '/api/news/links');
const chatPost = posts.find((p) => p.endpoint.includes('/chat/channels/'));
check('URLスキーマ無しは https:// へ補完され、送信は url 1項目だけ',
  newsPost?.body?.url === EXPECT_URL && Object.keys(newsPost?.body || {}).length === 1, newsPost?.body);
check('共有の行き先は /api/news/links（職員チャットへの投稿は発生しない＝v3.1.7・禁则16）',
  !!newsPost && !chatPost, { newsPost: newsPost?.endpoint, chatPost: chatPost?.endpoint });
check('共有後はモーダルが閉じ、成功トースト「ピックアップ教育ニュースへ…」',
  !!afterShare && afterShare.toasts.some((t) => t.includes('ピックアップ教育ニュースへ')), afterShare);
check('タブはダッシュボードのまま（チャットタブへ遷移しない）',
  afterShare?.activeView === 'view-dashboard', afterShare?.activeView);

// サーバー実データ: news_links に共有URLが登録される（server のタイトル取得を待つ）
const sharedUrls = await waitFor(() => page.evaluate(async (u) => {
  const m = await import('/js/api.js');
  const res = await m.apiGet('/news/links', { limit: 50 });
  const urls = (res.links || []).map((x) => String(x.url || ''));
  return urls.some((x) => x.toLowerCase() === u.toLowerCase()) ? urls : null;
}, EXPECT_URL), 12000);
check('サーバー実データ: ピノックアップ教育ニュースに共有URLが登録されている',
  Array.isArray(sharedUrls), sharedUrls?.slice(0, 2));

// ---- 14. カードは1行表示（タイトルリンク＋右端の小さな日付・共有者名とドメインバッチは出ない） ----
const cardShape = await page.evaluate(() => {
  const card = document.querySelector('#dash-news-summary > div.news-link-card');
  const link = card?.querySelector('a.news-link-card__title');
  const date = card?.querySelector('.news-link-card__date');
  if (!card || !link || !date) return null;
  const csCard = getComputedStyle(card);
  const csLink = getComputedStyle(link);
  const csDate = getComputedStyle(date);
  const cardRect = card.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  const dateRect = date.getBoundingClientRect();
  return {
    cards: document.querySelectorAll('#dash-news-summary > div.news-link-card').length,
    display: csCard.display,
    alignItems: csCard.alignItems,
    cardH: Math.round(cardRect.height),
    linkH: Math.round(linkRect.height),
    linkW: Math.round(linkRect.width),
    linkScrollW: link.scrollWidth,
    nowrap: csLink.whiteSpace,
    overflowX: csLink.overflowX,
    ellipsis: csLink.textOverflow,
    linkFont: csLink.fontSize,
    linkWeight: parseFloat(csLink.fontWeight),
    linkLineCount: Math.round(linkRect.height / parseFloat(csLink.lineHeight)),
    dateFont: csDate.fontSize,
    dateRightGap: Math.round(cardRect.right - dateRect.right),
    href: link.href,
    target: link.target,
    rel: link.rel,
    titleAttr: link.getAttribute('title'),
    linkText: link.textContent,
    dateText: date.textContent,
    badge: !!card.querySelector('.badge'),
    shareName: card.textContent.includes('共有:'),
    borderW: parseFloat(csCard.borderTopWidth),
    borderS: csCard.borderTopStyle,
    cardUnderline: csLink.textDecorationLine,
    cardOutline: csLink.outlineStyle,
    lucideInCard: !!card.querySelector('svg'),
  };
});
check('カードは1行（flex行・タイトルリンク高19px・カード高38px以下・1行分しかない）',
  cardShape && cardShape.display === 'flex' && cardShape.alignItems === 'center'
  && cardShape.linkH === 19 && cardShape.cardH <= 38 && cardShape.linkLineCount === 1, cardShape);
check('長いタイトルは1行で … に切り詰められる（nowrap / overflow:hidden / text-overflow:ellipsis・下に下線は出さない）',
  cardShape && cardShape.nowrap === 'nowrap' && cardShape.overflowX === 'hidden'
  && cardShape.ellipsis === 'ellipsis' && cardShape.linkScrollW >= cardShape.linkW
  && cardShape.cardUnderline === 'none', cardShape);
check('ホバーで全文が出る（title属性＝リンクの全文・リンクの文字も全文）',
  cardShape && !!cardShape.titleAttr && cardShape.titleAttr === cardShape.linkText, cardShape);
check('右端に小さな日付（10px・カード右端の余白12px以下・M/D形）、共有者名とドメインバッチは出ない',
  cardShape && cardShape.dateFont === '10px' && cardShape.dateRightGap <= 12
  && /^\d{1,2}\/\d{1,2}$/.test(cardShape.dateText) && !cardShape.shareName && !cardShape.badge, cardShape);
check('リンクは下線・二重リング・下地を持たず新タブで開く（target=_blank・rel=noopener）、カード枠は2px実線',
  cardShape && cardShape.cardUnderline === 'none' && cardShape.cardOutline === 'none'
  && cardShape.href === EXPECT_URL && cardShape.target === '_blank' && cardShape.rel.includes('noopener')
  && cardShape.borderW === 2 && cardShape.borderS === 'solid', cardShape);

// ---- 17. 一覧は1列（本日の連絡と同一の flex 列・2列にならない・タイトルは14px太字） ----
const listShape = await page.evaluate(() => {
  const container = document.getElementById('dash-news-summary');
  if (!container) return null;
  const ccs = getComputedStyle(container);
  const bl = document.getElementById('dash-pinned-bulletins');
  const bcs = bl ? getComputedStyle(bl) : null;
  const widths = [...container.querySelectorAll('div.news-link-card')]
    .map((c) => Math.round(c.getBoundingClientRect().width));
  return {
    display: ccs.display, dir: ccs.flexDirection, gap: ccs.gap, widths,
    blDisplay: bcs ? bcs.display : null, blDir: bcs ? bcs.flexDirection : null, blGap: bcs ? bcs.gap : null,
  };
});
check('一覧は1列（flex column・本日の連絡と同一の gap・カード幅は全カード同一＝2列にならない・タイトルは14px太字＝本日の連絡と同じ列設計）',
  listShape && listShape.display === 'flex' && listShape.dir === 'column'
  && listShape.blDisplay === 'flex' && listShape.blDir === 'column' && listShape.gap === listShape.blGap
  && listShape.widths.length >= 1 && new Set(listShape.widths).size === 1 && listShape.widths[0] >= 300
  && cardShape && cardShape.linkFont === '14px' && cardShape.linkWeight >= 700,
  { listShape, linkFont: cardShape?.linkFont, weight: cardShape?.linkWeight });

// カード本体だけホバーリングを描く（中のリンクは二重リングを出さない＝UI十条5）
const newsCardEl = await page.$('#dash-news-summary > div.news-link-card');
await newsCardEl.hover();
await sleep(400);
const hoveredCard = await page.evaluate(() => {
  const card = document.querySelector('#dash-news-summary > div.news-link-card');
  const link = card?.querySelector('a.news-link-card__title');
  const cs = getComputedStyle(card);
  return {
    hovered: card.matches(':hover'),
    outline: cs.outlineStyle,
    outlineW: cs.outlineWidth,
    transform: cs.transform,
    cursor: cs.cursor,
    linkOutline: getComputedStyle(link).outlineStyle,
  };
});
check('ホバーでカードに1pxリング＋3px浮き、中のリンクは二重リングが出ない',
  hoveredCard.hovered === true && hoveredCard.outline === 'solid'
  && parseFloat(hoveredCard.outlineW) === 3
  && /^matrix\(1, 0, 0, 1, 0, -3\)$/.test(hoveredCard.transform)
  && hoveredCard.cursor === 'pointer' && hoveredCard.linkOutline === 'none', hoveredCard);

// ---- 15. サーバー実データ: タイトルの出所（title_source）とページタイトル ----
const sharedMeta = await waitFor(() => page.evaluate(async (u) => {
  const m = await import('/js/api.js');
  const res = await m.apiGet('/news/links', { limit: 50 });
  const item = (res.links || []).find((x) => String(x.url || '').toLowerCase() === u.toLowerCase());
  return item ? { title: item.title, domain: item.domain, source: item.title_source ?? item.titleSource ?? null } : null;
}, EXPECT_URL), 12000);
check('サーバー実データ: title_source（title / h1 / og / domain）が記録されている',
  ['title', 'h1', 'og', 'domain'].includes(sharedMeta?.source), sharedMeta);
check('サーバー実データ: ページタイトルが取れた時はタイトルがドメイン名でない（取れない時はドメイン名）',
  sharedMeta && (sharedMeta.source === 'domain'
    ? sharedMeta.title === sharedMeta.domain
    : sharedMeta.title !== sharedMeta.domain && !sharedMeta.title.includes(sharedMeta.domain)), sharedMeta);

// ---- 11. 閉じるボタン・ESC（全モーダル共通ルール） ----
await openShare();
await page.click('#news-share-modal .modal-footer .modal-close');
await sleep(300);
const closedByBtn = await page.evaluate(() => document.getElementById('news-share-modal').classList.contains('hidden'));
check('フッターの「閉じる」ボタンで閉じられる', closedByBtn);

await openShare();
await page.keyboard.press('Escape');
await sleep(300);
const closedByEsc = await page.evaluate(() => document.getElementById('news-share-modal').classList.contains('hidden'));
check('ESC キーで閉じられる', closedByEsc);

// ---- 12. 背景クリック規則（モーダル内ドラッグ脱出は閉じない／背景押下は閉じる） ----
await openShare();
const geo = await page.evaluate(() => {
  const o = document.getElementById('news-share-modal').getBoundingClientRect();
  const c = document.querySelector('#news-share-modal .modal-card').getBoundingClientRect();
  return { o: { x: o.x, y: o.y, w: o.width, h: o.height }, c: { x: c.x, y: c.y, w: c.width, h: c.height } };
});
const bgPoint = { x: geo.o.x + 8, y: geo.o.y + 8 }; // オーバーレイの左上隅 = カード外の背景
const cardPoint = { x: geo.c.x + geo.c.w / 2, y: geo.c.y + geo.c.h / 2 };

// モーダル内で押し開始 → 背景で離す → 閉じない
await page.mouse.move(cardPoint.x, cardPoint.y);
await page.mouse.down();
await page.mouse.move(bgPoint.x, bgPoint.y);
await page.mouse.up();
await sleep(300);
const afterDragOut = await page.evaluate(() => document.getElementById('news-share-modal').classList.contains('hidden'));
check('モーダル内で押し開始し背景で離すと閉じない（テキスト選択ドラッグのストレス回避）', !afterDragOut, { bgPoint, cardPoint });

// 背景で押し開始 → 背景で離す → 閉じる
await page.mouse.move(bgPoint.x, bgPoint.y);
await page.mouse.down();
await page.mouse.up();
await sleep(300);
const afterBgClick = await page.evaluate(() => document.getElementById('news-share-modal').classList.contains('hidden'));
check('背景で押し開始して離すと閉じる', afterBgClick);

// ---- 13. Lucide アイコンが実描画されている（ボタン・モーダルヘッダー） ----
const icons = await page.evaluate(() => {
  const svgIn = (sel) => !!document.querySelector(sel)?.querySelector('svg');
  return {
    btn: svgIn('#dash-btn-news-share'),
    head: svgIn('#news-share-modal .modal-header .modal-title'),
    closeX: svgIn('#news-share-modal .modal-close-x'),
  };
});
check('ボタン・モーダルのアイコンがSVGとして描画されている', icons.btn && icons.head && icons.closeX, icons);

// このテストが作った共有リンクを掃除して終わる（DB にテストの残りを溜めない）
const cleaned = await cleanNewsLinks();
console.log(`掃除(終了): 共有リンク ${cleaned} 件`);

// ---- 16. 後片付け: このテストが作った共有リンクはサーバーから消える（テストの残りを DB に溜めない） ----
const leftUrls = await page.evaluate(async (prefix) => {
  const m = await import('/js/api.js');
  const res = await m.apiGet('/news/links', { limit: 100 });
  return (res.links || []).filter((x) => String(x.url || '').startsWith(prefix)).map((x) => x.url);
}, CLEAN_PREFIX);
check('後片付け: このテストが作った共有リンクはサーバーから消える（掃除後は API に出ない）',
  cleaned >= 1 && leftUrls.length === 0, { cleaned, leftUrls });

await browser.close();
console.log('---');
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL OK');
process.exit(0);
