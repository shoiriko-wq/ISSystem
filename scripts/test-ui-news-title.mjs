/**
 * ピノックアップ教育ニュースのタイトル表示の回帰テスト（実ブラウザ + サーバー実データ + cron再取得）
 *
 * 検証ルール（ISSystem仕様書 §14 のニュースカードUI・§17 の通信環境に準拠）:
 *  1. Node は v26.x で、undici が global スコープにある（Agent / Dispatcher / ProxyAgent / setGlobalDispatcher）
 *  2. ProxyAgent が Dispatcher を継承し、setGlobalDispatcher が関数である
 *  3. 内蔵 https の globalAgent に ProxyAgent が付いている（環境変数プロキシが global Agent へ結線される）
 *  4. .env の HTTPS_PROXY / HTTP_PROXY が学校プロキシ、NODE_USE_ENV_PROXY=1、node --use-system-ca が揃う
 *  5. その環境で mext.go.jp の実ページを fetch できる（タイトルが <title> から取れる・ドメイン名でない）
 *  6. User-Agent は ASCII のみ（日本語 UA は fetch が送信前に TypeError になる）
 *  7. 「記事を共有」で url 1項目だけ POST され、サーバー実データに title_source とタイトルが登録される
 *  8. ページタイトルが取れた行はタイトルがドメイン名でなく、UI のリンク文字もサーバー実データのタイトルと一致する
 *  9. カードリンク a は 17.5px の太字、リンク高24px・カード高42px以下・1行・末尾 … 切り詰め・ホバーで全文
 * 10. 一覧は1列（flex column・gap 13.125px＝本日の連絡の gap と同一・カード幅は全カード同一）、日付10px・枠2px実線
 * 11. ホバーでカードに1pxリング＋3px浮き、中のリンクは二重リングが出ない（UI十条5）
 * 12. 未読マーカは14px（タイトル 17.5px ＞ マーカ 14px）
 * 13. cron 再取得: ドメイン名の行だけを見て取れた行の title / title_source を更新、取れない行はドメイン名のまま
 * 14. 再取得後も URL・共有者・追加日は変わらない
 * 15. 後片付け: このテストが作った行は全部消え、API・UI に出ない（実行前後で news_links の件数は同じ）
 *
 * 実行: node scripts/test-ui-news-title.mjs  （ISSystem サーバーが必要。--use-system-ca は自動で付け足す）
 *  options: UI_BASE=https://127.0.0.1:3443  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 */
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { query, closeDatabase } from '../config/database.js';
import newsLinkModel from '../src/models/news-link.model.js';
import newsService, {
  extractPageTitle, fetchHtmlGuarded, titleFetchEnvStatus, assertByteStringHeaders,
  fitTitle, TITLE_USER_AGENT, TITLE_MAX_CHARS, TITLE_SOURCES,
} from '../src/services/news.service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 通信環境（OSの証明書ストアを使う）は起動フラグが必須。フラグなしで呼ばれたら自分を使い直して走る
if (!process.execArgv.some((a) => a.startsWith('--use-system-ca'))) {
  const r = spawnSync(process.execPath, ['--use-system-ca', ...process.argv.slice(1)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

// CA の信頼は OS の証明書ストアで一度だけ登録する（NODE_EXTRA_CA_CERTS はコードに書かない＝第12条）。
// 実測は headless Chrome の ignoreHTTPSErrors と --ignore-certificate-errors で TLS を通す。
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';

/** ブラウザ解決（CHROME_PATH が最優先。Windows の Chrome/Edge と Linux の chrome/chromium を探す） */
function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH を指定してください。');
}
const CHROME = findChrome();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 実行ごとに一意なURL（同一URLの共有は server が 409 で拒否するためクエリで一意化し、最後に掃除する）
const RUN_TAG = Date.now();
const CANONICAL_URL = `https://www.mext.go.jp/b_menu/happou/20261107.html?ui-ntt=${RUN_TAG}`;
const TYPED_URL = CANONICAL_URL.replace(/^https:\/\//, '');   // スキーマ無し入力（https:// 補完の実測）
const UNREACH_URL = `https://titletest${RUN_TAG}.example.test/index.html`;   // 取れない行（DNS が無い）
// このテストが作った共有リンクだけ掃除する（テストの残りを DB に溜めない）
const CLEAN_PREFIX = 'https://www.mext.go.jp/b_menu/happou/20261107.html?ui-ntt=%';
const cleanNewsLinks = async () => (await query('DELETE FROM news_links WHERE lower(url) LIKE ?', [CLEAN_PREFIX])).rowCount;
const linkRow = async (url) => (await query(
  'SELECT url, title, domain, title_source, added_by_name, added_at FROM news_links WHERE lower(url) = lower($1) LIMIT 1',
  [url]
)) .rows[0] || null;
// API の一覧から「このテストが作ったURL」だけを拾う（seed 等、他の共有リンクは後片付けの対象にしない）
const apiLinks = async (tag) => page.evaluate(async (t) => {
  const m = await import('/js/api.js');
  const res = await m.apiGet('/news/links', { limit: 100 });
  return (res.links || []).map((x) => String(x.url || '')).filter((u) => u.includes(t));
}, tag);
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

// プロキシ設定は .env（学校の環境設定）。in-process の fetch も同じ環境で叩く
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

// 前実行の残りを掃除してから走る（共有済みURLの蓄積で 409 にならないため・件数比較の基準もcleanにする）
console.log(`掃除(開始前): 共有リンク ${await cleanNewsLinks()} 件`);
const baselineCount = (await query('SELECT COUNT(*) AS c FROM news_links WHERE is_deleted = 0')).rows[0].c;

const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

// ---- 1-4. 通信環境（Node 26・undici global スコープ・環境変数プロキシ・OSの証明書ストア） ----
// 環境起因（Node の版・学校のネットワーク・CA信頼）はコード起因の FAIL にしない（AGENTS 第5条＝設定・状態の問題は人間に確認する）
const warnings = [];
const checkEnv = (name, ok, detail, reason) => {
  if (ok) {
    check(name, true, detail);
    return true;
  }
  warnings.push(`${name}（${reason}）`);
  console.log(`  要人間確認 - ${name} -> ${JSON.stringify(detail)} (${reason})`);
  return false;
};

const nodeMajor = Number(process.versions.node.split('.')[0]);
const undiciGlobal = {
  Agent: typeof globalThis.Agent,
  Dispatcher: typeof globalThis.Dispatcher,
  ProxyAgent: typeof globalThis.ProxyAgent,
  setGlobalDispatcher: typeof globalThis.setGlobalDispatcher,
};
// Node 26 は undici が global スコープに生える。それ以前の Node では node:undici を module から取る（環境変数プロキシの結線は同じ）
const undiciMod = await import('node:undici').catch(() => null);
const getUndici = (name) => globalThis[name] ?? undiciMod?.[name] ?? null;
const ProxyAgent = getUndici('ProxyAgent');
const Dispatcher = getUndici('Dispatcher');
const setGlobalDispatcher = getUndici('setGlobalDispatcher');
const proxyAgentFromMod = ProxyAgent && process.env.HTTPS_PROXY ? new ProxyAgent(process.env.HTTPS_PROXY) : null;

const envReason = `この実行環境の Node は ${process.versions.node}（Node 26 の環境で実行する）`;
const netReason = 'この実行環境は学校のネットワーク（プロキシ）に届かない。学校で人間が確認する';

checkEnv('Node は v26.x（undici が global スコープに生えるのは Node 26 以降）', nodeMajor >= 26,
  { node: process.versions.node, undiciGlobal }, envReason);
checkEnv('undici が global スコープにある（Agent / Dispatcher / ProxyAgent / setGlobalDispatcher）',
  undiciGlobal.Agent === 'function' && undiciGlobal.Dispatcher === 'function'
  && undiciGlobal.ProxyAgent === 'function' && undiciGlobal.setGlobalDispatcher === 'function',
  undiciGlobal, envReason);
checkEnv('ProxyAgent が Dispatcher を継承し、setGlobalDispatcher が関数である',
  !!proxyAgentFromMod && !!Dispatcher && proxyAgentFromMod instanceof Dispatcher
  && typeof setGlobalDispatcher === 'function',
  { mod: !!undiciMod, global: undiciGlobal,
    inherits: !!proxyAgentFromMod && !!Dispatcher ? proxyAgentFromMod instanceof Dispatcher : false }, envReason);
checkEnv('内蔵 https の globalAgent に ProxyAgent が付いている（環境変数プロキシが global Agent へ結線される）',
  https.globalAgent.constructor.name === 'ProxyAgent', { agent: https.globalAgent.constructor.name },
  '学校の環境で NODE_USE_ENV_PROXY=1 ＋ Node の global Agent 結線を人間が確認する');

const env = titleFetchEnvStatus();
const envFileText = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
check('.env に学校プロキシ（proxy2.hyogo-c.ed.jp:8080）が書かれている',
  /HTTPS_PROXY=http:\/\/proxy2\.hyogo-c\.ed\.jp:8080/.test(envFileText)
  && /HTTP_PROXY=http:\/\/proxy2\.hyogo-c\.ed\.jp:8080/.test(envFileText),
  { proxy: env.proxy });
check('NODE_USE_ENV_PROXY=1（環境変数プロキシを Node が使う）', env.envProxyOn, { envProxyOn: env.envProxyOn });
check('node --use-system-ca が付いている（プロキシ経由TLSを学校のCAで検証する）', env.systemCa, { systemCa: env.systemCa });
check('プロキシ・環境変数・フラグが揃ってタイトル取得の準備OK', env.ready, env);

// ---- 5,6. 実ページをプロキシ経由で fetch してタイトルが取れる（User-Agent は ASCII） ----
const canonicalHtml = await fetchHtmlGuarded(CANONICAL_URL).catch((e) => ({ error: `${e.name}: ${e.message}` }));
const fetchedTitle = canonicalHtml && typeof canonicalHtml === 'string' ? extractPageTitle(canonicalHtml) : null;
const netBlocked = typeof canonicalHtml !== 'string';
checkEnv('mext.go.jp の実ページが fetch できる（HTML 1000文字以上）',
  typeof canonicalHtml === 'string' && canonicalHtml.length >= 1000,
  typeof canonicalHtml === 'string' ? { len: canonicalHtml.length } : canonicalHtml, netReason);
checkEnv('ページタイトルが取れる（<title> → <h1> → og:title の順）',
  !!fetchedTitle && fetchedTitle.title.length >= 6, fetchedTitle, netReason);
checkEnv('タイトル出所が記録される（title / h1 / og のいずれか）',
  Object.values(TITLE_SOURCES).includes(fetchedTitle?.titleSource) && fetchedTitle?.titleSource !== 'domain',
  fetchedTitle, netReason);
checkEnv('タイトルはドメイン名でなく、ドメイン名を含まない',
  !!fetchedTitle && !fetchedTitle.title.includes('mext.go.jp'), fetchedTitle, netReason);
const longTitleCut = fitTitle('あ'.repeat(200));
check('タイトルは120文字以内（TITLE_MAX_CHARS。長いタイトルは fitTitle が120文字へ切る＝コード起因）',
  TITLE_MAX_CHARS === 120 && longTitleCut.length === TITLE_MAX_CHARS
  && (!fetchedTitle || fetchedTitle.title.length <= TITLE_MAX_CHARS),
  { max: TITLE_MAX_CHARS, longLen: longTitleCut.length, fetchedLen: fetchedTitle?.title.length ?? null });
const asciiUaOk = assertByteStringHeaders({ 'user-agent': TITLE_USER_AGENT })['user-agent'] === TITLE_USER_AGENT;
let jpUaRejected = false;
try {
  assertByteStringHeaders({ 'user-agent': 'ピノックアップ教育ニュース/1.0' });
} catch (e) {
  jpUaRejected = e instanceof TypeError;
}
check('User-Agent は ASCII のみ（日本語 UA は送信前に TypeError になる）',
  asciiUaOk && jpUaRejected, { ua: TITLE_USER_AGENT, jpUaRejected });

// ---- 7-9. 「記事を共有」で url 1項目だけ POST → サーバー実データにタイトルが登録される ----
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

// 共有 POST とレスポンスを記録する（チャット POST は「出ないこと」を確認するため捕まえる）
const posts = [];
const postResponses = [];
page.on('request', (req) => {
  const url = req.url();
  if (req.method() !== 'POST') return;
  if (/\/api\/news\/links$/.test(url) || /\/api\/chat\/channels\/[^/]+\/messages$/.test(url)) {
    let body = null;
    try { body = JSON.parse(req.postData() || '{}'); } catch (e) { body = null; }
    posts.push({ endpoint: url.replace(BASE, ''), body });
  }
});
page.on('response', async (res) => {
  if (/\/api\/news\/links$/.test(res.url())) {
    try { postResponses.push(await res.json()); } catch (e) { /* JSON でない応答は数えない */ }
  }
});

const openShare = async () => {
  await page.evaluate(() => document.querySelector('.app-sidebar .nav-item[data-tab="dashboard"]').click());
  await sleep(400);
  await page.click('#dash-btn-news-share');
  await sleep(500);
};

await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

// 共有モーダルを開いて、スキーマ無しURLを入力し、共有する
await openShare();
const opened = await page.evaluate(() => ({
  open: !document.getElementById('news-share-modal').classList.contains('hidden'),
  inputIds: [...document.querySelectorAll('#news-share-form input, #news-share-form select, #news-share-form textarea')].map((e) => e.id),
  focusedId: document.activeElement?.id,
}));
check('共有モーダルが開き、入力欄は記事URLだけ（URL欄へフォーカス）',
  opened.open && opened.inputIds.length === 1 && opened.inputIds[0] === 'news-share-url'
  && opened.focusedId === 'news-share-url', opened);

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
}), 14000);

