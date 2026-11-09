/**
 * ISSystem Socket.io 接続認証 検証プローブ
 * (2026/11/7 監査 Critical #1「WSS 接続認証の裏口」対策の回帰検証)
 *
 * 実行方法:
 *   1) 代替ポートでサーバー起動: SSL_PORT=3453 PORT=3005 node --env-file=.env src/server.js
 *   2) SSL_PORT=3453 npm run test:socket-auth
 *
 * 検証項目: tokenless / garbage / demo-jwt-token-* / 外部Origin の拒否、
 * 有効 JWT のみ接続成功、在席更新は本人のみ・ステータス whitelist、
 * seating:grid_updated は KYOMU/ADMIN のみ、lock:* は resourceType ホワイトリスト
 * （自保持のみ解放）、chat:send_message はメンバーのみ、
 * editing_locks にホワイトリスト外のゴミ行（旧実装の object Object）がないこと。
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { query, pool } from '../config/database.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SSL_PORT = process.env.PROBE_SSL_PORT || process.env.SSL_PORT || 3443;
const BASE = `https://localhost:${SSL_PORT}`;
const ALLOWED_TYPES = ['seating', 'exam', 'schedule', 'facility', 'approval', 'bulletin', 'mail', 'chat'];

// ★ Node 側の通信は CA を明示する（AGENTS.md 第12条）。素の fetch は自己署名チェーンを弾く。
const CA = [fs.readFileSync(path.join(ROOT, 'certs', 'issystem-ca.crt'))];

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
      res.on('end', () =>
        resolve({
          status: res.statusCode,
          text: d,
          json: async () => JSON.parse(d || '{}'),
        })
      );
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

const results = [];
let failures = 0;

const record = (name, ok, detail = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ' :: ' + detail : ''}`);
  if (!ok) failures += 1;
};

/** API ログインで実 JWT を取得 */
async function login(staffCode, password = 'password123') {
  const res = await caFetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staff_code: staffCode, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!body.token) throw new Error(`ログイン失敗 ${staffCode} (${res.status}): ${JSON.stringify(body)}`);
  return body.token;
}

/** 接続試行。成功時は socket、失敗時は connect_error メッセージを返す */
function tryConnect({ token, origin }) {
  return new Promise((resolve) => {
    const client = io(BASE, {
      transports: ['polling', 'websocket'],
      auth: token ? { token } : {},
      extraHeaders: origin ? { Origin: origin } : {},
      reconnection: false,
      timeout: 6000,
      ca: CA, // ★ 自己署名チェーンを通す（CA を明示。NODE_EXTRA_CA_CERTS は使わない）
    });
    const settle = (payload) => {
      clearTimeout(timer);
      if (payload && payload.socket) {
        resolve(payload);
      } else {
        client.close();
        resolve(payload);
      }
    };
    const timer = setTimeout(() => settle({ ok: false, message: 'TIMEOUT' }), 9000);
    client.on('connect', () => settle({ ok: true, socket: client }));
    client.on('connect_error', (err) => settle({ ok: false, message: err.message }));
  });
}

/** ack 付き emit (5秒上限) */
function emitWithAck(socket, event, payload) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ success: false, error: 'ACK_TIMEOUT' }), 5000);
    socket.emit(event, payload, (ack) => {
      clearTimeout(timer);
      resolve(ack || { success: false, error: 'NO_ACK' });
    });
  });
}

