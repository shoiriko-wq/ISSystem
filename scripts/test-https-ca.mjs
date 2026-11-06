/**
 * ISSystem 安全通信（プライベートCA + HTTPS/WSS）検証テスト
 *
 * 検証項目:
 *  1. プライベートCA・サーバー証明書が存在し openssl verify が OK
 *  2. TLS ハンドシェイクが CA のみで信頼される (authorized, issuer, SAN)
 *  3. HTTPS のアプリ・API・ログインが CA トラストのみで機能する
 *  4. 非HTTPアクセスには CAダウンロードページが表示される (指紋・HTTPS案内)
 *  5. 非HTTPの API は 426 Upgrade Required で拒否、アプリ画面は CAページに置換
 *  6. CA証明書を HTTP でダウンロードできる (attachment・PEM・指紋一致)
 *  7. HTTPS でも /ca ページが利用できる
 *  8. ブラウザは wss:// で接続し、アプリ内 API は https 相対で機能する
 *  9. 非HTTPポートでは plain ws 接続が確立しない
 *
 * 実行: npm run test:ui:https   (NODE_EXTRA_CA_CERTS=./certs/issystem-ca.crt 付き)
 *  options: UI_BASE=https://127.0.0.1:3443  INSECURE_BASE=http://127.0.0.1:3000
 *           UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=/usr/bin/google-chrome
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import tls from 'node:tls';
import { inspect } from 'node:util';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';
import { io } from 'socket.io-client';

const ROOT = path.resolve(import.meta.dirname, '..');
const SECURE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const INSECURE = process.env.INSECURE_BASE || 'http://127.0.0.1:3000';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const CA_PATH = path.join(ROOT, 'certs', 'issystem-ca.crt');
const SRV_PATH = path.join(ROOT, 'certs', 'server.pem');
const SECURE_PORT = Number(new URL(SECURE).port || 443);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// OpenSSL の実行ファイルを探索する（PATH → Git for Windows → Program Files 等）
const findOpenSSL = () => {
  const candidates = [];
  if (process.env.OPENSSL) candidates.push(process.env.OPENSSL);
  candidates.push('openssl');
  const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const systemRoot = process.env['SystemRoot'] || 'C:\\Windows';
  candidates.push(path.join(programFiles, 'Git', 'usr', 'bin', 'openssl.exe'));
  candidates.push(path.join(programFiles, 'Git', 'bin', 'openssl.exe'));
  for (const base of [programFiles, programFilesX86]) {
    for (const name of ['OpenSSL', 'OpenSSL-Win64', 'OpenSSL-Win32', 'GnuWin32']) {
      const exe = path.join(base, name, 'bin', 'openssl.exe');
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  }
  candidates.push(path.join(systemRoot, 'System32', 'openssl.exe'));
  for (const cand of candidates) {
    try {
      execFileSync(cand, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return cand;
    } catch {
      // この候補は使えない → 次を試す
    }
  }
  throw new Error(
    'OpenSSL が見つかりませんでした。Git for Windows をインストールするか、' +
    '環境変数 OPENSSL に openssl.exe のフルパスを設定してください。'
  );
};


const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  const d = detail === null ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${d}`);
};

/** Node 側 fetch（NODE_EXTRA_CA_CERTS の CA トラストで https を検証） */
const getRaw = async (url, opts = {}) => {
  try {
    const r = await fetch(url, opts);
    const text = await r.text();
    return { status: r.status, text, headers: Object.fromEntries(r.headers.entries()) };
  } catch (e) {
    return { status: 0, text: '', headers: {}, error: e.message };
  }
};

console.log(`SECURE=${SECURE}  INSECURE=${INSECURE}`);

// --- 1. 証明書ファイルと CA 検証 ---
const caPem = fs.readFileSync(CA_PATH, 'utf8');
const srvPem = fs.readFileSync(SRV_PATH, 'utf8');
check('CA証明書とサーバー証明書が存在する', fs.existsSync(CA_PATH) && fs.existsSync(SRV_PATH));
const caX509 = new crypto.X509Certificate(caPem);
const srvX509 = new crypto.X509Certificate(srvPem);
const caFingerprint = crypto
  .createHash('sha256')
  .update(caX509.raw)
  .digest('hex')
  .toUpperCase()
  .match(/../g)
  .join(':');
