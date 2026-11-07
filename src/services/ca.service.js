/**
 * ISSystem Private CA Service (プライベートCA・TLS証明書管理)
 *
 * プライベートCA ルート証明書 / サーバー証明書の読み込み、TLS オプション生成、
 * CAダウンロードページ（HTML）の構築を行う。
 * 証明書の生成は `npm run cert:gen`（scripts/create-ca.mjs）が行う。
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import config from '../../config/default.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// プロジェクトルート（src/services → 2つ上）
const ROOT = path.resolve(__dirname, '..', '..');

export const CA_FILE_NAME = 'issystem-ca.crt'; // PEM 内容・.crt 拡張（Windows ではダブルクリックで開ける）

/** 証明書ファイルの絶対パス群を解決する */
export function sslPaths() {
  const resolve = (p) => path.resolve(ROOT, p);
  return {
    dir: resolve(config.ssl.dir),
    key: resolve(config.ssl.key),
    cert: resolve(config.ssl.cert),
    ca: resolve(config.ssl.ca),
    chain: path.join(resolve(config.ssl.dir), 'chain.pem'),
    caFileName: CA_FILE_NAME,
  };
}

/** 証明書がすべて存在するか */
export function certsExist() {
  const p = sslPaths();
  return fs.existsSync(p.key) && fs.existsSync(p.cert) && fs.existsSync(p.ca);
}

/**
 * Node https サーバー用 TLS オプションを構築する
 * @returns {{key:Buffer, cert:Buffer[]|Buffer, ca:Buffer} | null} 証明書が無い場合は null
 */
export function loadTlsOptions() {
  const p = sslPaths();
  if (!fs.existsSync(p.key) || !fs.existsSync(p.cert)) {
    return null;
  }
  const key = fs.readFileSync(p.key);
  const cert = fs.readFileSync(p.cert);
  const ca = fs.existsSync(p.ca) ? fs.readFileSync(p.ca) : null;
  // 証明書チェーン（サーバー証明書 + ルートCA）をクライアントに提示させる
  return ca ? { key, cert, certChain: [cert, ca], ca } : { key, cert };
}

/**
 * ルートCA証明書の情報（指紋・有効期限）を返す（キャッシュ付き）
 */
let caCache = null;
export function getCaInfo() {
  const p = sslPaths();
  if (caCache && caCache.path === p.ca) return caCache.info;

  if (!fs.existsSync(p.ca)) {
    const info = { exists: false, path: p.ca };
    caCache = { path: p.ca, info };
    return info;
  }

  const pem = fs.readFileSync(p.ca, 'utf8');
  const x509 = new crypto.X509Certificate(pem);
  const info = {
    exists: true,
    path: p.ca,
    pem,
    fingerprint: sha256Fingerprint(x509),
    serial: x509.serialNumber,
    validFrom: x509.validFrom,
    validTo: x509.validTo,
    subject: x509.subject,
  };
  caCache = { path: p.ca, info };
  return info;
}

/**
 * CAダウンロードページの HTML を構築する
 * @param {Object} ctx
 * @param {boolean} ctx.secure    安全接続 (HTTPS) で開かれたページかどうか
 * @param {string} ctx.host       アクセスホスト（req.headers.host）
 * @param {number} ctx.httpsPort  HTTPS ポート
 * @param {string|null} ctx.secureUrl 安全URL基点（SSL_CA_PAGE_BASE。未設定なら host:port から導出）
 * @param {string} ctx.caFileName CAファイル名
 * @param {Object} ctx.caInfo     getCaInfo() の結果
 */
