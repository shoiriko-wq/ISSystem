/**
 * ISSystem School Schedule & Event Service
 * 校内行事予定・本日のタイムライン・月別/週別カレンダー・学年別スケジュール算出
 */

import scheduleModel from '../models/schedule.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

export const scheduleService = {
  /**
   * 指定範囲（月別/週別）の校内行事・スケジュール一覧の取得
   * @param {string} startDate - 'YYYY-MM-DD'
   * @param {string} endDate - 'YYYY-MM-DD'
   * @param {number|string|null} targetGrade - 学年フィルター
   */
  async getSchedulesByRange(startDate, endDate, targetGrade = null) {
    if (!startDate || !endDate) {
      throw new ApiError(400, '開始日および終了日は必須です。');
    }

    const grade = targetGrade ? parseInt(targetGrade, 10) : null;
    const schedules = await scheduleModel.findByDateRange(startDate, endDate, grade);

    return {
      startDate,
      endDate,
      targetGrade: grade,
      schedules,
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

    const newSchedule = await scheduleModel.create({
      title: title.trim(),
      description: description ? description.trim() : '',
      event_date,
      start_time: start_time || null,
      end_time: end_time || null,
      category: category || 'EVENT',
      target_grade: target_grade ? parseInt(target_grade, 10) : null,
      created_by_user_id: user.id,
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
        category: newSchedule.category,
      }),
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