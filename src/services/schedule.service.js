/**
 * ISSystem School Schedule & Event Service
 * 校内行事予定・本日のタイムライン・月別/週別カレンダー・学年別スケジュール算出
 */

import scheduleModel from '../models/schedule.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

/** カテゴリ色キーの許可リスト (フロントエンドの Tailwind パレットと共有) */
const CATEGORY_COLOR_KEYS = ['ACCENT', 'SUCCESS', 'WARNING', 'INFO', 'PURPLE', 'SLATE', 'DANGER'];
const CATEGORY_NAME_MAX = 12;
const SCHEDULE_TITLE_MAX = 60;

/** '1,2,3' / [1,2] を正整数配列へ正規化 */
function normalizeCategoryIds(raw) {
  if (raw === null || raw === undefined) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return list.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n) && n > 0);
}

export const scheduleService = {
  /**
   * カテゴリマスタ一覧 (使用行事件数付き)
   */
  async getCategories() {
    return scheduleModel.getCategories();
  },

  /**
   * カテゴリ追加 (呼び出し側で requireKyomuOnlyRole により教務部 KYOMU 権限を保証する)
   * @param {Object} data - { name, color_key, sort_order }
   * @param {Object} user
   */
  async createCategory(data, user) {
    const name = String(data.name || '').trim();
    const colorKey = String(data.color_key || 'SLATE').toUpperCase();
    const sortOrder = Number.isInteger(data.sort_order) ? data.sort_order : 0;

    if (!name) {
      throw new ApiError(400, 'カテゴリ名は必須です。');
    }
    if (name.length > CATEGORY_NAME_MAX) {
      throw new ApiError(400, `カテゴリ名は${CATEGORY_NAME_MAX}文字以内で入力してください。`);
    }
    if (!CATEGORY_COLOR_KEYS.includes(colorKey)) {
      throw new ApiError(400, `カテゴリ色は ${CATEGORY_COLOR_KEYS.join(' / ')} のいずれかを指定してください。`);
    }

    const existing = await scheduleModel.getCategories();
    if (existing.some((c) => c.name === name)) {
      throw new ApiError(409, `カテゴリ「${name}」は既に存在します。`);
    }

    const category = await scheduleModel.createCategory({ name, color_key: colorKey, sort_order: sortOrder });

    await auditModel.logAction({
      userId: user.id,
      action: 'CREATE_SCHEDULE_CATEGORY',
      targetEntity: 'SCHEDULE_CATEGORY',
      targetId: String(category.id),
      changesJson: JSON.stringify({ name, color_key: colorKey, sort_order: sortOrder })
    });

    return category;
  },

  /**
   * カテゴリ改名・色変更 (教務部 KYOMU のみ)
   */
  async updateCategory(id, data, user) {
    const catId = parseInt(id, 10);
    if (!Number.isInteger(catId)) {
      throw new ApiError(400, 'カテゴリIDが不正です。');
    }

    const existing = await scheduleModel.getCategories();
    const target = existing.find((c) => c.id === catId);
    if (!target) {
      throw new ApiError(404, '対象のカテゴリが見つかりません。');
    }

    const patch = {};
    if (data.name !== undefined) {
      const name = String(data.name).trim();
      if (!name) throw new ApiError(400, 'カテゴリ名は必須です。');
      if (name.length > CATEGORY_NAME_MAX) {
        throw new ApiError(400, `カテゴリ名は${CATEGORY_NAME_MAX}文字以内で入力してください。`);
      }
      if (existing.some((c) => c.name === name && c.id !== catId)) {
        throw new ApiError(409, `カテゴリ「${name}」は既に存在します。`);
      }
      patch.name = name;
    }
    if (data.color_key !== undefined) {
      const colorKey = String(data.color_key).toUpperCase();
      if (!CATEGORY_COLOR_KEYS.includes(colorKey)) {
        throw new ApiError(400, `カテゴリ色は ${CATEGORY_COLOR_KEYS.join(' / ')} のいずれかを指定してください。`);
      }
      patch.color_key = colorKey;
    }
    if (data.sort_order !== undefined) {
      patch.sort_order = parseInt(data.sort_order, 10) || 0;
    }

    const updated = await scheduleModel.updateCategory(catId, patch);

    await auditModel.logAction({
      userId: user.id,
      action: 'UPDATE_SCHEDULE_CATEGORY',
      targetEntity: 'SCHEDULE_CATEGORY',
      targetId: String(catId),
      changesJson: JSON.stringify(patch)
    });

    return updated;
  },

  /**
   * カテゴリ削除 (教務部 KYOMU のみ・行事側の紐付けは CASCADE で解除)
   */
  async deleteCategory(id, user) {
    const catId = parseInt(id, 10);
    if (!Number.isInteger(catId)) {
      throw new ApiError(400, 'カテゴリIDが不正です。');
    }

    const existing = await scheduleModel.getCategories();
    const target = existing.find((c) => c.id === catId);
    if (!target) {
      throw new ApiError(404, '対象のカテゴリが見つかりません。');
    }

    const result = await scheduleModel.deleteCategory(catId);

    await auditModel.logAction({
      userId: user.id,
      action: 'DELETE_SCHEDULE_CATEGORY',
      targetEntity: 'SCHEDULE_CATEGORY',
      targetId: String(catId),
      changesJson: JSON.stringify({ name: target.name, affected_schedules: result.affected_schedules })
    });

    return {
      message: `カテゴリ「${target.name}」を削除しました（${result.affected_schedules}件の行事から紐付けを外しました）。`,
      affected_schedules: result.affected_schedules
    };
  },

  /**
   * 指定範囲（月別/週別）の校内行事・スケジュール一覧の取得
   * @param {string} startDate - 'YYYY-MM-DD'
   * @param {string} endDate - 'YYYY-MM-DD'
   * @param {number|string|null} targetGrade - 学年フィルター
   * @param {string|number[]|null} categoryIds - 複数選択時は「いずれか1つ以上」を含む行事のみ
   */
  async getSchedulesByRange(startDate, endDate, targetGrade = null, categoryIds = null) {
    if (!startDate || !endDate) {
      throw new ApiError(400, '開始日および終了日は必須です。');
    }

    const grade = targetGrade ? parseInt(targetGrade, 10) : null;
    const catIds = normalizeCategoryIds(categoryIds);
    const schedules = await scheduleModel.findByDateRange(startDate, endDate, grade, catIds);

    return {
      startDate,
      endDate,
      targetGrade: grade,
      categoryIds: catIds,
      schedules
    };
  },

  /**
   * 本日のタイムライン表示用行事予定算出
   * @param {string} targetDate - 'YYYY-MM-DD' (未指定の場合は本日)
   * @param {number|string|null} targetGrade
   */
  async getTodayTimeline(targetDate, targetGrade = null) {
    const today = targetDate || new Date().toISOString().split('T')[0];
    const grade = targetGrade ? parseInt(targetGrade, 10) : null;

    const todaySchedules = await scheduleModel.findByDateRange(today, today, grade);

    // 時間帯順に並び替え（終日行事は先頭）
    const sortedTimeline = todaySchedules.sort((a, b) => {
      if (!a.start_time && !b.start_time) return 0;
      if (!a.start_time) return -1;
      if (!b.start_time) return 1;
      return a.start_time.localeCompare(b.start_time);
    });

    return {
      date: today,
      timeline: sortedTimeline,
    };
  },

  /**
   * 新規校内行事・スケジュールの追加
   * @param {Object} data - { title, description, event_date, start_time, end_time, category, target_grade }
   * @param {Object} user - { id, name }
   */
  async createSchedule(data, user) {
    const { title, description, event_date, start_time, end_time, category, target_grade } = data;

    if (!title || !event_date) {
      throw new ApiError(400, '行事タイトルおよび実施日付は必須項目です。');
    }
    if (title.trim().length > SCHEDULE_TITLE_MAX) {
      throw new ApiError(400, `行事タイトルは${SCHEDULE_TITLE_MAX}文字以内で入力してください。`);
    }

    // 行事は複数カテゴリを登録できる (category_ids を明示指定した場合は 1つ以上必須)
    const rawCats = data.category_ids ?? data.categoryIds;
    let categoryIds = rawCats === undefined ? [] : normalizeCategoryIds(rawCats);
    if (rawCats !== undefined && categoryIds.length === 0) {
      throw new ApiError(400, '行事には少なくとも1つのカテゴリが必要です。カテゴリを選択してください。');
    }
    if (categoryIds.length === 0) {
      // 旧形式 (category 文字列) は同名カテゴリへ解決して紐付ける (対応が無ければ紐付けなしで作成)
      const allCategories = await scheduleModel.getCategories();
      const legacyKey = String(category || '').trim().toUpperCase();
      const matched = allCategories.find((c) => String(c.name).trim().toUpperCase() === legacyKey);
      if (matched) categoryIds = [matched.id];
    }

    const newSchedule = await scheduleModel.create({
      title: title.trim(),
      description: description ? description.trim() : '',
      event_date,
      start_time: start_time || null,
      end_time: end_time || null,
      category: category || 'EVENT',
      target_grade: target_grade ? parseInt(target_grade, 10) : null,
      created_by_user_id: user.id,
      category_ids: categoryIds
    });

    // 監査ログの記録
    await auditModel.logAction({
      userId: user.id,
      action: 'CREATE_SCHEDULE',
      targetEntity: 'SCHOOL_SCHEDULE',
      targetId: newSchedule.id,
      changesJson: JSON.stringify({
        title: newSchedule.title,
        eventDate: newSchedule.event_date,
        categoryIds
      })
    });

    return newSchedule;
  },

  /**
   * 既存行事・スケジュールの更新
   * @param {string} id
   * @param {Object} data
   * @param {Object} user
   */
  async updateSchedule(id, data, user) {
    if (!id) {
      throw new ApiError(400, 'スケジュールIDが指定されていません。');
    }

    const existing = await scheduleModel.findById(id);
    if (!existing) {
      throw new ApiError(404, '対象の行事・スケジュールが見つかりません。');
    }

    if (data.title !== undefined && String(data.title).trim().length > SCHEDULE_TITLE_MAX) {
      throw new ApiError(400, `行事タイトルは${SCHEDULE_TITLE_MAX}文字以内で入力してください。`);
    }

    // category_ids 指定時は 1つ以上必須 (1行事→複数カテゴリ)
    const rawCats = data.category_ids ?? data.categoryIds;
    if (rawCats !== undefined) {
      const catIds = normalizeCategoryIds(rawCats);
      if (catIds.length === 0) {
        throw new ApiError(400, '行事には少なくとも1つのカテゴリが必要です。');
      }
      data.category_ids = catIds;
    }

    const updatedSchedule = await scheduleModel.update(id, data);

    await auditModel.logAction({
      userId: user.id,
      action: 'UPDATE_SCHEDULE',
      targetEntity: 'SCHOOL_SCHEDULE',
      targetId: id,
      changesJson: JSON.stringify(data),
    });

    return updatedSchedule;
  },

  /**
   * 行事・スケジュールの削除（論理削除）
   * @param {string} id
   * @param {Object} user
   */
  async deleteSchedule(id, user) {
    if (!id) {
      throw new ApiError(400, 'スケジュールIDが指定されていません。');
    }

    const existing = await scheduleModel.findById(id);
    if (!existing) {
      throw new ApiError(404, '対象の行事・スケジュールが見つかりません。');
    }

    await scheduleModel.delete(id);

    await auditModel.logAction({
      userId: user.id,
      action: 'DELETE_SCHEDULE',
      targetEntity: 'SCHOOL_SCHEDULE',
      targetId: id,
    });

    return { message: 'スケジュールを削除しました。' };
  },
};

export default scheduleService;