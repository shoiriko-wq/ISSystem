/**
 * ISSystem Integration Tests - 教職員 CSV 一括登録 API (v3.1.15 / 仕様書 §5)
 * preview (実DB突合の検証) → commit (1トランザクション INSERT) → 初回ログイン →
 * アプリ系 API 403 ゲート → 初期パスワード変更 → API 解禁 → 監査ログ を検証する。
 */

import request from 'supertest';
import app from '../src/app.js';
import { query } from '../config/database.js';
import { closePool, bearer } from './helpers.js';

// scripts/seed.js が種目するアカウント (_helpers.js と同一)
const KYOMU = { staff_code: 'T2026001', password: 'password123' };
const TEACHER = { staff_code: 'T2026002', password: 'password123' };

// 実行ごとに衝突しない教職員番号と、全行で使う初期パスワード
const stamp = String(Date.now()).slice(-6);
const codeA = `T9${stamp}a`;
const codeB = `T9${stamp}b`;
const codeAdmin = `T9${stamp}c`;
const codePw = `T9${stamp}d`;
const dupCode = 'T2026001';
const initPw = 'Init2026!8';
const newPw = 'Changed2026!9';
const subjectName = 'CSVテスト科';

// 行1・行2 は正しく、行3〜5 は意図したエラー行 (実DBに存在するデータで検証する)
const csvText = [
  'staff_code,name,role,grade,department,email,password,extension_number,desk_number,group_zone,status_note,subjects',
  `${codeA},CSV テスト 太郎,TEACHER,1,１学年,,${initPw},221,B-77,staff,着任初日,${subjectName}`,
  `${codeB},CSV テスト 二号,TEACHER,2,２学年,,${initPw},222,B-78,staff,,`,
  `${dupCode},既存 教職員,TEACHER,1,１学年,,${initPw}`,
  `${codeAdmin},昇格 テスト,ADMIN,,,,${initPw}`,
  `${codePw},短い パスワード,TEACHER,,,,abc`
].join('\n');

const csvBase64 = Buffer.from(csvText, 'utf8').toString('base64');

let kyomuToken = '';
let teacherToken = '';
let previewId = '';
let importToken = '';

