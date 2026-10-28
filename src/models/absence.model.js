/**
 * ISSystem 年休等・出張 欠席登録モデル (absence_records)
 * ダッシュボード表示用の 1日 × 1教員 × 1区分 の登録データを管理
 */

import { openDb, nowIso } from '../utils/db.js';

/**
 * 登録区分の表示ラベル
 */
export const ABSENCE_TYPE_LABELS = {
  LEAVE: '年休等',
  TRIP: '出張',
};

/**
 * 日付値 (DATE / 文字列 / Date) を YYYY-MM-DD に正規化
 */
function formatDateValue(value) {
  if (!value) return '';
  if (value instanceof Date) {
    return value.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }
  return String(value).trim().substring(0, 10);
}

function mapRecord(row) {
  const type = row.record_type;
  return {
    id: row.id,
    user_id: row.user_id,
    user_name: row.user_name || '教員',
    staff_code: row.staff_code || '',
    department: row.department || '',
    record_date: formatDateValue(row.record_date),
    record_type: type,
    record_type_label: ABSENCE_TYPE_LABELS[type] || type,
    reason: row.reason || '',
    recorded_by: row.recorded_by,
    recorded_by_name: row.recorded_by_name || '',
    avatar_url: row.avatar_url || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export const absenceModel = {
  /**
   * 指定日の登録一覧を教員名付きで取得
   * @param {string} targetDate YYYY-MM-DD
   * @param {string} recordType 任意の过滤区分 ('LEAVE' | 'TRIP')
   */
  async listByDate(targetDate, recordType = null) {
    const db = await openDb();
    const baseSql = `
      SELECT ar.*, u.name AS user_name, u.staff_code, u.department, u.avatar_url AS avatar_url
      FROM absence_records ar
      JOIN users u ON u.id = ar.user_id
    `;
    const orderBy = ' ORDER BY ar.record_type ASC, u.name ASC';

    if (recordType) {
      const result = await db.query(
        baseSql + ' WHERE ar.record_date = ? AND ar.record_type = ?' + orderBy,
        [targetDate, recordType]
      );
      return result.rows.map(mapRecord);
    }

    const result = await db.query(baseSql + ' WHERE ar.record_date = ?' + orderBy, [targetDate]);
    return result.rows.map(mapRecord);
  },

  /**
   * 指定日の区分別人数 (年休等 / 出張) を取得
   * @param {string} targetDate YYYY-MM-DD
   */
  async countByDate(targetDate) {
    const db = await openDb();
    const result = await db.query(
      `SELECT record_type, COUNT(*) AS cnt
       FROM absence_records
       WHERE record_date = ?
       GROUP BY record_type`,
      [targetDate]
    );

    const counts = { LEAVE: 0, TRIP: 0 };
    for (const row of result.rows) {
      if (counts[row.record_type] !== undefined) {
        counts[row.record_type] = parseInt(row.cnt, 10);
      }
    }
    return counts;
  },

  /**
   * 単一登録の取得
   */
  async findById(id) {
    const db = await openDb();
    const result = await db.query(
      `SELECT ar.*, u.name AS user_name, u.staff_code, u.department
       FROM absence_records ar
       JOIN users u ON u.id = ar.user_id
       WHERE ar.id = ?`,
      [id]
    );
    return result.rows[0] ? mapRecord(result.rows[0]) : null;
  },

  /**
   * 登録の作成・更新 (同一 教員×日付×区分 は 1件に集約)
   * @param {object} data { user_id, record_date, record_type, reason, recorded_by, recorded_by_name, id? }
   */
  async upsert(data) {
    const db = await openDb();
    const recordDate = formatDateValue(data.record_date);
    const id = data.id || `abs_${Date.now()}_${Math.floor(Math.random() * 900) + 100}`;

    const result = await db.query(
      `INSERT INTO absence_records
        (id, user_id, record_date, record_type, reason, recorded_by, recorded_by_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, record_date, record_type) DO UPDATE SET
         reason = EXCLUDED.reason,
         recorded_by = EXCLUDED.recorded_by,
         recorded_by_name = EXCLUDED.recorded_by_name,
         updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [
        id,
        data.user_id,
        recordDate,
        data.record_type,
        data.reason || '',
        data.recorded_by,
        data.recorded_by_name || '',
        nowIso(),
        nowIso(),
      ]
    );

    return result.rows[0] ? mapRecord(result.rows[0]) : null;
  },

  /**
   * 登録の削除 (ID 指定)
   */
  async deleteById(id) {
    const db = await openDb();
    const result = await db.query(
      `SELECT ar.*, u.name AS user_name, u.staff_code, u.department
       FROM absence_records ar
       JOIN users u ON u.id = ar.user_id
       WHERE ar.id = ?`,
      [id]
    );
    const record = result.rows[0] ? mapRecord(result.rows[0]) : null;

    await db.query('DELETE FROM absence_records WHERE id = ?', [id]);
    return record;
  },

  /**
   * 教員 × 日付 × 区分での削除 (本人取消用)
   */
  async deleteByKey(user_id, record_date, record_type) {
    const db = await openDb();
    const targetDate = formatDateValue(record_date);

    const result = await db.query(
      `SELECT ar.*, u.name AS user_name, u.staff_code, u.department
       FROM absence_records ar
       JOIN users u ON u.id = ar.user_id
       WHERE ar.user_id = ? AND ar.record_date = ? AND ar.record_type = ?`,
      [user_id, targetDate, record_type]
    );
    const record = result.rows[0] ? mapRecord(result.rows[0]) : null;

    if (!record) return null;

    await db.query('DELETE FROM absence_records WHERE id = ?', [record.id]);
    return record;
  },

  /**
   * 就労中の教員一覧 (登録フォームのセレクト用)
   */
  async listSelectableUsers() {
    const db = await openDb();
    const result = await db.query(
      `SELECT id, staff_code, name, role, grade, department
       FROM users
       ORDER BY role ASC, name ASC`
    );
    return result.rows;
  },

  /**
   * 教員の存在確認
   */
  async findUserById(user_id) {
    const db = await openDb();
    const result = await db.query(
      `SELECT id, staff_code, name, role, grade, department FROM users WHERE id = ?`,
      [user_id]
    );
    return result.rows[0] || null;
  },
};

export default absenceModel;
