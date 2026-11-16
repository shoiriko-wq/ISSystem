/**
 * ピノックアップ教育ニュースのページタイトル取得ルール検証（v3.1.16・2026-11-16）
 *  サーバーがURLをfetchして <title> → <h1> → og:title を取り、取れないときだけドメイン名にする規則と、
 *  ドメイン名のままの行を cron が毎時再取得して title / title_source を更新する規則、
 *  学校の環境で外部ページへ到達するための通信環境（学校プロキシ＋node --use-system-ca）の揃い方を検証する。
 *
 *  fetch はモック（ネットワークを叩かない）。DB は共有（seed の T2026001 を使い、作った行は最後に掃除する）。
 *  実行: npm run test:one -- test/news-title.test.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../config/database.js';
import newsLinkModel from '../src/models/news-link.model.js';
import { newsService, extractPageTitle, pickTitleTag, pickH1Tag, pickOgTitleTag,
  dropSiteName, fitTitle, normalizeLinkUrl, titleFetchEnvStatus, TITLE_MAX_CHARS } from '../src/services/news.service.js';
import { closePool, seededUser } from './helpers.js';

const RUN_TAG = Date.now().toString(36);
const TEST_URL_PREFIX = `https://titletest${RUN_TAG}.example.test/`;
const cleanTestLinks = async () => (await query(
  'DELETE FROM news_links WHERE lower(url) LIKE ?', [`https://titletest${RUN_TAG}.example.test/%`]
)).rowCount;

/** フェイクレスポンス（res.body は無い → readBoundedHtml は res.text() へ落ちる） */
const fakeRes = (html, status = 200, contentType = 'text/html; charset=UTF-8') => ({
  status,
  ok: status >= 200 && status < 300,
  headers: { get: (name) => (String(name).toLowerCase() === 'content-type' ? contentType : null) },
  text: async () => html,
});


const realFetch = global.fetch;

/** seed の教務主任の users.id（news_links.added_by は users(id) を参照する） */
const seedUserId = async () => {
  const res = await query(`SELECT id FROM users WHERE staff_code = ?`, [seededUser.staff_code]);
  return res.rows[0]?.id ?? null;
};

describe('ページタイトル抽出規則（<title> → <h1> → og:title）', () => {
  test('<title> が最優先（h1 と og より上）。実体参照は元へ戻す', () => {
    const html = `<html><head><title>中間考査の問題提出＆登録 &amp; 通知</title>
      <meta property="og:title" content="副次タイトル｜サイト名"></head>
      <body><h1>本文見出し</h1></body></html>`;
    expect(extractPageTitle(html)).toEqual({ title: '中間考査の問題提出＆登録 & 通知', titleSource: 'title' });
    expect(pickTitleTag(html)).toBe('中間考査の問題提出＆登録 & 通知');
  });

  test('<title> が無いページは <h1>（子タグ・バッチは文字だけ残す）', () => {
    const html = '<html><body><h1 class="t"><span>学校運営</span><br>業務の自動化の手引き</h1></body></html>';
    expect(extractPageTitle(html)).toEqual({ title: '学校運営 業務の自動化の手引き', titleSource: 'h1' });
    expect(pickH1Tag(html)).toBe('学校運営 業務の自動化の手引き');
  });

  test('<title> も <h1> も無いページは og:title（サイト名接尾を除く）', () => {
    const html = '<html><head><meta name="og:title" content="ICT機器の活用事例（公開授業）｜西宮市"><title>サイト名</title></head><body></body></html>';
    expect(extractPageTitle(html)).toEqual({ title: 'ICT機器の活用事例（公開授業）', titleSource: 'og' });
    expect(dropSiteName(pickOgTitleTag(html))).toBe('ICT機器の活用事例（公開授業）');
  });

  test('タイトルが短い（サイト名だけの語）は使わない → null（画面はドメイン名のまま）', () => {
    const html = '<html><head><title>文部科学省</title></head><body></body></html>';
    expect(extractPageTitle(html)).toBeNull();
    expect(fitTitle('文部科学省')).toBeNull();
    expect(fitTitle('ICT機器の活用事例')).not.toBeNull();
  });

  test('長すぎるタイトルは 120文字で切る（DBはこの長さまで保存）', () => {
    const long = 'あ'.repeat(200);
    expect(fitTitle(long).length).toBe(TITLE_MAX_CHARS);
    expect(extractPageTitle(`<html><head><title>${long}</title></head></html>`).title.length).toBe(TITLE_MAX_CHARS);
  });

  test('共有URL正規化: スキーマ無しは https:// 補完・内部アドレスとドット無しは拒否', () => {
    expect(normalizeLinkUrl('mext.go.jp/b_menu/')).toBe('https://mext.go.jp/b_menu/');
    expect(normalizeLinkUrl('http://news.yahoo.co.jp/')).toBe('http://news.yahoo.co.jp/');
    expect(normalizeLinkUrl('localhost:3443/x')).toBeNull();
    expect(normalizeLinkUrl('127.0.0.1/x')).toBeNull();
    expect(normalizeLinkUrl('foo/x')).toBeNull();
    expect(normalizeLinkUrl('')).toBeNull();
  });
});

