/**
 * ISSystem Seating Chart Data Access Model
 * 仕様: seating_status (user_id, desk_number, group_zone, current_status)
 */

import { query } from '../../config/database.js';
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
      const res = await query(
        `SELECT s.*, u.name, u.department, u.staff_code, u.role, u.grade
         FROM seating_status s
         LEFT JOIN users u ON s.user_id = u.id
         ORDER BY s.desk_number ASC`
      );
      return res.rows || [];
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
      const ts = nowIso();
      const existingRes = await db.query(`SELECT id FROM seating_status WHERE user_id = $1`, [userId]);
      if (existingRes.rows[0]) {
        await db.query(
          `UPDATE seating_status SET desk_number = $1, current_status = $2, status_note = $3, updated_at = $4 WHERE user_id = $5`,
          [desk, status, note, ts, userId]
        );
      } else {
        await db.query(
          `INSERT INTO seating_status (id, user_id, desk_number, group_zone, current_status, status_note, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [`seat_${userId}`, userId, desk, cell.group_zone || 'staff', status, note, ts]
        );
      }
    }
    return cells;
  },

  /**
   * 座席表マトリクス（rows/cols と席割当て）の取得
   * @param {string} matrixId
   */
  async getSeatMatrix(matrixId = 'staff_room') {
    const db = await openDb();
    const matrixRes = await db.query(
      `SELECT id, name, rows, cols, updated_at FROM seat_matrices WHERE id = $1`,
      [matrixId]
    );
    const matrixRow = matrixRes.rows[0];
    const matrix = matrixRow
      ? { id: matrixRow.id, name: matrixRow.name, rows: Number(matrixRow.rows), cols: Number(matrixRow.cols) }
      : { id: matrixId, name: '座席表', rows: 5, cols: 6 };

    const cellsRes = await db.query(
      `SELECT c.row_idx, c.col_idx, c.user_id,
              u.name, u.staff_code, u.role, u.department, u.subjects, u.avatar_url
       FROM seat_matrix_cells c
       JOIN users u ON u.id = c.user_id
       WHERE c.matrix_id = $1
       ORDER BY c.row_idx ASC, c.col_idx ASC`,
      [matrixId]
    );

    const seats = (cellsRes.rows || []).map((r) => ({
      row: Number(r.row_idx),
      col: Number(r.col_idx),
      user_id: r.user_id,
      name: r.name,
      staff_code: r.staff_code || '',
      role: r.role,
      department: r.department || '',
      subjects: r.subjects || '[]',
      avatar_url: r.avatar_url || null,
    }));

    return { matrix, seats };
  },

  /**
   * 座席表マトリクスの保存（rows/cols と全席割当てを一括差し替え）
   * @param {string} matrixId
   * @param {number} rows
   * @param {number} cols
   * @param {Array<{row:number,col:number,user_id:string}>} assignments
   */
  async saveSeatMatrix(matrixId, rows, cols, assignments = []) {
    const db = await openDb();
    const ts = nowIso();

    await db.query(
      `INSERT INTO seat_matrices (id, name, rows, cols, updated_at)
       VALUES ($1, '座席表', $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET rows = $2, cols = $3, updated_at = $4`,
      [matrixId, rows, cols, ts]
    );

    // 席割当てはマトリクス単位で全消去→再登録（ユーザの席移動・クリアを反映）
    await db.query(`DELETE FROM seat_matrix_cells WHERE matrix_id = $1`, [matrixId]);

    for (const a of assignments) {
      await db.query(
        `INSERT INTO seat_matrix_cells (id, matrix_id, row_idx, col_idx, user_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (matrix_id, row_idx, col_idx) DO UPDATE SET user_id = $5, updated_at = $6`,
        [`${matrixId}_${a.row}_${a.col}`, matrixId, a.row, a.col, a.user_id, ts]
      );
    }

    return { rows, cols, assignments };
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
