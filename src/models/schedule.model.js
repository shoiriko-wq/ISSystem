/**
 * ISSystem School Schedule & Event Data Access Model
 * 校内行事予定・本日のタイムライン・カテゴリ多選択対応 PostgreSQL 準拠モデル
 * ※ 1行事は複数カテゴリを持ち、複数カテゴリ選択時は「いずれか1つ以上」を含む行事を返す
 */

import { openDb } from '../utils/db.js';
import { query } from '../../config/database.js';

async function getDb() {
  return openDb();
}

/** 初期カテゴリマスタ（DB未構築時・モックフォールバック用） */
const INITIAL_CATEGORIES = [
  { id: 1, name: '1学年', color_key: 'INFO', sort_order: 1 },
  { id: 2, name: '2学年', color_key: 'SUCCESS', sort_order: 2 },
  { id: 3, name: '3学年', color_key: 'WARNING', sort_order: 3 },
  { id: 4, name: '教務', color_key: 'ACCENT', sort_order: 4 },
  { id: 5, name: '進路', color_key: 'PURPLE', sort_order: 5 },
  { id: 6, name: '総務', color_key: 'SLATE', sort_order: 6 },
  { id: 7, name: '生徒部', color_key: 'DANGER', sort_order: 7 }
];

const mockSchedules = new Map();
const mockCategories = new Map(INITIAL_CATEGORIES.map((c) => [c.id, { ...c }]));
/** schedule_id -> Set(category_id) */
const mockCategoryMap = new Map([
  ['sch_101', new Set([1, 2, 3])],
  ['sch_102', new Set([4])],
  ['sch_103', new Set([7])]
]);

/** '1,2,3' / [1,2] を正整数配列へ正規化 (未指定は null) */
export function normalizeCategoryIds(raw) {
  if (raw === null || raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return list.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0);
}

function mockCategoriesOf(scheduleId) {
  const ids = mockCategoryMap.get(scheduleId) || new Set();
  return Array.from(ids)
    .map((id) => mockCategories.get(id))
    .filter(Boolean)
    .map((c) => ({ id: c.id, name: c.name, color_key: c.color_key, sort_order: c.sort_order }));
}

