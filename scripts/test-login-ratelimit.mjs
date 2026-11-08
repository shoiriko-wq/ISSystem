/**
 * ISSystem ログイン・招待コード レート制限 API 回帰テスト (v3.0.7, 2026/11/8)
 * 監査 High「ログイン試行制限・アカウントロックなし・招待コード 8 桁総当たり」対策の実測検証。
 * - T9999999（不存在）への 25 回失敗ログイン: 最初の 5 回 401、以降 429（IP+識別子 15分5回・失敗のみカウント）
 * - 失敗ログインが監査ログ LOGIN_FAILED に記録されること（成功 LOGIN のみの旧実装からの検証）
 * - 招待コード: 128bit (32文字16進大写)・コード単位 15分5試行（架空コード 6 試行 → 5×401 + 429）
 * - 実コードの初回登録は 201、used コードの再使用は 401、ADMIN が後片付け（ユーザー削除 200）
 * 前提: サーバー稼働中（API https://localhost:3443/api、CA 信頼）と scripts/seed.js 種目完了。
 * ユーザー単位ロックアウト (423) は test/auth.test.js 8b（サービス直結）で検証。
 * 注意: 失敗ログインキー（IP+識別子）は 15 分ウィンドウを共有しない識別子を使う（UI テストの T2026001 を枯らさない）。
 */

import { randomBytes } from 'crypto';

const API_BASE = process.env.API_BASE || 'https://localhost:3443/api';

const results = [];
const record = (item, pass, detail = '') => {
  results.push({ item, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${item}${detail ? ` (${detail})` : ''}`);
};

const api = async (method, path, body, token) => {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON */ }
  return { status: res.status, json };
};

const login = async (staffCode, password = 'password123') => {
  const res = await api('POST', '/auth/login', { staff_code: staffCode, password });
  if (res.status !== 200 || !res.json?.token) throw new Error(`ログイン失敗: ${staffCode} status=${res.status}`);
  return res.json.token;
};

(async () => {
  console.log('=== ログイン・招待コード レート制限 API 検証 ===');
  const { query, pool } = await import('../config/database.js');

  const kyomuToken = await login('T2026001');
  const adminToken = await login('T2026000');
  record('KYOMU・ADMIN 正常ログインは成功（レート制限は成功をカウントしない）', !!kyomuToken && !!adminToken);

  const before = await query("SELECT count(*)::int AS c FROM audit_logs WHERE action = 'LOGIN_FAILED'");
  const beforeCount = Number(before.rows[0].c);

  // --- 1. 不存在ユーザーへの 25 回失敗ログイン（実行ごとに一意な識別子・キーを共有しない） ---
  const ghostStaff = `G9${Date.now()}`;
  const statuses = [];
  for (let i = 0; i < 25; i++) {
    const r = await api('POST', '/auth/login', { staff_code: ghostStaff, password: 'guess' });
    statuses.push(r.status);
  }
  const first5 = statuses.slice(0, 5);
  const rest = statuses.slice(5);
  record(
    '不存在ユーザー 25 回失敗ログイン: 最初の 5 回 401、6 回目以降 429（15分5回制限）',
    first5.every((s) => s === 401) && rest.every((s) => s === 429),
    `401×${first5.filter((s) => s === 401).length} / 429×${rest.filter((s) => s === 429).length}`
  );
  const after = await query("SELECT count(*)::int AS c FROM audit_logs WHERE action = 'LOGIN_FAILED'");
  const delta = Number(after.rows[0].c) - beforeCount;
  record('失敗ログインが監査ログ LOGIN_FAILED に記録（5 件以上＝サービス到達分）', delta >= 5, `delta=${delta}（429 ブロック分はサービス到達せず）`);

  // --- 2. 招待コード 128bit 化 ---
  const gen = await api('POST', '/auth/generate-invitation', {}, kyomuToken);
  const code = gen.json?.code || '';
  record('招待コードは 128bit (32文字16進大写)', gen.status === 201 && /^[0-9A-F]{32}$/.test(code), `code=${code.slice(0, 8)}… (${code.length}文字)`);

  // --- 3. 架空コード 6 試行（コード単位 15分5試行制限）---
  const fakeCode = randomBytes(16).toString('hex').toUpperCase(); // 実行ごとに一意（レート制限キーを前回実行と共有しない）
  const regStatuses = [];
  for (let i = 0; i < 6; i++) {
    const r = await api('POST', '/auth/register-invitation', {
      invitationCode: fakeCode,
      staff_code: 'T9999998',
      password: 'password123',
      name: 'レートテスト 先生',
    });
    regStatuses.push(r.status);
  }
  record(
    '架空招待コード 6 試行: 5 回 400（無効コード）、6 回目 429（コード単位 15分5試行）',
    regStatuses.slice(0, 5).every((s) => s === 400) && regStatuses[5] === 429,
    JSON.stringify(regStatuses)
  );

  // --- 4. 実コードの初回登録 201・used 再使用 401・ADMIN 後片付け ---
  const tempStaff = `T99${String(Date.now()).slice(-6)}`;
  const reg = await api('POST', '/auth/register-invitation', {
    invitationCode: code,
    staff_code: tempStaff,
    password: 'password123',
    name: 'レートテスト 先生',
  });
  record('実コードの初回登録は 201', reg.status === 201, `status=${reg.status}`);
  const reUse = await api('POST', '/auth/register-invitation', {
    invitationCode: code,
    staff_code: `T99${String(Date.now() + 1).slice(-6)}`,
    password: 'password123',
    name: '再使用テスト',
  });
  record('使用済みコードの再登録は拒否 (400)', reUse.status === 400, `status=${reUse.status}`);

  const users = await api('GET', '/users', null, adminToken);
  const tempUser = (users.json?.users || []).find((u) => u.staff_code === tempStaff);
  const del = tempUser ? await api('DELETE', `/users/${tempUser.id}`, null, adminToken) : { status: -1 };
  record('ADMIN がテストユーザーを削除して後片付け (200)', del.status === 200, `status=${del.status}`);

  await pool.end();

  const failures = results.filter((r) => !r.pass);
  console.log('=====');
  console.log(`合計 ${results.length} 件 / 失敗 ${failures.length}`);
  if (failures.length) {
    console.error('レート制限 API 検証: 失敗あり');
    process.exit(1);
  }
  console.log('レート制限 API 検証 ALL PASS');
})().catch((e) => {
  console.error('レート制限 API 検証: 実行エラー', e);
  process.exit(1);
});