/**
 * ISSystem Seating Chart Data Access Model
 * 仕様: seating_status (user_id, desk_number, group_zone, current_status)
 */

import { openDb, nowIso } from '../utils/db.js';

const mockStudents = new Map([
  ['1101', { student_code: '1101', grade: 1, class_num: 1, attendance_num: 1, name: '青木 翔' }],
  ['1102', { student_code: '1102', grade: 1, class_num: 1, attendance_num: 2, name: '井上 葵' }],
  ['2101', { student_code: '2101', grade: 2, class_num: 1, attendance_num: 1, name: '佐藤 健' }],
]);

function deskToCell(deskNumber, index) {
  const match = String(deskNumber || '').match(/([A-Z])-?(\d+)/i);
  if (match) {
    const row = match[1].toUpperCase().charCodeAt(0) - 64;
    const col = parseInt(match[2], 10);
    return { row, col };
  }
  return { row: Math.floor(index / 6) + 1, col: (index % 6) + 1 };
}

export const seatingModel = {
  async listStatus() {
    try {
      const db = await openDb();
      const rows = await db.all(
        `SELECT s.*, u.name, u.department, u.staff_code, u.role, u.grade
         FROM seating_status s
         LEFT JOIN users u ON s.user_id = u.id
         ORDER BY s.desk_number ASC`
      );
      await db.close();
      return rows || [];
    } catch (err) {
      console.warn('[SeatingModel] listStatus failed:', err.message);
      return [];
    }
  },

  async listLayouts() {
    const seats = await this.listStatus();
    const mapped = seats.map((s, idx) => {
      const pos = deskToCell(s.desk_number, idx);
      return {
        ...s,
        id: s.id,
        user_id: s.user_id,
        name: s.name,
        current_status: s.current_status,
        status: s.current_status,
        status_note: s.status_note,
        department: s.department,
        row: pos.row,
        col: pos.col,
        teacher_id: s.user_id,
        teacher_name: s.name,
      };
    });

    return [
      {
        id: 'staff_room',
        name: '職員室メイン配置図',
        rows: 6,
        cols: 8,
        is_active: true,
        seats: mapped,
      },
    ];
  },

  async findLayoutById(id) {
    const layouts = await this.listLayouts();
    return layouts.find((l) => l.id === id) || layouts[0] || null;
  },

  async getCellsByLayoutId() {
    const layouts = await this.listLayouts();
    return layouts[0]?.seats || [];
  },

  async createLayout(data) {
    return {
      id: data.id || 'staff_room',
      name: data.name || '職員室メイン配置図',
      rows: data.rows || 6,
      cols: data.cols || 8,
      is_active: true,
    };
  },

  async updateCells(_layoutId, cells = []) {
    const db = await openDb();
    for (const cell of cells) {
      const userId = cell.teacher_id || cell.user_id || cell.teacherId;
      if (!userId) continue;
      const desk = cell.desk_number || cell.note || `${String.fromCharCode(64 + Number(cell.row || cell.row_idx || 1))}-${String(cell.col || cell.col_idx || 1).padStart(2, '0')}`;
      const status = cell.current_status || cell.status || 'PRESENT';
      const note = cell.status_note || cell.note || '';
      const existing = await db.get(`SELECT id FROM seating_status WHERE user_id = ?`, [userId]);
      if (existing) {
        await db.run(
          `UPDATE seating_status SET desk_number = ?, current_status = ?, status_note = ?, updated_at = ? WHERE user_id = ?`,
          [desk, status, note, nowIso(), userId]
        );
      } else {
        await db.run(
          `INSERT INTO seating_status (id, user_id, desk_number, group_zone, current_status, status_note, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [`seat_${userId}`, userId, desk, cell.group_zone || 'staff', status, note, nowIso()]
        );
      }
    }
    await db.close();
    return cells;
  },

  async findStudentByCode(studentCode) {
    return mockStudents.get(String(studentCode)) || null;
  },

  async searchStudents(searchKey) {
    if (!searchKey) return [];
    const key = searchKey.trim();
    return Array.from(mockStudents.values()).filter(
      (s) => s.student_code.includes(key) || s.name.includes(key)
    );
  },
};

export default seatingModel;