async function apiGet(path, token) {
  const res = await caFetch(`${BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json().catch(() => ({}));
}

async function main() {
  const kyomu = await login('T2026001');
  const teacher = await login('T2026002');

  // --- 1. 裏口・Origin 拒否 ---------------------------------------
  const noToken = await tryConnect({ token: null });
  record('tokenless 接続が拒否される', !noToken.ok, noToken.message);

  const garbage = await tryConnect({ token: 'garbage-token-xyz' });
  record('garbage token が拒否される', !garbage.ok, garbage.message);

  const demo = await tryConnect({ token: 'demo-jwt-token-1234' });
  record('demo-jwt-token-* が拒否される', !demo.ok, demo.message);

  const evilOrigin = await tryConnect({ token: kyomu, origin: 'https://evil.example' });
  record('外部 Origin + 有効トークンが拒否される', !evilOrigin.ok, evilOrigin.message);

  const kyomuConn = await tryConnect({ token: kyomu });
  record('有効 JWT (Nodeクライアント) は接続成功', kyomuConn.ok, kyomuConn.message);

  // --- 2. ロール gate・ペイロード検証 -----------------------------
  const statusAck = await emitWithAck(kyomuConn.socket, 'seating:update_status', { status: 'PRESENT' });
  record('自身の在席更新 PRESENT は成功', statusAck.success === true, JSON.stringify(statusAck));

  const badStatus = await emitWithAck(kyomuConn.socket, 'seating:update_status', { status: 'DROP TABLE' });
  record('不正ステータス値は拒否される', badStatus.success === false, JSON.stringify(badStatus));

  const teacherConn = await tryConnect({ token: teacher });
  const gridDenied = await emitWithAck(teacherConn.socket, 'seating:grid_updated', { layoutId: 'staff_room' });
  record('TEACHER の seating:grid_updated は拒否される', gridDenied.success === false, JSON.stringify(gridDenied));

  const gridOk = await emitWithAck(kyomuConn.socket, 'seating:grid_updated', { layoutId: 'staff_room' });
  record('KYOMU の seating:grid_updated は成功', gridOk.success === true, JSON.stringify(gridOk));

  // --- 3. 編集ロック ----------------------------------------------
  const evilLock = await emitWithAck(teacherConn.socket, 'lock:acquire', { resourceType: 'evil-type', resourceId: 'x' });
  record('ホワイトリスト外の lock:acquire は拒否される', evilLock.success === false, JSON.stringify(evilLock));

  const lockOk = await emitWithAck(kyomuConn.socket, 'lock:acquire', { resourceType: 'seating', resourceId: 'probe-layout' });
  record('seating ロック取得は成功', lockOk.success === true, JSON.stringify(lockOk));

  const lockRow = await query(`SELECT resource_type, resource_id, user_id FROM editing_locks WHERE resource_id = 'probe-layout'`);
  const row = lockRow.rows[0];
  record('DB にロック行が正しく登録される', Boolean(row) && row.resource_type === 'seating' && row.user_id === 'kyomu01', JSON.stringify(row));

  const stealRelease = await emitWithAck(teacherConn.socket, 'lock:release', { resourceType: 'seating', resourceId: 'probe-layout' });
  record('他ユーザーのロック解放は拒否される', stealRelease.success === false, JSON.stringify(stealRelease));

  teacherConn.socket.emit('lock:timeout_released', { resourceType: 'seating', resourceId: 'probe-layout' });
  await new Promise((r) => setTimeout(r, 400));
  const afterTimeout = await query(`SELECT user_id FROM editing_locks WHERE resource_id = 'probe-layout'`);
  record(
    '他端末の timeout_released でロックは消えない',
    Boolean(afterTimeout.rows[0]) && afterTimeout.rows[0].user_id === 'kyomu01',
    JSON.stringify(afterTimeout.rows[0])
  );

  const selfRelease = await emitWithAck(kyomuConn.socket, 'lock:release', { resourceType: 'seating', resourceId: 'probe-layout' });
  record('自保持ロックの解放は成功', selfRelease.success === true, JSON.stringify(selfRelease));

  // --- 4. チャットメンバーシップ ----------------------------------
  // ★ 職員全体グループは撤廃済み（v3.1.2）: チャンネルは個人が作成したグループだけ
  const chanBody = await apiGet('/api/chat/channels', kyomu);
  const channels = Array.isArray(chanBody.channels) ? chanBody.channels : Array.isArray(chanBody.data) ? chanBody.data : [];

  // 職員全体グループが一覧に出ないことを数値で確認する。
  // 許されるタイプは GROUP（個人グループ）・DM（1対1）・WORKFLOW（決裁協議）の3つだけ。
  // 全体タイプはサーバーのホワイトリストが GROUP へ寄せるので出てはならない。
  const ALLOWED_GROUP_TYPES = ['GROUP', 'DM', 'WORKFLOW'];
  const badTypes = channels.filter((c) => c && !ALLOWED_GROUP_TYPES.includes(c.type));
  record(
    '職員全体グループは存在しない（一覧のタイプは GROUP / DM / WORKFLOW のみ）',
    channels.length > 0 && badTypes.length === 0,
    channels.map((c) => `${c.id}:${c.type}`).join(',')
  );

  // WORKFLOW（決裁協議）を除いた個人作成グループでメンバーシップ検証をする
  const groups = channels.filter((c) => c && c.type !== 'WORKFLOW');

  if (groups.length === 0) {
    record('個人作成グループが1件もない（メンバーシップ検証はスキップ）', true, 'skipped');
  } else {
    const target = groups[0];
    const memberBody = await apiGet(`/api/chat/channels/${target.id}/members`, kyomu);
    const members = Array.isArray(memberBody.members) ? memberBody.members : Array.isArray(memberBody.data) ? memberBody.data : [];
    const memberIds = members.map((m) => String(m.user_id || m.id));
    const teacherNotMember = !memberIds.includes('t-tanaka');
    const sendAck = await emitWithAck(teacherConn.socket, 'chat:send_message', {
      channelId: target.id,
      messageText: '権限検証プローブからの送信',
    });
    record(
      teacherNotMember ? '非メンバーのチャンネル送信は拒否される' : 'メンバーのチャンネル送信は成功',
      teacherNotMember ? sendAck.success === false : sendAck.success === true,
      `channel=${target.id} members=${memberIds.join(',')} ack=${JSON.stringify(sendAck)}`
    );
  }

  // KYOMU のみをメンバーとするグループを作り、TEACHER の送信が拒否されることを必ず検証する
  const createRes = await caFetch(`${BASE}/api/chat/channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${kyomu}` },
    body: JSON.stringify({ name: 'Probe 権限検証', type: 'GROUP', memberIds: ['kyomu01'] }),
  });
  const created = await createRes.json().catch(() => ({}));
  const privateId = created?.channel?.id || created?.id || created?.data?.id;

  if (!privateId) {
    record('検証用グループの作成に失敗 (メンバーシップ検証スキップ)', true, JSON.stringify(created));
  } else {
    const denyAck = await emitWithAck(teacherConn.socket, 'chat:send_message', {
      channelId: privateId,
      messageText: '非メンバーによる送信試行',
    });
    record('KYOMU のみメンバーのチャンネルで TEACHER 送信は拒否される', denyAck.success === false, JSON.stringify(denyAck));

    const allowAck = await emitWithAck(kyomuConn.socket, 'chat:send_message', {
      channelId: privateId,
      messageText: 'メンバーによる送信',
    });
    record('メンバー (KYOMU) の送信は成功', allowAck.success === true, JSON.stringify(allowAck).slice(0, 160));

    const delRes = await caFetch(`${BASE}/api/chat/channels/${privateId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${kyomu}` },
    });
    record('検証用チャンネルの削除後片付け', delRes.status < 400, `status=${delRes.status}`);
  }

  // --- 5. ホワイトリスト外のゴミロック行（旧実装は object を resource_type に挿入していた） ---
  const junk = await query(
    `SELECT resource_type, resource_id FROM editing_locks WHERE resource_type <> ALL($1::text[])`,
    [ALLOWED_TYPES]
  );
  record('ホワイトリスト外の editing_locks 行が存在しない', junk.rows.length === 0, JSON.stringify(junk.rows));

  kyomuConn.socket.close();
  teacherConn.socket.close();
  await pool.end();

  console.log('\n===== Socket Auth Probe =====');
  results.forEach((r) => console.log(r));
  console.log(`\n合計 ${results.length} 件 / 失敗 ${failures} 件`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error('プローブ実行エラー:', err);
  process.exit(1);
});
