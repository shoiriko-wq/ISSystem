/**
 * ISSystem プライベートCA・サーバー証明書生成スクリプト
 *
 * OpenSSL を使って自己署名のルートCA（プライベートCA）と、
 * そのCAで署名されたサーバー証明書（HTTPS/WSS用）を certs/ に生成する。
 *
 * 実行:  npm run cert:gen            # 未存在時のみ生成（冪等）
 *        npm run cert:gen -- --force # 既存があっても再生成
 *
 * 環境変数:
 *   SSL_DIR   = 出力ディレクトリ (既定: ./certs)
 *   SSL_HOSTS = 証明書のSANに含めるホスト/IP (既定: localhost,issystem.local,127.0.0.1,::1)
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
const CA_PEM = path.join(CERT_DIR, 'issystem-ca.pem');
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

const openssl = (args) => {
  const out = execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out;
};

const main = () => {
  const force = process.argv.includes('--force');

  console.log('====================================================');
  console.log('ISSystem プライベートCA / サーバー証明書 生成');
  console.log('====================================================');
  console.log(`出力ディレクトリ: ${CERT_DIR}`);
  console.log(`SANホスト: ${rawHosts.join(', ')}`);

  if (fs.existsSync(CA_PEM) && fs.existsSync(SRV_PEM) && !force) {
    console.log('✅ 証明書は既に存在します。再生成する場合は `npm run cert:gen -- --force` を実行してください。');
    printInfo();
    return;
  }

  fs.mkdirSync(CERT_DIR, { recursive: true });
  fs.chmodSync(CERT_DIR, 0o755);

  // 1. ルートCA（自己署名・CA拡張）
  console.log('[1/4] ルートCA を生成中...');
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', String(CA_DAYS), '-nodes',
    '-keyout', CA_KEY,
    '-out', CA_PEM,
    '-subj', CA_SUBJECT,
    '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]);
  fs.chmodSync(CA_KEY, 0o600);

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
    '-CA', CA_PEM,
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
  const verify = openssl(['verify', '-CAfile', CA_PEM, SRV_PEM]).trim();
  console.log(`  openssl verify: ${verify}`);

  fs.writeFileSync(CHAIN_PEM, fs.readFileSync(SRV_PEM, 'utf8') + fs.readFileSync(CA_PEM, 'utf8'), 'utf8');

  // 後片付け（CSR / ext / serial は一時ファイル）
  for (const f of [CSR_FILE, EXT_FILE, SERIAL_FILE]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  printInfo();

  console.log('');
  console.log('【次のステップ】');
  console.log(`  1. 端末の信頼ストアに ${path.relative(ROOT, CA_PEM)} をインストール（ブラウザ/OS/Node）`);
  console.log('     - Windows: ファイルをダブルクリック →「信頼されたルート」にインストール');
  console.log('     - macOS:   開いて「環境」で常時信頼');
  console.log('     - Node:    NODE_EXTRA_CA_CERTS=./certs/issystem-ca.pem');
  console.log('  2. サーバーを起動: npm start （HTTPS: 3443, 非HTTPはCAダウンロードページを表示）');
};

const printInfo = () => {
  try {
    const ca = new crypto.X509Certificate(fs.readFileSync(CA_PEM));
    const srv = new crypto.X509Certificate(fs.readFileSync(SRV_PEM));
    console.log('');
    console.log(`ルートCA   : ${ca.subject}`);
    console.log(`  SHA-256指紋: ${sha256Fingerprint(ca)}`);
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
