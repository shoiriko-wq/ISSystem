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

export const CA_FILE_NAME = 'issystem-ca.pem';

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
  const validTo = caInfo.exists ? caInfo.validTo : '-';
  const subject = caInfo.exists ? caInfo.subject : '-';

  const statusBlock = secure
    ? `<div class="alert ok">
        <strong>このページは安全な接続 (HTTPS) で開かれています。</strong><br />
        証明書をインストール済みであれば、そのまま ISSystem を利用できます。
        同じページから CA 証明書を再取得することも可能です。
      </div>`
    : `<div class="alert warn">
        <strong>このページは「非安全」な接続 (HTTP) で開かれています。</strong><br />
        ISSystem はプライベートCAで発行した証明書により <code>https://</code>（HTTPS）と
        <code>wss://</code>（WebSocket Secure）で通信します。<br />
        ブラウザがこの証明書を信頼できるよう、下記のルートCA証明書を端末にインストールしてください。
      </div>`;

  const certBlock = caInfo.exists
    ? `<a class="btn" href="/ca/${caFileName}" download>ルートCA証明書（${escapeHtml(caFileName)}）をダウンロード</a>`
    : `<span class="btn disabled">CA証明書が見つかりません</span>`;


  const head = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="referrer" content="strict-origin-when-cross-origin" />
<title>ISSystem ｜ 安全通信（プライベートCA）設定</title>
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
  footer { margin-top:1.5rem; font-size:.8125rem; color:var(--muted); line-height:1.7; }
</style>
</head>
<body>
`;



  const body = `
<main class="wrap">
  <header>
    <div class="brand">ISSystem 職員室情報共有システム</div>
    <div class="sub">プライベートCAによる安全通信（HTTPS / WSS）設定ページ</div>
  </header>

  ${statusBlock}

  <div class="card">
    <h2>1. ルートCA証明書をダウンロードしてインストールする</h2>
    <p>ISSystem のサーバー証明書は、学校内ネットワーク用のプライベートCAが発行しています。<br />
    端末（ブラウザ・OS・Node.js）にルートCAを登録すると、警告なく HTTPS / WSS が利用できるようになります。</p>
    <div class="actions">
      ${certBlock}
      ${secure ? '' : `<a class="btn secondary" href="${escapeHtml(httpsUrl)}">安全接続 (HTTPS) で開く</a>`}
    </div>
    <h3>指紋（SHA-256）で真正性を確認してください</h3>
    <div class="fp">${escapeHtml(fingerprint)}</div>
    <p>指紋が管理者の案内と一致することを確認してからインストールしてください。<br />
    発行者: <code>${escapeHtml(subject)}</code> ／ 有効期限: <code>${escapeHtml(validTo)}</code></p>
  </div>
`;


  const steps = `
  <div class="card">
    <h2>2. 端末ごとのインストール手順</h2>
    <h3>Windows 10 / 11（Chrome・Edge）</h3>
    <ol>
      <li>上のボタンで <code>${escapeHtml(caFileName)}</code> をダウンロードします。</li>
      <li>ファイルをダブルクリックし、<code>信頼されたルート証明機関</code> に登録します（「常時信頼する」を設定）。</li>
      <li>ブラウザを再起動し、<code>${escapeHtml(httpsUrl)}</code> を開きます。</li>
    </ol>
    <h3>macOS（Safari・Chrome）</h3>
    <ol>
      <li>ダウンロードした.pemを開き、キーチェーンで <code>常時信頼</code> に設定します。</li>
      <li><code>${escapeHtml(httpsUrl)}</code> を開きます。</li>
    </ol>
    <h3>Firefox</h3>
    <ol>
      <li><code>設定 → 個人情報保護 → 証明書 → 信頼されたルート → 証明書をインポート</code> で.pemを選択し、<code>このCAによるWebサイトの信頼</code> を有効化します。</li>
    </ol>
    <h3>Node.js（スクリプト・自動化・UIテスト）</h3>
    <ol>
      <li>環境変数 <code>NODE_EXTRA_CA_CERTS=./certs/${escapeHtml(caFileName)}</code> を設定して実行します。</li>
      <li>ヘッドレスブラウザの検証では <code>ignoreHTTPSErrors</code> / <code>--ignore-certificate-errors</code> を使用します。</li>
    </ol>
    <h3>Android / iPad（学校端末）</h3>
    <ol>
      <li>ダウンロードした.pemを端末に保存し、<code>設定 → セキュリティ → 認証情報の削除とインストール</code>（Android）または構成ファイル（iPad）で信頼設定します。</li>
    </ol>
  </div>

  <footer>
    <p><strong>非HTTP接続について:</strong> 非安全ポート（HTTP）はCA証明書の配布専用です。<br />
    API 呼び出しは <code>426 Upgrade Required</code> で拒否され、アプリケーション（画面）は安全接続 (HTTPS) でのみ提供されます。<br />
    WebSocket (socket.io) は HTTPS と同一ポートの <code>wss://</code> でのみ接続できます。</p>
    <p>サーバー管理者: 証明書の生成は <code>npm run cert:gen</code>（OpenSSL が必要）です。</p>
  </footer>
</main>
</body>
</html>
`;

  return head + body + steps;
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
