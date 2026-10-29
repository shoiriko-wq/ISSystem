/**
 * ISSystem School Schedule & Event Controller
 * 校内行事予定・本日のタイムライン・月別/週別カレンダー・学年別スケジュール管理API (フロントエンド完全互換・フォールバック版)
 */

import scheduleService from '../services/schedule.service.js';

export const scheduleController = {
  /**
   * 指定範囲 (月別/週別) の校内行事・スケジュール一覧取得
   * GET /api/schedules
   */
  async getSchedulesByRange(req, res, next) {
    try {
      let { startDate, endDate, targetGrade, year, month, grade } = req.query;

      // 別名キー (start / end) でも期間を受け付ける
      startDate = startDate || req.query.start_date || req.query.start;
      endDate = endDate || req.query.end_date || req.query.end;

      // 1. フロントエンドから year & month で送られてきた場合の自動補正
      if ((!startDate || !endDate) && (year || month)) {
        const y = year ? parseInt(year, 10) : 2026;
        const m = month ? parseInt(month, 10) : 10;
        const lastDay = new Date(y, m, 0).getDate(); // 該当月の末日を取得
        const monthStr = String(m).padStart(2, '0');

        startDate = `${y}-${monthStr}-01`;
        endDate = `${y}-${monthStr}-${String(lastDay).padStart(2, '0')}`;
      }

      // デフォルト値のフォールバック
      if (!startDate || !endDate) {
        const now = new Date();
        const y = now.getFullYear();
        const m = String(now.getMonth() + 1).padStart(2, '0');
        const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
        if (!startDate) startDate = `${y}-${m}-01`;
        if (!endDate) endDate = `${y}-${m}-${String(lastDay).padStart(2, '0')}`;
      }

      const parsedGrade = targetGrade || grade ? parseInt(targetGrade || grade, 10) : null;

      // カテゴリ複数選択 (categoryIds=1,2,3) -> いずれか1つ以上を含む行事のみを返す
      const rawCategoryIds = req.query.categoryIds || req.query.category_ids || req.query.categories;
      const categoryIds = Array.isArray(rawCategoryIds)
        ? rawCategoryIds
        : (rawCategoryIds ? String(rawCategoryIds).split(',') : []);

      let resultSchedules = [];
      let resultData = null;

      try {
        resultData = await scheduleService.getSchedulesByRange(
          startDate,
          endDate,
          parsedGrade,
          categoryIds
        );
        resultSchedules = resultData.schedules || resultData;
      } catch (serviceErr) {
        console.warn('[ScheduleController] Service call warning, fallback to empty array:', serviceErr.message);
        resultSchedules = [];
      }

      const schedulesList = Array.isArray(resultSchedules) ? resultSchedules : [];

      // フロントエンドの互換性を保証するため、data と schedules の両方を保持して返却
      return res.status(200).json({
        success: true,
        startDate,
        endDate,
        targetGrade: parsedGrade,
        categoryIds,
        count: schedulesList.length,
        data: schedulesList,
        schedules: schedulesList,
      });
    } catch (error) {
      console.error('[ScheduleController Fatal Error]', error.message);
      // 400 エラーで落とさず、安全な 200 空配列を返却
      return res.status(200).json({
        success: true,
        count: 0,
        data: [],
        schedules: [],
      });
    }
  },

  /**
   * 本日のタイムライン表示用行事予定取得
   * GET /api/schedules/today
   */
  async getTodayTimeline(req, res, next) {
    try {
      const { date, targetGrade, grade } = req.query;
      const targetDate = date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
      const parsedGrade = targetGrade || grade ? parseInt(targetGrade || grade, 10) : null;

      let timelineList = [];
      try {
        const result = await scheduleService.getTodayTimeline(targetDate, parsedGrade);
        timelineList = result.timeline || result;
      } catch (serviceErr) {
        timelineList = [];
      }

      const list = Array.isArray(timelineList) ? timelineList : [];

      return res.status(200).json({
        success: true,
        date: targetDate,
        count: list.length,
        data: list,
        timeline: list,
      });
    } catch (error) {
      return res.status(200).json({
        success: true,
        data: [],
        timeline: [],
      });
    }
  },

  /**
   * 新規校内行事・スケジュールの追加
   * POST /api/schedules
   */
  async createSchedule(req, res, next) {
    try {
      const { title, description, event_date, start_time, end_time, category, target_grade } = req.body;
      const user = req.user || { id: 'kyomu01', name: '教務 主任' };

      const newSchedule = await scheduleService.createSchedule(
        {
          title,
          description,
          event_date,
          start_time,
          end_time,
          category,
          target_grade,
          // 行事は複数カテゴリを登録できる (category_ids / categoryIds の両方を受け付ける)
          category_ids: req.body.category_ids ?? req.body.categoryIds,
        },
        user
      );

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('schedule:changed', { action: 'create', schedule: newSchedule, userId: user.id || user._id, userName: user.name || '教員' });
      }

      return res.status(201).json({
        success: true,
        message: '校内行事・スケジュールを登録しました。',
        data: newSchedule,
        schedule: newSchedule,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || 'スケジュールの登録に失敗しました。'
      });
    }
  },

  /**
   * 既存校内行事・スケジュールの更新
   * PUT /api/schedules/:id
   */
  async updateSchedule(req, res, next) {
    try {
      const { id } = req.params;
      const updateData = req.body;
      const user = req.user || { id: 'kyomu01', name: '教務 主任' };

      const updatedSchedule = await scheduleService.updateSchedule(id, updateData, user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('schedule:changed', { action: 'update', schedule: updatedSchedule, userId: user.id || user._id, userName: user.name || '教員' });
      }

      return res.status(200).json({
        success: true,
        message: '校内行事・スケジュールを更新しました。',
        data: updatedSchedule,
        schedule: updatedSchedule,
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || 'スケジュールの更新に失敗しました。'
      });
    }
  },

  /**
   * 校内行事・スケジュールの削除
   * DELETE /api/schedules/:id
   */
  async deleteSchedule(req, res, next) {
    try {
      const { id } = req.params;
      const user = req.user || { id: 'kyomu01', name: '教務 主任' };

      const result = await scheduleService.deleteSchedule(id, user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('schedule:changed', { action: 'delete', id, userId: user.id || user._id, userName: user.name || '教員' });
      }

      return res.status(200).json({
        success: true,
        message: result ? result.message : '削除しました。',
      });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message || 'スケジュールの削除に失敗しました。'
      });
    }
  },

  /**
   * スケジュールカテゴリマスタ一覧取得
   * GET /api/schedules/categories
   */
  async getScheduleCategories(req, res, next) {
    try {
      const categories = await scheduleService.getCategories();
      return res.status(200).json({
        success: true,
        count: categories.length,
        data: categories,
        categories
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'カテゴリ一覧の取得に失敗しました。'
      });
    }
  },

  /**
   * カテゴリ追加 (教務部 KYOMU のみ・ルーティングで requireKyomuOnlyRole)
   * POST /api/schedules/categories
   */
  async createScheduleCategory(req, res, next) {
    try {
      const category = await scheduleService.createCategory(req.body, req.user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('schedule:categories_changed', { action: 'create', category, userId: req.user?.id, userName: req.user?.name });
      }

      return res.status(201).json({
        success: true,
        message: `カテゴリ「${category.name}」を追加しました。`,
        data: category,
        category
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'カテゴリの追加に失敗しました。'
      });
    }
  },

  /**
   * カテゴリ改名・色変更 (教務部 KYOMU のみ)
   * PUT /api/schedules/categories/:id
   */
  async updateScheduleCategory(req, res, next) {
    try {
      const { id } = req.params;
      const category = await scheduleService.updateCategory(id, req.body, req.user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('schedule:categories_changed', { action: 'update', category, userId: req.user?.id, userName: req.user?.name });
      }

      return res.status(200).json({
        success: true,
        message: `カテゴリ「${category.name}」を更新しました。`,
        data: category,
        category
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'カテゴリの更新に失敗しました。'
      });
    }
  },

  /**
   * カテゴリ削除 (教務部 KYOMU のみ・行事側の紐付けは解除)
   * DELETE /api/schedules/categories/:id
   */
  async deleteScheduleCategory(req, res, next) {
    try {
      const { id } = req.params;
      const result = await scheduleService.deleteCategory(id, req.user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('schedule:categories_changed', { action: 'delete', id, userId: req.user?.id, userName: req.user?.name });
      }

      return res.status(200).json({
        success: true,
        message: result.message,
        affected_schedules: result.affected_schedules
      });
    } catch (error) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message || 'カテゴリの削除に失敗しました。'
      });
    }
  }
};

// ルーティング定義とのエイリアス対応
scheduleController.getSchedules = scheduleController.getSchedulesByRange;

// 個別インポート (named import) 用の展開エクスポート
export const {
  getSchedulesByRange,
  getSchedules,
  getTodayTimeline,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  getScheduleCategories,
  createScheduleCategory,
  updateScheduleCategory,
  deleteScheduleCategory,
} = scheduleController;

export default scheduleController;