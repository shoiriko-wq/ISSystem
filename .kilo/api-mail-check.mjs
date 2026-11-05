/**
 * メール接続設定 API 検証
 * 実行: node .kilo/api-mail-check.mjs  (ISSystem サーバーが必要 / UI_BASE, UI_USER, UI_PASS 上書き可)
 */

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';

const failures = [];
const log = (name, val) => console.log(`${name} = ${JSON.stringify(val)}`);
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

const login = async () => {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staff_code: USER, password: PASS }),
  });
  const json = await res.json();
  return { token: json.token, user: json.user };
};

const api = async (method, path, token, body = null) => {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}/api${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
};

const { token, user } = await login();
if (!token) {
  console.error('ログインに失敗しました');
  process.exit(1);
}

// 0. 検証開始前に設定をクリア (既存設定があれば削除して未設定状態から検証)
await api('DELETE', '/mail/account', token);

// 1. 初回は needs_setup = true / ユーザー情報からメールアドレスを提案する
const before = await api('GET', '/mail/account', token);
log('GET 1', { status: before.status, account: before.json?.account });
check('初回は needs_setup', before.status === 200 && before.json?.account?.needs_setup === true, before.json?.account);
check('ユーザー情報の email を提案', typeof before.json?.account?.suggested_email === 'string' && before.json.account.suggested_email.includes('@'), before.json?.account?.suggested_email);

// 2. 不正メール / 短すぎパスワードは 400
const badEmail = await api('POST', '/mail/account', token, { email_address: 'not-an-email', password: 'abcdef' });
check('不正メールは 400', badEmail.status === 400, { status: badEmail.status, message: badEmail.json?.message });
const shortPass = await api('POST', '/mail/account', token, { email_address: 'test@mail.example.com', password: 'abcd' });
check('短いパスワードは 400', shortPass.status === 400, { status: shortPass.status, message: shortPass.json?.message });

// 3. 正常保存 (201) / レスポンスにパスワードは含まれない
const saved = await api('POST', '/mail/account', token, {
  email_address: 'Tanaka.H@issystem.example',
  password: 'mail-secret-123',
  imap_host: 'imap.issystem.example',
  imap_port: '993',
  smtp_host: 'smtp.issystem.example',
  smtp_port: '465',
});
log('POST 保存', { status: saved.status, account: saved.json?.account });
check('保存成功', saved.status === 201 && saved.json?.account?.email_address === 'tanaka.h@issystem.example', saved.json?.account);
check('レスポンスにパスワードなし', !JSON.stringify(saved.json).includes('mail-secret-123'));
check('サーバー設定保存', saved.json?.account?.imap_port === 993 && saved.json?.account?.smtp_port === 465, saved.json?.account);

// 4. 再取得で needs_setup = false
const after = await api('GET', '/mail/account', token);
check('設定済みとして取得', after.status === 200 && after.json?.account?.needs_setup === false && after.json.account.email_address === 'tanaka.h@issystem.example', after.json?.account);

// 5. DB ではパスワードが暗号化保存されている
const { query } = await import('../config/database.js');
const rowRes = await query('SELECT password_enc FROM mail_accounts WHERE user_id = ?', [user.id]);
const enc = rowRes.rows[0]?.password_enc || '';
check('DB のパスワードは暗号文', enc.split(':').length === 3 && !enc.includes('mail-secret-123'), { head: enc.slice(0, 24) });

// 6. 設定削除で未設定へ戻る
const removed = await api('DELETE', '/mail/account', token);
const reset = await api('GET', '/mail/account', token);
check('削除で needs_setup へ', removed.status === 200 && reset.json?.account?.needs_setup === true, { removed: removed.status, reset: reset.json?.account });

console.log('--- mail API result ---');
console.log(failures.length === 0 ? 'ALL PASS' : `NG: ${failures.join(', ')}`);
process.exit(failures.length === 0 ? 0 : 1);
