/**
 * ISSystem プライベートCA・サーバー証明書生成スクリプト
 *
 * OpenSSL を使って自己署名のルートCA（プライベートCA）と、
 * そのCAで署名されたサーバー証明書（HTTPS/WSS用）を certs/ に生成する。
 * ルートCAは Windows ユーザーに親切な .crt（PEM 内容・ダブルクリックで開ける）で出力する。
 * ルートCA・サーバー証明書の双方に SAN（SSL_HOSTS と同一のホスト名/IP）を付与する。
 *
 * 実行:  npm run cert:gen            # 未存在時のみ生成（冪等）
 *        npm run cert:gen -- --force # 既存があっても CA も含め一切を再生成
 *        npm run cert:gen -- --server-only # 既存ルートCAを再利用しサーバー証明書のみ再署名
 *          （SAN=SSL_HOSTS 変更時に推奨。CA が変わらないため端末の信頼ストア設定は有効のまま）
 *
 * 環境変数（.env から読む。シェル環境変数が優先）:
 *   SSL_DIR   = 出力ディレクトリ (既定: ./certs)
 *   SSL_HOSTS = 証明書のSANに含めるホスト/IP (既定: localhost,issystem.local,127.0.0.1,::1)
 *              LAN 端末が https://IP:3443 を開くにはその IPv4 を必ず含める必要がある
 *              （SAN 不一致はブラウザが警告なしで接続を拒否する）。IP は静态化（DHCP固定）を推奨。
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// .env を読む（シェル環境変数が優先: override: false）。
// サーバー側の設定（config/default.js）と証明書 SAN（SSL_HOSTS）を单一来源に揃え、
// `npm run cert:gen` が .env の LAN IP を SAN に反映できるようにする。
dotenv.config({ path: path.join(ROOT, '.env'), override: false, quiet: true });
const CERT_DIR = process.env.SSL_DIR ? path.resolve(ROOT, process.env.SSL_DIR) : path.join(ROOT, 'certs');

const rawHosts = (process.env.SSL_HOSTS || 'localhost,issystem.local,issystem,127.0.0.1,::1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// SAN 用の DNS/IP 項目を組み立てる（::1 は OpenSSL 表記 0:0:0:0:0:0:0:1）
const sanItems = rawHosts.map((h) => {
  if (h === '::1') return 'IP:0:0:0:0:0:0:0:1';
  if (/^\d+(\.\d+){3}$/.test(h)) return `IP:${h}`;
  return `DNS:${h}`;
});

const CA_KEY = path.join(CERT_DIR, 'issystem-ca.key');
const CA_CRT = path.join(CERT_DIR, 'issystem-ca.crt'); // PEM 内容・.crt 拡張（Windows 用）
const CA_PEM = path.join(CERT_DIR, 'issystem-ca.pem'); // 旧来名（PEMコピー・常に .crt と同期）
const SRV_KEY = path.join(CERT_DIR, 'server.key');
const SRV_PEM = path.join(CERT_DIR, 'server.pem');
const CHAIN_PEM = path.join(CERT_DIR, 'chain.pem');
const EXT_FILE = path.join(CERT_DIR, 'server.ext');
const CSR_FILE = path.join(CERT_DIR, 'server.csr');
const SERIAL_FILE = path.join(CERT_DIR, 'issystem-ca.srl');

const CA_SUBJECT = '/C=JP/O=ISSystem/OU=Staff Room Net/CN=ISSystem Private Root CA';
const SRV_SUBJECT = '/C=JP/O=ISSystem/OU=Staff Room Net/CN=localhost';
const CA_DAYS = 3650;   // ルートCA: 10年
const SRV_DAYS = 825;    // サーバー証明書: 約2年（OpenSSL 上限 825日）

// 証明書の SHA-256 指紋（DER をハッシュし AA:BB:.. 形式で返す）
const sha256Fingerprint = (x509) =>
  crypto
    .createHash('sha256')
    .update(x509.raw)
    .digest('hex')
    .toUpperCase()
    .match(/../g)
    .join(':');

// OpenSSL の実行ファイルを探索する
//  1. 環境変数 OPENSSL（フルパス指定）
//  2. PATH 上の "openssl"
//  3. Git for Windows 同梱の openssl.exe
//  4. Program Files (x86)\OpenSSL、Program Files\GnuWin32、System32 など
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
    for (const name of ['OpenSSL', 'OpenSSL-Win64', 'OpenSSL-Win32', 'GnuWin32', 'ScadaMobile4x']) {
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

const OPENSSL_BIN = findOpenSSL();

const openssl = (args) => {
  const out = execFileSync(OPENSSL_BIN, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
};

const main = () => {
  const force = process.argv.includes('--force');
  // --server-only: 既存のルートCA（issystem-ca.key / issystem-ca.crt）を再利用し、
  // サーバー証明書だけを SAN（SSL_HOSTS）付きで再署名する。CA を再生成しないため
  // 各端末の信頼ストア設定はそのまま有効（SAN 変更の推奨経路）。
  const serverOnly = process.argv.includes('--server-only');

  console.log('====================================================');
  console.log('ISSystem プライベートCA / サーバー証明書 生成');
  console.log('====================================================');
  console.log(`出力ディレクトリ: ${CERT_DIR}`);
  console.log(`SANホスト: ${rawHosts.join(', ')}`);

  if (serverOnly && (!fs.existsSync(CA_KEY) || !fs.existsSync(CA_CRT))) {
    console.error('❌ --server-only には既存のルートCA (certs/issystem-ca.key / issystem-ca.crt) が必要です。');
    console.error('   初回は `npm run cert:gen` でルートCA とサーバー証明書を生成してください。');
    process.exit(1);
  }

  if (fs.existsSync(CA_CRT) && fs.existsSync(SRV_PEM) && !force && !serverOnly) {
    console.log('✅ 証明書は既に存在します。');
    console.log('   SAN（SSL_HOSTS）だけ変更する: `npm run cert:gen -- --server-only`（CA は再利用）');
    console.log('   一切を再生成する（CA も交換）: `npm run cert:gen -- --force`（全端末の信頼ストア再設定が必要）');
    printInfo();
    return;
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.chmodSync(CERT_DIR, 0o755);

  // 1. ルートCA（自己署名・CA拡張・SAN付き）
  if (serverOnly) {
    console.log('[1/4] ルートCA は既存のまま再利用します（--server-only）');
  } else {
    console.log('[1/4] ルートCA を生成中...');
    openssl([
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', String(CA_DAYS), '-nodes',
      '-keyout', CA_KEY,
      '-out', CA_CRT,
      '-subj', CA_SUBJECT,
      // SAN を CA にも付与する（サーバー証明書と同じホスト名/IP。信頼ストアや
      // SAN を要求するツールが CA を拒否しないため）
      '-addext', `subjectAltName=${sanItems.join(',')}`,
      '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
      '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    ]);
    fs.chmodSync(CA_KEY, 0o600);
    fs.chmodSync(CA_CRT, 0o644);
    // 旧来名 issystem-ca.pem は常に .crt と同一内容に保つ（古いCAの取り残しを防ぐ）
    fs.copyFileSync(CA_CRT, CA_PEM);
  }

  // 2. サーバー鍵 + CSR
  console.log('[2/4] サーバー鍵・CSR を生成中...');
  openssl([
    'req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', SRV_KEY,
    '-out', CSR_FILE,
    '-subj', SRV_SUBJECT,
  ]);
  fs.chmodSync(SRV_KEY, 0o600);

  // 3. サーバー証明書（CAで署名、SAN/サーバー認証拡張付き）
  console.log('[3/4] サーバー証明書をCAで署名中...');
  fs.writeFileSync(
    EXT_FILE,
    [
      `subjectAltName=${sanItems.join(',')}`,
      'basicConstraints=CA:FALSE',
      'keyUsage=digitalSignature,keyEncipherment',
      'extendedKeyUsage=serverAuth',
    ].join('\n') + '\n',
    'utf8'
  );
  openssl([
    'x509', '-req',
    '-in', CSR_FILE,
    '-CA', CA_CRT,
    '-CAkey', CA_KEY,
    '-CAcreateserial',
    '-out', SRV_PEM,
    '-days', String(SRV_DAYS),
    '-sha256',
    '-extfile', EXT_FILE,
  ]);
  fs.chmodSync(SRV_PEM, 0o644);

  // 4. 検証 + 中間チェーンファイル
  console.log('[4/4] 証明書の検証...');
  const verify = openssl(['verify', '-CAfile', CA_CRT, SRV_PEM]).trim();
  console.log(`  openssl verify: ${verify}`);

  fs.writeFileSync(CHAIN_PEM, fs.readFileSync(SRV_PEM, 'utf8') + fs.readFileSync(CA_CRT, 'utf8'), 'utf8');

  // 後片付け（CSR / ext / serial は一時ファイル）
  for (const f of [CSR_FILE, EXT_FILE, SERIAL_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  printInfo();

  console.log('');
  console.log('【次のステップ】');
  if (serverOnly) {
    console.log('  1. ルートCA は変更していません（指紋は不変）。各端末の信頼ストア設定は有効のまま。');
    console.log(`     サーバー証明書 SAN: ${rawHosts.join(', ')}`);
    console.log('     → サーバーを再起動し、ブラウザで https://<SANのホスト/IP>:3443/ を開く。');
  } else {
    console.log(`  1. 端末の信頼ストアに ${path.relative(ROOT, CA_CRT)} をインストール（ブラウザ/OS/Node）`);
    console.log('     - Windows: .crt をダブルクリック →「信頼されたルート」にインストール');
    console.log('     - macOS:   開いて「環境」で常時信頼');
    console.log('     - Node:    NODE_EXTRA_CA_CERTS=./certs/issystem-ca.crt');
  }
  console.log('  2. サーバーを起動: npm start （HTTPS: 3443, 非HTTPはCAダウンロードページを表示）');
};

const printInfo = () => {
  try {
    const ca = new crypto.X509Certificate(fs.readFileSync(CA_CRT));
    const srv = new crypto.X509Certificate(fs.readFileSync(SRV_PEM));
    console.log('');
    console.log(`ルートCA   : ${ca.subject}`);
    console.log(`  SHA-256指紋: ${sha256Fingerprint(ca)}`);
    console.log(`  SAN        : ${ca.subjectAltName || '(なし)'}`);
    console.log(`  有効期限   : ${ca.validTo}`);
    console.log(`サーバー証明書: ${srv.subject}`);
    console.log(`  発行者     : ${srv.issuer}`);
    console.log(`  SAN        : ${srv.subjectAltName || '(なし)'}`);
    console.log(`  有効期限   : ${srv.validTo}`);
  } catch (e) {
    console.warn('[WARN] 証明書情報の表示に失敗:', e.message);
  }
};

main();