const newsPost = posts.find((p) => p.endpoint === '/api/news/links');
const chatPost = posts.find((p) => p.endpoint.includes('/chat/channels/'));
check('URLスキーマ無しは https:// へ補完され、送信は url 1項目だけ',
  newsPost?.body?.url === CANONICAL_URL && Object.keys(newsPost?.body || {}).length === 1, newsPost?.body);
check('共有の行き先は /api/news/links（職員チャットへの投稿は発生しない）、成功トースト・ダッシュボードに残る',
  !!newsPost && !chatPost && newsPost.endpoint === '/api/news/links'
  && !!afterShare && afterShare.toasts.some((t) => t.includes('教育ニュースへ') && t.includes('共有しました'))
  && afterShare.activeView === 'view-dashboard',
  { newsPost: newsPost?.endpoint, chatPost: chatPost?.endpoint, activeView: afterShare?.activeView, toasts: afterShare?.toasts });

// サーバー実データ（news_links）の行を待つ（server のタイトル取得完了込み）
const sharedRow = await waitFor(async () => linkRow(CANONICAL_URL), 14000);
check('サーバー実データ: 共有URLが news_links に登録される（title_source が記録される）',
  !!sharedRow && Object.values(TITLE_SOURCES).includes(sharedRow.title_source),
  sharedRow && { title: sharedRow.title, source: sharedRow.title_source });
