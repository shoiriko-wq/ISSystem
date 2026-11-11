/**
 * 実装とドキュメントの矛盾を検出する検証ゲート（AGENTS.md 第12条）
 * 実行: node scripts/verify-docs.mjs  （順序の最后。server が起動済みで health を実測する）
 *
 * 検査項目:
 *  1. README に番号付き契約項目（UI十条＋禁则）があり、機能制約の意味が揃う
 *     （AGENTS.md との文言一致は検査しない — AGENTS.md は README を参照する）
 *  2. AGENTS.md は README を参照し、検証階層・Jest直列・共有DB衝突・CA・Git衛生を書く
 *  3. package.json: pretest（init-db + seed）, npm test と test:one の --runInBand（直列）,
 *     api:check, db:drop-general-chat, npm script に NODE_EXTRA_CA_CERTS を埋め込まない,
 *     puppeteer を使う scripts/test-*.mjs が test:ui:all に漏れなく含まれる
 *  4. サイドバーの現実（収納67.25px・せり出し16.3rem・main の余白常時確保・is-focus）が
 *     CSS・JS・README で一致する（AGENTS.md は寸法を書かない）
 *  5. API スモークが src/routes/index.js の全トップレベルAPIセグメントを叩く + health 実測
 *  6. 仕様書に必須節（既知の課題・意図された非実装・改訂履歴・検証の実行順序）がある
 *  7. general チャット参照の完全除去（migrate*.js の注释は許す）
 *  8. CHANGELOG がある + 検証用一時成果物を Git が追跡していない
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Git の追跡状態を読む（失敗時は空文字 = 検査対象外）
const execGit = (args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
};

// 文字コード自動認識: UTF-8 で失敗すれば Shift-JIS で読む（README・AGENTS.md・仕様書は Windows 日本語）
const sjis = new TextDecoder('shift_jis');
const read = (p) => {
  const buf = fs.readFileSync(path.join(ROOT, p));
  const utf8 = new TextDecoder('utf-8', { fatal: true });
  try {
    return utf8.decode(buf);
  } catch {
    return sjis.decode(buf);
  }
};

const results = [];
const record = (name, pass, detail = '') => results.push({ name, pass, detail });

// --- 1. README: UI十条の存在（正典）と機能制約の意味 ---
// 文書の文言一致（AGENTS.md との書き写し）は検査しない。AGENTS.md は README を参照する。
const readme = read('README.md');
const uiTenSection = readme.split(/\r?\n/).filter((l) => /^\d+\.\s/.test(l.trim()));
record('README に番号付き契約項目が10以上（UI十条＋禁则）', uiTenSection.length >= 10, `項目数=${uiTenSection.length}`);

// README が正典として守る意味（機能制約）: 文書の文言一致ではなく、実在する約束を検査する
const prohibitions = [
  ['テストの削除・スキップ禁止', /テストの削除.*禁止/],
  ['UIテストは px 実測', /px で実測/],
  ['CA環境変数を npm script に埋め込まない', /NODE_EXTRA_CA_CERTS.*埋め込まない/],
  ['DB破壊禁止（テスト失敗時にテーブル・レコードを消すな）', /レコードを消せ.*禁止|DB破壊/],
  ['general チャットは全廃（テスト・fixture にも残さない）', /general は全廃/],
  ['チャットは発言者以外が読み書き（server 側で members 検証）', /発言者以外/],
  ['メールはメールボックスのみ', /メールボックス/],
  ['追加の権限なし（教務と校長のみ）', /追加の権限.*禁止/],
  ['検証の階層（開発中は該当スイート・コミット前は全ゲート）', /検証の階層/],
  ['サーバーを再起動しないで UI テストを走らせない', /サーバーを再起動/],
];
prohibitions.forEach(([n, re]) => record(`README 禁则: ${n}`, re.test(readme)));

// --- 2. AGENTS.md: README を参照し、検証階層の要点を書く ---
const agents = read('AGENTS.md');
record('AGENTS.md は UI十条の正典を README に置いている', /README.*UI十条|UI十条.*README/.test(agents));
record('AGENTS.md に検証階層（開発中・全ゲート）', /開発中/.test(agents) && /全ゲート/.test(agents));
record('AGENTS.md に Jest 直列（--runInBand）と共有DB衝突の警告', /--runInBand/.test(agents) && /衝突/.test(agents));
record('AGENTS.md に CA を npm script に埋め込まない', /NODE_EXTRA_CA_CERTS.*埋め込まない/.test(agents));
record('AGENTS.md に検証用一時成果物をコミットしない', /\.gitignore/.test(agents));

// --- 3. package.json ---
const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts || {};
const joined = Object.values(scripts).join(' && ');
record('pretest が init-db + seed を実行', /init-db/.test(scripts.pretest || '') && /seed/.test(scripts.pretest || ''));
record('npm test は --runInBand（Jest を1プロセス直列）', /--runInBand/.test(scripts.test || ''));
record('api:check（api-smoke-test.js）', /api-smoke-test/.test(scripts['api:check'] || ''));
record('db:drop-general-chat（第11条）', /drop-general/.test(scripts['db:drop-general-chat'] || ''));
record('test:one（開発中の単スイート・--runInBand）', /--runInBand/.test(scripts['test:one'] || ''));
record('npm script に NODE_EXTRA_CA_CERTS を埋め込まない', !/NODE_EXTRA_CA_CERTS/.test(joined));

// puppeteer を使う scripts/test-*.mjs が test:ui:all に漏れなく含まれる
const uiFiles = fs
  .readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => /^test-.*\.mjs$/.test(f) && read(path.join('scripts', f)).includes('puppeteer-core'));
const allScript = scripts['test:ui:all'] || '';
uiFiles.forEach((f) => {
  const keys = Object.keys(scripts).filter((k) => new RegExp('scripts[/\\\\]' + f).test(scripts[k]));
  const wired = keys.length > 0 && keys.some((k) => allScript.includes('npm run ' + k));
  record(`test:ui:all に ${f}`, wired, keys.length ? keys.join(',') : 'npm script 未登録');
});

// --- 4. サイドバーの現実（AGENTS.md 第8条）: CSS・JS と README・AGENTS.md の一致 ---
const layouts = read('public/css/layouts.css');
const mainJs = read('public/js/main.js');
record('CSS 収納幅 67.25px !important', /width:\s*67\.25px\s*!important/.test(layouts));
record('CSS main 余白 4.2rem（収納幅分を常時確保）', /padding-left:\s*4\.2rem\s*!important/.test(layouts));
record('CSS せり出し 16.3rem（広幅の main 追従）', /padding-left:\s*16\.3rem\s*!important/.test(layouts));
record('CSS #app-body は position: relative（オーバーレイ）', /#app-body\s*\{[^}]*position:\s*relative/s.test(layouts));
record('CSS は :hover と is-hover/is-focus を併用', /:hover/.test(layouts) && /is-hover/.test(layouts) && /is-focus/.test(layouts));
record('JS は is-hover と is-focus を管理', /is-hover/.test(mainJs) && /is-focus/.test(mainJs));
record('README のサイドバー記述は現実（67.25px・16.3rem）', readme.includes('67.25px') && readme.includes('16.3rem'));
// AGENTS.md は寸法を書かない（正典は README と layouts.css）

// --- 5. API スモークの網羅 + health 実測 ---
const routes = read('src/routes/index.js');
const segments = new Set();
const segRe = /router\.(get|post|put|delete|patch)\(\s*'\/([^/'"]+)/g;
let m;
while ((m = segRe.exec(routes))) segments.add(m[2]);
const smoke = read('scripts/api-smoke-test.js');
segments.forEach((seg) => record(`API スモーク被覆 /api/${seg}`, new RegExp('/' + seg + '(?![A-Za-z0-9-])').test(smoke)));

const ca = fs.readFileSync(path.join(ROOT, 'certs', 'issystem-ca.crt'));
const health = await new Promise((resolve) => {
  const req = https.request({ host: '127.0.0.1', port: 3443, path: '/api/health', method: 'GET', ca: [ca], timeout: 4000 }, (res) => resolve(res.statusCode));
  req.on('error', (e) => resolve('ERR ' + (e.code || e.message)));
  req.end();
});
record('health 実測（server 起動済み・200）', health === 200, String(health));

// --- 6. 仕様書の必須節 ---
const spec = read('ISSystem仕様書.md');
record('仕様書: 既知の課題', /既知の課題/.test(spec));
record('仕様書: 意図された非実装', /意図された非実装/.test(spec));
record('仕様書: 改訂履歴', /改訂履歴/.test(spec));
record('仕様書: 検証の実行順序と制約', /テスト実行の順序と制約/.test(spec));

// --- 7. general チャット参照の完全除去（migrate*.js の注释は許す） ---
const generalHits = [];
const walk = (dir) => {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) return;
  for (const e of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(rel);
      continue;
    }
    if (!/\.(js|mjs)$/.test(e.name) || /^migrate/.test(e.name)) continue;
    if (path.join(dir, e.name).split(path.sep).join('/') === 'scripts/verify-docs.mjs') continue; // ゲート自身の検査語を除外
    const content = read(rel);
    content.split(/\r?\n/g).forEach((line, i) => {
      if (/chat\/channels\/general|'general'|"general"|`general`/.test(line)) {
        generalHits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 110)}`);
      }
    });
  }
};
walk('public/js');
walk('src');
walk('scripts');
record('general チャット参照の完全除去', generalHits.length === 0, generalHits.slice(0, 20).join(' | '));

// --- 8. CHANGELOG と Git 追跡の衛生（AGENTS.md 第10条） ---
record('CHANGELOG.md がある', fs.existsSync(path.join(ROOT, 'CHANGELOG.md')));

// 検証用一時成果物が Git に追跡されていないこと（data/・ui*.txt・nohup.out 等）
const tracked = execGit(['ls-files']);
const junk = tracked.split(/\r?\n/).filter((f) => {
  const p = f.split(path.sep).join('/');
  if (p.startsWith('data/') || p === 'nohup.out') return true;
  const base = p.split('/').pop();
  return /^(ui|t|vd|api|mail-|smoke|npmtest|test_out).*\.txt$/.test(base)
    || ['prompt.txt', 'health.json', 'audit-resolve.json'].includes(base)
    || /\.tmp$/.test(base) || base === 'tmp-probe.mjs';
});
record('検証用一時成果物を Git が追跡していない', junk.length === 0, junk.slice(0, 15).join(' | '));

// --- 表示 ---
console.log('=== ドキュメント検証レポート ===');
for (const r of results) {
  console.log(`${r.pass ? 'OK' : 'NG'}: ${r.name}${r.detail ? ' → ' + r.detail : ''}`);
}
const fails = results.filter((r) => !r.pass);
console.log(`\n合計 ${results.length} 項目、失敗 ${fails.length} 項目`);
if (fails.length > 0) process.exit(1);
