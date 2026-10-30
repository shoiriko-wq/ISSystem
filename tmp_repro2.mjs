import app from './src/app.js';
import { query, closeDatabase } from './src/utils/db.js';
import request from 'supertest';

async function tokenFor(staffCode, password = 'password123') {
  const res = await request(app).post('/api/auth/login').send({ staff_code: staffCode, password });
  return res.body?.token ?? null;
}

const kyomu = await tokenFor('T2026001');

// 新規考査を作成
const created = await request(app)
  .post('/api/exam')
  .set('Authorization', `Bearer ${kyomu}`)
  .send({ title: 'tmp×圧縮', start_date: '2099-12-01', end_date: '2099-12-03', days_count: 3, daily_slots: 8, grades: [1, 2, 3] });
const id = created.body.data.id;

await request(app).post(`/api/exam/${id}/subject-survey/start`).set('Authorization', `Bearer ${kyomu}`);
await request(app).post(`/api/exam/${id}/timetable`).set('Authorization', `Bearer ${kyomu}`);

const before = await query(
  `SELECT day_number, COUNT(*) c, SUM(slot_span) s FROM exam_slots WHERE exam_master_id = ? GROUP BY day_number ORDER BY day_number`,
  [id]
);
console.log('BEFORE', JSON.stringify(before.rows));

const cells = [];
for (let s = 1; s <= 8; s++) cells.push({ day: 2, slot: s });
const put = await request(app).put(`/api/exam/${id}/schedule-cells`).set('Authorization', `Bearer ${kyomu}`).send({ cells });
console.log('PUT', JSON.stringify(put.body));

const after = await query(
  `SELECT day_number, slot_number, slot_span, is_blocked FROM exam_slots WHERE exam_master_id = ? ORDER BY day_number, slot_number`,
  [id]
);
console.log('AFTER', JSON.stringify(after.rows));

await query('DELETE FROM exam_masters WHERE id = ?', [id]);
await query('DELETE FROM audit_logs WHERE resource_id = ?', [id]);
await closeDatabase();