check('サーバー実データ: ページタイトルが取れた行はタイトルがドメイン名でない（取れない行はドメイン名）',
  !!sharedRow && (sharedRow.title_source === 'domain'
    ? sharedRow.title === sharedRow.domain
    : sharedRow.title !== sharedRow.domain && !sharedRow.title.includes(sharedRow.domain)),
  sharedRow && { title: sharedRow.title, domain: sharedRow.domain, source: sharedRow.title_source });
check('API のタイトルはサーバー実データと一致する（POST の応答と行のタイトルが同じ）',
  !!sharedRow && postResponses.some((r) => String(r?.link?.title || '') === sharedRow.title
    && String(r?.link?.url || '') === sharedRow.url),
  { rowTitle: sharedRow?.title, api: postResponses.map((r) => ({ title: r?.link?.title ?? null, url: r?.link?.url ?? null })) });

// カードのリンク文字・寸法・一覧の列設計をpx実測する（共有直後のカードを捕まえる）
const cardData = await waitFor(() => page.evaluate((u) => {
  const card = [...document.querySelectorAll('#dash-news-summary > div.news-link-card')]
    .find((c) => c.querySelector('a.news-link-card__title')?.href === u);
  if (!card) return null;
  const link = card.querySelector('a.news-link-card__title');
  const date = card.querySelector('.news-link-card__date');
  const csCard = getComputedStyle(card);
  const csLink = getComputedStyle(link);
  const csDate = getComputedStyle(date);
  const cardRect = card.getBoundingClientRect();
  const linkRect = link.getBoundingClientRect();
  const dateRect = date.getBoundingClientRect();
  const container = document.getElementById('dash-news-summary');
  const ccs = getComputedStyle(container);
  const bl = document.getElementById('dash-pinned-bulletins');
  const bcs = bl ? getComputedStyle(bl) : null;
  const marker = document.querySelector('.dash-news-unread-marker');
  return {
    linkText: link.textContent,
    linkTitleAttr: link.getAttribute('title'),
    href: link.href,
    target: link.target,
    rel: link.rel,
    linkFont: csLink.fontSize,
    linkWeight: parseFloat(csLink.fontWeight),
    linkH: Math.round(linkRect.height),
    linkW: Math.round(linkRect.width),
    linkScrollW: link.scrollWidth,
    nowrap: csLink.whiteSpace,
    overflowX: csLink.overflowX,
    ellipsis: csLink.textOverflow,
    underline: csLink.textDecorationLine,
    linkOutline: csLink.outlineStyle,
    cardH: Math.round(cardRect.height),
    cardBorderW: parseFloat(csCard.borderTopWidth),
    cardBorderS: csCard.borderTopStyle,
    dateFont: csDate.fontSize,
    dateText: date.textContent,
    dateRightGap: Math.round(cardRect.right - dateRect.right),
    badge: !!card.querySelector('.badge'),
    shareName: card.textContent.includes('共有:'),
    containerDisplay: ccs.display,
    containerDir: ccs.flexDirection,
    containerGap: ccs.gap,
    containerGapPx: parseFloat(ccs.gap),
    blGap: bcs ? bcs.gap : null,
    cardWidths: [...container.querySelectorAll('div.news-link-card')].map((c) => Math.round(c.getBoundingClientRect().width)),
    markerFont: marker ? getComputedStyle(marker).fontSize : null,
    markerPx: marker ? parseFloat(getComputedStyle(marker).fontSize) : null,
  };
}, CANONICAL_URL), 12000);

