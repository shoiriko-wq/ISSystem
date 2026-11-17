/**
 * ISSystem Integration Tests - 管理者によるユーザ情報編集 API (v3.2.0追加5 / 仕様書 §5・§7)
 *
 * - `PUT /api/users/:id` は ADMIN のみ (name / email / grade / department / extension_number /
 *   is_parttime / subjects / role / is_kyomu)。KYOMU は 403（担当教科のみ PUT /api/users/:id/subjects）。
 * - 教職員番号 (staff_code) と password_hash は編集対象外（staff_code は座席・チャット・考査監督が FK 参照）。
 * - role と is_kyomu は ADMIN のみ変更できる。ADMIN は自分自身の ADMIN を外せない（ロックアウト防止）。
 * - 監査ログ UPDATE_USER_INFO に差分 (from→to) が残る。password_hash は監査に載せない。
 * 前提: scripts/seed.js の種目が完了していること（実 DB と突合する）。
 */

import request from 'supertest';
import app from '../src/app.js';
import { query } from '../config/database.js';
import { closePool, bearer, loginToken } from './helpers.js';
import { userInfoService } from '../src/services/user-info.service.js';

const ADMIN = { staff_code: 'T2026000', password: 'password123' };
const KYOMU = { staff_code: 'T2026001', password: 'password123' };
const TEACHER = { staff_code: 'T2026002', password: 'password123' };

const stamp = String(Date.now()).slice(-6);
const tempCode = `UI${stamp}`;
const tempPw = 'Temp2026!8';
const subjectName = '情報編集テスト科';

let adminToken = '';
let kyomuToken = '';
let teacherToken = '';
let tempId = '';
let tempToken = '';
let secondSubject = ''; // 教科マスタの現行正式名（テストで固定名を使わない）

const userRow = async (id) => (await query('SELECT * FROM users WHERE id = ?', [id])).rows[0];

