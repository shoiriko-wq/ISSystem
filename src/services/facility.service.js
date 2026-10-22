/**
 * ISSystem Facility & Equipment Reservation Service
 * 施設・備品マスター管理・重複防止時間重複計算バリデーション・予約作成 & キャンセル
 */

import facilityModel from '../models/facility.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

/**
 * 時刻文字列 'HH:MM' を分に変換するヘルパー関数
 * @param {string} timeStr - '09:00' 等
 */
function timeToMinutes(timeStr) {
  if (!timeStr || !timeStr.includes(':')) return -1;
  const [hours, minutes] = timeStr.split(':').map(Number);
  return hours * 60 + minutes;
}

export const facilityService = {
  /**
   * 全施設・備品マスター一覧の取得
   */
  async getAllFacilities() {
    return await facilityModel.listFacilities();
  },

  /**
   * 特定日付における指定施設の予約状況一覧取得
   * @param {string} facilityId
   * @param {string} targetDate - 'YYYY-MM-DD'
   */
  async getReservations(facilityId, targetDate) {
    if (!facilityId || !targetDate) {
      throw new ApiError(400, '施設IDおよび対象日付は必須です。');
    }

    const facility = await facilityModel.findFacilityById(facilityId);
    if (!facility) {
      throw new ApiError(404, '指定された施設・備品が見つかりません。');
    }

    const reservations = await facilityModel.getReservationsByDate(facilityId, targetDate);

    return {
      facility,
      targetDate,
      reservations,
    };
  },

  /**
   * 時間重複判定付きの新規施設・備品予約登録
   * @param {Object} reservationData - { facility_id, title, target_date, start_time, end_time }
   * @param {Object} user - { id, name }
   */
  async createReservation(reservationData, user) {
    const { facility_id, title, target_date, start_time, end_time } = reservationData;

    // 必須入力チェック
    if (!facility_id || !title || !target_date || !start_time || !end_time) {
      throw new ApiError(400, '施設ID、予約件名、日付、開始時刻、終了時刻はすべて必須です。');
    }

    // 施設存在チェック
    const facility = await facilityModel.findFacilityById(facility_id);
    if (!facility) {
      throw new ApiError(404, '対象の施設・備品が存在しません。');
    }

    // 時刻バリデーション (開始時間 < 終了時間)
    const startMin = timeToMinutes(start_time);
    const endMin = timeToMinutes(end_time);

    if (startMin < 0 || endMin < 0) {
      throw new ApiError(400, '時刻のフォーマットが正しくありません。(例: 09:30)');
    }

    if (startMin >= endMin) {
      throw new ApiError(400, '終了時刻は開始時刻よりも後の時間を指定してください。');
    }

    // 重複予約判定 (Overlap Validation)
    // 条件: (既存Start < 新規End) AND (既存End > 新規Start)
    const overlappingReservation = await facilityModel.checkOverlap(
      facility_id,
      target_date,
      start_time,
      end_time
    );

    if (overlappingReservation) {
      throw new ApiError(
        409,
        `指定された時間帯 (${start_time}〜${end_time}) には既に予約「${overlappingReservation.title}」（予約者: ${overlappingReservation.user_name || '他教員'}）が入っています。`
      );
    }

    // 予約の確定処理
    const newReservation = await facilityModel.createReservation({
      facility_id,
      facility_name: facility.name,
      user_id: user.id,
      user_name: user.name,
      title: title.trim(),
      target_date,
      start_time,
      end_time,
    });

    // 監査ログ記録
    await auditModel.logAction({
      userId: user.id,
      action: 'CREATE_FACILITY_RESERVATION',
      targetEntity: 'FACILITY_RESERVATION',
      targetId: newReservation.id,
      changesJson: JSON.stringify({
        facilityName: facility.name,
        targetDate: target_date,
        timeSlot: `${start_time}-${end_time}`,
      }),
    });

    return newReservation;
  },

  /**
   * 予約のキャンセル処理 (本人、教務主任、管理者のみ)
   * @param {string} reservationId
   * @param {Object} user - { id, role, is_kyomu }
   */
  async cancelReservation(reservationId, user) {
    if (!reservationId) {
      throw new ApiError(400, '予約IDが指定されていません。');
    }

    // キャンセル権限の照会・検証はモデル側および呼び出し元で判定
    await facilityModel.cancelReservation(reservationId, user.id);

    // 監査ログの記録
    await auditModel.logAction({
      userId: user.id,
      action: 'CANCEL_FACILITY_RESERVATION',
      targetEntity: 'FACILITY_RESERVATION',
      targetId: reservationId,
    });

    return { message: '予約を正常にキャンセルしました。' };
  },

  /**
   * 特定日付における全施設・備品の稼働状況マトリクス一覧取得
   * @param {string} targetDate - 'YYYY-MM-DD'
   */
  async getDailyFacilityOverview(targetDate) {
    if (!targetDate) {
      throw new ApiError(400, '対象日付を指定してください。');
    }

    const facilities = await facilityModel.listFacilities();

    const overviewList = await Promise.all(
      facilities.map(async (fac) => {
        const reservations = await facilityModel.getReservationsByDate(fac.id, targetDate);
        return {
          facility: fac,
          reservations,
        };
      })
    );

    return {
      targetDate,
      facilitiesOverview: overviewList,
    };
  },
};

export default facilityService;