describe('タイトル取得の通信環境（学校プロキシ＋OSの証明書）', () => {
  const saved = {
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    HTTP_PROXY: process.env.HTTP_PROXY,
    NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY,
  };

  afterEach(() => {
    process.env.HTTPS_PROXY = saved.HTTPS_PROXY;
    process.env.HTTP_PROXY = saved.HTTP_PROXY;
    process.env.NODE_USE_ENV_PROXY = saved.NODE_USE_ENV_PROXY;
  });

  const withExecArgv = (argv, fn) => {
    const original = process.execArgv;
    Object.defineProperty(process, 'execArgv', { value: argv, configurable: true });
    try { return fn(); } finally {
      Object.defineProperty(process, 'execArgv', { value: original, configurable: true });
    }
  };

  test('プロキシ設定と NODE_USE_ENV_PROXY=1 と --use-system-ca が揃って ready', () => {
    process.env.HTTPS_PROXY = 'http://proxy2.hyogo-c.ed.jp:8080';
    process.env.NODE_USE_ENV_PROXY = '1';
    const env = withExecArgv(['--use-system-ca'], titleFetchEnvStatus);
    expect(env.proxy).toBe('http://proxy2.hyogo-c.ed.jp:8080');
    expect(env.envProxyOn).toBe(true);
    expect(env.systemCa).toBe(true);
    expect(env.ready).toBe(true);
  });

  test('プロキシ・NODE_USE_ENV_PROXY・起動フラグが欠けたら ready=false（ドメイン名になった理由がログに出る）', () => {
    process.env.HTTPS_PROXY = undefined;
    process.env.HTTP_PROXY = undefined;
    process.env.NODE_USE_ENV_PROXY = undefined;
    expect(withExecArgv([], titleFetchEnvStatus).ready).toBe(false);

    process.env.HTTPS_PROXY = 'http://proxy2.hyogo-c.ed.jp:8080';
    const partial = withExecArgv([], titleFetchEnvStatus);
    expect(partial.proxy).toBe('http://proxy2.hyogo-c.ed.jp:8080');
    expect(partial.envProxyOn).toBe(false);
    expect(partial.systemCa).toBe(false);
    expect(partial.ready).toBe(false);

    process.env.NODE_USE_ENV_PROXY = '1';
    expect(withExecArgv([], titleFetchEnvStatus).systemCa).toBe(false);
    expect(withExecArgv(['--use-system-ca'], titleFetchEnvStatus).ready).toBe(true);
  });

  test('学校の環境設定は .env と起動コマンドに揃っている（プロキシ＋--use-system-ca）', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const envText = fs.readFileSync(path.join(root, '.env'), 'utf8');
    expect(envText).toMatch(/^NODE_USE_ENV_PROXY=1$/m);
    expect(envText).toMatch(/^HTTPS_PROXY=http:\/\/[^\s:]+:\d+$/m);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.scripts.start).toContain('--use-system-ca');
    expect(pkg.scripts.start).toContain('--env-file=.env');
  });
});

