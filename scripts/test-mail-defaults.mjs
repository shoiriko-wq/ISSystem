/**
 * メール接続初期値（.env の秘匿情報）検証
 *
 * 検証項目:
 *  1. .env（Git 除外対象）から IMAP / SMTP 初期値が読み込まれる
 *  2. 実サーバー名が Git 追跡ファイルのどこにも存在しない（GitHub に送らない）
 *  3. 未設定時の API は .env の初期値を返す（メールタブフォームのプリフィル元）
 *  4. サーバー欄を未入力で保存しても .env の初期値が保存される
 *  5. ユーザー指定値は初期値より優先される / レスポンスにパスワードは含まれない
 *  6. 検証後、未設定状態へ戻して .env 初期値がプリフィルされる
 * 実行: node scripts/test-mail-defaults.mjs  （ISSystem サーバーが必要）
 *  options: UI_BASE  UI_USER  UI_PASS
 *  ※ Node 側の API 呼び出しは CA を明示する（AGENTS.md 第12条）。素の fetch は自己署名チェーンで
 *    SELF_SIGNED_CERT_IN_CHAIN になり落ちる（NODE_EXTRA_CA_CERTS は npm script に埋め込まない）。
 * NG が 1 件でもあれば exit code 1
 */
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import config from '../config/default.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const MAIL_PASSWORD = 'default-check-123';
const OVERRIDES = { imap_host: 'imap.issystem.example', imap_port: 993, smtp_host: 'smtp.issystem.example', smtp_port: 465 };

const SECURE = BASE.startsWith('https:');
const CA = SECURE ? [fs.readFileSync(path.join(ROOT, 'certs', 'issystem-ca.crt'))] : null;

/** CA を渡す API 呼び出し（fetch と同じ形の res.status / res.json() を返す） */
function caFetch(url, opts = {}) {
  const u = new URL(url);
  const useHttps = u.protocol === 'https:';
  const mod = useHttps ? https : http;
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    const body = opts.body ? String(opts.body) : null;
    if (body) headers['Content-Length'] = String(Buffer.byteLength(body));
    const reqOpts = {
      hostname: u.hostname,
      port: u.port || (useHttps ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || 'GET',
      headers,
    };
    if (useHttps) reqOpts.ca = CA;
    const r = mod.request(reqOpts, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, text: d, json: async () => JSON.parse(d || '{}') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

const git = (args) => {
  try {
    return execSync(`git --no-pager ${args}`, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (err) {
    return ''; // 該当なし（exit 1）
  }
};

const login = async () => {
  const res = await caFetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staff_code: USER, password: PASS }),
  });
  const json = await res.json();
  return json.token || null;
};

const api = async (method, path, token, body = null) => {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body) headers['Content-Type'] = 'application/json';
  const res = await caFetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const token = await login();
if (!token) {
  console.error('ログインに失敗しました（サーバー起動と CA 信頼を確認してください）');
  process.exit(1);
}

// 1. .env からの読み込み（実値はテストに書かない = 秘匿情報をコミットしない）
const d = config.mail;
const validServer = (host, port) =>
  typeof host === 'string' && /^[A-Za-z0-9.-]+$/.test(host) && Number.isInteger(port) && port >= 1 && port <= 65535;
check('.env から IMAP 初期値が読める', validServer(d.imapHost, d.imapPort), { imap: `${d.imapHost}:${d.imapPort}` });
check('.env から SMTP 初期値が読める', validServer(d.smtpHost, d.smtpPort), { smtp: `${d.smtpHost}:${d.smtpPort}` });

// 2. Git 追跡ファイルとテンプレートに .env の実値が漏れていない
const trackedLeaks = [d.imapHost, d.smtpHost].filter(Boolean).filter((v) => git(`grep -l -F -- "${v}"`) !== '');
check('Git 追跡ファイルに初期値のサーバー名なし', trackedLeaks.length === 0, { leaks: trackedLeaks });
const exampleText = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
const exampleLeaks = [d.imapHost, d.smtpHost].filter(Boolean).filter((v) => exampleText.includes(v));
check('.env.example はプレースホルダー（実値なし）', exampleLeaks.length === 0, { leaks: exampleLeaks });
check('.env は Git 除外対象', git('check-ignore .env').includes('.env'), { ignored: git('check-ignore .env') });

// 0. 未設定状態から検証
await api('DELETE', '/mail/account', token);

// 3. 未設定時は .env の初期値が返る
const before = await api('GET', '/mail/account', token);
const b = before.json?.account || {};
check('未設定で needs_setup', before.status === 200 && b.needs_setup === true, { status: before.status, needs_setup: b.needs_setup });
check('未設定時 API は IMAP 初期値を返す', b.imap_host === d.imapHost && b.imap_port === d.imapPort, { imap: `${b.imap_host}:${b.imap_port}` });
check('未設定時 API は SMTP 初期値を返す', b.smtp_host === d.smtpHost && b.smtp_port === d.smtpPort, { smtp: `${b.smtp_host}:${b.smtp_port}` });

// 4. サーバー欄未入力の保存 -> .env 初期値が保存される
const saved = await api('POST', '/mail/account', token, {
  email_address: `${USER.toLowerCase()}@issystem.example`,
  password: MAIL_PASSWORD,
});
const s = saved.json?.account || {};
check('未入力保存で初期値が保存される',
  saved.status === 201 && s.imap_host === d.imapHost && s.imap_port === d.imapPort && s.smtp_host === d.smtpHost && s.smtp_port === d.smtpPort,
  { status: saved.status, imap: `${s.imap_host}:${s.imap_port}`, smtp: `${s.smtp_host}:${s.smtp_port}` });
check('レスポンスにパスワードなし', !JSON.stringify(saved.json).includes(MAIL_PASSWORD), { keys: Object.keys(s) });

// 5. ユーザー指定値は初期値より優先
const overridden = await api('POST', '/mail/account', token, {
  email_address: `${USER.toLowerCase()}@issystem.example`,
  password: MAIL_PASSWORD,
  ...OVERRIDES,
});
const o = overridden.json?.account || {};
check('ユーザー指定値が初期値より優先',
  overridden.status === 201 && o.imap_host === OVERRIDES.imap_host && o.imap_port === OVERRIDES.imap_port &&
  o.smtp_host === OVERRIDES.smtp_host && o.smtp_port === OVERRIDES.smtp_port,
  { imap: `${o.imap_host}:${o.imap_port}`, smtp: `${o.smtp_host}:${o.smtp_port}` });

// 6. 削除で未設定へ戻り、初期値が再びプリフィルされる（DB を初期状態へ戻す）
await api('DELETE', '/mail/account', token);
const after = await api('GET', '/mail/account', token);
const a = after.json?.account || {};
check('削除で未設定＋初期値プリフィルへ戻る',
  after.status === 200 && a.needs_setup === true && a.imap_host === d.imapHost && a.smtp_port === d.smtpPort,
  { needs_setup: a.needs_setup, imap: `${a.imap_host}:${a.imap_port}` });

console.log('--- mail defaults result ---');
console.log(failures.length === 0 ? 'ALL PASS' : `NG: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);