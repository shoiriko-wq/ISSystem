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

// 教科マスタ名は data/seed/subject_groups.csv（運用で作り替える実データ）に依存する。
// 固定名をコードへ書かず、beforeAll で実在する教科名を1件読んで突合の正答に使う。
let validSubjectGroup = '';

const subjectCsv = () => [
  'name,subject_id,grade,sort_order,notes',
  `${subjectNameA},${validSubjectGroup},1,100,CSV科目`,
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

const decisionCsv = () => [
  DECISION_HEADERS.join(','),
  `${decisionNameA},CS国,${validSubjectGroup},1,OTHER,ALL,田中 先生,,1,60,${roomNameA},CSV決定`,
  `${decisionNameB},CS国2,${validSubjectGroup},2,OTHER,ALL,存在しない先生,,1,60,${roomNameA},CSV決定`,
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
    // 教科マスタ（data/seed/subject_groups.csv 由来の実データ）から実在教科名を1件取る
    const grp = await query('select name from subjects order by sort_order asc, name asc limit 1');
    expect(grp.rows.length).toBeGreaterThan(0);
    validSubjectGroup = String(grp.rows[0].name);
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

  test('テンプレートは 6 セクションの登録項目列のみ (UTF-8 BOM)', async () => {
    const headers = {
      class: ['grade', 'name', 'short_name', 'is_active'],
      group: ['name', 'color_key', 'sort_order'],
      subject: ['name', 'subject_id', 'grade', 'sort_order', 'notes'],
      room: ['name', 'seats', 'notes', 'is_active'],
      decision: DECISION_HEADERS,
      plan: ['title', 'start_date', 'end_date', 'daily_slots'],
    };
    const names = {
      class: 'classes-import-template.csv',
      group: 'subject_groups-import-template.csv',
      subject: 'curriculum_subjects-import-template.csv',
      room: 'basic_rooms-import-template.csv',
      decision: 'exam_subject_decisions-import-template.csv',
      plan: 'exam_plan-import-template.csv',
    };
    for (const section of ['class', 'group', 'subject', 'room', 'decision', 'plan']) {
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
      .get('/api/exam/import/template/bogus')
      .set('Authorization', bearer(kyomuToken));
    expect(bad.statusCode).toBe(400);
  });

  test('preview は section / exam_master_id / csvBase64 を検証する', async () => {
    const csv = b64('grade,name,short_name,is_active\n1,X,1X,TRUE');
    const badSection = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'bogus', exam_master_id: examId, csvBase64: csv });
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
      .send({ section: 'subject', exam_master_id: examId, csvBase64: b64(subjectCsv()) });
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
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(decisionCsv()) });
    expect(res.statusCode).toBe(200);
    const d = dataOf(res);
    expect(d.valid_rows).toBe(0);
    expect(d.locked).toBe(false);
    expect(d.rows[0].errors.join('')).toContain('教室名');
    expect(d.rows[1].errors.join('')).toContain('出題者');

    const missing = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'decision', exam_master_id: 'no-such-exam', csvBase64: b64(decisionCsv()) });
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
      .send({ section: 'subject', exam_master_id: examId, csvBase64: b64(subjectCsv()), rows: [2] });
    expect(subj.statusCode).toBe(201);
    expect(dataOf(subj).registered_count).toBe(1);

    const subjDb = await query('select name, subject_id from curriculum_subjects where name = $1', [subjectNameA]);
    expect(subjDb.rows[0].subject_id).toBe(validSubjectGroup);

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
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(decisionCsv()) });
    expect(dpv.statusCode).toBe(200);
    const d = dataOf(dpv);
    expect(d.valid_rows).toBe(1);
    expect(d.rows[0].action).toBe('create');
    expect(d.rows[1].ok).toBe(false);

    const dec = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(decisionCsv()), rows: [2] });
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
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(decisionCsv()) });
    expect(dataOf(dpv2).rows[0].action).toBe('update');
    const dec2 = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(decisionCsv()), rows: [2] });
    expect(dec2.statusCode).toBe(201);
    expect(dataOf(dec2).results[0].action).toBe('update');
    const decList = await request(app)
      .get(`/api/exam/${examId}/decisions`)
      .set('Authorization', bearer(kyomuToken));
    expect(decList.body.data.decisions.filter((x) => x.subject_name === decisionNameA).length).toBe(1);
  });

  test('実データ出力（mode=current）は登録済みデータ全件を書き出し、決定は exam_master_id 必須', async () => {
    const countOf = async (sql, params = []) => Number((await query(sql, params)).rows[0].c);
    const headers = {
      class: ['grade', 'name', 'short_name', 'is_active'],
      group: ['name', 'color_key', 'sort_order'],
      subject: ['name', 'subject_id', 'grade', 'sort_order', 'notes'],
      room: ['name', 'seats', 'notes', 'is_active'],
      plan: ['title', 'start_date', 'end_date', 'daily_slots'],
    };
    const names = {
      class: 'classes-current.csv',
      group: 'subject_groups-current.csv',
      subject: 'curriculum_subjects-current.csv',
      room: 'basic_rooms-current.csv',
      plan: 'exam_plan-current.csv',
    };
    const expectCounts = {
      class: await countOf('select count(*) c from classes'),
      group: await countOf('select count(*) c from subjects'),
      subject: await countOf('select count(*) c from curriculum_subjects'),
      room: await countOf('select count(*) c from basic_rooms'),
      plan: await countOf('select count(*) c from exam_masters where is_active = true'),
    };
    for (const section of ['class', 'group', 'subject', 'room', 'plan']) {
      const res = await request(app)
        .get(`/api/exam/import/template/${section}?mode=current`)
        .set('Authorization', bearer(kyomuToken));
      expect(res.statusCode).toBe(200);
      const d = dataOf(res);
      expect(d.mode).toBe('current');
      expect(d.fileName).toBe(names[section]);
      expect(d.row_count).toBe(expectCounts[section]);
      expect(d.csvText.charCodeAt(0)).toBe(0xfeff);
      expect(d.csvText.split('\r\n')[0]).toBe('\uFEFF' + headers[section].join(','));
    }
    const planText = dataOf(
      await request(app).get('/api/exam/import/template/plan?mode=current').set('Authorization', bearer(kyomuToken))
    ).csvText;
    expect(planText).toContain(examTitle);

    const noId = await request(app).get('/api/exam/import/template/decision?mode=current').set('Authorization', bearer(kyomuToken));
    expect(noId.statusCode).toBe(400);
    const decCount = await countOf('select count(*) c from exam_subject_decisions where exam_master_id = $1', [examId]);
    expect(decCount).toBeGreaterThan(0);
    const withId = await request(app)
      .get(`/api/exam/import/template/decision?mode=current&exam_master_id=${examId}`)
      .set('Authorization', bearer(kyomuToken));
    expect(withId.statusCode).toBe(200);
    expect(withId.body.data.row_count).toBe(decCount);
    expect(withId.body.data.csvText).toContain(decisionNameA);

    const decPv = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'decision', exam_master_id: examId, csvBase64: b64(withId.body.data.csvText) });
    expect(decPv.statusCode).toBe(200);
    expect(dataOf(decPv).total_rows).toBe(decCount);
    expect(dataOf(decPv).valid_rows).toBe(decCount);
    expect(dataOf(decPv).rows.every((r) => r.action === 'update')).toBe(true);

    const t403 = await request(app).get('/api/exam/import/template/class?mode=current').set('Authorization', bearer(teacherToken));
    expect(t403.statusCode).toBe(403);
    const anon = await request(app).get('/api/exam/import/template/class?mode=current');
    expect(anon.statusCode).toBe(401);
  });


  test('教室の実データ CSV を編集して commit すると座席数が update される（実DB往復）', async () => {
    const d = dataOf(
      await request(app).get('/api/exam/import/template/room?mode=current').set('Authorization', bearer(kyomuToken))
    );
    const lines = d.csvText.split('\r\n').filter((l) => l.trim() !== '');
    const idx = lines.findIndex((l) => l.startsWith(`${roomNameA},`));
    expect(idx).toBeGreaterThan(0);
    const parts = lines[idx].split(',');
    expect(Number(parts[1])).toBe(40);
    parts[1] = '35';
    lines[idx] = parts.join(',');
    const csvBase64 = b64(lines.join('\r\n'));
    const pv = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'room', exam_master_id: examId, csvBase64 });
    expect(pv.statusCode).toBe(200);
    const pd = dataOf(pv);
    expect(pd.total_rows).toBe(lines.length - 1);
    expect(pd.rows.every((r) => r.action === 'update')).toBe(true);
    const cm = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'room', exam_master_id: examId, csvBase64, rows: [idx + 1] });
    expect(cm.statusCode).toBe(201);
    expect(dataOf(cm).registered_count).toBe(1);
    expect(dataOf(cm).results[0].action).toBe('update');
    const db = await query('select seats from basic_rooms where name = $1', [roomNameA]);
    expect(Number(db.rows[0].seats)).toBe(35);
    await query('update basic_rooms set seats = 40 where name = $1', [roomNameA]);
    await query("delete from editing_locks where resource_type = 'exam_basic'");
  });


  test('教科の実データ CSV は全行 update で、色変更と新規行 commit が教科マスタへ反映される', async () => {
    const groupNew = `CSV教科${stamp}`;
    const d = dataOf(
      await request(app).get('/api/exam/import/template/group?mode=current').set('Authorization', bearer(kyomuToken))
    );
    const lines = d.csvText.split('\r\n').filter((l) => l.trim() !== '');
    const idx = lines.findIndex((l) => l.startsWith(`${validSubjectGroup},`));
    expect(idx).toBeGreaterThan(0);
    const origColor = String(lines[idx].split(',')[1]);
    const parts = lines[idx].split(',');
    parts[1] = 'purple';
    lines[idx] = parts.join(',');
    lines.push(`${groupNew},slate,500`);
    const csvBase64 = b64(lines.join('\r\n'));
    const pv = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'group', exam_master_id: examId, csvBase64 });
    expect(pv.statusCode).toBe(200);
    const pd = dataOf(pv);
    expect(pd.total_rows).toBe(lines.length - 1);
    expect(pd.valid_rows).toBe(lines.length - 1);
    expect(pd.rows[idx - 1].action).toBe('update');
    expect(pd.rows[lines.length - 2].action).toBe('create');
    const cm = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'group', exam_master_id: examId, csvBase64, rows: pd.rows.map((r) => r.row) });
    expect(cm.statusCode).toBe(201);
    expect(dataOf(cm).registered_count).toBe(lines.length - 1);
    const dbColor = await query('select color_key from subjects where name = $1', [validSubjectGroup]);
    expect(String(dbColor.rows[0].color_key).toLowerCase()).toBe('purple');
    const dbNew = await query('select id, name from subjects where name = $1', [groupNew]);
    expect(dbNew.rows.length).toBe(1);
    await query('update subjects set color_key = $2 where name = $1', [validSubjectGroup, origColor]);
    await query('delete from subjects where name = $1', [groupNew]);
    await query("delete from editing_locks where resource_type = 'exam_basic'");
  });


  test('考査期間の実データ CSV commit は試験期間を REGISTERED 化し、新考査名は考査マスタを増やす', async () => {
    const planNew = `CSVプラン考査${stamp}`;
    const d = dataOf(
      await request(app).get('/api/exam/import/template/plan?mode=current').set('Authorization', bearer(kyomuToken))
    );
    const lines = d.csvText.split('\r\n').filter((l) => l.trim() !== '');
    const idx = lines.findIndex((l) => l.startsWith(`${examTitle},`));
    expect(idx).toBeGreaterThan(0);
    const parts = lines[idx].split(',');
    parts[1] = '2026-11-20';
    parts[2] = '2026-11-22';
    parts[3] = '3';
    lines[idx] = parts.join(',');
    lines.push(`${planNew},2026-12-01,2026-12-03,2`);
    const csvBase64 = b64(lines.join('\r\n'));
    const pv = await request(app)
      .post('/api/exam/import/preview')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'plan', exam_master_id: examId, csvBase64 });
    expect(pv.statusCode).toBe(200);
    const pd = dataOf(pv);
    expect(pd.total_rows).toBe(lines.length - 1);
    expect(pd.rows[idx - 1].action).toBe('update');
    expect(pd.rows[lines.length - 2].action).toBe('create');
    // 共有DBの他考査は触らない（テスト考査と新考査の2行だけ commit）
    const cm = await request(app)
      .post('/api/exam/import/commit')
      .set('Authorization', bearer(kyomuToken))
      .send({ section: 'plan', exam_master_id: examId, csvBase64, rows: [idx + 1, lines.length] });
    expect(cm.statusCode).toBe(201);
    expect(dataOf(cm).registered_count).toBe(2);
    expect(dataOf(cm).results.map((r) => r.action)).toEqual(['update', 'create']);
    const db = await query('select start_date, end_date, days_count, daily_slots from exam_masters where id = $1', [examId]);
    expect(String(db.rows[0].start_date).slice(0, 10)).toBe('2026-11-20');
    expect(Number(db.rows[0].days_count)).toBe(3);
    const phases = await query('select plan_phase from exam_phases where exam_master_id = $1', [examId]);
    expect(phases.rows[0].plan_phase).toBe('REGISTERED');
    const newMaster = await query('select id, title, days_count from exam_masters where title = $1', [planNew]);
    expect(newMaster.rows.length).toBe(1);
    expect(Number(newMaster.rows[0].days_count)).toBe(3);
    const newId = String(newMaster.rows[0].id);
    await query('delete from exam_phases where exam_master_id = $1', [newId]);
    await query('delete from exam_masters where id = $1', [newId]);
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