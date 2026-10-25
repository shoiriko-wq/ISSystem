/**
 * ISSystem 年休等・出張 欠席登録サービス
 * ダッシュボードサマリー取得・教員による手動記入（登録/取消）と権限判定
 *
 * 権限:
 *  - 教務・管理職 (PRIVILEGED_RECORDING_ROLES) は全教員の登録を行える
 *  - 一般教員は「自分の分」だけを登録・取消できる
 *  ※ 将来的に管理職ロールを増やす場合は PRIVILEGED_RECORDING_ROLES に追加する
 */

import { absenceModel, ABSENCE_TYPE_LABELS } from '../models/absence.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

/** 区分ラベル (controller からも利用) */
export { ABSENCE_TYPE_LABELS };

/** 登録権限を持つロール (教務主任・管理職・システム管理者) */
export const PRIVILEGED_RECORDING_ROLES = ['KYOMU', 'SEIFO', 'ADMIN'];

/** 現在ダッシュボードで扱う登録区分 */
export const ABSENCE_TYPES = ['LEAVE', 'TRIP'];

/**
 * YYYY-MM-DD が実在する日付かを検証 (2099-13-01 等の虚日を排除)
 */
function isValidDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/**
 * 日付文字列 (YYYY-MM-DD) を正規化。未取得・不正時は日本時間の今日を返す
 */
function resolveDate(raw) {
  const s = String(raw || '').trim().substring(0, 10);
  return isValidDateStr(s) ? s : new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

/**
 * 登録権限 (教務・管理職) を持つユーザーかを判定
 */
export function hasRecordingRole(user) {
  if (!user) return false;
  const role = String(user.role || '').toUpperCase();
  return PRIVILEGED_RECORDING_ROLES.includes(role) || user.is_kyomu === true;
}

/**
 * 対象教員に対する登録・取消権限の判定
 * 教務・管理職は全教員、一般教員は本人分のみ
 */
export function canRecordFor(user, targetUserId) {
  if (!user || !targetUserId) return false;
  const currentId = String(user.id || user._id || '');
  if (currentId && currentId === String(targetUserId)) return true;
  return hasRecordingRole(user);
}

export const absenceService = {
  /**
   * ダッシュボード表示用サマリー (年休等・出張 人数 + 登録一覧)
   * @param {string} targetDate YYYY-MM-DD
   * @param {object} user JWTペイロード (権限判定用)
   */
  async getSummary(targetDate, user) {
    const date = resolveDate(targetDate);
    const counts = await absenceModel.countByDate(date);
    const records = await absenceModel.listByDate(date);

    return {
      date,
      counts: {
        LEAVE: counts.LEAVE || 0,
        TRIP: counts.TRIP || 0,
      },
      labels: ABSENCE_TYPE_LABELS,
      total_staff: records.length,
      records,
      can_record: hasRecordingRole(user),
      can_record_self: true,
    };
  },

  /**
   * 年休等・出張 の登録 (手動記入)
   * @param {object} payload { user_id, record_type, record_date, reason }
   * @param {object} user 登録操作者のJWTペイロード
   */
  async recordAbsence(payload, user) {
    const recordType = String(payload.record_type || '').toUpperCase();
    if (!ABSENCE_TYPES.includes(recordType)) {
      throw new ApiError(400, '区分は「年休等 (LEAVE)」または「出張 (TRIP)」で指定してください。');
    }

    const targetUserId = String(payload.user_id || '').trim();
    if (!targetUserId) {
      throw new ApiError(400, '登録対象の教員を選択してください。');
    }

    if (!canRecordFor(user, targetUserId)) {
      throw new ApiError(422, '他の教員の年休等・出張を登録する権限がありません（教務・管理職のみ登録可能です）。');
    }

    const targetUser = await absenceModel.findUserById(targetUserId);
    if (!targetUser) {
      throw new ApiError(422, '登録対象の教員が見つかりません。');
    }

    const rawDate = String(payload.record_date || '').trim().substring(0, 10);
    if (!isValidDateStr(rawDate)) {
      throw new ApiError(400, '対象日 (YYYY-MM-DD) が不正です。存在する日付を指定してください。');
    }
    const recordDate = rawDate;
    const reason = String(payload.reason || '').trim().substring(0, 200);

    const saved = await absenceModel.upsert({
      user_id: targetUserId,
      record_date: recordDate,
      record_type: recordType,
      reason,
      recorded_by: user.id || user._id,
      recorded_by_name: user.name || '教員',
    });

    // upsert の RETURNING 行には教員名JOINがないため、検索済みの targetUser で補完
    if (saved) {
      saved.user_name = targetUser.name;
      saved.staff_code = targetUser.staff_code;
      saved.department = targetUser.department;
    }

    await auditModel.logAction({
      userId: user.id || user._id,
      action: 'RECORD_ABSENCE',
      targetEntity: 'ABSENCE_RECORD',
      targetId: saved.id,
      changesJson: JSON.stringify({
        user_id: saved.user_id,
        record_date: saved.record_date,
        record_type: saved.record_type,
        reason: saved.reason,
        recorded_by_name: saved.recorded_by_name,
      }),
    });

    return saved;
  },

  /**
   * 登録の取消 (削除)
   * @param {string} recordId 登録ID
   * @param {object} user 操作者のJWTペイロード
   */
  async removeAbsence(recordId, user) {
    const record = await absenceModel.findById(recordId);
    if (!record) {
      throw new ApiError(404, '登録が見つかりません。');
    }

    if (!canRecordFor(user, record.user_id)) {
      throw new ApiError(422, '他の教員の年休等・出張登録を取消する権限がありません。');
    }

    const deleted = await absenceModel.deleteById(recordId);

    await auditModel.logAction({
      userId: user.id || user._id,
      action: 'DELETE_ABSENCE_RECORD',
      targetEntity: 'ABSENCE_RECORD',
      targetId: recordId,
      changesJson: JSON.stringify({ before: record, after: null }),
    });

    return deleted;
  },

  /**
   * 登録フォーム用の教員一覧 (権限に応じた選択肢)
   * @param {object} user 操作者のJWTペイロード
   */
  async getSelectableTeachers(user) {
    const all = await absenceModel.listSelectableUsers();
    const privileged = hasRecordingRole(user);

    return all.map((u) => ({
      id: u.id,
      name: u.name,
      staff_code: u.staff_code,
      department: u.department,
      selectable: privileged || String(u.id) === String(user.id || user._id),
    }));
  },
};

export default absenceService;
