/**
 * 基本情報セクション編集ロック E2E テスト（実 DB + 実サービス）
 * 実行: npm run test:exam:lock (= node --env-file=.env scripts/test-exam-basic-lock.mjs)
 * 座席表の編集排他ロック（editing_locks）と同じ仕組みを 4セクション（class/group/subject/room）で検証する。
 * 実行後はテストユーザー・テスト行・exam_basic ロックをクリーンアップする。
 */
import bcrypt from 'bcrypt';
import { query } from '../config/database.js';
import config from '../config/default.js';
import { basicinfoService } from '../src/services/basicinfo.service.js';
import { subjectService } from '../src/services/subject.service.js';

const A = { id: 'lck-kyomu-a', name: 'LCK教務A', role: 'KYOMU' };
const B = { id: 'lck-kyomu-b', name: 'LCK教務B', role: 'KYOMU' };
const T = { id: 'lck-teacher', name: 'LCK教員', role: 'TEACHER' };

const CLASS_A = 'LCK9-1';
const CLASS_B = 'LCK9-2';
const GROUP_A = 'LCK教科国語';
const ROOM_A = 'LCK教室Z';

const failures = [];
const ok = (cond, msg) => {
  console.log(cond ? `  ✓ ${msg}` : `  ✗ ${msg}`);
  if (!cond) failures.push(msg);
};

/** 指定ステータスコードで拒否されることを検証 */
async function expectReject(fn, code, msg) {
  try {
    await fn();
    ok(false, `${msg}（拒否されなかった）`);
  } catch (e) {
    ok(Number(e.statusCode) === code, `${msg} (code=${e.statusCode})`);
  }
}

async function cleanup() {
  await query(`DELETE FROM editing_locks WHERE resource_type = 'exam_basic'`, []);
  await query(`DELETE FROM classes WHERE name LIKE 'LCK%'`, []);
  await query(`DELETE FROM subjects WHERE name LIKE 'LCK%'`, []);
  await query(`DELETE FROM basic_rooms WHERE name LIKE 'LCK%'`, []);
  await query(`DELETE FROM users WHERE id LIKE 'lck-%'`, []);
}

async function prep() {
  await cleanup();
  const hash = bcrypt.hashSync('lcktest', config.auth.bcryptSaltRounds);
  for (const u of [A, B, T]) {
    await query(
      `INSERT INTO users (id, staff_code, name, password_hash, role, grade, is_parttime)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [u.id, u.id, u.name, hash, u.role, null, false]
    );
  }
}

async function main() {
  await prep();

  // 1) 教務がクラスロックを取得（編集可能モード）
  const lock = await basicinfoService.lockSection('class', A);
  ok(lock && String(lock.user_id) === A.id, 'A がクラス編集ロックを取得');
  const locks = await basicinfoService.sectionLocks();
  ok(locks.class && String(locks.class.user_id) === A.id && locks.class.user_name === A.name, 'sectionLocks が保持者（A）を返す');

  // 2) 他教員（B）は書き込み・解除・再取得すべて 423
  await expectReject(() => basicinfoService.assertSectionWritable('class', B), 423, 'B の書き込み検証は 423');
  await expectReject(() => basicinfoService.createItem('class', { grade: 1, name: CLASS_B }, B), 423, 'B のクラス作成は 423');
  await expectReject(() => basicinfoService.updateItem('class', 1, { name: 'x' }, B), 423, 'B のクラス改名は 423');
  await expectReject(() => basicinfoService.unlockSection('class', B), 423, 'B のロック解除は 423');
  await expectReject(() => basicinfoService.lockSection('class', B), 423, 'B のロック再取得は 423');

  // 3) 保持者（A）は書き込み可・心跳（再取得）で TTL 延長
  const created = await basicinfoService.createItem('class', { grade: 1, name: CLASS_A }, A);
  ok(created && String(created.name) === CLASS_A, 'A（保持者）のクラス作成');
  const re = await basicinfoService.lockSection('class', A);
  ok(re && String(re.user_id) === A.id, 'A の再取得（心跳）でロック維持');
  ok((await basicinfoService.sectionLocks()).class, '作成後もロックは保持される');

  // 4) 非教務（TEACHER）はロック取得不可（403）
  await expectReject(() => basicinfoService.lockSection('class', T), 403, '教員はロック取得 403');

  // 5) 解除後は他教務が書ける（ロック未取得時も教務権限で通す＝自動登録との互換）
  const released = await basicinfoService.unlockSection('class', A);
  ok(released && released.released === true, 'A の解除');
  ok(!(await basicinfoService.sectionLocks()).class, '解除でロック消失');
  const createdB = await basicinfoService.createItem('class', { grade: 1, name: CLASS_B }, B);
  ok(createdB && String(createdB.name) === CLASS_B, '解除後の B のクラス作成（ロックなし＝教務権限で通す）');

  // 6) 教科（group）は subject.service 経由でも守られる
  await basicinfoService.lockSection('group', A);
  await expectReject(() => subjectService.createSubject(GROUP_A, B), 423, 'B の教科作成は 423（group）');
  const group = await subjectService.createSubject(GROUP_A, A);
  ok(group, 'A（保持者）の教科作成');
  await basicinfoService.unlockSection('group', A);

  // 7) 教室（room）も同一ロックで守る
  await basicinfoService.lockSection('room', A);
  await expectReject(() => basicinfoService.createItem('room', { name: ROOM_A, seats: 40 }, B), 423, 'B の教室作成は 423（room）');
  const room = await basicinfoService.createItem('room', { name: ROOM_A, seats: 40 }, A);
  ok(room && String(room.name) === ROOM_A, 'A（保持者）の教室作成');
  await basicinfoService.unlockSection('room', A);

  // 8) 4セクションは独立（クラスロックが教室の書き込みを止めない）
  await basicinfoService.lockSection('class', A);
  const room2 = await basicinfoService.createItem('room', { name: 'LCK教室Y', seats: 30 }, B);
  ok(room2, 'クラスロック中は教室（別セクション）の書き込みが通る');
  await basicinfoService.unlockSection('class', A);

  await cleanup();
  console.log(failures.length ? `\n✗ ${failures.length}件失敗` : '\n✓ ALL PASS');
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