describe('ドメイン名のままの共有リンクのタイトル再取得（cron 毎時）', () => {
  const titles = {
    // <title> が取れる（サイト名接尾付きの実ページを模する）
    'ok-title.html': fakeRes('<html><head><title>学びの支援に関する国際調査の結果報告｜国立教育政策研究所</title></head><body></body></html>'),
    // <title> が無く <h1> が取れる
    'ok-h1.html': fakeRes('<html><body><h1>ICT機器の活用事例（公開授業）</h1></body></html>'),
    // ページが開けない（404）→ ドメイン名維持
    'broken.html': fakeRes('<html>not found</html>', 404, 'text/html'),
    // fetch が throw（タイムアウト）→ ドメイン名維持
    'timeout.html': null,
  };

  let fetchCalls = [];
  const mockFetch = () => {
    fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(String(url));
      const key = String(url).split('/').pop();
      if (key === 'timeout.html') throw new TypeError('fetch failed');
      return titles[key] ?? fakeRes('<html><body>nothing</body></html>');
    };
  };

  test('title_source=domain の行だけを見て、取れた行は title と出所を更新し、取れない行はドメイン名のまま', async () => {
    mockFetch();

    // 共有DBの既存行（seedのドメイン名3件など）も対象に入ることを織り込んで測る
    const preCount = (await newsLinkModel.listNewsLinksWithDomainTitle({ limit: 100 })).length;

    for (const key of Object.keys(titles)) {
      await newsLinkModel.createNewsLink({
        url: `${TEST_URL_PREFIX}${key}`,
        title: `titletest${RUN_TAG}.example.test`,
        domain: `titletest${RUN_TAG}.example.test`,
        titleSource: 'domain',
        addedBy: await seedUserId(),
        addedByName: '教務主任',
      });
    }

    const result = await newsService.refreshSharedLinkTitles({ limit: 100 });
    expect(result.checked).toBe(preCount + 4);
    expect(result.updated).toBe(2);
    expect(result.failed).toBe(preCount + 2);

    const rows = await query(
      `SELECT url, title, title_source, domain, added_by_name FROM news_links WHERE lower(url) LIKE ? ORDER BY url`,
      [`https://titletest${RUN_TAG}.example.test/%`]
    );
    const byFile = Object.fromEntries(rows.rows.map((r) => [String(r.url).split('/').pop(), r]));

    expect(byFile['ok-title.html'].title).toBe('学びの支援に関する国際調査の結果報告｜国立教育政策研究所');
    expect(byFile['ok-title.html'].title_source).toBe('title');
    expect(byFile['ok-h1.html'].title).toBe('ICT機器の活用事例（公開授業）');
    expect(byFile['ok-h1.html'].title_source).toBe('h1');
    // 取れなかった行はタイトルも出所もそのまま（URL・共有者・追加日は変わらない）
    expect(byFile['broken.html'].title).toBe(`titletest${RUN_TAG}.example.test`);
    expect(byFile['broken.html'].title_source).toBe('domain');
    expect(byFile['timeout.html'].title_source).toBe('domain');
    expect(rows.rowCount).toBe(4);

    // 次回の対象は更新済み行を含まない（title_source=domain の行だけ）
    const targets = await newsLinkModel.listNewsLinksWithDomainTitle({ limit: 100 });
    const mine = targets
      .filter((t) => String(t.url).startsWith(`https://titletest${RUN_TAG}.example.test/`))
      .map((t) => String(t.url).split('/').pop())
      .sort();
    expect(mine).toEqual(['broken.html', 'timeout.html']);

    global.fetch = realFetch;
    expect(await cleanTestLinks()).toBe(4);
    const rest = await query(
      'SELECT COUNT(*) AS n FROM news_links WHERE lower(url) LIKE ?',
      [`https://titletest${RUN_TAG}.example.test/%`]
    );
    expect(rest.rows[0].n).toBe('0');
  });

  test('対象行の件数だけ fetch を叩く（毎時の再取得は空振りでも安全・更新+失敗=対象件数）', async () => {
    mockFetch();
    const before = await newsLinkModel.listNewsLinksWithDomainTitle({ limit: 5 });
    const result = await newsService.refreshSharedLinkTitles({ limit: 5 });
    expect(fetchCalls.length).toBe(before.length);
    expect(result.checked).toBe(before.length);
    expect(result.updated + result.failed).toBe(result.checked);
    global.fetch = realFetch;
  });

  test('後片付け: このテストが作った共有リンクは DB に残らない', async () => {
    const rest = await query(
      'SELECT COUNT(*) AS n FROM news_links WHERE lower(url) LIKE ?',
      [`https://titletest${RUN_TAG}.example.test/%`]
    );
    expect(rest.rows[0].n).toBe('0');
    await closePool();
  });
});



