/**
 * ISSystem Facility Data Access Model
 * 仕様: resources / reservations (resource_id, is_cancelled)
 */

import { openDb, todayJst, nowIso } from '../utils/db.js';

async function getDb() {
  return openDb();
}

function resourceIdOf(data) {
  return String(data.resource_id || data.resourceId || data.facility_id || data.facilityId || '');
}

function dateOfRange(startTime) {
  if (!startTime) return todayJst();
  return String(startTime).substring(0, 10);
}

export const facilityModel = {
  async findAll() {
    try {
      const db = await getDb();
      const rows = await db.all(`SELECT id, name, category FROM resources ORDER BY category, name`);
      await db.close();
      return (rows || []).map((r) => ({ ...r, facility_id: r.id }));
    } catch (err) {
      console.warn('[FacilityModel] findAll failed:', err.message);
      return [];
    }
  },

  async listFacilities() {
    return this.findAll();
  },

  async findFacilityById(id) {
    try {
      const db = await getDb();
      const row = await db.get(`SELECT id, name, category FROM resources WHERE id = ?`, [String(id)]);
      await db.close();
      return row ? { ...row, facility_id: row.id } : null;
    } catch (err) {
      return null;
    }
  },

  async getDailyOverview(targetDate) {
    const dateStr = targetDate || todayJst();
    const facilities = await this.findAll();

    try {
      const db = await getDb();
      const rows = await db.all(
        `SELECT r.*, res.name as facility_name
         FROM reservations r
         LEFT JOIN resources res ON res.id = COALESCE(r.resource_id, r.facility_id)
         WHERE (r.target_date = ? OR substr(r.start_time, 1, 10) = ?)
           AND COALESCE(r.is_cancelled, 0) = 0
         ORDER BY r.start_time ASC`,
        [dateStr, dateStr]
      );
      await db.close();

      return facilities.map((fac) => {
        const facRes = (rows || []).filter(
          (r) => String(r.resource_id || r.facility_id) === String(fac.id)
        );
        return {
          ...fac,
          facility_id: fac.id,
          facility_name: fac.name,
          reservations: facRes.map((r) => ({
            ...r,
            facility_id: fac.id,
            resource_id: r.resource_id || fac.id,
            facility_name: fac.name,
            purpose: r.title,
          })),
        };
      });
    } catch (err) {
      console.warn('[FacilityModel] getDailyOverview failed:', err.message);
      return facilities.map((fac) => ({
        ...fac,
        facility_id: fac.id,
        facility_name: fac.name,
        reservations: [],
      }));
    }
  },

  async findReservationsByFacility(facilityId, targetDate) {
    const dateStr = targetDate || todayJst();
    try {
      const db = await getDb();
      const rows = await db.all(
        `SELECT * FROM reservations
         WHERE COALESCE(resource_id, facility_id) = ?
           AND (target_date = ? OR substr(start_time, 1, 10) = ?)
           AND COALESCE(is_cancelled, 0) = 0`,
        [String(facilityId), dateStr, dateStr]
      );
      await db.close();
      return rows || [];
    } catch (err) {
      return [];
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
           AND (? != id OR ? IS NULL)
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

    const overlap = await this.checkOverlap(fId, targetDate, startTime, endTime);
    if (overlap) {
      const err = new Error(`指定された時間帯には既に予約「${overlap.title}」が入っています。`);
      throw err;
    }

    const newRes = {
      id,
      resource_id: fId,
      facility_id: fId,
      title,
      target_date: targetDate,
      start_time: startTime,
      end_time: endTime,
      user_id: user.id || data.user_id || 'kyomu01',
      user_name: user.name || data.user_name || '教員',
      is_cancelled: 0,
      created_at: nowIso(),
    };

    const db = await getDb();
    await db.run(
      `INSERT INTO reservations (id, resource_id, facility_id, title, target_date, start_time, end_time, user_id, user_name, is_cancelled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [id, fId, fId, title, targetDate, startTime, endTime, newRes.user_id, newRes.user_name, newRes.created_at]
    );
    await db.close();
    return newRes;
  },

  async cancelReservation(reservationId) {
    const db = await getDb();
    await db.run(`UPDATE reservations SET is_cancelled = 1 WHERE id = ?`, [reservationId]);
    await db.close();
    return true;
  },
};

export default facilityModel;