export function buildCaPage(ctx) {
  const { secure, host, httpsPort, caFileName, caInfo } = ctx;
  const secureBase = ctx.secureUrl || `https://${host}:${httpsPort}`;
  // 末尾のスラッシュを揃えて URL を表示・リンクする
  const httpsUrl = secureBase.endsWith('/') ? secureBase : `${secureBase}/`;
  const fingerprint = caInfo.exists ? caInfo.fingerprint : '（証明書が見つかりません）';

  const statusBlock = secure
    ? `<p class="note ok">このページは安全な接続 (HTTPS) で開かれています。<br />証明書はインストール済みなので、そのまま <code>${escapeHtml(httpsUrl)}</code> を開けます。</p>`
    : `<p class="note">ISSystem は学校内ネットワーク用の証明書（プライベートCA）で安全にやり取りします。<br />はじめての方は、下の設定を一度だけ行えば、警告なく使えるようになります。</p>`;

  const certBlock = caInfo.exists
    ? `<a class="btn" href="/ca/${caFileName}" download>ルートCA証明書をダウンロード</a>`
    : `<span class="btn disabled">証明書が見つかりません</span>`;
  const openHttps = secure
    ? ''
    : `<a class="btn secondary" href="${escapeHtml(httpsUrl)}">ISSystem を開く</a>`;


  const head = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="strict-origin-when-cross-origin" />
<title>ISSystem ｜ はじめに（証明書の設定）</title>
<style>
  :root { --bg:#F7FAFC; --card:#FFFFFF; --text:#0F172A; --muted:#64748B; --brand:#037A71; --ring:#CBD5E1; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:"Noto Sans JP","Hiragino Sans","Yu Gothic",system-ui,sans-serif; padding:2rem 1rem; }
  .wrap { max-width:52rem; margin:0 auto; }
  header { border-bottom:2px solid var(--brand); padding-bottom:.75rem; margin-bottom:1.25rem; }
  .brand { font-size:1.25rem; font-weight:700; color:var(--brand); }
  .sub { font-size:.875rem; color:var(--muted); margin-top:.25rem; }
  .alert { border-radius:.75rem; padding:1rem 1.125rem; font-size:.9375rem; line-height:1.7; }
  .alert.warn { border:1px solid #FECACA; background:#FEF2F2; color:#7F1D1D; }
  .alert.ok { border:1px solid #A7F3D0; background:#ECFDF5; color:#065F46; }
  .card { background:var(--card); border:1px solid var(--ring); border-radius:.75rem; padding:1.25rem; margin-top:1rem; }
  h2 { font-size:1rem; margin:0 0 .75rem; }
  h3 { font-size:.9375rem; margin:1rem 0 .5rem; color:var(--text); }
  p, li { font-size:.9375rem; line-height:1.75; margin:.25rem 0; }
  ol { margin:.25rem 0 .75rem; padding-left:1.5rem; }
  code { background:#EEF2F7; border-radius:.25rem; padding:.1rem .35rem; font-size:.875rem; word-break:break-all; }
  .actions { display:flex; flex-wrap:wrap; gap:.75rem; margin-top:.75rem; }
  .btn { display:inline-block; background:var(--brand); color:#fff; text-decoration:none; border-radius:.5rem; padding:.875rem 1.5rem; font-size:.9375rem; font-weight:600; }
  .btn.secondary { background:#334155; }
  .btn.disabled { background:#94A3B8; color:#F1F5F9; }
  .fp { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.8125rem; background:#EEF2F7; border:1px solid var(--ring); border-radius:.5rem; padding:.75rem; letter-spacing:.05em; word-break:break-all; margin-top:.5rem; }
  .note { border-radius:.75rem; padding:1rem 1.125rem; font-size:.9375rem; line-height:1.7; border:1px solid var(--ring); background:var(--card); }
  .note.ok { border:1px solid #A7F3D0; background:#ECFDF5; color:#065F46; }
  .muted { color:var(--muted); font-size:.875rem; }
  .tabs { margin-top:1rem; }
  .tabs input[type=radio] { position:absolute; width:1px; height:1px; opacity:0; }
  .tablist { display:flex; flex-wrap:wrap; gap:.35rem; }
  .tablist label { cursor:pointer; font-size:.875rem; padding:.5rem .8rem; border:1px solid var(--ring); border-bottom:none; border-radius:.5rem .5rem 0 0; background:#EEF2F7; color:var(--muted); }
  .panels { border-top:2px solid var(--brand); }
  .panel { display:none; padding-top:.9rem; }
  #dev-win:checked ~ .tablist label[for=dev-win],
  #dev-ios:checked ~ .tablist label[for=dev-ios],
  #dev-android:checked ~ .tablist label[for=dev-android],
  #dev-firefox:checked ~ .tablist label[for=dev-firefox],
  #dev-node:checked ~ .tablist label[for=dev-node] { background:var(--brand); color:#fff; border-color:var(--brand); }
  #dev-win:checked ~ .panels #p-win,
  #dev-ios:checked ~ .panels #p-ios,
  #dev-android:checked ~ .panels #p-android,
  #dev-firefox:checked ~ .panels #p-firefox,
  #dev-node:checked ~ .panels #p-node { display:block; }
  footer { margin-top:1.5rem; font-size:.8125rem; color:var(--muted); line-height:1.7; }
</style>
</head>
<body>
`;



  const body = `
<main class="wrap">
  <header>
    <div class="brand">ISSystem 職員室情報共有システムへようこそ</div>
    <div class="sub">はじめて接続される方へ — 証明書の設定は一度だけ、安全に使えます。</div>
  </header>

  ${statusBlock}

  <div class="card">
    <h2>はじめ設定（3ステップ）</h2>
    <div class="actions">
      ${certBlock}
      ${openHttps}
    </div>

    <div class="tabs">
      <input type="radio" name="dev" id="dev-win" checked>
      <input type="radio" name="dev" id="dev-ios">
      <input type="radio" name="dev" id="dev-android">
      <input type="radio" name="dev" id="dev-firefox">
      <input type="radio" name="dev" id="dev-node">
      <div class="tablist">
        <label for="dev-win">Windows</label>
        <label for="dev-ios">iPhone / iPad</label>
        <label for="dev-android">Android</label>
        <label for="dev-firefox">Firefox</label>
        <label for="dev-node">その他（開発・テスト）</label>
      </div>
      <div class="panels">
        <div class="panel" id="p-win">
          <ol>
            <li>上の「証明書をダウンロード」を押す。</li>
            <li><code>${escapeHtml(caFileName)}</code> をダブルクリックし、<code>信頼されたルート証明機関</code> に「常時信頼する」で登録。</li>
            <li>ブラウザを再起動し、<code>${escapeHtml(httpsUrl)}</code> を開く。</li>
          </ol>
        </div>
        <div class="panel" id="p-ios">
          <ol>
            <li>証明書をダウンロードし、「ファイル」アプリに保存。</li>
            <li>その <code>.crt</code> をタップし、設定の「プロファイルとデバイス管理」でインストール。</li>
            <li>設定 → 一般 → 証明書設定で <code>ISSystem CA</code> を「常時信頼」に設定し、Safari を再起動。</li>
          </ol>
        </div>
        <div class="panel" id="p-android">
          <ol>
            <li>証明書をダウンロード。</li>
            <li>設定 → セキュリティ → 認証情報の削除とインストール → CA証明書をインストール。</li>
            <li>ブラウザを再起動して <code>${escapeHtml(httpsUrl)}</code> を開く。</li>
          </ol>
        </div>
        <div class="panel" id="p-firefox">
          <ol>
            <li>設定 → 個人情報保護 → 証明書 → 信頼されたルート →「証明書をインポート」で <code>.crt</code> を選び、「このCAによるWebサイトの信頼」を有効化。</li>
            <li><code>${escapeHtml(httpsUrl)}</code> を開く。</li>
          </ol>
        </div>
        <div class="panel" id="p-node">
          <ol>
            <li>環境変数 <code>NODE_EXTRA_CA_CERTS=./certs/${escapeHtml(caFileName)}</code> を設定して実行。</li>
            <li>ヘッドレスブラウザ検証は <code>--ignore-certificate-errors</code> を使用。</li>
          </ol>
        </div>
      </div>
    </div>

    <h3>指紋（SHA-256）</h3>
    <div class="fp">${escapeHtml(fingerprint)}</div>
    <p class="muted">指紋が管理者の案内と一致することを確認してからインストールしてください。</p>
  </div>

  <footer>
    <p>設定は一度だけ。数分で終わります。分からない時は職員室・管理者に気軽に声をかけてください。</p>
    <p>サーバー管理者: 証明書の生成は <code>npm run cert:gen</code>。</p>
  </footer>
</main>
</body>
</html>
`;

  return head + body;
}

export default { sslPaths, certsExist, loadTlsOptions, getCaInfo, buildCaPage, CA_FILE_NAME };


const escapeHtml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 証明書の SHA-256 指紋（DER をハッシュし AA:BB:.. 形式で返す） */
export const sha256Fingerprint = (x509) =>
  crypto
    .createHash('sha256')
    .update(x509.raw)
    .digest('hex')
    .toUpperCase()
    .match(/../g)
    .join(':');
