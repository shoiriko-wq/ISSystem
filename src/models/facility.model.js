/**
 * ISSystem Facility & Reservation Data Access Model
 * PostgreSQL (resources / reservations / editing_locks / facility_cells) 完全対応版
 */

import { query } from '../../config/database.js';
import { openDb, nowIso, todayJst } from '../utils/db.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** モデル層用 SQLite 互換アダプタ (共有プール借用 / close() は no-op) */
async function getDb() {
  return openDb();
}

function resourceIdOf(data) {
  return String(data.resource_id || data.resourceId || data.facility_id || data.facilityId || '');
}

/** 'HH:MM' / 'HH:MM:SS' を 'HH:MM' に正規化 (不正なら null) */
function normalizeTime(raw) {
  if (!raw) return null;
  const match = String(raw).trim().match(/(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD...' を 'YYYY-MM-DD' に正規化 (HH:MM を日付として誤認しない) */
function normalizeDate(raw) {
  if (!raw) return null;
  const match = String(raw).trim().match(DATE_RE);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function dateOfRange(startTime) {
  if (!startTime) return todayJst();
  return normalizeDate(startTime) || todayJst();
}

/** target_date と時刻表記から文字列比較可能な 'YYYY-MM-DD HH:MM:SS' を組み立てる */
function toDateTime(targetDate, time) {
  const str = String(time || '').trim();
  if (!str) return null;
  if (str.includes(' ')) return str; // 既に 'YYYY-MM-DD HH:MM:SS' 形式
  const date = normalizeDate(targetDate) || todayJst();
  const hhmm = normalizeTime(str);
  return hhmm ? `${date} ${hhmm}:00` : `${date} ${str}:00`;
}

const isDateLike = (value) => typeof value === 'string' && DATE_RE.test(value.trim());

export const facilityModel = {
  async findAll() {
    try {
      const res = await query(`SELECT id, name, category FROM resources ORDER BY category, name`);
      return (res.rows || []).map((r) => ({ ...r, facility_id: r.id, facility_name: r.name }));
    } catch (err) {
      console.warn('[FacilityModel] findAll failed:', err.message);
      return [];
    }
  },

  async listFacilities(filters = {}) {
    return this.findAll();
  },

  async findFacilityById(id) {
    const res = await query('SELECT id, name, category FROM resources WHERE id = $1', [String(id)]);
    const row = res.rows[0];
    return row ? { ...row, facility_id: row.id, facility_name: row.name } : null;
  },

  async findResourceById(id) {
    return this.findFacilityById(id);
  },

  // ================= 予約 (reservations) =================

  /**
   * 予約取得。呼び出し側の形式揺れを吸収する:
   *   getReservationsByDate(facilityId, date) / getReservationsByDate(date) / getReservationsByDate(facilityId)
   */
  async getReservationsByDate(arg1, arg2) {
    let facilityId = null;
    let date = null;

    if (arg1 && arg2) {
      // (date, facilityId) 順も吸収する
      if (isDateLike(arg1) && !isDateLike(arg2)) {
        date = arg1;
        facilityId = arg2;
      } else {
        facilityId = arg1;
        date = arg2;
      }
    } else if (arg1 && isDateLike(arg1)) {
      date = arg1;
    } else {
      facilityId = arg1 || null;
    }

    const params = [];
    const conditions = ['COALESCE(r.is_cancelled, 0) = 0'];

    if (facilityId) {
      params.push(String(facilityId));
      conditions.push(`COALESCE(r.resource_id, r.facility_id) = $${params.length}`);
    }

    if (date) {
      params.push(normalizeDate(date) || date);
      conditions.push(`(r.target_date = $${params.length} OR substring(r.start_time, 1, 10) = $${params.length})`);
    }

    try {
      const res = await query(
        `SELECT r.*, COALESCE(u.name, r.user_name) AS user_name, u.avatar_url AS avatar_url,
                COALESCE(res.name, r.facility_id) AS facility_name,
                COALESCE(r.resource_id, r.facility_id) AS facility_id
         FROM reservations r
         LEFT JOIN users u ON r.user_id = u.id
         LEFT JOIN resources res ON res.id = COALESCE(r.resource_id, r.facility_id)
         WHERE ${conditions.join(' AND ')}
         ORDER BY r.target_date, r.start_time`,
        params
      );
      return res.rows.map((r) => ({ ...r, purpose: r.title }));
    } catch (err) {
      console.warn('[FacilityModel] getReservationsByDate failed:', err.message);
      return [];
    }
  },

  async findReservationsByFacility(facilityId, targetDate) {
    if (!facilityId) return this.getReservationsByDate(targetDate);
    return this.getReservationsByDate(facilityId, targetDate);
  },

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
      `SELECT r.*, COALESCE(u.name, r.user_name) AS user_name, u.avatar_url AS avatar_url,
              COALESCE(r.resource_id, r.facility_id) AS facility_id
       FROM reservations r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE COALESCE(r.resource_id, r.facility_id) = $1
         AND r.target_date >= $2 AND r.target_date <= $3
         AND COALESCE(r.is_cancelled, 0) = 0
       ORDER BY r.target_date, r.start_time`,
      [String(facilityId), start, end]
    );
    return res.rows.map((r) => ({ ...r, purpose: r.title }));
  },

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
  },

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
  },

  /**
   * 二重予約検出 (既存.start_time < 新規.end_time AND 既存.end_time > 新規.start_time)
   * 時刻は 'HH:MM' / 'YYYY-MM-DD HH:MM:SS' を許容する
   * @param {string} facilityId
   * @param {string} targetDate - 'YYYY-MM-DD'
   * @param {string} startTime
   * @param {string} endTime
   * @param {string} [excludeId] - 除外する自己予約ID
   */
  async checkOverlap(facilityId, targetDate, startTime, endTime, excludeId = null) {
    const date = normalizeDate(targetDate) || todayJst();
    const start = toDateTime(date, startTime);
    const end = toDateTime(date, endTime);

    try {
      const res = await query(
        `SELECT r.*, COALESCE(u.name, r.user_name) AS user_name, u.avatar_url AS avatar_url
         FROM reservations r
         LEFT JOIN users u ON r.user_id = u.id
         WHERE COALESCE(r.resource_id, r.facility_id) = $1
           AND COALESCE(r.is_cancelled, 0) = 0
           AND ($2::text IS NULL OR r.id <> $2::text)
           AND r.start_time < $3 AND r.end_time > $4
         ORDER BY r.start_time ASC
         LIMIT 1`,
        [String(facilityId), excludeId ? String(excludeId) : null, end, start]
      );
      return res.rows[0] || null;
    } catch (err) {
      console.warn('[FacilityModel] checkOverlap failed:', err.message);
      return null;
    }
  },

  async createReservation(data, user = {}) {
    const fId = resourceIdOf(data) || '1';
    const targetDate =
      normalizeDate(data.target_date || data.targetDate) || dateOfRange(data.start_time) || todayJst();
    const startTime = toDateTime(targetDate, data.start_time || data.startTime || '08:50');
    const endTime = toDateTime(targetDate, data.end_time || data.endTime || '09:40');
    const title = data.title || data.purpose || '施設利用';
    const userId = data.user_id || user.id || null;
    const userName = data.user_name || user.name || '教員';
    const id = data.id || `res_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

    const overlap = await this.checkOverlap(fId, targetDate, startTime, endTime);
    if (overlap) {
      const err = new Error(`指定された時間帯は既存の予約「${overlap.title}」と時間帯が重複しています。`);
      err.statusCode = 409;
      throw err;
    }

    try {
      const res = await query(
        `INSERT INTO reservations (id, resource_id, facility_id, user_id, user_name, title, target_date, start_time, end_time, is_cancelled, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0, $10)
         RETURNING *`,
        [id, fId, fId, userId, userName, title, targetDate, startTime, endTime, nowIso()]
      );
      const created = res.rows[0];
      if (created) return { ...created, purpose: created.title };
      return {
        id,
        resource_id: fId,
        facility_id: fId,
        user_id: userId,
        user_name: userName,
        title,
        target_date: targetDate,
        start_time: startTime,
        end_time: endTime,
        is_cancelled: 0,
        created_at: nowIso(),
      };
    } catch (err) {
      // 一意制約衝突は 409 として扱う (二重登録防止)
      if (err && (err.code === '23505' || /duplicate key/i.test(String(err.message)))) {
        const conflict = new Error('指定された時間帯は既存の予約と時間帯が重複しています。');
        conflict.statusCode = 409;
        throw conflict;
      }
      throw err;
    }
  },

  async findReservationById(id) {
    const res = await query(
      `SELECT r.*, COALESCE(u.name, r.user_name) AS user_name
       FROM reservations r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.id = $1`,
      [id]
    );
    return res.rows[0] || null;
  },

  /**
   * 予約の取消（ソフトキャンセル）
   */
  async cancelReservation(id, userId = null) {
    const res = await query(
      `UPDATE reservations SET is_cancelled = 1 WHERE id = $1 RETURNING *`,
      [String(id)]
    );
    const row = res.rows[0] || null;
    return row ? { ...row, purpose: row.title } : null;
  },

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
  },

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
  },

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
  },

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
  },

  async getCells(cellKey) {
    const res = await query(
      'SELECT cell_key, value FROM facility_cells WHERE cell_key LIKE $1 ORDER BY cell_key',
      [`${cellKey}%`]
    );
    return res.rows;
  }
}

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


