import request from 'supertest';
import app from './src/app.js';
import { query, closeDatabase } from './src/utils/db.js';

const login = await request(app).post('/api/auth/login').send({ staff_code: 'T2026001', password: 'password123' });
const token = login.body.token;
console.log('login', login.statusCode, login.body.user?.role, login.body.user?.id);

const res = await request(app)
  .post('/api/exam')
  .set('Authorization', `Bearer ${token}`)
  .send({ title: 'TMP500考査', start_date: '2099-11-01', end_date: '2099-11-03', days_count: 3, daily_slots: 8, grades: [1, 2, 3] });

console.log('POST /api/exam ->', res.statusCode, JSON.stringify(res.body));
const id = res.body?.data?.id;
if (id) {
  await query('DELETE FROM exam_masters WHERE id = ?', [id]);
  console.log('cleaned', id);
}
await closeDatabase();