export const scheduleModel = {
  /** カテゴリマスタ一覧（行事への使用件数付き） */
  async getCategories() {
    try {
      const res = await query(
        `SELECT c.id, c.name, c.color_key, c.sort_order,
                (SELECT COUNT(m.schedule_id) FROM schedule_category_map m WHERE m.category_id = c.id) AS event_count
         FROM schedule_categories c
         ORDER BY c.sort_order ASC, c.id ASC`
      );
      if (res.rows.length > 0) {
        return res.rows.map((r) => ({
          id: parseInt(r.id, 10),
          name: r.name,
          color_key: r.color_key,
          sort_order: parseInt(r.sort_order, 10),
          event_count: parseInt(r.event_count, 10)
        }));
      }
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] getCategories fallback:', err.message);
    }
    return Array.from(mockCategories.values())
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((c) => ({
        id: c.id,
        name: c.name,
        color_key: c.color_key,
        sort_order: c.sort_order,
        event_count: Array.from(mockCategoryMap.values()).reduce((n, set) => n + (set.has(c.id) ? 1 : 0), 0)
      }));
  },

  /** カテゴリ追加（教務部 KYOMU のみがサービス層で権限チェック後に呼ぶ） */
  async createCategory({ name, color_key = 'SLATE', sort_order = 0 }) {
    try {
      const res = await query(
        `INSERT INTO schedule_categories (name, color_key, sort_order)
         VALUES ($1, $2, $3) RETURNING id, name, color_key, sort_order`,
        [name, color_key, parseInt(sort_order, 10) || 0]
      );
      const row = res.rows[0];
      const cat = {
        id: parseInt(row.id, 10),
        name: row.name,
        color_key: row.color_key,
        sort_order: parseInt(row.sort_order, 10),
        event_count: 0
      };
      mockCategories.set(cat.id, { ...cat });
      return cat;
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] createCategory failed:', err.message);
      const nextId = Math.max(0, ...Array.from(mockCategories.keys())) + 1;
      const cat = { id: nextId, name, color_key, sort_order: parseInt(sort_order, 10) || 0, event_count: 0 };
      mockCategories.set(cat.id, cat);
      return cat;
    }
  },

  /** カテゴリ改名・色変更（教務部 KYOMU のみ） */
  async updateCategory(id, { name, color_key, sort_order }) {
    const catId = parseInt(id, 10);
    try {
      const res = await query(
        `UPDATE schedule_categories
         SET name = COALESCE($1, name), color_key = COALESCE($2, color_key),
             sort_order = COALESCE($3, sort_order), updated_at = CURRENT_TIMESTAMP
         WHERE id = $4
         RETURNING id, name, color_key, sort_order`,
        [
          name || null,
          color_key || null,
          sort_order === undefined ? null : parseInt(sort_order, 10),
          catId
        ]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        const cat = {
          id: parseInt(row.id, 10),
          name: row.name,
          color_key: row.color_key,
          sort_order: parseInt(row.sort_order, 10)
        };
        mockCategories.set(catId, { ...(mockCategories.get(catId) || {}), ...cat });
        return cat;
      }
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] updateCategory failed:', err.message);
    }
    const base = mockCategories.get(catId);
    if (!base) return null;
    const updated = {
      ...base,
      ...(name ? { name } : {}),
      ...(color_key ? { color_key } : {}),
      ...(sort_order !== undefined ? { sort_order: parseInt(sort_order, 10) } : {})
    };
    mockCategories.set(catId, updated);
    return updated;
  },

  /** カテゴリ削除（教務部 KYOMU のみ・行事側の紐付けは CASCADE で削除） */
  async deleteCategory(id) {
    const catId = parseInt(id, 10);
    const mockAffected = Array.from(mockCategoryMap.values())
      .reduce((n, set) => n + (set.has(catId) ? 1 : 0), 0);
    try {
      const delMap = await query(`DELETE FROM schedule_category_map WHERE category_id = $1`, [catId]);
      await query(`DELETE FROM schedule_categories WHERE id = $1`, [catId]);
      mockCategoryMap.forEach((set) => set.delete(catId));
      mockCategories.delete(catId);
      return { id: catId, affected_schedules: delMap.rowCount ?? mockAffected };
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] deleteCategory failed:', err.message);
      mockCategoryMap.forEach((set) => set.delete(catId));
      mockCategories.delete(catId);
      return { id: catId, affected_schedules: mockAffected };
    }
  },

  /** 行事行へカテゴリ配列 categories を付与する */
  async attachCategories(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return rows;
    try {
      const res = await query(
        `SELECT m.schedule_id, c.id, c.name, c.color_key, c.sort_order
         FROM schedule_category_map m
         JOIN schedule_categories c ON c.id = m.category_id
         WHERE m.schedule_id = ANY($1::text[])
         ORDER BY c.sort_order ASC, c.id ASC`,
        [rows.map((r) => r.id)]
      );
      const byId = new Map();
      for (const r of res.rows) {
        if (!byId.has(r.schedule_id)) byId.set(r.schedule_id, []);
        byId.get(r.schedule_id).push({
          id: parseInt(r.id, 10),
          name: r.name,
          color_key: r.color_key,
          sort_order: parseInt(r.sort_order, 10)
        });
      }
      for (const row of rows) {
        const cats = byId.get(row.id) || [];
        row.categories = cats;
        row.categoryIds = cats.map((c) => c.id);
        row.categoryNames = cats.map((c) => c.name);
      }
      return rows;
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] attachCategories fallback:', err.message);
      for (const row of rows) {
        const cats = mockCategoriesOf(row.id);
        row.categories = cats;
        row.categoryIds = cats.map((c) => c.id);
        row.categoryNames = cats.map((c) => c.name);
      }
      return rows;
    }
  },

  /** 行事とカテゴリの紐付けを同期 (1行事→複数カテゴリ) */
  async syncCategoryMap(scheduleId, categoryIds) {
    const ids = normalizeCategoryIds(categoryIds) || [];
    const mockSet = mockCategoryMap.get(scheduleId) || new Set();
    mockSet.clear();
    ids.forEach((id) => mockSet.add(id));
    mockCategoryMap.set(scheduleId, mockSet);

    try {
      await query(`DELETE FROM schedule_category_map WHERE schedule_id = $1`, [scheduleId]);
      for (const id of ids) {
        await query(
          `INSERT INTO schedule_category_map (schedule_id, category_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
          [scheduleId, id]
        );
      }
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] syncCategoryMap failed:', err.message);
    }
  },

  /**
   * 指定された日付範囲または年月指定によるスケジュール・行事一覧の取得
   * @param {string|Object} startDateOrOptions - 'YYYY-MM-DD' または { year, month, startDate, endDate, targetGrade, categoryIds }
   * @param {string} [endDateParam] - 'YYYY-MM-DD'
   * @param {number|null} [targetGradeParam] - 学年フィルター
   * @param {string|number[]|null} [categoryIdsParam] - 複数選択時は「いずれか1つ以上」を含む行事のみ
   */
  async findByDateRange(startDateOrOptions, endDateParam, targetGradeParam = null, categoryIdsParam = null) {
    let startDate = typeof startDateOrOptions === 'string' ? startDateOrOptions : null;
    let endDate = endDateParam;
    let targetGrade = targetGradeParam;

    if (typeof startDateOrOptions === 'object' && startDateOrOptions !== null) {
      const opts = startDateOrOptions;
      targetGrade = opts.targetGrade || opts.target_grade || null;
      categoryIdsParam = categoryIdsParam || opts.categoryIds || opts.category_ids || null;

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

    const catIds = normalizeCategoryIds(categoryIdsParam);

    try {
      const params = [startDate, endDate];
      let nextIdx = 3;

      let sql = `
        SELECT s.*, u.name as created_by_name, u.avatar_url as created_by_avatar
        FROM school_schedules s
        LEFT JOIN users u ON s.created_by_user_id = u.id
        WHERE s.event_date >= $1 AND s.event_date <= $2
      `;

      if (targetGrade) {
        sql += ` AND (s.target_grade IS NULL OR s.target_grade = $${nextIdx})`;
        params.push(parseInt(targetGrade, 10));
        nextIdx += 1;
      }

      // 複数カテゴリ選択 -> 少なくとも1つのカテゴリを含む行事のみ (ANY 一致)
      if (catIds && catIds.length > 0) {
        sql += ` AND EXISTS (SELECT 1 FROM schedule_category_map m WHERE m.schedule_id = s.id AND m.category_id = ANY($${nextIdx}::int[]))`;
        params.push(catIds);
        nextIdx += 1;
      }

      sql += ` ORDER BY s.event_date ASC, s.start_time ASC`;

      const res = await query(sql, params);
      if (res.rows && res.rows.length > 0) {
        return this.attachCategories(res.rows);
      }
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] findByDateRange fallback:', err.message);
    }

    const list = Array.from(mockSchedules.values()).filter((s) =>
      s.event_date >= startDate && s.event_date <= endDate
    );
    const filtered = (catIds && catIds.length > 0)
      ? list.filter((s) => mockCategoriesOf(s.id).some((c) => catIds.includes(c.id)))
      : list;
    filtered.forEach((s) => { s.categories = mockCategoriesOf(s.id); });
    return filtered;
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
   * ID指定でのスケジュール取得（カテゴリ付与）
   */
  async findById(id) {
    try {
      const res = await query(
        `SELECT s.*, u.name as created_by_name, u.avatar_url as created_by_avatar
         FROM school_schedules s
         LEFT JOIN users u ON s.created_by_user_id = u.id
         WHERE s.id = $1`,
        [id]
      );
      if (res.rows.length > 0) {
        const row = res.rows[0];
        await this.attachCategories([row]);
        return row;
      }
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] findById fallback:', err.message);
    }
    const item = mockSchedules.get(id);
    if (item) {
      item.categories = mockCategoriesOf(id);
      return item;
    }
    return null;
  },

  /**
   * 新規行事作成（category_ids で複数カテゴリを登録）
   */
  async create(data) {
    const id = data.id || `sch_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);
    const eventDate = data.event_date || data.date || data.target_date || data.targetDate
      || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    const categoryIds = normalizeCategoryIds(data.category_ids ?? data.categoryIds) || [];

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
      await query(
        `INSERT INTO school_schedules (id, title, description, event_date, start_time, end_time, category, target_grade, created_by_user_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          id, newSchedule.title, newSchedule.description, newSchedule.event_date,
          newSchedule.start_time, newSchedule.end_time, newSchedule.category,
          newSchedule.target_grade, newSchedule.created_by_user_id,
          newSchedule.created_at, newSchedule.updated_at
        ]
      );
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] create DB insert failed:', err.message);
    }

    await this.syncCategoryMap(id, categoryIds);
    // 紐付け直後のカテゴリ (id / 色 / 名前) を実データから付与する
    await this.attachCategories([newSchedule]);
    return newSchedule;
  },

  /**
   * 行事・予定の更新（category_ids 指定でカテゴリ紐付けも差し替え）
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
      await query(
        `UPDATE school_schedules
         SET title = $1, description = $2, event_date = $3, start_time = $4, end_time = $5, category = $6, target_grade = $7, updated_at = $8
         WHERE id = $9`,
        [
          data.title || item.title, data.description || item.description,
          data.event_date || item.event_date, data.start_time || item.start_time,
          data.end_time || item.end_time, data.category || item.category,
          data.target_grade !== undefined ? data.target_grade : item.target_grade,
          nowStr, id
        ]
      );
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] update DB failed:', err.message);
    }

    const categoryIds = normalizeCategoryIds(data.category_ids ?? data.categoryIds);
    if (categoryIds) {
      await this.syncCategoryMap(id, categoryIds);
    }
    if (item) {
      await this.attachCategories([item]);
    }
    return item;
  },

  /**
   * 行事・予定の削除（カテゴリ紐付けも同時削除）
   */
  async delete(id) {
    mockSchedules.delete(id);
    mockCategoryMap.delete(id);
    try {
      await query(`DELETE FROM schedule_category_map WHERE schedule_id = $1`, [id]);
      await query(`DELETE FROM school_schedules WHERE id = $1`, [id]);
    } catch (err) {
      console.warn('[ScheduleModel PG Warning] delete DB failed:', err.message);
    }
  }
};

export default scheduleModel;

