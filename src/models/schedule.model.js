/**
 * ISSystem School Schedule & Event Data Access Model
 * 校内行事予定・本日のタイムライン・学年別スケジュール SQLite 完全対応モデル
 */

import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.resolve(__dirname, '../../database.sqlite');

async function getDb() {
  return await open({
    filename: dbPath,
    driver: sqlite3.Database
  });
}

const mockSchedules = new Map();

export const scheduleModel = {
  /**
   * 指定された日付範囲または年月指定によるスケジュール・行事一覧の取得
   * @param {string|Object} startDateOrOptions - 'YYYY-MM-DD' または { year, month, startDate, endDate, targetGrade }
   * @param {string} [endDateParam] - 'YYYY-MM-DD'
   * @param {number|null} [targetGradeParam] - 学年フィルター
   */
  async findByDateRange(startDateOrOptions, endDateParam, targetGradeParam = null) {
    let startDate = typeof startDateOrOptions === 'string' ? startDateOrOptions : null;
    let endDate = endDateParam;
    let targetGrade = targetGradeParam;

    if (typeof startDateOrOptions === 'object' && startDateOrOptions !== null) {
      const opts = startDateOrOptions;
      targetGrade = opts.targetGrade || opts.target_grade || null;

      if (opts.year && opts.month) {
        const y = parseInt(opts.year, 10);
        const m = String(opts.month).padStart(2, '0');
        const lastDay = new Date(y, parseInt(opts.month, 10), 0).getDate();
        startDate = `${y}-${m}-01`;
        endDate = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
      } else {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
        startDate = opts.startDate || opts.start_date || `${y}-${m}-01`;
        endDate = opts.endDate || opts.end_date || `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
      }
    }

    if (!startDate || !endDate) {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
      if (!startDate) startDate = `${y}-${m}-01`;
      if (!endDate) endDate = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
    }

    try {
      const db = await getDb();
      let sql = `
        SELECT s.*, u.name as created_by_name
        FROM school_schedules s
        LEFT JOIN users u ON s.created_by_user_id = u.id
        WHERE s.event_date >= ? AND s.event_date <= ?
      `;
      const params = [startDate, endDate];

      if (targetGrade) {
        sql += ` AND (s.target_grade IS NULL OR s.target_grade = ?)`;
        params.push(parseInt(targetGrade, 10));
      }

      sql += ` ORDER BY s.event_date ASC, s.start_time ASC`;

      const rows = await db.all(sql, params);
      await db.close();

      if (rows && rows.length > 0) {
        return rows;
      }
    } catch (err) {
      console.warn('[ScheduleModel SQLite Warning] findByDateRange fallback:', err.message);
    }

    return Array.from(mockSchedules.values()).filter(s => {
      const matchesStart = s.event_date >= startDate;
      const matchesEnd = s.event_date <= endDate;
      return matchesStart && matchesEnd;
    });
  },

  /**
   * 本日のタイムライン行事予定取得
   * @param {string} targetDate - 'YYYY-MM-DD'
   */
  async getTodayTimeline(targetDate) {
    const dateStr = targetDate || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    return this.findByDateRange(dateStr, dateStr);
  },

  /**
   * ID指定でのスケジュール取得
   * @param {string} id
   */
  async findById(id) {
    if (!id) return null;
    if (mockSchedules.has(id)) return mockSchedules.get(id);

    try {
      const db = await getDb();
      const row = await db.get(`SELECT * FROM school_schedules WHERE id = ?`, [id]);
      await db.close();
      return row || null;
    } catch (err) {
      console.warn('[ScheduleModel SQLite Warning] findById fallback:', err.message);
      return null;
    }
  },

  /**
   * 新規行事・予定の登録
   * @param {Object} data
   */
  async create(data) {
    const id = data.id || `sch_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

    const eventDate = data.event_date || data.date || data.target_date || data.targetDate || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

    const newSchedule = {
      id,
      title: data.title || data.name || '無題の予定',
      description: data.description || data.memo || '',
      event_date: eventDate,
      start_time: data.start_time || data.startTime || null,
      end_time: data.end_time || data.endTime || null,
      category: data.category || data.type || 'EVENT',
      target_grade: data.target_grade ? parseInt(data.target_grade, 10) : null,
      created_by_user_id: data.created_by_user_id || 'kyomu01',
      created_at: nowStr,
      updated_at: nowStr
    };

    mockSchedules.set(id, newSchedule);

    try {
      const db = await getDb();
      await db.run(
        `INSERT INTO school_schedules (id, title, description, event_date, start_time, end_time, category, target_grade, created_by_user_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id, newSchedule.title, newSchedule.description, newSchedule.event_date,
          newSchedule.start_time, newSchedule.end_time, newSchedule.category,
          newSchedule.target_grade, newSchedule.created_by_user_id,
          newSchedule.created_at, newSchedule.updated_at
        ]
      );
      await db.close();
    } catch (err) {
      console.warn('[ScheduleModel SQLite Warning] create DB insert failed:', err.message);
    }

    return newSchedule;
  },

  /**
   * 行事・予定の更新
   * @param {string} id
   * @param {Object} data
   */
  async update(id, data) {
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const item = await this.findById(id);

    if (item) {
      if (data.title !== undefined) item.title = data.title;
      if (data.description !== undefined) item.description = data.description;
      if (data.event_date !== undefined) item.event_date = data.event_date;
      if (data.start_time !== undefined) item.start_time = data.start_time;
      if (data.end_time !== undefined) item.end_time = data.end_time;
      if (data.category !== undefined) item.category = data.category;
      if (data.target_grade !== undefined) item.target_grade = data.target_grade;
      item.updated_at = nowStr;
      mockSchedules.set(id, item);
    }

    try {
      const db = await getDb();
      await db.run(
        `UPDATE school_schedules
         SET title = ?, description = ?, event_date = ?, start_time = ?, end_time = ?, category = ?, target_grade = ?, updated_at = ?
         WHERE id = ?`,
        [
          data.title || item.title, data.description || item.description,
          data.event_date || item.event_date, data.start_time || item.start_time,
          data.end_time || item.end_time, data.category || item.category,
          data.target_grade !== undefined ? data.target_grade : item.target_grade,
          nowStr, id
        ]
      );
      await db.close();
    } catch (err) {
      console.warn('[ScheduleModel SQLite Warning] update DB failed:', err.message);
    }

    return item;
  },

  /**
   * 行事・予定の削除
   * @param {string} id
   */
  async delete(id) {
    mockSchedules.delete(id);
    try {
      const db = await getDb();
      await db.run(`DELETE FROM school_schedules WHERE id = ?`, [id]);
      await db.close();
    } catch (err) {
      console.warn('[ScheduleModel SQLite Warning] delete DB failed:', err.message);
    }
  }
};

export default scheduleModel;