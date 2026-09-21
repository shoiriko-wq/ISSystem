const express = require('express');
const router = express.Router();
const { db } = require('../db/schema');

// --- 団体マスター API ---

// 1. 団体一覧取得
router.get('/groups', (req, res) => {
  try {
    const groups = db.prepare('SELECT * FROM gym_groups ORDER BY id ASC').all();
    res.json(groups);
  } catch (err) {
    res.status(500).json({ error: '団体一覧の取得に失敗しました: ' + err.message });
  }
});

// 2. 団体の新規追加
router.post('/groups', (req, res) => {
  const { name, category, contact_person, note } = req.body;
  if (!name) {
    return res.status(400).json({ error: '団体名は必須です。' });
  }

  try {
    const stmt = db.prepare('INSERT INTO gym_groups (name, category, contact_person, note) VALUES (?, ?, ?, ?)');
    const info = stmt.run(name, category || '部活動', contact_person || '', note || '');
    res.status(201).json({ id: info.lastInsertRowid, name, category, contact_person, note });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(400).json({ error: '同じ名前の団体が既に存在します。' });
    }
    res.status(500).json({ error: '団体の登録に失敗しました: ' + err.message });
  }
});

// --- 予約 API ---

// 3. 予約一覧取得（カレンダー用）
router.get('/reservations', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT 
        r.id,
        r.group_id,
        g.name as group_name,
        r.area,
        r.purpose,
        r.teacher_name,
        r.start_time as start,
        r.end_time as end,
        r.note
      FROM gym_reservations r
      LEFT JOIN gym_groups g ON r.group_id = g.id
    `).all();

    // FullCalendar 用にイベントタイトルを整形
    const events = rows.map(r => ({
      id: r.id,
      title: `[${r.area}] ${r.group_name || '未設定'} - ${r.purpose}`,
      start: r.start,
      end: r.end,
      extendedProps: {
        group_id: r.group_id,
        group_name: r.group_name,
        area: r.area,
        purpose: r.purpose,
        teacher_name: r.teacher_name,
        note: r.note
      }
    }));

    res.json(events);
  } catch (err) {
    res.status(500).json({ error: '予約情報の取得に失敗しました: ' + err.message });
  }
});

// 4. 新規予約・上書き処理
router.post('/reservations', (req, res) => {
  const { group_id, area, purpose, teacher_name, start_time, end_time, note, force } = req.body;

  // ★ 団体名（group_id）も含めて必須チェック
  if (!group_id || !area || !purpose || !start_time || !end_time) {
    return res.status(400).json({ error: '使用団体、使用エリア、目的、日時は必須項目です。' });
  }

  try {
    // 時間重複チェック（「全面」予約はすべてと重なり、部分エリアは全面または同一エリアと重なる）
    const overlapping = db.prepare(`
      SELECT r.id, r.purpose, r.teacher_name, g.name as group_name 
      FROM gym_reservations r
      LEFT JOIN gym_groups g ON r.group_id = g.id
      WHERE (r.area = '全面' OR ? = '全面' OR r.area = ?)
        AND r.start_time < ? 
        AND r.end_time > ?
    `).all(area, area, end_time, start_time);

    // 重複があり、かつ強制上書き（force）でなければ 409 Conflict を返す
    if (overlapping.length > 0 && !force) {
      return res.status(409).json({
        conflict: true,
        message: '指定された時間帯・エリアには既に予約が存在します。',
        overlapping: overlapping
      });
    }

    // 上書き（force: true）の場合は重複する古い予約を削除
    if (overlapping.length > 0 && force) {
      const deleteStmt = db.prepare('DELETE FROM gym_reservations WHERE id = ?');
      for (const item of overlapping) {
        deleteStmt.run(item.id);
      }
    }

    // 新規登録
    const stmt = db.prepare(`
      INSERT INTO gym_reservations (group_id, area, purpose, teacher_name, start_time, end_time, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const info = stmt.run(group_id, area, purpose, teacher_name || '', start_time, end_time, note || '');

    res.status(201).json({
      id: info.lastInsertRowid,
      message: force ? '既存の予約を更新（上書き）しました。' : '予約が完了しました。'
    });

  } catch (err) {
    console.error('体育館予約作成エラー:', err);
    res.status(500).json({ error: '予約処理に失敗しました: ' + err.message });
  }
});

// 5. 予約の削除
router.delete('/reservations/:id', (req, res) => {
  try {
    const stmt = db.prepare('DELETE FROM gym_reservations WHERE id = ?');
    const result = stmt.run(req.params.id);
    if (result.changes === 0) {
      return res.status(404).json({ error: '該当する予約が見つかりません。' });
    }
    res.json({ message: '予約を削除しました。' });
  } catch (err) {
    res.status(500).json({ error: '削除処理に失敗しました: ' + err.message });
  }
});

module.exports = router;