describe('CSV 一括登録 API (/api/users/import)', () => {
  beforeAll(async () => {
    // 教科マスタに検証用教科名を追加する (data/seed/*.csv が無い開発DBでも教科名検証を通すため)
    await query(
      `INSERT INTO subjects (id, name, sort_order, color_key) VALUES ($1, $2, 90, 'SLATE') ON CONFLICT DO NOTHING`,
      [`subj_test_${stamp}`, subjectName]
    );
    const k = await request(app).post('/api/auth/login').send(KYOMU);
    kyomuToken = k.body.token;
    const t = await request(app).post('/api/auth/login').send(TEACHER);
    teacherToken = t.body.token;
  });

  // 1. プレビュー: 実DBと突合した検証結果 (正2行 / 誤3行)。ハッシュはレスポンスに出さない
  it('POST /api/users/import/preview - 5行中2行が登録可・3行が登録不可 (§5)', async () => {
    const res = await request(app)
      .post('/api/users/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ csvBase64, fileName: 'test-users.csv' });

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    previewId = res.body.preview_id;
    expect(previewId).toMatch(/^[0-9a-f]{32}$/);
    expect(res.body.total_rows).toBe(5);
    expect(res.body.valid_rows).toBe(2);
    expect(res.body.invalid_rows).toBe(3);

    const rows = res.body.rows;
    expect(rows[0].valid).toBe(true);
    expect(rows[0].desk_number).toBe('B-77');
    expect(rows[1].valid).toBe(true);
    expect(rows[2].errors.join('')).toContain('教職員番号');
    expect(rows[3].errors.join('')).toContain('昇格');
    expect(rows[4].errors.join('')).toContain('8文字');

    // 初期パスワード・bcrypt ハッシュはレスポンスに出さない
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain(initPw);
    expect(serialized).not.toContain('password_hash');
    expect(rows[0]).not.toHaveProperty('raw_password');
  });

  // 2. 登録不可行を含めた commit は 400 (部分作成なし)
  it('POST /api/users/import/commit - 登録不可行を含むと 400 で作成0件 (§5)', async () => {
    const res = await request(app)
      .post('/api/users/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ preview_id: previewId, rows: [1, 3] });
    expect(res.statusCode).toBe(400);
    const check = await query('select count(*) c from users where staff_code = $1', [codeA]);
    expect(Number(check.rows[0].c)).toBe(0);
  });

  // 3. 正しく選択した2行を1トランザクションで作成 (users + seating_status + 監査ログ)
  it('POST /api/users/import/commit - 2行を1トランザクションで作成し must_change_password=1 (§5)', async () => {
    const res = await request(app)
      .post('/api/users/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ preview_id: previewId, rows: [1, 2] });

    expect(res.statusCode).toBe(201);
    expect(res.body.created_count).toBe(2);
    expect(res.body.must_change_password).toBe(true);

    const users = await query(
      'select staff_code, role, grade, must_change_password, subjects from users where staff_code = any($1)',
      [[codeA, codeB]]
    );
    expect(users.rows.length).toBe(2);
    expect(users.rows.every((r) => Number(r.must_change_password) === 1)).toBe(true);
    expect(users.rows.map((r) => r.role)).toEqual(['TEACHER', 'TEACHER']);

    // 教科名は教科マスタの id として保存される (§5)。id は users.id = 教職員番号
    const rowA = users.rows.find((r) => r.staff_code === codeA);
    expect(rowA.grade).toBe('1');
    expect(JSON.parse(rowA.subjects || '[]')[0]).toBe(`subj_test_${stamp}`);

    const seats = await query(
      'select user_id, desk_number, current_status from seating_status where user_id = any($1)',
      [[codeA, codeB]]
    );
    expect(seats.rows.length).toBe(2);
    expect(seats.rows.find((r) => r.user_id === codeA).desk_number).toBe('B-77');

    const audit = await query("select count(*) c from audit_logs where action = 'USER_IMPORT'");
    expect(Number(audit.rows[0].c)).toBeGreaterThan(0);
  });

  // 4. 初回ログイン: must_change_password=true とフラグ付き JWT
  it('初回ログインは must_change_password=true を返す (§5)', async () => {
    const res = await request(app).post('/api/auth/login').send({ staff_code: codeA, password: initPw });
    expect(res.statusCode).toBe(200);
    expect(res.body.user.must_change_password).toBe(true);
    importToken = res.body.token;
  });

  // 5. アプリ系 API は 403 で遮断。パスワード変更に必要な auth 系は通す (app.js ゲート)
  it('アプリ系 API は 403 PASSWORD_CHANGE_REQUIRED で遮断され auth 系は通る', async () => {
    const blocked = await request(app).get('/api/seating/matrix').set('Authorization', bearer(importToken));
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const me = await request(app).get('/api/auth/me').set('Authorization', bearer(importToken));
    expect(me.statusCode).toBe(200);
  });

  // 6. 初期パスワードを変更すると新トークンが発行され API が解禁される
  it('初期パスワード変更で新トークンが発行され API が解禁 (§5)', async () => {
    const res = await request(app)
      .put('/api/auth/change-password')
      .set('Authorization', bearer(importToken))
      .send({ currentPassword: initPw, newPassword: newPw });

    expect(res.statusCode).toBe(200);
    const fresh = res.body.token;
    expect(fresh).toBeTruthy();

    const ok = await request(app).get('/api/seating/matrix').set('Authorization', bearer(fresh));
    expect(ok.statusCode).toBe(200);

    const db = await query('select must_change_password from users where staff_code = $1', [codeA]);
    expect(Number(db.rows[0].must_change_password)).toBe(0);

    // 初期パスワードでの再ログインはできない
    const old = await request(app).post('/api/auth/login').send({ staff_code: codeA, password: initPw });
    expect(old.statusCode).toBe(401);
  });

  // 7. 消費済みプレビューの再利用は禁止
  it('消費済みプレビューの再 commit は 400 (§5)', async () => {
    const res = await request(app)
      .post('/api/users/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ preview_id: previewId, rows: [1] });
    expect(res.statusCode).toBe(400);
  });

  // 8. 教務部限定 (一般 TEACHER は 403、未ログインは 401)
  it('preview は教務部限定 (TEACHER は 403 / 未ログインは 401)', async () => {
    const t = await request(app)
      .post('/api/users/import/preview')
      .set('Authorization', bearer(teacherToken))
      .send({ csvBase64, fileName: 'x.csv' });
    expect(t.statusCode).toBe(403);

    const anon = await request(app).post('/api/users/import/preview').send({ csvBase64, fileName: 'x.csv' });
    expect(anon.statusCode).toBe(401);
  });

  // 9. テンプレート CSV (列順は README §5 と同一。必須4列 staff_code / name / role / password)
  it('GET /api/users/import/template - 12列の列順と必須4列が一致', async () => {
    const res = await request(app)
      .get('/api/users/import/template')
      .set('Authorization', bearer(kyomuToken));
    expect(res.statusCode).toBe(200);
    expect(res.body.headers).toEqual([
      'staff_code', 'name', 'role', 'grade', 'department', 'email',
      'password', 'extension_number', 'desk_number', 'group_zone', 'status_note', 'subjects'
    ]);
    expect(res.body.required_columns).toEqual(['staff_code', 'name', 'password', 'role']);
    expect(res.body.csvText.charCodeAt(0)).toBe(0xfeff);
  });

  afterAll(async () => {
    await query('delete from users where staff_code = any($1)', [[codeA, codeB]]);
    await query("delete from audit_logs where action = 'USER_IMPORT'");
    await query('delete from subjects where name = $1', [subjectName]);
    await closePool();
  });
});