check('ルートCA証明書は CA:TRUE', caX509.ca === true, { isCA: caX509.ca, fingerprint: caFingerprint });
check('サーバー証明書の発行者がプライベートCA', srvX509.issuer.includes('ISSystem Private Root CA'), {
  issuer: srvX509.issuer.replace(/\n/g, ' '),
});
const san = srvX509.subjectAltName || '';
check('サーバー証明書のSANに localhost と 127.0.0.1', san.includes('DNS:localhost') && san.includes('127.0.0.1'), {
  san: san.replace(/\n/g, ' '),
});
const OPENSSL_BIN = findOpenSSL();
const verifyOut = execFileSync(OPENSSL_BIN, ['verify', '-CAfile', CA_PATH, SRV_PATH], { encoding: 'utf8' }).trim();
check('openssl verify でサーバー証明書が OK', verifyOut.endsWith(': OK'), { verify: verifyOut });


// --- 2. TLS ハンドシェイク（プライベートCAのみで信頼できるか） ---
const fmtName = (v) => (typeof v === 'string' ? v : inspect(v).replace(/\n/g, ' '));
const tlsInfo = await new Promise((resolve) => {
  const sock = tls.connect(
    { host: '127.0.0.1', port: SECURE_PORT, servername: 'localhost', ca: [caPem], timeout: 8000 },
    () => {
      const cert = sock.getPeerCertificate(true);
      const lite = sock.getPeerCertificate(false);
      resolve({
        authorized: sock.authorized,
        issuer: fmtName(lite.issuer || '').replace(/\n/g, ' '),
        certMatches: Buffer.from(cert.raw).toString('base64') === srvX509.raw.toString('base64'),
        reason: sock.authorizationError || null,
      });
      sock.end();
    }
  );
  sock.on('error', (e) => resolve({ authorized: false, issuer: '', certMatches: false, reason: e.message }));
  setTimeout(() => resolve({ authorized: false, issuer: '', certMatches: false, reason: 'timeout' }), 8000);
});
check('TLS接続がプライベートCAのみで信頼される (authorized)', tlsInfo.authorized === true, {
  authorized: tlsInfo.authorized,
  reason: tlsInfo.reason,
});
check('TLSチェーンの発行者がプライベートCA', tlsInfo.issuer.includes('ISSystem Private Root CA'), { issuer: tlsInfo.issuer });
check('提示されたサーバー証明書が certs/server.pem と一致', tlsInfo.certMatches === true, { certMatches: tlsInfo.certMatches });

