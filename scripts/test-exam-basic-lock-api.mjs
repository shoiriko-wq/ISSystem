/**
 * 基本情報セクション編集ロック API スモークテスト（稼働中サーバーへ実リクエスト）
 * 実行: npm run test:exam:lock:api (= node scripts/test-exam-basic-lock-api.mjs)
 * 前提: サーバー稼働中（HTTPS/WSS 3443）、シード済み教務アカウント（T2026001 / T2026000, 密码 password123）。
 * 証明書: CA を明示的に渡す（fetch は自己署名証明書を弾くため node:https を使う — AGENTS.md 第12条）。
 * 終了後にテスト行とロックをクリーンアップする。
 */
import fs from 'node:fs';
import nodePath from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..');
const CA = [fs.readFileSync(nodePath.join(ROOT, 'certs', 'issystem-ca.crt'))];
const BASE = process.env.API_BASE || 'https://127.0.0.1:3443/api';

const A = { staff_code: 'T2026001', password: 'password123' };
const B = { staff_code: 'T2026000', password: 'password123' };
const ROOM_NAME = 'LCKAPI室';
const CLASS_NAME = 'LCKAPI9';
const KINDS = ['class', 'group', 'subject', 'room'];

const failures = [];
const ok = (cond, msg) => {
  console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`);
  if (!cond) failures.push(msg);
};

const show = (text, n = 120) => String(text || '').replace(/\s+/g, ' ').slice(0, n);

/** CA を明示した HTTPS リクエスト（token があれば Bearer を付ける） */
function request(method, p, body, tok = '') {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p);
    const h = { 'Content-Type': 'application/json' };
    const bodyText = body ? JSON.stringify(body) : '';
    if (bodyText) h['Content-Length'] = String(Buffer.byteLength(bodyText));
    if (tok) h.Authorization = `Bearer ${tok}`;
    const r = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: h, ca: CA }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(d); } catch { json = null; }
        resolve({ status: res.statusCode, json, text: d });
      });
    });
    r.on('error', reject);
    if (bodyText) r.write(bodyText);
    r.end();
  });
}

async function login(creds) {
  const res = await request('POST', '/auth/login', creds);
  const token = res.json?.data?.token || res.json?.token || res.json?.accessToken;
  if (!token) throw new Error(`login failed (${res.status}) ${show(res.text)}`);
  return token;
}


/** 実行前の後片付け（前回失敗時の残行・残ロックを掃除して冪等にする） */
async function cleanup(ta) {
  for (const kind of KINDS) await request('DELETE', `/exam/basic-lock/${kind}`, null, ta);
  const subjects = await request('GET', '/subjects', null, ta);
  for (const s of subjects.json?.subjects || []) {
    if (String(s.name).startsWith('LCKAPI')) await request('DELETE', `/subjects/${s.id}`, null, ta);
  }
  const info = await request('GET', '/basic-info', null, ta);
  const d = info.json?.data || {};
  for (const r of d.rooms || []) {
    if (String(r.name).startsWith('LCKAPI')) await request('DELETE', `/basic-info/room/${r.id}`, null, ta);
  }
  for (const c of d.classes || []) {
    if (String(c.name).startsWith('LCKAPI')) await request('DELETE', `/basic-info/class/${c.id}`, null, ta);
  }
}


async function main() {
  const ta = await login(A);
  const tb = await login(B);
  await cleanup(ta);

  // board にロック状態が載る（basic_info.locks）＝既定は誰もロックしていない＝読み取り専用
  const masters = await request('GET', '/exam/masters', null, ta);
  const examId = (masters.json?.data || []).find((m) => m.status !== 'INACTIVE')?.id || masters.json?.data?.[0]?.id;
  ok(!!examId, `アクティブ考査 ${examId} (${masters.status})`);
  const board0 = await request('GET', `/exam/${examId}/board`, null, ta);
  ok(board0.status === 200 && board0.json?.data?.basic_info?.locks, 'board.basic_info.locks が存在');
  ok(KINDS.every((k) => !board0.json?.data?.basic_info?.locks?.[k]), '初期は全セクションがロックなし（読み取り専用）');

  // A が編集可能モード（クラスロック取得）→ board に保持者が出る
  const acq = await request('POST', '/exam/basic-lock/class', {}, ta);
  ok(acq.status === 200 && acq.json?.success, `A のクラスロック取得 (${acq.status}) ${show(acq.json?.message)}`);
  const board1 = await request('GET', `/exam/${examId}/board`, null, ta);
  const lockA = board1.json?.data?.basic_info?.locks?.class;
  ok(lockA && lockA.user_id && lockA.user_name, `board に保持者表示 (${lockA?.user_name})`);

  // B は編集不能（取得・書き込み・解除すべて 423）
  const acqB = await request('POST', '/exam/basic-lock/class', {}, tb);
  ok(acqB.status === 423, `B のロック再取得は 423 (${acqB.status}) ${show(acqB.json?.message)}`);
  const writeB = await request('POST', '/basic-info/class', { grade: 1, name: CLASS_NAME }, tb);
  ok(writeB.status === 423, `B のクラス作成は 423 (${writeB.status}) ${show(writeB.json?.message)}`);
  const relB = await request('DELETE', '/exam/basic-lock/class', null, tb);
  ok(relB.status === 423, `B のロック解除は 423 (${relB.status})`);

  // 教務（A・保持者）は書き込み可。同一クラス名の再作成は 409
  const writeA = await request('POST', '/basic-info/class', { grade: 1, name: CLASS_NAME }, ta);
  ok(writeA.status === 201, `A（保持者）のクラス作成 (${writeA.status}) ${show(writeA.json?.message)}`);
  const classId = writeA.json?.data?.id;
  const dupA = await request('POST', '/basic-info/class', { grade: 1, name: CLASS_NAME }, ta);
  ok(dupA.status === 409, `同一クラス名の再作成は 409 (${dupA.status}) ${show(dupA.json?.message)}`);

  // 教科（group）は subject.service 経由でも守られる
  const acqG = await request('POST', '/exam/basic-lock/group', {}, ta);
  ok(acqG.status === 200, `A の教科（group）ロック取得 (${acqG.status})`);
  const groupB = await request('POST', '/subjects', { name: 'LCKAPI教科' }, tb);
  ok(groupB.status === 423, `B の教科作成は 423 (${groupB.status}) ${show(groupB.json?.message)}`);
  const groupA = await request('POST', '/subjects', { name: 'LCKAPI教科' }, ta);
  ok(groupA.status === 201, `A（保持者）の教科作成 (${groupA.status})`);
  const groupId = groupA.json?.subject?.id;
  const relG = await request('DELETE', '/exam/basic-lock/group', null, ta);
  ok(relG.status === 200, `A の教科ロック解除 (${relG.status})`);

  // 4セクションは独立（クラスロック中は教室＝別セクションの書き込みが通る）
  const roomB = await request('POST', '/basic-info/room', { name: ROOM_NAME, seats: 40 }, tb);
  ok(roomB.status === 201, `クラスロック中の B の教室作成（別セクション＝通す） (${roomB.status})`);
  const roomId = roomB.json?.data?.id;

  // 解除後はロックなしで教務が書ける（自動登録との互換）
  const relClass = await request('DELETE', '/exam/basic-lock/class', null, ta);
  ok(relClass.status === 200, `A のクラスロック解除 (${relClass.status})`);
  const board2 = await request('GET', `/exam/${examId}/board`, null, ta);
  ok(!board2.json?.data?.basic_info?.locks?.class && !board2.json?.data?.basic_info?.locks?.group, 'board のロックが戻る（読み取り専用）');
  const writeB2 = await request('POST', '/basic-info/class', { grade: 1, name: 'LCKAPI9-2' }, tb);
  ok(writeB2.status === 201, `解除後の B のクラス作成（ロックなし＝教務権限で通す） (${writeB2.status})`);
  const class2Id = writeB2.json?.data?.id;

  // クリーンアップ（テスト行削除・ロック返却）
  const delRoom = await request('DELETE', `/basic-info/room/${roomId}`, null, ta);
  ok(delRoom.status === 200, `テスト教室削除 (${delRoom.status})`);
  const delClass = await request('DELETE', `/basic-info/class/${classId}`, null, ta);
  ok(delClass.status === 200, `テストクラス削除 (${delClass.status})`);
  const delClass2 = await request('DELETE', `/basic-info/class/${class2Id}`, null, ta);
  ok(delClass2.status === 200, `テストクラス2削除 (${delClass2.status})`);
  const delGroup = await request('DELETE', `/subjects/${groupId}`, null, ta);
  ok(delGroup.status === 200, `テスト教科削除 (${delGroup.status})`);
  const board3 = await request('GET', `/exam/${examId}/board`, null, ta);
  ok(KINDS.every((k) => !board3.json?.data?.basic_info?.locks?.[k]), 'テスト後も全セクションのロックなし');

  console.log(failures.length ? `\n✗ ${failures.length}件失敗` : '\n✓ ALL PASS');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