check('UI のリンク文字はサーバー実データのタイトルと一致する',
  !!cardData && cardData.linkText === sharedRow?.title, { ui: cardData?.linkText, db: sharedRow?.title });
check('ドメイン名はリンク文字に出ない（タイトルがページタイトルなら「mext.go.jp」を含まない）',
  !!cardData && (sharedRow?.title_source === 'domain'
    ? cardData.linkText === sharedRow.domain
    : !cardData.linkText.includes('mext.go.jp')), { linkText: cardData?.linkText, source: sharedRow?.title_source });

check('リンク a は17.5pxの太字（本日の連絡の掲示見出しと同一寸法）',
  !!cardData && cardData.linkFont === '17.5px' && cardData.linkWeight >= 700,
  { font: cardData?.linkFont, weight: cardData?.linkWeight });
check('リンク高24px・カード高42px以下（1行表示・px実測）',
  !!cardData && cardData.linkH === 24 && cardData.cardH <= 42,
  { linkH: cardData?.linkH, cardH: cardData?.cardH });
check('長いタイトルは1行で … に切り詰められる（nowrap / overflow:hidden / text-overflow:ellipsis）',
  !!cardData && cardData.nowrap === 'nowrap' && cardData.overflowX === 'hidden'
  && cardData.ellipsis === 'ellipsis' && cardData.linkScrollW >= cardData.linkW, cardData);