// --- 3. HTTPS のアプリ・API (CAトラストのみで) ---
const health = await getRaw(`${SECURE}/api/health`);
check(
  'HTTPS health が CAトラストのみで 200 ONLINE',
  health.status === 200 && health.text.includes('ONLINE'),
  { status: health.status, error: health.error }
);
const login = await getRaw(`${SECURE}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ staff_code: USER, password: PASS }),
});
check('HTTPS でログインできる (CAトラストのみ)', login.status === 200 && login.text.includes('token'), {
  status: login.status,
  error: login.error,
});

// --- 4-7. 非HTTP（CAページ表示・API拒否・CA配布） ---
const rootPage = await getRaw(`${INSECURE}/`);
check(
  '非HTTPのルートはCAダウンロードページを表示',
  rootPage.status === 200 && rootPage.text.includes('プライベートCA') && rootPage.text.includes('CA証明書'),
  { status: rootPage.status }
);
check('CAページにルートCA指紋が表示される', rootPage.text.includes(caFingerprint), { fingerprint: caFingerprint });
check(`CAページに https://127.0.0.1:${SECURE_PORT}/ 案内がある`, rootPage.text.includes(`https://127.0.0.1:${SECURE_PORT}/`));
check('CAページにスクリプトがない (script-src none)', !/<script/i.test(rootPage.text));
check('CAページにインストール手順がある', rootPage.text.includes('信頼されたルート証明機関') && rootPage.text.includes('NODE_EXTRA_CA_CERTS'));

const apiInsecure = await getRaw(`${INSECURE}/api/bulletins`);
check(
  '非HTTPのAPIは 426 Upgrade Required で拒否',
  apiInsecure.status === 426 && apiInsecure.text.includes('INSECURE_TRANSPORT'),
  { status: apiInsecure.status }
);

const appInsecure = await getRaw(`${INSECURE}/index.html`);
check(
  'アプリ画面は非HTTPで提供されない (CAページへ置換)',
  appInsecure.text.includes('プライベートCA') && !appInsecure.text.includes('職員室内リアルタイム情報共有システム'),
  { status: appInsecure.status }
);

const caDl = await getRaw(`${INSECURE}/ca/issystem-ca.crt`);
check('CA証明書をHTTPでダウンロードできる', caDl.status === 200 && caDl.text.startsWith('-----BEGIN CERTIFICATE'), {
  status: caDl.status,
});
const disp = String(caDl.headers['content-disposition'] || '');
check('CAダウンロードは attachment ファイル名付き', disp.includes('attachment') && disp.includes('issystem-ca.crt'), {
  contentDisposition: disp,
});
check('ダウンロードCAがルートCAと完全一致', caDl.text.trim() === caPem.trim());

const caPageSecure = await getRaw(`${SECURE}/ca`);
check('HTTPSでも /ca ページが利用できる', caPageSecure.status === 200 && caPageSecure.text.includes('安全な接続 (HTTPS)'), {
  status: caPageSecure.status,
});


// --- 8. ブラウザ (アプリ画面・wss接続・API) ---
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
  ignoreHTTPSErrors: true,
});
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.goto(`${SECURE}/`, { waitUntil: 'networkidle2' });
const content = await page.content();
check('HTTPSでアプリ画面 (index.html) が表示される', content.includes('職員室内リアルタイム情報共有システム'), { url: page.url() });

await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: 'networkidle2' });
await sleep(400);
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 15000 });

// ページ内の socket.io クライアント状態を検査 (https origin → wss transport)
let sockState = null;
for (let i = 0; i < 40 && !(sockState && sockState.connected); i++) {
  sockState = await page.evaluate(async () => {
    const mod = await import('/js/socket.js');
    const s = mod.socketClient?.socket;
    if (!s) return null;
    return {
      connected: s.connected === true,
      transport: s.io?.engine?.transport?.name || null,
      uri: s.io?.uri || null,
      proto: location.protocol,
    };
  });
  if (!(sockState && sockState.connected)) await sleep(250);
}
check(
  'ブラウザは wss://（WebSocket Secure）で接続している',
  !!sockState && sockState.connected && sockState.transport === 'websocket' && sockState.proto === 'https:',
  sockState
);

const pageApi = await page.evaluate(async () => {
  const t = localStorage.getItem('is_system_jwt_token_v251');
  const r = await fetch('/api/bulletins', { headers: { Authorization: `Bearer ${t}` } });
  return { status: r.status, proto: location.protocol, hasToken: !!t };
});
check('アプリ内のAPI呼び出しは https 相対で機能', pageApi.status === 200, { status: pageApi.status, proto: pageApi.proto });

// --- 9. 非HTTPポートでは plain ws 接続が確立しない ---
const plain = await new Promise((resolve) => {
  const s = io(INSECURE, { transports: ['polling', 'websocket'], reconnection: false, timeout: 4000 });
  const done = (r) => {
    try { s.close(); } catch (e) { /* noop */ }
    resolve(r);
  };
  const timer = setTimeout(() => done({ connected: s.connected, reason: 'timeout' }), 6000);
  s.on('connect', () => { clearTimeout(timer); done({ connected: true, reason: 'connected' }); });
  s.on('connect_error', (e) => { clearTimeout(timer); done({ connected: false, reason: e.message }); });
});
check('非HTTPポートでは plain ws/socket 接続が確立しない', plain.connected === false, { reason: plain.reason });

check('ページに未捕获JSエラーがない', pageErrors.length === 0, { pageErrors: pageErrors.slice(0, 3) });

await browser.close();

console.log('=== REPORT ===');
console.log(
  JSON.stringify(
    { secure: SECURE, insecure: INSECURE, caFingerprint, failures: failures.length ? failures : 'ALL PASS' },
    null,
    2
  )
);
process.exit(failures.length ? 1 : 0);
