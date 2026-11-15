/**
 * ISSystem 定期考査 基本情報・実施科目 CSV 一括登録 API テスト (仕様書 §7)
 * 対象: /api/exam/import (template / preview / commit / cancel / 権限 / 実DB突合)
 * user-import.test.js と同一パターン (supertest + app + PostgreSQL 実検証)
 */
import request from 'supertest';
import app from '../src/app.js';
import { query } from '../config/database.js';
import { bearer, closePool } from './helpers.js';

const KYOMU = { staff_code: 'T2026001', password: 'password123' };
const TEACHER = { staff_code: 'T2026002', password: 'password123' };

// 実行ごとに衝突しないテストデータ名
const stamp = String(Date.now()).slice(-6);
const classNameA = `CSVテストA組${stamp}`;
const classNameB = `CSVテストB組${stamp}`;
const classNameC = `CSVテストC組${stamp}`;
const subjectNameA = `CSVテスト国語${stamp}`;
const subjectNameB = `CSVテスト数学${stamp}`;
const roomNameA = `CSV教室A${stamp}`;
const roomNameB = `CSV教室B${stamp}`;
const decisionNameA = `CSV決定国語${stamp}`;
const decisionNameB = `CSV決定不存在${stamp}`;
const examTitle = `CSVインポート考査${stamp}`;

const b64 = (text) => Buffer.from(text, 'utf8').toString('base64');
const dataOf = (res) => res.body.data;

const CLASS_CSV = [
  'grade,name,short_name,is_active',
  `1,${classNameA},CA,TRUE`,
  `2,${classNameB},CB,TRUE`,
  `9,${classNameC},CC,TRUE`,
  `1,${classNameA},CA,TRUE`,
].join('\n');

const SUBJECT_CSV = [
  'name,subject_id,grade,sort_order,notes',
  `${subjectNameA},コ,1,100,CSV科目`,
  `${subjectNameB},ZZZ,1,101,CSV科目`,
].join('\n');

const ROOM_CSV = [
  'name,seats,notes,is_active',
  `${roomNameA},40,CSV教室,TRUE`,
  `${roomNameB},5,少人数,TRUE`,
].join('\n');

const DECISION_HEADERS = [
  'subject_name', 'subject_short', 'subject_id', 'grade', 'stream', 'scope',
  'setter_teacher_id', 'patrol_teacher_id', 'duration_slots', 'duration_minutes', 'room_name', 'notes',
];

const DECISION_CSV = [
  DECISION_HEADERS.join(','),
  `${decisionNameA},CS国,コ,1,OTHER,ALL,田中 先生,,1,60,${roomNameA},CSV決定`,
  `${decisionNameB},CS国2,コ,2,OTHER,ALL,存在しない先生,,1,60,${roomNameA},CSV決定`,
].join('\n');

let kyomuToken = '';
let teacherToken = '';
let examId = '';