check('ホバーで全文が出る（title属性＝リンクの全文・リンクの文字も全文）',
  !!cardData && cardData.linkTitleAttr === cardData.linkText, cardData?.linkTitleAttr);
check('右端に小さな日付（10px・カード右端の余白12px以下・M/D形）、共有者名とドメインバッチは出ない',
  !!cardData && cardData.dateFont === '10px' && cardData.dateRightGap <= 12
  && /^\d{1,2}\/\d{1,2}$/.test(cardData.dateText) && !cardData.shareName && !cardData.badge, cardData);
check('リンクは下線・二重リングを持たず新タブで開く（target=_blank・rel=noopener）、カード枠は2px実線',
  !!cardData && cardData.underline === 'none' && cardData.linkOutline === 'none'
  && cardData.href === CANONICAL_URL && cardData.target === '_blank' && cardData.rel.includes('noopener')
  && cardData.cardBorderW === 2 && cardData.cardBorderS === 'solid', cardData);
check('一覧は1列（flex column・カード幅は全カード同一＝2列にならない・幅300px以上）',
  !!cardData && cardData.containerDisplay === 'flex' && cardData.containerDir === 'column'
  && cardData.cardWidths.length >= 1 && new Set(cardData.cardWidths).size === 1 && cardData.cardWidths[0] >= 300,
  { display: cardData?.containerDisplay, dir: cardData?.containerDir, widths: cardData?.cardWidths });
