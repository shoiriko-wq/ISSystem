import { query, closeDatabase } from '../config/database.js';

const counts = await query('SELECT (SELECT count(*) FROM classes) AS classes, (SELECT count(*) FROM subjects) AS subjects, (SELECT count(*) FROM basic_rooms) AS rooms, (SELECT count(*) FROM curriculum_subjects) AS curriculum, (SELECT count(*) FROM exam_slots) AS exam_slots');
console.log('COUNTS=' + JSON.stringify(counts.rows[0]));

const rooms = await query('SELECT id, name, seats FROM basic_rooms ORDER BY id LIMIT 3');
console.log('ROOMS=' + JSON.stringify(rooms.rows));

const cls = await query('SELECT id, grade, name FROM classes ORDER BY grade, id LIMIT 3');
console.log('CLASSES=' + JSON.stringify(cls.rows));

const subj = await query('SELECT id, name FROM subjects ORDER BY id LIMIT 3');
console.log('SUBJECTS=' + JSON.stringify(subj.rows));

await closeDatabase();
