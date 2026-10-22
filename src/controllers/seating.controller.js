/**
 * ISSystem Staff Room & Classroom Seating Chart Controller
 * 可変グリッド座席表レイアウト・セル配置一括保存・4桁生徒コード即時検索・排他編集ロック制御API
 */

import seatingService from '../services/seating.service.js';

export const seatingController = {
  /**
   * 全座席表レイアウト一覧の取得
   * GET /api/seating/layouts
   */
  async getLayouts(req, res, next) {
    try {
      const layouts = await seatingService.getLayouts();
      const seats = layouts[0]?.seats || [];

      return res.status(200).json({
        success: true,
        count: seats.length,
        layouts,
        seats,
        rows: layouts[0]?.rows || 6,
        cols: layouts[0]?.cols || 8,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 指定座席表レイアウトの詳細および全セル配置データ取得（教員在席状況の同期付加）
   * GET /api/seating/layouts/:id
   */
  async getLayoutDetail(req, res, next) {
    try {
      const { id } = req.params;

      const result = await seatingService.getLayoutDetail(id);

      return res.status(200).json({
        success: true,
        layout: result.layout,
        cells: result.cells,
        editingLock: result.editingLock,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 可変グリッド形式での新規座席表レイアウト作成
   * POST /api/seating/layouts
   */
  async createLayout(req, res, next) {
    try {
      const { name, rows, cols } = req.body;
      const user = req.user;

      const newLayout = await seatingService.createLayout({ name, rows, cols }, user);

      return res.status(201).json({
        success: true,
        message: '新しい座席表レイアウトを作成しました。',
        layout: newLayout,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 座席配置セルデータの一括更新・保存 (排他編集ロック検証付き)
   * PUT /api/seating/layouts/:id/cells
   */
  async saveSeatingCells(req, res, next) {
    try {
      const { id } = req.params;
      const { cells, seats } = req.body;
      const user = req.user;
      const payload = Array.isArray(cells) ? cells : (seats || []).map((s) => ({
        row_idx: s.row,
        col_idx: s.col,
        teacher_id: s.teacherId || s.user_id,
        note: s.note,
        current_status: s.status,
        status_note: s.note,
      }));

      const result = await seatingService.saveSeatingCells(id || 'staff_room', payload, user);

      return res.status(200).json({
        success: true,
        message: result.message,
        cells: result.cells,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 4桁生徒コード (例: '1101' -> 1年1組1番) による生徒情報即時検索
   * GET /api/seating/students/code/:code
   */
  async getStudentByCode(req, res, next) {
    try {
      const { code } = req.params;

      const student = await seatingService.getStudentByCode(code);

      return res.status(200).json({
        success: true,
        student,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 生徒のインクリメンタル検索 (コードまたは氏名部分一致)
   * GET /api/seating/students/search
   */
  async searchStudents(req, res, next) {
    try {
      const { q } = req.query;

      const students = await seatingService.searchStudents(q || '');

      return res.status(200).json({
        success: true,
        count: students.length,
        students,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 編集作業開始時の排他ロック取得 / ハートビート更新
   * POST /api/seating/layouts/:id/lock
   */
  async acquireEditingLock(req, res, next) {
    try {
      const { id } = req.params;
      const user = req.user;

      const lock = await seatingService.acquireEditingLock(id, user);

      return res.status(200).json({
        success: true,
        message: '編集ロックを取得しました。',
        lock,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 編集作業終了時の排他ロック解放
   * DELETE /api/seating/layouts/:id/lock
   */
  async releaseEditingLock(req, res, next) {
    try {
      const { id } = req.params;
      const user = req.user;

      const result = await seatingService.releaseEditingLock(id, user);

      return res.status(200).json({
        success: true,
        message: '編集ロックを解放しました。',
        result,
      });
    } catch (error) {
      next(error);
    }
  },
};

export default seatingController;