check('一覧の gap は本日の連絡と同一（13.125px＝0.75rem）',
  !!cardData && cardData.containerGap === cardData.blGap && cardData.containerGapPx === 13.125,
  { newsGap: cardData?.containerGap, bulletinsGap: cardData?.blGap, px: cardData?.containerGapPx });

// カード本体だけホバーリングを描く（中のリンクは二重リングを出さない＝UI十条5）
const newsCardEl = await page.evaluateHandle((u) => [...document.querySelectorAll('#dash-news-summary > div.news-link-card')]
  .find((c) => c.querySelector('a.news-link-card__title')?.href === u), CANONICAL_URL);
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

check('未読マーカは14px（タイトル 17.5px ＞ マーカ 14px の寸法関係をpx実測）',
  !!cardData && cardData.markerFont === '14px' && cardData.markerPx === 14 && cardData.linkWeight >= 700,
  { markerFont: cardData?.markerFont, titleFont: cardData?.linkFont });

// ---- cron 再取得（ドメイン名の行だけを見て、取れた行の title / title_source を更新する） ----
const seededUser = (await query("SELECT id, name FROM users WHERE staff_code = 'T2026001' LIMIT 1")).rows[0];
const createdRows = [];
const createDomainRow = async (url, domainTitle, source = 'domain') => {
  const item = await newsLinkModel.createNewsLink({
    url, title: domainTitle, domain: new URL(url).hostname, titleSource: source,
    addedBy: seededUser.id, addedByName: seededUser.name,
  });
  createdRows.push(item.id);
  return item;
};
const DOMAIN_TITLE_URL = `https://www.mext.go.jp/b_menu/happou/20261107.html?ui-ntt=${RUN_TAG}-domain`;
const domainRow = await createDomainRow(DOMAIN_TITLE_URL, 'www.mext.go.jp');
const deadRow = await createDomainRow(UNREACH_URL, `titletest${RUN_TAG}.example.test`);
// title_source が domain でない行（再取得の対象にならない行）を作る
const doneRow = await createDomainRow(
  `https://www.mext.go.jp/b_menu/happou/20261107.html?ui-ntt=${RUN_TAG}-done`,
  '共有時にタイトルが取れた行のタイトル', 'title'
);
const DONE_URL = doneRow.url;
const PRE_CREATED_ROWS = createdRows.length;

const preRefreshSnapshot = await query(
  'SELECT url, title, title_source, added_by_name, added_at FROM news_links WHERE id = ANY($1::text[]) ORDER BY url',
  [createdRows]
);
const refresh = await newsService.refreshSharedLinkTitles({ limit: 60 });

check('cron 再取得はドメイン名の行だけを見る（作った3行すべてが対象に入る）',
  refresh.checked >= createdRows.length, { checked: refresh.checked, created: createdRows.length });
checkEnv('cron 再取得は取れた行の title / title_source を更新する（更新1件以上）',
  refresh.updated >= 1, refresh, netReason);

const domainAfter = await linkRow(DOMAIN_TITLE_URL);
checkEnv('取れた行のタイトルはページタイトルと一致し、出所は title / h1 / og のいずれかになる',
  !!domainAfter && domainAfter.title === fetchedTitle?.title
  && ['title', 'h1', 'og'].includes(domainAfter.title_source),
  { dbTitle: domainAfter?.title, source: domainAfter?.title_source, fetched: fetchedTitle?.title }, netReason);

const deadAfter = await linkRow(UNREACH_URL);
check('取れない行はドメイン名のまま（title と title_source が変わらない）',
  !!deadAfter && deadAfter.title === `titletest${RUN_TAG}.example.test` && deadAfter.title_source === 'domain',
  { title: deadAfter?.title, source: deadAfter?.title_source });

