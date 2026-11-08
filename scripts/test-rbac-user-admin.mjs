/**
 * ISSystem RBAC API 回帰テスト (2026/11/8)
 * /api/users 系・招待コード発行・チャットチャンネル削除の RBAC を API 実測で検証する。
 * 権限マトリクス:
 * - TEACHER: 一覧は sanitizedName (email/extension_number/password_hash なし) / 作成 403 / 削除 403 / 招待発行 403 / チャンネル削除 403 (作成は可)
 * - KYOMU (教務主任): 一覧全件 (password_hash は一切返さない) / 作成可 (role は TEACHER 固定＝ADMIN 昇格抑止) / 削除 403 / 招待発行 201 / チャンネル削除 200
 * - ADMIN: 作成 (role 指定可)・ユーザー削除・チャンネル削除・招待発行すべて可能
 * 前提: サーバー稼働中（API は https://localhost:3443/api、CA 証明書 certs/issystem-ca.crt を NODE_EXTRA_CA_CERTS 経由で信頼）で scripts/seed.js の種目が完了していること。
 */

const API_BASE = process.env.API_BASE || 'https://localhost:3443/api';

const results = [];
const record = (item, pass, detail = '') => {
  results.push({ item, pass, detail });
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${item}${detail ? ` (${detail})` : ''}`);
};

const api = async (method, path, body, token) => {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
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

const login = async (staffCode) => {
  const res = await api('POST', '/auth/login', { staff_code: staffCode, password: 'password123' });
  if (res.status !== 200 || !res.json?.token) {
    throw new Error(`ログイン失敗: ${staffCode} status=${res.status}`);
  }
  return res.json.token;
};

(async () => {
  console.log('=== RBAC ユーザー管理・招待コード・チャンネル削除 API 検証 ===');

  // 教務主任 (KYOMU)・一般教員 (TEACHER)・システム管理者 (ADMIN) のトークンを取得
  const kyomuToken = await login('T2026001');   // 教務 主任 (KYOMU)
  const teacherToken = await login('T2026002'); // 田中 先生 (TEACHER)
  const adminToken = await login('T2026000');   // システム 管理者 (ADMIN)

  // --- 1. ユーザー一覧のフィールド最小化 (TEACHER にメール・内線・ハッシュを返さない) ---
  const teacherList = await api('GET', '/users', null, teacherToken);
  const sanitized = (teacherList.json?.users || []).every(
    (u) => u.email === undefined && u.extension_number === undefined && u.password_hash === undefined && u.staff_code && u.name
  );
  record('TEACHER GET /users は 200 かつ sanitizedName (email/extension_number/hash なし)', teacherList.status === 200 && sanitized, `status=${teacherList.status}`);

  const kyomuList = await api('GET', '/users', null, kyomuToken);
  const kyomuUsers = kyomuList.json?.users || [];
  const hasEmail = kyomuUsers.some((u) => u.email);
  const noHash = kyomuUsers.every((u) => u.password_hash === undefined);
  record('KYOMU GET /users は 200 で email 含む全件・password_hash は一切返さない', kyomuList.status === 200 && hasEmail && noHash, `status=${kyomuList.status} hasEmail=${hasEmail} noHash=${noHash}`);

  const adminList = await api('GET', '/users', null, adminToken);
  record('ADMIN GET /users は 200 で全件', adminList.status === 200 && (adminList.json?.users || []).some((u) => u.email), `status=${adminList.status}`);

  // --- 2. ユーザー作成 (権限昇格の消去) ---
  const tempStaff = `RB${String(Date.now()).slice(-6)}`;
  const tCreate = await api('POST', '/users', { staff_code: tempStaff, name: 'RBAC テスト', password: 'password123', role: 'ADMIN' }, teacherToken);
  record('TEACHER POST /users (role:ADMIN) は 403 (教職員アカウント作成権限なし)', tCreate.status === 403, `status=${tCreate.status}`);

  const kCreate = await api('POST', '/users', { staff_code: tempStaff, name: 'RBAC テスト', password: 'password123', role: 'ADMIN' }, kyomuToken);
  const createdRole = kCreate.json?.user?.role;
  record('KYOMU POST /users は 201 だが role は TEACHER 固定 (ADMIN への権限昇格抑止)', kCreate.status === 201 && createdRole === 'TEACHER', `status=${kCreate.status} role=${createdRole}`);
  const createdId = kCreate.json?.user?.id;

  // --- 3. ユーザー削除 (ADMIN のみ) ---
  const tDelete = await api('DELETE', `/users/${createdId}`, null, teacherToken);
  record('TEACHER DELETE /users/:id は 403', tDelete.status === 403, `status=${tDelete.status}`);

  const kDelete = await api('DELETE', `/users/${createdId}`, null, kyomuToken);
  record('KYOMU DELETE /users/:id は 403 (削除は ADMIN のみ)', kDelete.status === 403, `status=${kDelete.status}`);

  const aDelete = await api('DELETE', `/users/${createdId}`, null, adminToken);
  record('ADMIN DELETE /users/:id は 200 (KYOMU が作成したテストアカウントを掃除)', aDelete.status === 200, `status=${aDelete.status}`);

  // --- 4. 招待コード発行 (KYOMU/ADMIN のみ) ---
  const tInv = await api('POST', '/auth/generate-invitation', {}, teacherToken);
  record('TEACHER POST /auth/generate-invitation は 403', tInv.status === 403, `status=${tInv.status}`);

  const kInv = await api('POST', '/auth/generate-invitation', {}, kyomuToken);
  record('KYOMU POST /auth/generate-invitation は 201 (128bit=32文字16進大写コード)', kInv.status === 201 && /^[0-9A-F]{32}$/.test(kInv.json?.code || ''), `status=${kInv.status} code=${kInv.json?.code?.slice(0, 8)}…(${(kInv.json?.code || '').length}文字)`);

  const aInv = await api('POST', '/auth/generate-invitation', {}, adminToken);
  record('ADMIN POST /auth/generate-invitation は 201', aInv.status === 201, `status=${aInv.status}`);

  // --- 5. チャットチャンネル削除 (KYOMU/ADMIN のみ。作成は全教職員維持) ---
  const group = await api('POST', '/chat/channels', { name: 'RBAC検証グループ', type: 'PRIVATE', memberIds: ['kyomu01', 't-tanaka'] }, kyomuToken);
  const channelId = group.json?.channel?.id || group.json?.data?.id;
  record('KYOMU POST /chat/channels グループ作成は 201 (作成は全員開放のまま)', group.status === 201 && channelId, `status=${group.status} id=${channelId}`);

  const tGroupDelete = await api('DELETE', `/chat/channels/${channelId}`, null, teacherToken);
  record('TEACHER (グループメンバー) DELETE /chat/channels/:id は 403', tGroupDelete.status === 403, `status=${tGroupDelete.status}`);

  const kGroupDelete = await api('DELETE', `/chat/channels/${channelId}`, null, kyomuToken);
  record('KYOMU DELETE /chat/channels/:id は 200 (教務部は削除可)', kGroupDelete.status === 200, `status=${kGroupDelete.status}`);

  // 教員自分のグループ: 作成可・削除は 403、ADMIN が掃除して後片付け
  const tGroup = await api('POST', '/chat/channels', { name: 'RBAC教員グループ', type: 'PRIVATE', memberIds: ['t-tanaka'] }, teacherToken);
  const tChannelId = tGroup.json?.channel?.id || tGroup.json?.data?.id;
  record('TEACHER POST /chat/channels 自身グループ作成は 201 (作成制限なし)', tGroup.status === 201 && tChannelId, `status=${tGroup.status}`);

  const tOwnDelete = await api('DELETE', `/chat/channels/${tChannelId}`, null, teacherToken);
  record('TEACHER 自分作成グループの DELETE も 403 (削除は教務部以上)', tOwnDelete.status === 403, `status=${tOwnDelete.status}`);

  const cleanup = await api('DELETE', `/chat/channels/${tChannelId}`, null, adminToken);
  record('ADMIN が教員グループを掃除して 200 (後片付け)', cleanup.status === 200, `status=${cleanup.status}`);

  const failed = results.filter((r) => !r.pass);
  console.log('=====');
  console.log(`合計 ${results.length} 件 / 失敗 ${failed.length}`);
  if (failed.length) {
    failed.forEach((f) => console.log(`  ✗ ${f.item}: ${f.detail}`));
    process.exit(1);
  }
  console.log('RBAC ユーザー管理・招待コード・チャンネル削除 API 検証 ALL PASS');
})().catch((err) => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});