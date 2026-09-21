const express = require('express');
const router = express.Router();
const { db } = require('../db/schema');

// 配列シャッフル用ヘルパー関数 (Fisher-Yates)
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- クラス管理 API ---
router.get('/classes', (req, res) => {
  try {
    const classes = db.prepare('SELECT * FROM classes ORDER BY id').all();
    res.json(classes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/classes', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'クラス名を入力してください' });
  try {
    const stmt = db.prepare('INSERT INTO classes (name) VALUES (?)');
    const info = stmt.run(name);
    
    // デフォルトレイアウト設定作成
    db.prepare(`
      INSERT INTO seating_layouts (class_id, column_counts, alignment)
      VALUES (?, '[6,7,7,7,7,6]', 'back')
    `).run(info.lastInsertRowid);

    res.status(201).json({ id: info.lastInsertRowid, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/classes/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM classes WHERE id = ?').run(req.params.id);
    res.json({ message: 'クラスを削除しました' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 生徒マスタ API ---
router.get('/students', (req, res) => {
  const { class_id } = req.query;
  try {
    if (class_id) {
      // 特定クラスに所属する生徒一覧
      const students = db.prepare(`
        SELECT s.* FROM students s
        JOIN class_students cs ON s.id = cs.student_id
        WHERE cs.class_id = ?
        ORDER BY s.id
      `).all(class_id);
      return res.json(students);
    }
    // 全生徒マスタ一覧
    const students = db.prepare('SELECT * FROM students ORDER BY id').all();
    res.json(students);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/students', (req, res) => {
  const { id, name, kana, gender, club, subject_option } = req.body;
  if (!id || !name) return res.status(400).json({ error: '生徒IDと氏名は必須です' });
  try {
    const stmt = db.prepare(`
      INSERT INTO students (id, name, kana, gender, club, subject_option)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(id, name, kana || '', gender || '未設定', club || '', subject_option || '');
    res.status(201).json({ message: '生徒を登録しました' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 生徒マスタ更新 API（修正機能用）
router.put('/students/:id', (req, res) => {
  const { name, kana, gender, club, subject_option } = req.body;
  try {
    const stmt = db.prepare(`
      UPDATE students 
      SET name = ?, kana = ?, gender = ?, club = ?, subject_option = ?
      WHERE id = ?
    `);
    stmt.run(name, kana || '', gender || '未設定', club || '', subject_option || '', req.params.id);
    res.json({ message: '生徒情報を更新しました' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/students/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM students WHERE id = ?').run(req.params.id);
    res.json({ message: '生徒を削除しました' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// CSV一括登録
router.post('/students/bulk', (req, res) => {
  const { students } = req.body;
  if (!Array.isArray(students)) return res.status(400).json({ error: 'データ形式が不正です' });

  const insert = db.prepare(`
    INSERT OR REPLACE INTO students (id, name, kana, gender, club, subject_option)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((list) => {
    for (const s of list) {
      insert.run(s.id, s.name, s.kana || '', s.gender || '未設定', s.club || '', s.subject_option || '');
    }
  });

  try {
    transaction(students);
    res.json({ message: `${students.length} 名の生徒データを登録・更新しました` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- クラスへの生徒割り当て API ---
router.post('/classes/:class_id/students', (req, res) => {
  const { student_ids } = req.body; // 配列 [ '101', '102' ]
  const classId = req.params.class_id;

  try {
    const deleteOld = db.prepare('DELETE FROM class_students WHERE class_id = ?');
    const insert = db.prepare('INSERT INTO class_students (class_id, student_id) VALUES (?, ?)');

    db.transaction(() => {
      deleteOld.run(classId);
      for (const sid of student_ids) {
        insert.run(classId, sid);
      }
    })();

    res.json({ message: 'クラス所属生徒を更新しました' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 座席レイアウト API ---
router.get('/layout/:class_id', (req, res) => {
  try {
    let layout = db.prepare('SELECT * FROM seating_layouts WHERE class_id = ?').get(req.params.class_id);
    if (!layout) {
      layout = { class_id: req.params.class_id, column_counts: '[6,7,7,7,7,6]', alignment: 'back' };
    } else {
      layout.column_counts = JSON.parse(layout.column_counts || '[6,7,7,7,7,6]');
    }
    res.json(layout);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/layout/:class_id', (req, res) => {
  const { column_counts, alignment } = req.body; // column_counts: [6,7,7,7,7,6], alignment: 'back'|'front'
  try {
    const countsJson = JSON.stringify(column_counts);
    const maxRows = Math.max(...column_counts);

    const stmt = db.prepare(`
      INSERT INTO seating_layouts (class_id, column_counts, max_rows, alignment, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(class_id) DO UPDATE SET
        column_counts = excluded.column_counts,
        max_rows = excluded.max_rows,
        alignment = excluded.alignment,
        updated_at = CURRENT_TIMESTAMP
    `);
    stmt.run(req.params.class_id, countsJson, maxRows, alignment || 'back');
    res.json({ message: '座席レイアウトを保存しました' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 座席割り当て取得 API ---
router.get('/assignments/:class_id', (req, res) => {
  try {
    const assigns = db.prepare('SELECT * FROM seat_assignments WHERE class_id = ?').all(req.params.class_id);
    res.json(assigns);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- 席替え実行 API（修正箇所） ---
router.post('/shuffle', (req, res) => {
  const { class_id, conditions, all_seat_ids } = req.body;

  try {
    const students = db.prepare(`
      SELECT s.id FROM students s
      JOIN class_students cs ON s.id = cs.student_id
      WHERE cs.class_id = ?
    `).all(class_id).map(s => s.id);

    if (students.length === 0) return res.status(400).json({ error: 'クラスに生徒が登録されていません' });

    let assignedSeats = new Map();
    let assignedStudents = new Set();

    // 1. 各条件グループ内でのランダム割り当て
    if (Array.isArray(conditions)) {
      for (const cond of conditions) {
        // 条件グループ内の席と生徒を独立してシャッフル
        const shuffSeats = shuffleArray(cond.seats);
        const shuffStudentIds = shuffleArray(cond.student_ids);

        shuffSeats.forEach((seatId, idx) => {
          if (shuffStudentIds[idx]) {
            assignedSeats.set(seatId, shuffStudentIds[idx]);
            assignedStudents.add(shuffStudentIds[idx]);
          }
        });
      }
    }

    // 2. 残り生徒と席のシャッフル
    const remainingSeats = all_seat_ids.filter(sid => !assignedSeats.has(sid));
    const remainingStudents = shuffleArray(students.filter(sid => !assignedStudents.has(sid)));

    remainingSeats.forEach((seatId, idx) => {
      if (remainingStudents[idx]) {
        assignedSeats.set(seatId, remainingStudents[idx]);
      }
    });

    // 3. DB保存
    const deleteOld = db.prepare('DELETE FROM seat_assignments WHERE class_id = ?');
    const insert = db.prepare('INSERT INTO seat_assignments (class_id, seat_id, student_id) VALUES (?, ?, ?)');

    db.transaction(() => {
      deleteOld.run(class_id);
      for (const [seatId, studentId] of assignedSeats.entries()) {
        insert.run(class_id, seatId, studentId);
      }
    })();

    res.json({ message: '席替えが完了しました' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;