const doneAfter = await linkRow(DONE_URL);
check('title_source が domain でない行は再取得の対象にならない（タイトルと出所はそのままで対象外）',
  !!doneAfter && doneAfter.title === '共有時にタイトルが取れた行のタイトル' && doneAfter.title_source === 'title',
  { title: doneAfter?.title, source: doneAfter?.title_source });

const postRefreshSnapshot = await query(
  'SELECT url, title, title_source, added_by_name, added_at FROM news_links WHERE id = ANY($1::text[]) ORDER BY url',
  [createdRows]
);
const rowKeys = (rows) => rows.rows.map((r) => `${r.url}|${r.added_by_name}|${r.added_at}`);
check('再取得後も URL・共有者・追加日は変わらない（title と出所だけが変わる）',
  rowKeys(preRefreshSnapshot).join('\n') === rowKeys(postRefreshSnapshot).join('\n'),
  { pre: rowKeys(preRefreshSnapshot), post: rowKeys(postRefreshSnapshot) });

// 再取得後のタイトルを UI が表示する（ダッシュボードを再読み込みしてカードを測る）
await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);
const refreshedCard = await waitFor(() => page.evaluate((u) => {
  const card = [...document.querySelectorAll('#dash-news-summary > div.news-link-card')]
    .find((c) => c.querySelector('a.news-link-card__title')?.href === u);
  if (!card) return null;
  const link = card.querySelector('a.news-link-card__title');
  const cs = getComputedStyle(link);
  return { text: link.textContent, font: cs.fontSize, weight: parseFloat(cs.fontWeight), titleAttr: link.getAttribute('title') };
}, CANONICAL_URL), 12000);
checkEnv('cron 再取得後は UI がページのタイトルを表示する（リンク文字＝実データ・17.5px・ドメイン名でない）',
  !!refreshedCard && refreshedCard.text === domainAfter?.title && refreshedCard.font === '17.5px'
  && refreshedCard.weight >= 700 && !refreshedCard.text.includes('mext.go.jp')
  && refreshedCard.titleAttr === domainAfter?.title, refreshedCard, netReason);

// ---- 後片付け（このテストが作った行を全部消す・API・UI に出ない・件数は実行前と同じ） ----
const cleanedDead = (await query('DELETE FROM news_links WHERE url = $1', [UNREACH_URL])).rowCount;
const cleaned = await cleanNewsLinks();
const leftUrls = await apiLinks(String(RUN_TAG));
const leftRows = (await query('SELECT COUNT(*) AS c FROM news_links WHERE id = ANY($1::text[])', [createdRows])).rows[0].c;
const afterCount = (await query('SELECT COUNT(*) AS c FROM news_links WHERE is_deleted = 0')).rows[0].c;

check('後片付け: このテストが作った共有リンクはサーバーから消える（掃除後の DB に残り0）',
  cleaned >= PRE_CREATED_ROWS - 1 && cleanedDead === 1 && Number(leftRows) === 0,
  { cleaned, cleanedDead, leftRows, created: createdRows.length });
check('掃除後は API に出ない（news/links にテストのURLが1件も残らない）',
  leftUrls.length === 0, { left: leftUrls.length, urls: leftUrls.slice(0, 3) });

await page.reload({ waitUntil: 'networkidle2' });
await sleep(1200);
const uiLeft = await page.evaluate((prefix) => {
  return [...document.querySelectorAll('#dash-news-summary > div.news-link-card a.news-link-card__title')]
    .map((a) => a.href).filter((h) => h.includes(prefix));
}, String(RUN_TAG));
check('掃除後は UI にも出ない（ダッシュボードのカードにテストのリンクが残り0）',
  uiLeft.length === 0, uiLeft);
check('実行前後で news_links の件数は同じ（テストの残りを DB に溜めない）',
  Number(afterCount) === Number(baselineCount), { before: baselineCount, after: afterCount });
check('ページの JS エラーは0（テスト中の pageerror が無い）',
  pageErrors.length === 0, pageErrors);

await browser.close();
await closeDatabase();
console.log('---');
if (warnings.length) {
  console.log(`要人間確認 (${warnings.length}): ${warnings.join(' / ')}`);
}
if (failures.length) {
  console.log(`FAILED (${failures.length}): ${failures.join(', ')}`);
  process.exit(1);
}
console.log('ALL OK');
process.exit(0);