describe('管理者によるユーザ情報編集 (PUT /api/users/:id)', () => {
  beforeAll(async () => {
    await query(
      `INSERT INTO subjects (id, name, sort_order, color_key) VALUES ($1, $2, 91, 'SLATE') ON CONFLICT DO NOTHING`,
      [`subj_uinfo_${stamp}`, subjectName]
    );
    adminToken = await loginToken(app, ADMIN);
    kyomuToken = await loginToken(app, KYOMU);
    teacherToken = await loginToken(app, TEACHER);
    // 教科マスタの正式名を現值から取る（他のテストの改名でマスタ名が変わっているため固定名を使わない）
    secondSubject = (await query('SELECT name FROM subjects ORDER BY sort_order ASC, name ASC LIMIT 1')).rows[0]?.name || '';

    // 教務部 (KYOMU) が作成した role TEACHER のテストアカウントを対象にする（ADMIN が掃除する）
    const created = await request(app)
      .post('/api/users')
      .set('Authorization', bearer(kyomuToken))
      .send({ staff_code: tempCode, name: '情報編集 テスト', password: tempPw, role: 'TEACHER' });
    tempId = created.body?.user?.id || created.body?.id;
    tempToken = await loginToken(app, { staff_code: tempCode, password: tempPw });
  });

  // --- 1. 権限: 担当教科以外の編集は ADMIN のみ ---
  it('未ログイン PUT /api/users/:id は 401', async () => {
    const res = await request(app).put(`/api/users/${tempId}`).send({ name: '権限テスト' });
    expect(res.statusCode).toBe(401);
  });

  it('TEACHER は他人と自分のユーザ情報編集 403 (name / role とも)', async () => {
    const other = await request(app).put(`/api/users/${tempId}`).set('Authorization', bearer(teacherToken)).send({ name: '教員が編集' });
    expect(other.statusCode).toBe(403);
    const selfRow = (await query('SELECT id FROM users WHERE staff_code = ?', [TEACHER.staff_code])).rows[0];
    const self = await request(app).put(`/api/users/${selfRow.id}`).set('Authorization', bearer(teacherToken)).send({ role: 'ADMIN' });
    expect(self.statusCode).toBe(403);
    expect((await userRow(selfRow.id)).role).toBe('TEACHER');
  });

  it('KYOMU は担当教科以外の編集 403・role 昇格 403（教務部は担当教科のみ）', async () => {
    const nameEdit = await request(app).put(`/api/users/${tempId}`).set('Authorization', bearer(kyomuToken)).send({ name: '教務が名前を変える' });
    expect(nameEdit.statusCode).toBe(403);
    const roleEdit = await request(app).put(`/api/users/${tempId}`).set('Authorization', bearer(kyomuToken)).send({ role: 'ADMIN' });
    expect(roleEdit.statusCode).toBe(403);
    expect((await userRow(tempId)).name).toBe('情報編集 テスト');
  });

  it('KYOMU は担当教科のみ編集できる (PUT /api/users/:id/subjects は 200 で現行維持)', async () => {
    const res = await request(app)
      .put(`/api/users/${tempId}/subjects`)
      .set('Authorization', bearer(kyomuToken))
      .send({ subjects: [subjectName] });
    expect(res.statusCode).toBe(200);
    const stored = JSON.parse((await userRow(tempId)).subjects);
    expect(stored).toEqual([subjectName]);
  });

  // --- 2. ADMIN は全項目を編集できる ---
  it('ADMIN は name / email / grade / department / 内線 / 非常勤 / role / 教務主任 / 担当教科を一度に編集 200', async () => {
    const body = {
      name: '情報編集 改名',
      email: `uinfo${stamp}@school.ed.jp`,
      grade: '2',
      department: '特色推進部',
      extension_number: '118',
      is_parttime: true,
      role: 'KYOMU',
      is_kyomu: true,
      subjects: [subjectName, secondSubject],
    };
    const res = await request(app).put(`/api/users/${tempId}`).set('Authorization', bearer(adminToken)).send(body);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.password_hash).toBeUndefined();

    const after = await userRow(tempId);
    expect(after.name).toBe('情報編集 改名');
    expect(after.email).toBe(`uinfo${stamp}@school.ed.jp`);
    expect(after.grade).toBe('2');
    expect(after.department).toBe('特色推進部');
    expect(after.extension_number).toBe('118');
    expect(after.is_parttime).toBe(true);
    expect(after.role).toBe('KYOMU');
    expect(Number(after.is_kyomu)).toBe(1);
    expect(JSON.parse(after.subjects)).toEqual(expect.arrayContaining([subjectName, secondSubject]));

    // 教職員番号とパスワードハッシュは編集対象外（ハッシュが変わらなければ同じパスワードで入れ続ける）
    expect(after.staff_code).toBe(tempCode);
    expect(after.password_hash).toMatch(/^\$2b\$/);
    const relogin = await request(app).post('/api/auth/login').send({ staff_code: tempCode, password: tempPw });
    expect(relogin.statusCode).toBe(200);
  });

  it('ADMIN の編集は監査ログ UPDATE_USER_INFO に差分 (from→to) を残す (password_hash は載せない)', async () => {
    const log = (await query("SELECT * FROM audit_logs WHERE action = 'UPDATE_USER_INFO' AND resource_id = ? ORDER BY id DESC LIMIT 1", [tempId])).rows[0];
    expect(log).toBeTruthy();
    const changes = JSON.parse(log.new_value);
    expect(changes.name).toEqual({ from: '情報編集 テスト', to: '情報編集 改名' });
    expect(changes.role).toEqual({ from: 'TEACHER', to: 'KYOMU' });
    expect(changes.is_parttime).toEqual({ from: 'false', to: 'true' });
    expect(log.user_name).toBe('システム 管理者');
    expect(JSON.stringify(log).includes('password_hash')).toBe(false);
  });

  // --- 3. 部分更新と項目検証 ---
  it('ADMIN の部分更新は指定項目だけ変わり他の項目は変わらない', async () => {
    const before = await userRow(tempId);
    const res = await request(app).put(`/api/users/${tempId}`).set('Authorization', bearer(adminToken)).send({ grade: '3' });
    expect(res.statusCode).toBe(200);
    const after = await userRow(tempId);
    expect(after.grade).toBe('3');
    expect(after.name).toBe(before.name);
    expect(after.email).toBe(before.email);
    expect(after.role).toBe('KYOMU');
    expect(after.extension_number).toBe('118');
  });

  it('ADMIN の編集検証: 空氏名・email 形式・email 重複・role ホワイトリスト・学年・内線・未登録教科・変更なしは 400/409', async () => {
    const bad = [
      [{ name: '   ' }, 400],
      [{ email: 'not-an-email' }, 400],
      [{ email: 'admin@school.ed.jp' }, 409], // sys-admin の email と重複
      [{ role: 'BOGUS' }, 400],
      [{ grade: 'abc' }, 400],
      [{ extension_number: 'abc' }, 400],
      [{ subjects: ['未登録教科名'] }, 400],
      [{}, 400],
    ];
    for (const [body, status] of bad) {
      const res = await request(app).put(`/api/users/${tempId}`).set('Authorization', bearer(adminToken)).send(body);
      expect(res.statusCode).toBe(status);
    }
    const missing = await request(app).put('/api/users/ui-none-id').set('Authorization', bearer(adminToken)).send({ name: '存在しない' });
    expect(missing.statusCode).toBe(404);
    // 検証失敗後は何も変わらない
    const after = await userRow(tempId);
    expect(after.name).toBe('情報編集 改名');
    expect(after.grade).toBe('3');
    expect(after.role).toBe('KYOMU');
  });

  // --- 4. ADMIN の role 変更保護（ロックアウト防止・最終 ADMIN 保護）---
  it('ADMIN は自分自身の role を ADMIN 以外へ降格できない (400)', async () => {
    const res = await request(app).put('/api/users/sys-admin').set('Authorization', bearer(adminToken)).send({ role: 'TEACHER' });
    expect(res.statusCode).toBe(400);
    expect((await userRow('sys-admin')).role).toBe('ADMIN');
    // 変更なしの PUT は 200（差分なし）・空 body は 400
    const same = await request(app).put('/api/users/sys-admin').set('Authorization', bearer(adminToken)).send({ role: 'ADMIN' });
    expect(same.statusCode).toBe(200);
    expect(same.body.changes).toEqual({});
  });

  it('ADMIN は role を ADMIN へ昇格できる。ADMIN が2人なら sys-admin を降格でき (200)、ADMIN が1人のとき service は 409 で止める', async () => {
    // temp (KYOMU) を ADMIN へ昇格 → ADMIN 2人
    const promote = await request(app).put(`/api/users/${tempId}`).set('Authorization', bearer(adminToken)).send({ role: 'ADMIN' });
    expect(promote.statusCode).toBe(200);
    expect((await userRow(tempId)).role).toBe('ADMIN');
    expect((await query("SELECT count(*)::int c FROM users WHERE role = 'ADMIN'")).rows[0].c).toBe(2);

    // 昇格後は role が JWT に焼かれているので再ログインする
    const tempAdminToken = await loginToken(app, { staff_code: tempCode, password: tempPw });
    const demote = await request(app).put('/api/users/sys-admin').set('Authorization', bearer(tempAdminToken)).send({ role: 'TEACHER' });
    expect(demote.statusCode).toBe(200);
    expect((await userRow('sys-admin')).role).toBe('TEACHER');

    // 直後に sys-admin を ADMIN へ戻す（ADMIN を必ず残す）
    const restore = await request(app).put('/api/users/sys-admin').set('Authorization', bearer(tempAdminToken)).send({ role: 'ADMIN' });
    expect(restore.statusCode).toBe(200);
    expect((await userRow('sys-admin')).role).toBe('ADMIN');

    // temp を TEACHER へ戻して ADMIN は sys-admin 1人だけにする
    const demote2 = await request(app).put(`/api/users/${tempId}`).set('Authorization', bearer(adminToken)).send({ role: 'TEACHER' });
    expect(demote2.statusCode).toBe(200);
    expect((await query("SELECT count(*)::int c FROM users WHERE role = 'ADMIN'")).rows[0].c).toBe(1);

    // service レベルの第三防衛線: ADMIN が1人のとき ADMIN を ADMIN 以外へ降格しようとしない
    await expect(
      userInfoService.updateByAdmin({ id: 'ghost-admin', name: 'テスト管理者', role: 'ADMIN' }, 'sys-admin', { role: 'TEACHER' })
    ).rejects.toMatchObject({ statusCode: 409 });
    expect((await userRow('sys-admin')).role).toBe('ADMIN');
    // service は ADMIN でない操作者を受け付けない
    await expect(
      userInfoService.updateByAdmin({ id: 'kyomu01', name: '教務 主任', role: 'KYOMU' }, tempId, { name: 'service 経由の名前変更' })
    ).rejects.toMatchObject({ statusCode: 403 });
    expect((await userRow(tempId)).name).toBe('情報編集 改名');
  });

  // --- 5. 一覧表示用フィールド (is_kyomu / is_parttime / 学年) が返る ---
  it('ADMIN・KYOMU の一覧は is_kyomu / is_parttime / grade を含む。TEACHER は名簿最小フィールドのみ', async () => {
    const asAdmin = await request(app).get('/api/users').set('Authorization', bearer(adminToken));
    expect(asAdmin.statusCode).toBe(200);
    const row = asAdmin.body.users.find((u) => u.id === tempId);
    expect(row).toBeTruthy();
    expect(row).toHaveProperty('is_kyomu');
    expect(row).toHaveProperty('is_parttime');
    expect(row.grade).toBe('3');

    const asTeacher = await request(app).get('/api/users').set('Authorization', bearer(teacherToken));
    const trow = asTeacher.body.users.find((u) => u.id === tempId);
    expect(trow.email).toBeUndefined();
    expect(trow.extension_number).toBeUndefined();
    expect(trow.password_hash).toBeUndefined();
  });

  // --- 6. 後片付け（テストアカウント・検証用教科・監査ログを消す）---
  afterAll(async () => {
    await query('DELETE FROM users WHERE id = ?', [tempId]);
    await query('DELETE FROM subjects WHERE id = ?', [`subj_uinfo_${stamp}`]);
    await query("DELETE FROM audit_logs WHERE action = 'UPDATE_USER_INFO'");
    await query(
      `UPDATE users SET name = 'システム 管理者', email = 'admin@school.ed.jp', role = 'ADMIN', grade = 'NONE',
       department = 'システム管理', extension_number = '100', is_kyomu = 0, is_parttime = false, updated_at = NOW()
       WHERE id = 'sys-admin'`
    );
    await closePool();
  });
});

