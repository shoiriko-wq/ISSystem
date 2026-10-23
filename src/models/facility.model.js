/**
 * 施設・備品予約モデル (Facility & Resource Model)
 * PostgreSQL (pg) 準拠実装
 */
import { query } from '../../config/database.js';
import { parseJson, todayJst } from '../utils/db.js';

class FacilityModel {
  async getResources() {
    try {
      const res = await query(`SELECT id, name, category FROM resources ORDER BY name ASC`);
      return res.rows;
    } catch (err) {
      console.error('[FacilityModel] getResources failed:', err.message);
      return [];
    }
  }

  async findResourceById(id) {
    try {
      const res = await query(`SELECT * FROM resources WHERE id = $1`, [id]);
      return res.rows[0] || null;
    } catch (err) {
      console.error('[FacilityModel] findResourceById failed:', err.message);
      return null;
    }
  }

  async listAvailable(dateStr) {
    const target = dateStr || todayJst();
    try {
      const res = await query(
        `SELECT r.id, r.name, r.category
         FROM resources r
         WHERE NOT EXISTS (
            SELECT 1 FROM reservations res
            WHERE res.resource_id = r.id
              AND res.target_date = $1
              AND res.is_cancelled = FALSE
         )
         ORDER BY r.category ASC, r.name ASC`,
        [target]
      );
      return res.rows;
    } catch (err) {
      console.error('[FacilityModel] listAvailable failed:', err.message);
      return [];
    }
  }

  async getSchedule(dateStr, userId) {
    const target = dateStr || todayJst();
    try {
      const res = await query(
        `SELECT res.*, r.name AS resource_name, r.category AS resource_category
         FROM reservations res
         JOIN resources r ON res.resource_id = r.id
         WHERE (res.target_date = $1 OR res.target_date IS NULL)
           AND res.is_cancelled = FALSE
           AND (res.user_id = $2 OR $2 IS NULL)
         ORDER BY
            CASE WHEN res.user_id = $3 THEN 0 ELSE 1 END,
            res.start_time ASC`,
        [target, userId || null, userId || null]
      );
      return res.rows;
    } catch (err) {
      console.error('[FacilityModel] getSchedule failed:', err.message);
      return [];
    }
  }

  async createReservation(data) {
    const id = `res_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    try {
      const res = await query(
        `SELECT * FROM reservations
         WHERE resource_id = $1
           AND target_date = $2
           AND is_cancelled = FALSE
           AND start_time < $4
           AND end_time > $3`,
        [data.resource_id, data.target_date, data.start_time, data.end_time]
      );
      if (res.rows.length > 0) {
        const existing = res.rows[0];
        throw new Error(`RESERVATION_CONFLICT: ${existing.resource_id} の ${existing.start_time} - ${existing.end_time} と重複しています。`);
      }

      await query(
        `INSERT INTO reservations (id, resource_id, facility_id, user_id, user_name, title, target_date, start_time, end_time, is_cancelled)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, FALSE)`,
        [
          id,
          data.resource_id,
          data.facility_id || data.resource_id,
          data.user_id || null,
          data.user_name || '教員',
          data.title,
          data.target_date || null,
          data.start_time,
          data.end_time,
        ]
      );
      return { id, ...data };
    } catch (err) {
      console.error('[FacilityModel] createReservation failed:', err.message);
      throw err;
    }
  }

  async cancelReservation(id, userId) {
    try {
      const res = await query(`SELECT * FROM reservations WHERE id = $1`, [id]);
      if (!res.rows[0]) return { cancelled: false, error: 'NOT_FOUND' };

      await query(`UPDATE reservations SET is_cancelled = TRUE WHERE id = $1`, [id]);
      return { cancelled: true, id };
    } catch (err) {
      console.error('[FacilityModel] cancelReservation failed:', err.message);
      throw err;
    }
  }

  async updateCells(cellId, newValues) {
    const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
    try {
      for (const [cellKey, value] of Object.entries(newValues)) {
        await query(
          `INSERT INTO facility_cells (cell_id, cell_key, value, updated_at, updated_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (cell_id, cell_key) DO UPDATE SET value = $6, updated_at = $7, updated_by = $8`,
          [cellId, cellKey, JSON.stringify(value), ts, 'admin', JSON.stringify(value), ts, 'admin']
        );
      }
      return this.getCells(cellId);
    } catch (err) {
      console.error('[FacilityModel] updateCells failed:', err.message);
      throw err;
    }
  }

  async getCells(cellId) {
    try {
      const res = await query(
        `SELECT * FROM facility_cells WHERE cell_id = $1 ORDER BY updated_at DESC`,
        [cellId]
      );
      const cells = {};
      for (const row of res.rows) {
        if (cells[row.cell_key]) continue;
        cells[row.cell_key] = parseJson(row.value, null);
      }
      return cells;
    } catch (err) {
      console.error('[FacilityModel] getCells failed:', err.message);
      return {};
    }
  }

  // 編集ロック (10分自動期限切れ)
  async acquireEditingLock(cellId, userId) {
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const lockKey = `lock:${cellId}`;
    try {
      const res = await query(`SELECT * FROM editing_locks WHERE lock_key = $1`, [lockKey]);
      if (res.rows[0]) {
        const lock = res.rows[0];
        if (lock.user_id === userId) return { acquired: true, user_id: userId };
        const expiredAt = new Date(new Date(lock.created_at).getTime() + 10 * 60 * 1000).toISOString().replace('T', ' ').substring(0, 19);
        if (nowStr > expiredAt) {
          await query(`DELETE FROM editing_locks WHERE lock_key = $1`, [lockKey]);
        } else {
          return { acquired: false, lock_holder: lock.user_id };
        }
      }
      await query(
        `INSERT INTO editing_locks (lock_key, user_id, created_at) VALUES ($1, $2, $3)
         ON CONFLICT (lock_key) DO UPDATE SET user_id = $4, created_at = $5`,
        [lockKey, userId, nowStr, userId, nowStr]
      );
      return { acquired: true, user_id: userId };
    } catch (err) {
      console.error('[FacilityModel] acquireEditingLock failed:', err.message);
      return { acquired: false, error: err.message };
    }
  }

  async releaseEditingLock(cellId) {
    try {
      await query(`DELETE FROM editing_locks WHERE lock_key = $1`, [`lock:${cellId}`]);
      return true;
    } catch (err) {
      return false;
    }
  }
}

export default new FacilityModel();