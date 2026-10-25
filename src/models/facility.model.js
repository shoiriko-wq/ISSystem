/**
 * ISSystem Facility & Reservation Data Access Model
 * PostgreSQL (resources / reservations / editing_locks / facility_cells) 完全対応版
 */

import { query } from '../../config/database.js';
import { nowIso } from '../utils/db.js';

async function getDb() {
  return openDb();
}

function resourceIdOf(data) {
  return String(data.resource_id || data.resourceId || data.facility_id || data.facilityId || '');
}

function dateOfRange(startTime) {
  if (!startTime) return todayJst();
  const str = String(startTime);
  // 日付形式 (YYYY-MM-DD...) の場合のみ採用する (HH:MM を日付として誤認しない)
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : todayJst();
}

export const facilityModel = {
  async findAll() {
    return this.listFacilities();
  }

  async findFacilityById(id) {
    const res = await query('SELECT * FROM resources WHERE id = $1', [id]);
    return res.rows[0] || null;
  }

  async findResourceById(id) {
    return this.findFacilityById(id);
  }

  // ================= 予約 (reservations) =================

  /**
   * 予約取得。呼び出し側の形式揺れを吸収する:
   *   getReservationsByDate(facilityId, date) / getReservationsByDate(date) / getReservationsByDate(facilityId)
   */
  async getReservationsByDate(arg1, arg2) {
    let facilityId = null;
    let date = null;

    if (arg2) {
      facilityId = arg1;
      date = arg2;
    } else if (typeof arg1 === 'string' && DATE_RE.test(arg1)) {
      date = arg1;
    } else {
      facilityId = arg1;
    }

    const params = [];
    const conditions = ['r.is_cancelled = false'];

    if (facilityId) {
      params.push(facilityId);
      conditions.push(`(r.resource_id = $${params.length} OR r.facility_id = $${params.length})`);
    }

    if (date) {
      params.push(date);
      conditions.push(`r.target_date = $${params.length}`);
    }

    const res = await query(
      `SELECT r.*, COALESCE(u.name, r.user_name) AS user_name
       FROM reservations r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE ${conditions.join(' AND ')}
       ORDER BY r.target_date, r.start_time`,
      params
    );
    return res.rows;
  }

  async findReservationsByFacility(facilityId) {
    return this.getReservationsByDate(facilityId);
  }

  /**
   * 期間指定の予約一覧 (target_date の範囲)
   * @param {string} facilityId
   * @param {Object} range - { start, end }
   */
  async getSchedule(facilityId, range = {}) {
    const start = range.start || range.from || range.startDate;
    const end = range.end || range.to || range.endDate;

    if (!start || !end) return this.getReservationsByDate(facilityId);

    const res = await query(
      `SELECT r.*, COALESCE(u.name, r.user_name) AS user_name
       FROM reservations r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE (r.resource_id = $1 OR r.facility_id = $1)
         AND r.target_date >= $2 AND r.target_date <= $3
         AND r.is_cancelled = false
       ORDER BY r.target_date, r.start_time`,
      [facilityId, start, end]
    );
    return res.rows;
  }

  /**
   * 指定日の施設別利用状況（施設ごとの予約有無を含む一覧）
   * @param {string} date - YYYY-MM-DD
   */
  async getDailyOverview(date) {
    const facilities = await this.listFacilities();
    const reservations = await this.getReservationsByDate(null, date);

    const byFacility = new Map();
    for (const r of reservations) {
      const key = r.resource_id || r.facility_id;
      if (!byFacility.has(key)) byFacility.set(key, []);
      byFacility.get(key).push(r);
    }

    return facilities.map((facility) => {
      const list = byFacility.get(facility.id) || [];
      return {
        facility,
        reservations: list,
        available: list.length === 0,
      };
    });
  }

  /**
   * 指定日に利用可能な施設一覧
   */
  async listAvailable(filters = {}) {
    const facilities = await this.listFacilities(filters);
    const date = filters.date || filters.day;
    if (!date) return facilities.map((f) => ({ ...f, available: true }));

    const reservations = await this.getReservationsByDate(null, date);
    const busy = new Set(reservations.map((r) => r.resource_id || r.facility_id));
    return facilities.filter((f) => !busy.has(f.id));
  }

  /**
   * 二重予約検出 (既存.start_time < 新規.end_time AND 既存.end_time > 新規.start_time)
   * 呼び出し形式吸収: checkOverlap(facilityId, date, start, end) / checkOverlap(facilityId, start, end)
   */
  async checkOverlap(arg1, arg2, arg3, arg4) {
    const facilityId = arg1;
    let date = null;
    let start = arg2;
    let end = arg3;

    if (arg4) {
      date = arg2;
      start = arg3;
      end = arg4;
    }
  },

  async getReservationsByDate(facilityId, targetDate) {
    return this.findReservationsByFacility(facilityId, targetDate);
  },

  async checkOverlap(facilityId, targetDate, startTime, endTime, excludeId = null) {
    const start = startTime.includes(' ') ? startTime : `${targetDate} ${startTime}:00`;
    const end = endTime.includes(' ') ? endTime : `${targetDate} ${endTime}:00`;
    try {
      const db = await getDb();
      const row = await db.get(
        `SELECT * FROM reservations
         WHERE COALESCE(resource_id, facility_id) = ?
           AND COALESCE(is_cancelled, 0) = 0
           AND (id <> CAST(? AS TEXT) OR CAST(? AS TEXT) IS NULL)
           AND start_time < ? AND end_time > ?`,
        [String(facilityId), excludeId, excludeId, end, start]
      );
      await db.close();
      return row || null;
    } catch (err) {
      return null;
    }
  },

  async createReservation(data, user = {}) {
    const id = `res_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const fId = resourceIdOf(data) || '1';
    const targetDate = data.target_date || data.targetDate || dateOfRange(data.start_time) || todayJst();
    let startTime = data.start_time || data.startTime || `${targetDate} 08:50:00`;
    let endTime = data.end_time || data.endTime || `${targetDate} 09:40:00`;
    if (startTime.length <= 5) startTime = `${targetDate} ${startTime}:00`;
    if (endTime.length <= 5) endTime = `${targetDate} ${endTime}:00`;
    const title = data.title || data.purpose || '施設利用';

    const overlap = await this.checkOverlap(facilityId, targetDate, startTime, endTime);
    if (overlap) {
      const err = new Error('既存の予約と時間帯が重複しています。');
      err.statusCode = 409;
      throw err;
    }

    const id = data.id || `res_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const res = await query(
      `INSERT INTO reservations (id, resource_id, facility_id, user_id, user_name, title, target_date, start_time, end_time, is_cancelled, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10)
       RETURNING *`,
      [id, facilityId, facilityId, userId, userName, title, targetDate, toDateTime(targetDate, startTime), toDateTime(targetDate, endTime), nowIso()]
    );
    return res.rows[0];
  }

  async findReservationById(id) {
    const res = await query(
      `SELECT r.*, COALESCE(u.name, r.user_name) AS user_name
       FROM reservations r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.id = $1`,
      [id]
    );
    return res.rows[0] || null;
  }

  /**
   * 予約の取消（ソフトキャンセル）
   */
  async cancelReservation(id, userId = null) {
    const res = await query(
      `UPDATE reservations SET is_cancelled = true WHERE id = $1 RETURNING *`,
      [id]
    );
    return res.rows[0] || null;
  }

  // ================= 編集排他ロック (editing_locks) =================

  /**
   * 編集ロックの取得（他ユーザーが保持している場合は null）
   * 3分無操作で last_accessed が古くなるため自動取得可能になる
   */
  async acquireEditingLock(resource_type, resource_id, user_id, user_name = null) {
    const nowStr = nowIso();
    const TTL_MS = 3 * 60 * 1000;

    const current = await query(
      'SELECT * FROM editing_locks WHERE resource_type = $1 AND resource_id = $2',
      [resource_type, resource_id]
    );
    const existing = current.rows[0];

    if (existing && existing.user_id !== user_id) {
      const last = new Date(existing.last_accessed);
      if (Date.now() - last.getTime() < TTL_MS) {
        return null;
      }
    }

    const res = await query(
      `INSERT INTO editing_locks (resource_type, resource_id, user_id, user_name, acquired_at, last_accessed)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (resource_type, resource_id)
       DO UPDATE SET user_id = EXCLUDED.user_id, user_name = EXCLUDED.user_name, last_accessed = EXCLUDED.last_accessed
       RETURNING *`,
      [resource_type, resource_id, user_id, user_name, nowStr, nowStr]
    );
    return res.rows[0];
  }

  /**
   * ロックのハートビート更新（操作があれば last_accessed を延ばす）
   */
  async touchEditingLock(resource_type, resource_id, user_id) {
    const res = await query(
      `UPDATE editing_locks SET last_accessed = $1
       WHERE resource_type = $2 AND resource_id = $3 AND user_id = $4
       RETURNING *`,
      [nowIso(), resource_type, resource_id, user_id]
    );
    return res.rows[0] || null;
  }

  /**
   * ロックの解放（保持者のみ解放可能）
   */
  async releaseEditingLock(resource_type, resource_id, user_id) {
    const res = await query(
      'SELECT * FROM editing_locks WHERE resource_type = $1 AND resource_id = $2',
      [resource_type, resource_id]
    );
    const existing = res.rows[0];

    if (existing && existing.user_id !== user_id) {
      return false;
    }

    await query(
      'DELETE FROM editing_locks WHERE resource_type = $1 AND resource_id = $2',
      [resource_type, resource_id]
    );
    return true;
  }

  // ================= フィールドセル値 (facility_cells) =================

  async updateCells(cells) {
    const nowStr = nowIso();
    const entries = Object.entries(cells);

    for (const [cellKey, value] of entries) {
      const cellId = cellKey.split(':')[0];
      await query(
        `INSERT INTO facility_cells (cell_id, cell_key, value, updated_at)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (cell_id, cell_key)
         DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        [cellId, cellKey, value, nowStr]
      );
    }

    return entries.map(([cellKey, value]) => ({ cellKey, value }));
  }

  async getCells(cellKey) {
    const res = await query(
      'SELECT cell_key, value FROM facility_cells WHERE cell_key LIKE $1 ORDER BY cell_key',
      [`${cellKey}%`]
    );
    return res.rows;
  }
}

// FacilityModel はクラス宣言時に export 済み
const facilityModel = new FacilityModel();

export const listAvailable = (...args) => facilityModel.listAvailable(...args);
export const listFacilities = (...args) => facilityModel.listFacilities(...args);
export const getReservationsByDate = (...args) => facilityModel.getReservationsByDate(...args);
export const getDailyOverview = (...args) => facilityModel.getDailyOverview(...args);
export const createReservation = (...args) => facilityModel.createReservation(...args);
export const findReservationById = (...args) => facilityModel.findReservationById(...args);
export const cancelReservation = (...args) => facilityModel.cancelReservation(...args);
export const checkOverlap = (...args) => facilityModel.checkOverlap(...args);
export const acquireEditingLock = (...args) => facilityModel.acquireEditingLock(...args);
export const touchEditingLock = (...args) => facilityModel.touchEditingLock(...args);
export const releaseEditingLock = (...args) => facilityModel.releaseEditingLock(...args);
export const updateCells = (...args) => facilityModel.updateCells(...args);
export const getCells = (...args) => facilityModel.getCells(...args);

export default facilityModel;


