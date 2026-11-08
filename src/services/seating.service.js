/**
 * ISSystem Staff Room & Classroom Seating Chart Service
 * 可変グリッド動的配置・4桁生徒コード高速検索・教員在席ステータスリアルタイム同期・排他編集ロック
 */

import seatingModel from '../models/seating.model.js';
import userModel from '../models/user.model.js';
import auditModel from '../models/audit.model.js';
import absenceModel from '../models/absence.model.js';
import { onlineUserIds } from '../utils/presence.js';
import { ApiError } from '../middlewares/error.middleware.js';

// 排他編集ロックの自動解放タイムアウト（ミリ秒） - 3分
const EDIT_LOCK_TIMEOUT_MS = 3 * 60 * 1000;
// 排他編集ロックのタイムアウト（秒） - ミドルウェアと同一の 180秒
const EDIT_LOCK_TIMEOUT_SEC = 180;

/** 座席表マトリクスの既定ID（編集ロックのリソースIDにも使用） */
const SEAT_MATRIX_ID = 'staff_room';

/** JST の当日日付 (YYYY-MM-DD) を返す */
function todayJST() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/** users.subjects (JSON文字列) を文字列配列へ正規化 */
function parseSubjects(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export const seatingService = {
  /**
   * 全座席表レイアウト一覧の取得
   */
  async getLayouts() {
    return await seatingModel.listLayouts();
  },

  /**
   * 座席表マトリクスの取得（rows/cols・席割当て＋オンライン状態・当日の出張/年休）
   */
  async getMatrix() {
    const { matrix, seats } = await seatingModel.getSeatMatrix(SEAT_MATRIX_ID);

    const absences = await absenceModel.listByDate(todayJST());
    const absencesByUser = new Map();
    for (const a of absences) {
      if (!absencesByUser.has(a.user_id)) absencesByUser.set(a.user_id, []);
      absencesByUser.get(a.user_id).push(a.record_type);
    }

    const mapped = seats.map((s) => ({
      ...s,
      subjects: parseSubjects(s.subjects),
      is_online: onlineUserIds.has(s.user_id),
      absences: absencesByUser.get(s.user_id) || [],
    }));

    const lock = await auditModel.getActiveEditingLock('seating', SEAT_MATRIX_ID, EDIT_LOCK_TIMEOUT_SEC);

    return {
      matrix: { id: SEAT_MATRIX_ID, name: matrix.name, rows: matrix.rows, cols: matrix.cols },
      seats: mapped,
      editingLock: lock,
    };
  },

  /**
   * 座席表マトリクスの保存（rows/cols と席割当てを一括更新）
   * ※ 編集可能モード（自分のアクティブロック）でのみ保存できる
   * @param {Object} data - { rows, cols, seats: [{ row, col, user_id }] }
   * @param {Object} user - { id, name }
   */
  async saveMatrix(data, user) {
    const rows = parseInt(data.rows, 10);
    const cols = parseInt(data.cols, 10);

    if (!Number.isInteger(rows) || !Number.isInteger(cols) || rows < 1 || cols < 1 || rows > 100 || cols > 100) {
      throw new ApiError(400, '行列は 1〜100 の範囲で指定してください。');
    }

    const lock = await auditModel.getActiveEditingLock('seating', SEAT_MATRIX_ID, EDIT_LOCK_TIMEOUT_SEC);
    if (!lock) {
      throw new ApiError(409, '編集可能モードへ切り替えてから保存してください。');
    }
    if (lock.user_id !== user.id) {
      throw new ApiError(
        423,
        `現在、${lock.user_name || '他の教員'} 先生が編集中のため保存できません。`
      );
    }

    const seatsInput = Array.isArray(data.seats) ? data.seats : [];
    const assignments = [];
    const assignedUsers = new Set();

    for (const s of seatsInput) {
      const row = Number(s.row);
      const col = Number(s.col);
      const userId = s.user_id;

      if (!userId) continue;
      if (!Number.isInteger(row) || !Number.isInteger(col)) continue;
      // 行列設定範囲外の席はマトリクスに存在しないため破棄
      if (row < 1 || row > rows || col < 1 || col > cols) continue;

      if (assignedUsers.has(userId)) {
        throw new ApiError(400, '同じ教職員を複数の席に割り当てることはできません。');
      }
      assignedUsers.add(userId);
      assignments.push({ row, col, user_id: userId });
    }

    const saved = await seatingModel.saveSeatMatrix(SEAT_MATRIX_ID, rows, cols, assignments);

    // 編集モード維持（ロックのハートビートを更新）
    await auditModel.refreshEditingLock('seating', SEAT_MATRIX_ID, user.id);

    await auditModel.logAction({
      userId: user.id,
      userName: user.name,
      action: 'SAVE_SEAT_MATRIX',
      resourceType: 'SEAT_MATRIX',
      resourceId: SEAT_MATRIX_ID,
      changesJson: JSON.stringify({ rows, cols, seatCount: assignments.length }),
    });

    return {
      message: '座席表を保存しました。',
      rows: saved.rows,
      cols: saved.cols,
      seats: assignments,
    };
  },

  /**
   * 編集可能モードへの切り替え（マトリクスの排他ロック取得）
   * @param {Object} user - { id, name }
   */
  async acquireMatrixLock(user) {
    const current = await auditModel.getActiveEditingLock('seating', SEAT_MATRIX_ID, EDIT_LOCK_TIMEOUT_SEC);

    if (current && current.user_id !== user.id) {
      throw new ApiError(
        423,
        `現在、${current.user_name || '他の教員'} 先生が編集中のため、編集可能モードへ切り替えられません。`
      );
    }

    const lock = await auditModel.acquireEditingLock(
      'seating',
      SEAT_MATRIX_ID,
      user.id,
      user.name,
      EDIT_LOCK_TIMEOUT_SEC
    );

    await auditModel.logAction({
      userId: user.id,
      userName: user.name,
      action: 'ACQUIRE_SEAT_MATRIX_LOCK',
      resourceType: 'SEAT_MATRIX',
      resourceId: SEAT_MATRIX_ID,
    });

    return lock;
  },

  /**
   * 編集ロックモードへの切り替え（マトリクスの排他ロック解放）
   * @param {Object} user - { id, name }
   */
  async releaseMatrixLock(user) {
    const current = await auditModel.getActiveEditingLock('seating', SEAT_MATRIX_ID, EDIT_LOCK_TIMEOUT_SEC);

    if (current && current.user_id === user.id) {
      await auditModel.releaseEditingLock('seating', SEAT_MATRIX_ID);
    }

    await auditModel.logAction({
      userId: user.id,
      userName: user.name,
      action: 'RELEASE_SEAT_MATRIX_LOCK',
      resourceType: 'SEAT_MATRIX',
      resourceId: SEAT_MATRIX_ID,
    });

    return { success: true };
  },

  /**
   * 座席表レイアウト詳細および全セル配置データの取得（教員在席状況の同期付加）
   * @param {string} layoutId
   */
  async getLayoutDetail(layoutId) {
    if (!layoutId) {
      throw new ApiError(400, 'レイアウトIDが指定されていません。');
    }

    const layout = await seatingModel.findLayoutById(layoutId);
    if (!layout) {
      throw new ApiError(404, '指定された座席表レイアウトが存在しません。');
    }

    const cells = await seatingModel.getCellsByLayoutId(layoutId);

    // 全教員の最新在席ステータスを取得してマッピング
    const teachers = await userModel.listAll();
    const teacherMap = new Map(teachers.map(t => [t.id, t]));

    // 各セルの教員情報に最新の在席ステータス (status: 'IN' | 'OUT' | 'CLASS' | 'TRIP') を動的同期
    const syncedCells = cells.map(cell => {
      if (cell.teacher_id && teacherMap.has(cell.teacher_id)) {
        const teacher = teacherMap.get(cell.teacher_id);
        return {
          ...cell,
          teacher_name: teacher.name,
          teacher_status: teacher.status || 'IN',
          teacher_department: teacher.department,
        };
      }
      return cell;
    });

    // 現在の排他編集ロック情報の取得
    const lock = await auditModel.getEditingLock('seating', layoutId);

    return {
      layout,
      cells: syncedCells,
      editingLock: lock,
    };
  },

  /**
   * 可変グリッド形式での新規座席表レイアウトの定義
   * @param {Object} data - { name, rows, cols }
   * @param {Object} user - { id, name }
   */
  async createLayout(data, user) {
    const { name, rows, cols } = data;

    if (!name || !rows || !cols) {
      throw new ApiError(400, 'レイアウト名、行数(rows)、列数(cols)は必須項目です。');
    }

    const numRows = parseInt(rows, 10);
    const numCols = parseInt(cols, 10);

    if (numRows <= 0 || numCols <= 0 || numRows > 20 || numCols > 20) {
      throw new ApiError(400, 'グリッドサイズは1〜20の範囲で指定してください。');
    }

    const newLayout = await seatingModel.createLayout({
      name: name.trim(),
      rows: numRows,
      cols: numCols,
    });

    await auditModel.logAction({
      userId: user.id,
      action: 'CREATE_SEATING_LAYOUT',
      targetEntity: 'SEATING_LAYOUT',
      targetId: newLayout.id,
      changesJson: JSON.stringify({ name: newLayout.name, rows: numRows, cols: numCols }),
    });

    return newLayout;
  },

  /**
   * 座席配置セルデータの一括更新・保存（排他編集ロック検証付き）
   * @param {string} layoutId
   * @param {Array<Object>} cells - [{ row_idx, col_idx, teacher_id, student_code, label, note }]
   * @param {Object} user - { id, name }
   */
  async saveSeatingCells(layoutId, cells, user) {
    if (!layoutId || !Array.isArray(cells)) {
      throw new ApiError(400, 'レイアウトIDおよびセルデータ配列は必須です。');
    }

    const layout = await seatingModel.findLayoutById(layoutId);
    if (!layout) {
      throw new ApiError(404, '対象の座席表レイアウトが見つかりません。');
    }

    // 他の教員による排他ロック保持チェック (3分以内の他者アクティブ編集を検知)
    const currentLock = await auditModel.getEditingLock('seating', layoutId);
    if (currentLock && currentLock.locked_by_user_id !== user.id) {
      const lockAge = Date.now() - new Date(currentLock.last_active_at).getTime();
      if (lockAge < EDIT_LOCK_TIMEOUT_MS) {
        throw new ApiError(
          423,
          `現在、${currentLock.locked_by_user_name || '他の教員'} 先生がこの座席表を編集中のため保存できません。`
        );
      }
    }

    // 4桁生徒コードが含まれる場合、マスター存在確認
    for (const cell of cells) {
      if (cell.student_code) {
        const student = await seatingModel.findStudentByCode(cell.student_code);
        if (!student) {
          throw new ApiError(400, `指定された生徒コード (${cell.student_code}) はマスターに存在しません。`);
        }
      }
    }

    // セル配置情報の一括更新
    const updatedCells = await seatingModel.updateCells(layoutId, cells);

    // 保存完了に伴い、編集ロックを解放
    await auditModel.releaseEditingLock('seating', layoutId);

    // 監査ログ記録
    await auditModel.logAction({
      userId: user.id,
      action: 'SAVE_SEATING_CELLS',
      targetEntity: 'SEATING_LAYOUT',
      targetId: layoutId,
      changesJson: JSON.stringify({ cellCount: cells.length }),
    });

    return {
      message: '座席表を正常に保存しました。',
      cells: updatedCells,
    };
  },

  /**
   * 4桁生徒コード (例: '1101' -> 1年1組1番) による生徒情報のピンポイント即時検索
   * @param {string} studentCode
   */
  async getStudentByCode(studentCode) {
    if (!studentCode || studentCode.trim().length !== 4) {
      throw new ApiError(400, '4桁の生徒コードを入力してください。(例: 1101)');
    }

    const code = studentCode.trim();
    const student = await seatingModel.findStudentByCode(code);

    if (!student) {
      throw new ApiError(404, `生徒コード「${code}」に該当する生徒が見つかりません。`);
    }

    return student;
  },

  /**
   * 生徒インクリメンタル検索 (コードまたは氏名部分一致)
   * @param {string} searchKey
   */
  async searchStudents(searchKey) {
    if (!searchKey || !searchKey.trim()) {
      return [];
    }

    return await seatingModel.searchStudents(searchKey.trim());
  },

  /**
   * 編集作業開始時の排他ロック取得およびハートビート更新
   * @param {string} layoutId
   * @param {Object} user - { id, name }
   */
  async acquireEditingLock(layoutId, user) {
    const layout = await seatingModel.findLayoutById(layoutId);
    if (!layout) {
      throw new ApiError(404, '対象の座席表レイアウトが存在しません。');
    }

    const currentLock = await auditModel.getEditingLock('seating', layoutId);

    // 他者が有効なロックを保持しているか判定
    if (currentLock && currentLock.locked_by_user_id !== user.id) {
      const lockAge = Date.now() - new Date(currentLock.last_active_at).getTime();
      if (lockAge < EDIT_LOCK_TIMEOUT_MS) {
        throw new ApiError(
          423,
          `現在、${currentLock.locked_by_user_name || '他の教員'} 先生が編集作業中です。`
        );
      }
    }

    // ロックの取得またはハートビート更新
    const lock = await auditModel.upsertEditingLock('seating', layoutId, user.id, user.name);

    return lock;
  },

  /**
   * 編集作業終了時の排他ロック解放
   * @param {string} layoutId
   * @param {Object} user
   */
  async releaseEditingLock(layoutId, user) {
    const currentLock = await auditModel.getEditingLock('seating', layoutId);

    if (currentLock && currentLock.locked_by_user_id === user.id) {
      await auditModel.releaseEditingLock('seating', layoutId);
    }

    return { success: true };
  },
};

export default seatingService;