describe('考査 CSV 一括登録 API (/api/exam/import)', () => {
  beforeAll(async () => {
    await query("delete from editing_locks where resource_type = 'exam_basic'");
    const k = await request(app).post('/api/auth/login').send(KYOMU);
    expect(k.statusCode).toBe(200);
    kyomuToken = k.body.token;
    const t = await request(app).post('/api/auth/login').send(TEACHER);
    teacherToken = t.body.token;
    const ex = await request(app)
      .post('/api/exam')
      .set('Authorization', bearer(kyomuToken))
      .send({ title: examTitle });
    expect(ex.statusCode).toBe(200);
    examId = dataOf(ex).id;
    expect(examId).toBeTruthy();
  });

  afterAll(async () => {
    await query('delete from exam_subject_decisions where exam_master_id = $1', [examId]);
    await query('delete from classes where name = any($1)', [[classNameA, classNameB, classNameC]]);
    await query('delete from curriculum_subjects where name = any($1)', [[subjectNameA, subjectNameB]]);
    await query('delete from basic_rooms where name = any($1)', [[roomNameA, roomNameB]]);
    await query('delete from exam_masters where id = $1', [examId]);
    await query("delete from editing_locks where resource_type = 'exam_basic'");
    await closePool();
  });

  test('テンプレートは 4 セクションの登録項目列のみ (UTF-8 BOM)', async () => {
    const headers = {
      class: ['grade', 'name', 'short_name', 'is_active'],
      subject: ['name', 'subject_id', 'grade', 'sort_order', 'notes'],
      room: ['name', 'seats', 'notes', 'is_active'],
      decision: DECISION_HEADERS,
    };
    const names = {
      class: 'classes-import-template.csv',
      subject: 'curriculum_subjects-import-template.csv',
      room: 'basic_rooms-import-template.csv',
      decision: 'exam_subject_decisions-import-template.csv',
    };
    for (const section of ['class', 'subject', 'room', 'decision']) {
      const res = await request(app)
        .get(`/api/exam/import/template/${section}`)
        .set('Authorization', bearer(kyomuToken));
      expect(res.statusCode).toBe(200);
      const d = dataOf(res);
      expect(d.headers).toEqual(headers[section]);
      expect(d.fileName).toBe(names[section]);
      expect(d.csvText.charCodeAt(0)).toBe(0xfeff);
      expect(d.csvText.split('\r\n')[0]).toBe('\uFEFF' + headers[section].join(','));
    }
    const bad = await request(app)
      .get('/api/exam/import/template/plan')
      .set('Authorization', bearer(kyomuToken));
    expect(bad.statusCode).toBe(400);
  });

  test('preview は section / exam_master_id / csvBase64 を検証する', async () => {
    const csv = b64('grade,name,short_name,is_active\n1,X,1X,TRUE');
    const badSection = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'plan', exam_master_id: examId, csvBase64: csv });
    expect(badSection.statusCode).toBe(400);
    expect(badSection.body.message).toContain('section');

    const noExam = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: '', csvBase64: csv });
    expect(noExam.statusCode).toBe(400);
    expect(noExam.body.message).toContain('exam_master_id');

    const noCsv = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: '' });
    expect(noCsv.statusCode).toBe(400);

    const headerOnly = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64('grade,name,short_name,is_active') });
    expect(headerOnly.statusCode).toBe(200);
    expect(dataOf(headerOnly).total_rows).toBe(0);
    expect(dataOf(headerOnly).valid_rows).toBe(0);
  });

  test('preview は全行を検証し staging と編集ロックを取得する（DB 書き込みなし）', async () => {
    const res = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV), fileName: 'classes.csv' });
    expect(res.statusCode).toBe(200);
    const d = dataOf(res);
    expect(d.preview_id).toMatch(/^[0-9a-f]{40}$/);
    expect(d.total_rows).toBe(4);
    expect(d.valid_rows).toBe(2);
    expect(d.invalid_rows).toBe(2);
    expect(d.rows[0].row).toBe(2);
    expect(d.rows[0].action).toBe('create');
    expect(d.rows[0].ok).toBe(true);
    expect(d.rows[2].ok).toBe(false);
    expect(d.rows[2].errors.join('')).toContain('grade');
    expect(d.rows[3].action).toBe('skip');
    expect(d.rows[3].errors.join('')).toContain('キー重複');
    expect(d.locked).toBe(true);
    expect(d.locks[0].user_id).toBe('kyomu01');

    // staging だけの状態 = DB へはまだ書き込まれていない
    const db = await query('select count(*) c from classes where name = any($1)', [[classNameA, classNameB, classNameC]]);
    expect(Number(db.rows[0].c)).toBe(0);

    // 編集ロックが実テーブルへ入っている
    const lock = await query("select user_id from editing_locks where resource_type = 'exam_basic' and resource_id = 'exam_basic_class'");
    expect(lock.rows[0].user_id).toBe('kyomu01');

    // 同じ CSV の再 preview は staging を再利用する
    const again = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV) });
    expect(again.body.data.preview_id).toBe(d.preview_id);

  });


  test('科目 preview は教科マスタ名を突合し、教室 preview は座席数を警告する', async () => {
    const subj = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'subject', exam_master_id: examId, csvBase64: b64(SUBJECT_CSV) });
    expect(subj.statusCode).toBe(200);
    const s = dataOf(subj);
    expect(s.total_rows).toBe(2);
    expect(s.valid_rows).toBe(1);
    expect(s.rows[1].ok).toBe(false);
    expect(s.rows[1].errors.join('')).toContain('subject_id');

    const room = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'room', exam_master_id: examId, csvBase64: b64(ROOM_CSV) });
    expect(room.statusCode).toBe(200);
    const r = dataOf(room);
    expect(r.valid_rows).toBe(2);
    expect(r.rows[1].warn.join('')).toContain('座席');
  });

  test('決定 preview は出題者と教室名を実データへ突合する（未登録教室は不可行）', async () => {
    const res = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(DECISION_CSV) });
    expect(res.statusCode).toBe(200);
    const d = dataOf(res);
    expect(d.valid_rows).toBe(0);
    expect(d.locked).toBe(false);
    expect(d.rows[0].errors.join('')).toContain('教室名');
    expect(d.rows[1].errors.join('')).toContain('出題者');

    const missing = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'decision', exam_master_id: 'no-such-exam', csvBase64: b64(DECISION_CSV) });
    expect(missing.statusCode).toBe(404);
    expect(missing.body.message).toContain('考査');
  });

  test('commit は検証済み行のみ基本情報へ登録する（クラス）', async () => {
    const cls = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV), rows: [2, 3] });
    expect(cls.statusCode).toBe(201);
    const d = dataOf(cls);
    expect(d.registered_count).toBe(2);
    expect(d.results.map((x) => x.action)).toEqual(['create', 'create']);

    const db = await query(
      'select id, name, grade from classes where name = any($1) order by grade asc',
      [[classNameA, classNameB]],
    );
    expect(db.rows.map((r) => r.name)).toEqual([classNameA, classNameB]);

    // 消费済み staging の再 commit は 400
    const re = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV), rows: [2] });
    expect(re.statusCode).toBe(400);

    // 登録不可行を含む commit は 400（行 4 は grade が不正）
    const badRow = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV) });
    expect(badRow.statusCode).toBe(200);
    const bad = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV), rows: [4] });
    expect(bad.statusCode).toBe(400);
    expect(bad.body.message).toContain('登録不可行');

    // preview に存在しない行番号は 400
    const out = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV), rows: [99] });
    expect(out.statusCode).toBe(400);

    // 取り消しで staging と編集ロックが消える
    const cancel = await request(app)
      .post('/api/exam/import/cancel')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV) });
    expect(cancel.statusCode).toBe(200);
    expect(dataOf(cancel).cancelled).toBe(true);
    const lock = await query("select count(*) c from editing_locks where resource_type = 'exam_basic' and resource_id = 'exam_basic_class'");
    expect(Number(lock.rows[0].c)).toBe(0);
    const after = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV), rows: [2] });

  });


  test('commit は科目・教室の検証済み行を登録し、決定行は出題者・教室を ID 解決して書く', async () => {
    const subj = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'subject', exam_master_id: examId, csvBase64: b64(SUBJECT_CSV), rows: [2] });
    expect(subj.statusCode).toBe(201);
    expect(dataOf(subj).registered_count).toBe(1);

    const subjDb = await query('select name, subject_id from curriculum_subjects where name = $1', [subjectNameA]);
    expect(subjDb.rows[0].subject_id).toBe('コ');

    const room = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'room', exam_master_id: examId, csvBase64: b64(ROOM_CSV), rows: [2, 3] });
    expect(room.statusCode).toBe(201);
    expect(dataOf(room).registered_count).toBe(2);

    const roomDb = await query('select name, seats from basic_rooms where name = any($1) order by name asc', [[roomNameA, roomNameB]]);
    expect(roomDb.rows.map((r) => Number(r.seats))).toEqual([40, 5]);

    // 教室が登録されたので決定行 1 は登録可能、出題者名不明の行 2 は不可行のまま
    const dpv = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(DECISION_CSV) });
    expect(dpv.statusCode).toBe(200);
    const d = dataOf(dpv);
    expect(d.valid_rows).toBe(1);
    expect(d.rows[0].action).toBe('create');
    expect(d.rows[1].ok).toBe(false);

    const dec = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(DECISION_CSV), rows: [2] });
    expect(dec.statusCode).toBe(201);
    expect(dataOf(dec).registered_count).toBe(1);

    const list = await request(app)
      .get(`/api/exam/${examId}/decisions`)
      .set('Authorization', bearer(kyomuToken));
    expect(list.statusCode).toBe(200);
    const created = list.body.data.decisions.find((x) => x.subject_name === decisionNameA);
    expect(created).toBeTruthy();
    expect(Number(created.grade)).toBe(1);

    // 同一 CSV の再 commit は update として扱う（決定行はキー一致で更新）
    const dpv2 = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(DECISION_CSV) });
    expect(dataOf(dpv2).rows[0].action).toBe('update');
    const dec2 = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(DECISION_CSV), rows: [2] });
    expect(dec2.statusCode).toBe(201);
    expect(dataOf(dec2).results[0].action).toBe('update');
    const decList = await request(app)
      .get(`/api/exam/${examId}/decisions`)
      .set('Authorization', bearer(kyomuToken));
    expect(decList.body.data.decisions.filter((x) => x.subject_name === decisionNameA).length).toBe(1);
  });

  test('CSV 一括登録は教務部限定（TEACHER は 403 / 未ログインは 401）', async () => {
    const t = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(teacherToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV) });
    expect(t.statusCode).toBe(403);

    const tc = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(teacherToken))
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV), rows: [2] });
    expect(tc.statusCode).toBe(403);

    const tmpl = await request(app)
      .get('/api/exam/import/template/class')
      .set('Authorization', bearer(teacherToken));
    expect(tmpl.statusCode).toBe(403);

    const anon = await request(app)
      .post('/api/exam/import/preview')
      .send({ section: 'class', exam_master_id: examId, csvBase64: b64(CLASS_CSV) });
    expect(anon.statusCode).toBe(401);
  });

  test('期限切れ preview の cleanup ルートは存在しない（サービス内部運用）', async () => {
    const res = await request(app)
      .get('/api/exam/import/cleanup')
      .set('Authorization', bearer(kyomuToken));
    expect(res.statusCode).toBe(404);
  });
});