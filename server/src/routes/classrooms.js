// src/routes/classrooms.js
const express = require('express');
const router = express.Router();
const { db } = require('../db/schema');

// 1. 教室一覧の取得 API (GET /api/classrooms)
router.get('/', (req, res) => {
  try {
    const classrooms = db.prepare('SELECT * FROM classrooms ORDER BY id ASC').all();
    res.json(classrooms);
  } catch (err) {
    res.status(500).json({ error: '教室一覧の取得に失敗しました' });
  }
});

// 2. 教室の新規追加 API (POST /api/classrooms)
router.post('/', (req, res) => {
  const { name, capacity, note } = req.body;
  if (!name) {
    return res.status(400).json({ error: '教室名は必須です' });
  }

  try {
    const stmt = db.prepare('INSERT INTO classrooms (name, capacity, note) VALUES (?, ?, ?)');
    const info = stmt.run(name, capacity || 0, note || '');
    res.status(201).json({ id: info.lastInsertRowid, name, capacity, note });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: '同じ名前の教室が既に存在します' });
    }
    res.status(500).json({ error: '教室の追加に失敗しました' });
  }
});

// 3. 教室情報の更新 API (PUT /api/classrooms/:id)
router.put('/:id', (req, res) => {
  const { id } = req.params;
  const { name, capacity, note } = req.body;

  if (!name) {
    return res.status(400).json({ error: '教室名は必須です' });
  }

  try {
    const stmt = db.prepare('UPDATE classrooms SET name = ?, capacity = ?, note = ? WHERE id = ?');
    const result = stmt.run(name, capacity || 0, note || '', id);

    if (result.changes === 0) {
      return res.status(404).json({ error: '対象の教室が見つかりません' });
    }

    res.json({ id: Number(id), name, capacity, note });
  } catch (err) {
    res.status(500).json({ error: '教室情報の更新に失敗しました' });
  }
});

// 4. 教室の削除 API (DELETE /api/classrooms/:id)
router.delete('/:id', (req, res) => {
  const { id } = req.params;

  try {
    const stmt = db.prepare('DELETE FROM classrooms WHERE id = ?');
    const result = stmt.run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: '対象の教室が見つかりません' });
    }

    res.json({ message: '教室を削除しました' });
  } catch (err) {
    res.status(500).json({ error: '教室の削除に失敗しました' });
  }
});

// 5. 予約一覧の取得 API (GET /api/classrooms/reservations)
router.get('/reservations', (req, res) => {
  const { classroom_id, start, end } = req.query;

  try {
    let query = `
      SELECT r.*, c.name as classroom_name 
      FROM classroom_reservations r
      JOIN classrooms c ON r.classroom_id = c.id
      WHERE 1=1
    `;
    const params = [];

    if (classroom_id) {
      query += ` AND r.classroom_id = ?`;
      params.push(classroom_id);
    }
    if (start) {
      query += ` AND r.end_time >= ?`;
      params.push(start);
    }
    if (end) {
      query += ` AND r.start_time <= ?`;
      params.push(end);
    }

    query += ` ORDER BY r.start_time ASC`;

    const reservations = db.prepare(query).all(...params);
    res.json(reservations);
  } catch (err) {
    res.status(500).json({ error: '予約一覧の取得に失敗しました' });
  }
});

// 6. 新規予約の作成 API (POST /api/classrooms/reservations)
router.post('/reservations', (req, res) => {
  const { classroom_id, title, teacher_name, start_time, end_time, equipment } = req.body;

  if (!classroom_id || !title || !teacher_name || !start_time || !end_time) {
    return res.status(400).json({ error: '必須項目が不足しています' });
  }

  // 重複予約のチェック
  const overlapCheck = db.prepare(`
    SELECT COUNT(*) as count FROM classroom_reservations
    WHERE classroom_id = ? 
      AND start_time < ? 
      AND end_time > ?
  `).get(classroom_id, end_time, start_time);

  if (overlapCheck.count > 0) {
    return res.status(400).json({ error: '指定した時間帯には既に他の予約が入っています' });
  }

  try {
    const stmt = db.prepare(`
      INSERT INTO classroom_reservations (classroom_id, title, teacher_name, start_time, end_time, equipment)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const info = stmt.run(classroom_id, title, teacher_name, start_time, end_time, equipment || '');
    res.status(201).json({ id: info.lastInsertRowid, message: '予約が完了しました' });
  } catch (err) {
    res.status(500).json({ error: '予約の作成に失敗しました' });
  }
});

// 7. 予約の削除 API (DELETE /api/classrooms/reservations/:id)
router.delete('/reservations/:id', (req, res) => {
  const { id } = req.params;

  try {
    const stmt = db.prepare('DELETE FROM classroom_reservations WHERE id = ?');
    const result = stmt.run(id);

    if (result.changes === 0) {
      return res.status(404).json({ error: '対象の予約が見つかりません' });
    }

    res.json({ message: '予約を取り消しました' });
  } catch (err) {
    res.status(500).json({ error: '予約の削除に失敗しました' });
  }
});
module.exports = router;