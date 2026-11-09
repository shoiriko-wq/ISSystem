/**
 * 実装とドキュメントの矛盾を検出する検証ゲート（AGENTS.md 第12条）
 * 実行: node scripts/verify-docs.mjs  （順序の最后。server が起動済みで health を実測する）
 *
 * 検査項目:
 *  1. README の「UI十条」（10項目）と「禁则」（10項目）
 *  2. AGENTS.md 第4条（UI十条・小項目1〜10）と第12条（検証の順序・直列実行・共有DB・CA）
 *  3. package.json: pretest（init-db + seed）, npm test の --runInBand（直列）, api:check,
 *     db:drop-general-chat, npm script に NODE_EXTRA_CA_CERTS を埋め込まない,
 *     puppeteer を使う scripts/test-*.mjs が test:ui:all に漏れなく含まれる
 *  4. サイドバーの現実（収納67.25px・せり出し16.3rem・main の余白常時確保・is-focus）が
 *     CSS・JS・README・AGENTS.md で一致する（AGENTS.md 第8条）
 *  5. API スモークが src/routes/index.js の全トップレベルAPIセグメントを叩く + health 実測
 *  6. 仕様書に必須節（既知の課題・意図された非実装・改訂履歴・検証の実行順序）がある
 *  7. general チャット参照の完全除去（第11条。migrate*.js の注释は許す）
 *  8. CHANGELOG.md がある
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

// --- 1. README: UI十条（10項目）と禁则（10項目） ---
const readme = read('README.md');
const uiTen = [
  ['項目は正方形タイル', /正方形タイル/],
  ['寸法・位置は px（rem 併記）', /\d+(\.\d+)?px/],
  ['余白・隙間・縮小・見切れなし', /余白|縮小|見切れ/],
  ['色分け・枠・影・角丸', /色分け|影|角丸/],
  ['ホバリングとフォーカスでせり出し', /ホバリング/],
  ['収納はオーバーレイ（main の余白を常時確保）', /オーバーレイ/],
  ['広幅（1100px以上）では main がせり出しへ追従', /追従/],
  ['縦移動・斜め移動なし', /縦移動|縦・斜め/],
  ['初回クリックが有効', /初回クリック/],
  ['検証スクリプト（寸法・位置・描画を px 実測）', /スクリーンショット|test:ui|test-.*\.mjs/],
];
uiTen.forEach(([n, re]) => record(`README UI十条: ${n}`, re.test(readme)));

const prohibitions = [
  ['テストの削除・スキップ禁止', /テストの削除/],
  ['UIテストは実測', /実測/],
  ['UI十条', /UI十条/],
  ['CA環境変数を npm script に埋め込まない', /NODE_EXTRA_CA_CERTS.*埋め込まない/],
  ['DB破壊禁止（テスト失敗時にテーブル・レコードを消すな）', /レコードを消せ.*禁止|DB破壊/],
  ['general チャットは全廃（テスト・fixture にも残さない）', /general は全廃/],
  ['チャットは発言者以外が読み書き（server 側で members 検証）', /発言者以外/],
  ['メールはメールボックスのみ', /メールボックス/],
  ['追加の権限なし（教務と校長のみ）', /追加の権限.*禁止/],
  ['検証の省略禁止', /省略禁止|省略しない/],
];
prohibitions.forEach(([n, re]) => record(`README 禁则: ${n}`, re.test(readme)));

// --- 2. AGENTS.md: 第4条（UI十条・小項目1〜10）と第12条（検証の順序・制約） ---
const agents = read('AGENTS.md');
const agentsTen = [
  ['1 項目は正方形タイル', /正方形タイル/],
  ['2 寸法・位置を px で実測', /\d+(\.\d+)?px/],
  ['3 余白・隙間・縮小・見切れなし', /余白|縮小|見切れ/],
  ['4 色分け・枠・影・角丸', /色分け|影|角丸/],
  ['5 ホバリング・フォーカスでせり出し', /ホバリング/],
  ['6 オーバーレイと main の余白', /オーバーレイ/],
  ['7 広幅では main がせり出しへ追従', /追従/],
  ['8 縦移動・斜め移動禁止', /縦移動|縦・斜め/],
  ['9 初回クリックが有効', /初回クリック/],
  ['10 スクリーンショット・CSS 阅读のみ禁止', /スクリーンショット/],
];
agentsTen.forEach(([n, re]) => record(`AGENTS.md 第4条（UI十条）: ${n}`, re.test(agents)));

const agentsGates = [
  ['Jest 直列（--runInBand）', /--runInBand/],
  ['pretest（init-db + seed）', /pretest/],
  ['test:ui:all を実行', /test:ui:all/],
  ['api:check（サーバー起動後）', /api:check/],
  ['verify-docs を最終ゲートとして実行', /verify-docs/],
  ['順序どおり・省略禁止', /順序どおり|省略禁止/],
  ['共有DB衝突の警告', /衝突/],
  ['CA を npm script に埋め込まない', /NODE_EXTRA_CA_CERTS.*埋め込まない/],
];
agentsGates.forEach(([n, re]) => record(`AGENTS.md 第12条: ${n}`, re.test(agents)));

// --- 3. package.json ---
const pkg = JSON.parse(read('package.json'));
const scripts = pkg.scripts || {};
const joined = Object.values(scripts).join(' && ');
record('pretest が init-db + seed を実行', /init-db/.test(scripts.pretest || '') && /seed/.test(scripts.pretest || ''));
record('npm test は --runInBand（Jest を1プロセス直列）', /--runInBand/.test(scripts.test || ''));
record('api:check（api-smoke-test.js）', /api-smoke-test/.test(scripts['api:check'] || ''));
record('db:drop-general-chat（第11条）', /drop-general/.test(scripts['db:drop-general-chat'] || ''));
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
record('AGENTS.md のサイドバー記述は現実（67.25px・16.3rem）', agents.includes('67.25px') && agents.includes('16.3rem'));

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
    if (path.join(dir, e.name) === 'scripts\\verify-docs.mjs') continue; // ゲート自身の検査語を除外
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

// --- 8. CHANGELOG ---
record('CHANGELOG.md がある', fs.existsSync(path.join(ROOT, 'CHANGELOG.md')));

// --- 表示 ---
console.log('=== ドキュメント検証レポート ===');
for (const r of results) {
  console.log(`${r.pass ? 'OK' : 'NG'}: ${r.name}${r.detail ? ' → ' + r.detail : ''}`);
}
const fails = results.filter((r) => !r.pass);
console.log(`\n合計 ${results.length} 項目、失敗 ${fails.length} 項目`);
if (fails.length > 0) process.exit(1);
