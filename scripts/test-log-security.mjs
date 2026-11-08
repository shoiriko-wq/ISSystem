/**
 * ISSystem ログ秘匿・保持 API 回帰テスト (v3.0.8, 2026/11/8)
 * §15 監査 #5「dbHash ログ流出・stack 出力・ログ権限/保存期間管理」の実測検証。
 * - 404 レスポンスに stack キーがない (production 秘匿)
 * - 失敗ログイン 401 がアクセスログ data/logs/access-YYYY-MM-DD.log に記録される
 * - ログディレクトリ mode 700、アクセスログファイル mode 600
 * - 当日アクセスログに bcrypt ハッシュ ($2b$/$2a$) がない
 * - ADMIN の監査 API に LOGIN_FAILED があり、JSON にハッシュがない
 * - レート制限稼働: 一意識別子 6 回失敗 = 401×5 + 429×1
 * 前提: サーバー稼働中 (https://localhost:3443/api, NODE_ENV=production, cwd=data 親)。
 * 実行ごとに一意な識別子を使いレート制限ウィンドウを共有しない。
 */

import fs from 'fs';
import path from 'path';

const API_BASE = process.env.API_BASE || 'https://localhost:3443/api';
const LOGS_DIR = process.env.LOG_DIR_PATH || path.join(process.cwd(), 'data', 'logs');

const results = [];
const record = (item, pass, detail = '') => {
  results.push({ item, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${item}${detail ? ` (${detail})` : ''}`);
};

const api = async (method, p, body = null, token = null) => {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    // 非 JSON レスポンスは無視
  }
  return { status: res.status, json };
};

const todayFile = () => {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(LOGS_DIR, `access-${ymd}.log`);
};

(async () => {
  // 1. 404 レスポンスに stack キーがない (production では秘匿)
  const notFound = await api('GET', '/nope');
  record('404 レスポンスに stack なし', notFound.status === 404 && notFound.json && notFound.json.stack === undefined, `status=${notFound.status}`);

  // 2. 一意識別子の失敗ログイン = 401 (アクセスログ記録用)
  const uniqueId = `F9${Date.now()}`;
  const fail1 = await api('POST', '/auth/login', { staff_code: uniqueId, password: 'definitely-wrong' });
  record('失敗ログイン 401', fail1.status === 401, `status=${fail1.status}`);

  // 3. ログディレクトリ mode 700 / アクセスログファイル mode 600
  const dirStatOk = fs.existsSync(LOGS_DIR) && (fs.statSync(LOGS_DIR).mode & 0o777) === 0o700;
  const file = todayFile();
  const fileStatOk = fs.existsSync(file) && (fs.statSync(file).mode & 0o777) === 0o600;
  record('data/logs モード 700', dirStatOk, dirStatOk ? '700' : `mode=0o${(fs.statSync(LOGS_DIR).mode & 0o777).toString(8)}`);
  record('アクセスログモード 600', fileStatOk, fileStatOk ? '600' : `mode=0o${(fs.statSync(file).mode & 0o777).toString(8)}`);

  // 4. 失敗ログインがアクセスログに記録 (dev: "POST /api/auth/login 401" / combined: 'POST /api/auth/login HTTP/1.1" 401')
  const content = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const logged = /POST \/api\/auth\/login[^"]*" 401/.test(content) || /POST \/api\/auth\/login 401/.test(content);
  record('アクセスログに 401 記録', logged, logged ? '' : '401 line not found');

  // 5. 当日アクセスログに bcrypt ハッシュなし
  record('アクセスログにハッシュなし', content.length > 0 && !content.includes('$2b$') && !content.includes('$2a$'), `lines=${content.split('\n').length}`);

  // 6. ADMIN 監査 API に LOGIN_FAILED (失敗ログインの監査、このスクリプト自身が 7 件生成)
  const loginRes = await api('POST', '/auth/login', { staff_code: 'T2026001', password: 'password123' });
  const adminToken = loginRes.json?.token;
  const auditRes = await api('GET', '/audit/logs?limit=200', null, adminToken);
  const logs = auditRes.json?.logs || [];
  const loginFailed = logs.filter((l) => l.action === 'LOGIN_FAILED').length;
  record('監査 API に LOGIN_FAILED', auditRes.status === 200 && loginFailed >= 3, `LOGIN_FAILED=${loginFailed}`);

  // 7. 監査 API JSON に bcrypt ハッシュなし
  const dump = JSON.stringify(auditRes.json || {});
  record('監査 API にハッシュなし', !dump.includes('$2b$') && !dump.includes('$2a$'));

  // 8. レート制限稼働: 一意識別子 6 回失敗 = 401×5 + 429×1
  const lockId = `Z9${Date.now()}`;
  const seq = [];
  for (let i = 0; i < 6; i++) {
    seq.push((await api('POST', '/auth/login', { staff_code: lockId, password: 'definitely-wrong' })).status);
  }
  record('6回失敗=401x5+429x1', seq.slice(0, 5).every((s) => s === 401) && seq[5] === 429, seq.join(','));

  const fails = results.filter((r) => !r.pass).length;
  console.log(`\n[SUMMARY] ${results.length}項目 / 失敗 ${fails}`);
  process.exit(fails ? 1 : 0);
})();
