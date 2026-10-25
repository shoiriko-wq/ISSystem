/**
 * ISSystem Facility & Equipment Reservation Service
 * 施設・備品マスター管理・重複防止時間重複計算バリデーション・予約作成 & キャンセル
 */

import facilityModel from '../models/facility.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

/**
 * 時刻表記 'HH:MM' / 'HH:MM:SS' / 'YYYY-MM-DD HH:MM:SS' を 'HH:MM' に正規化する
 * @param {string} raw
 */
function normalizeTime(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const match = str.match(/(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (!match) return null;
  const h = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * 日付表記 'YYYY-MM-DD' / 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DDTHH:MM' を 'YYYY-MM-DD' に正規化する
 * @param {string} raw
 */
function normalizeDate(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return `${match[1]}-${match[2]}-${match[3]}`;
}

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
    const { title } = reservationData;
    const facility_id =
      reservationData.facility_id ||
      reservationData.facilityId ||
      reservationData.resource_id ||
      reservationData.resourceId;
    const titleRaw = (title || reservationData.purpose || '').trim();

    // 必須入力チェック
    if (!facility_id || !titleRaw) {
      throw new ApiError(400, '施設IDと予約件名は必須です。');
    }

    // 時刻・日付表記の正規化 (HH:MM / YYYY-MM-DD HH:MM:SS の双方を受け付ける)
    const startRaw = reservationData.start_time || reservationData.startTime;
    const endRaw = reservationData.end_time || reservationData.endTime;
    const targetDate =
      normalizeDate(reservationData.target_date) ||
      normalizeDate(reservationData.targetDate) ||
      normalizeDate(reservationData.date) ||
      normalizeDate(startRaw);
    const startHHMM = normalizeTime(startRaw);
    const endHHMM = normalizeTime(endRaw);

    if (!targetDate) {
      throw new ApiError(400, '利用日付 (YYYY-MM-DD) を指定してください。');
    }
    if (!startHHMM || !endHHMM) {
      throw new ApiError(400, '開始・終了時刻のフォーマットが正しくありません。(例: 09:30)');
    }

    // 施設存在チェック
    const facility = await facilityModel.findFacilityById(facility_id);
    if (!facility) {
      throw new ApiError(404, '対象の施設・備品が存在しません。');
    }

    // 時刻バリデーション (開始時間 < 終了時間)
    const startMin = timeToMinutes(startHHMM);
    const endMin = timeToMinutes(endHHMM);

    if (startMin < 0 || endMin < 0) {
      throw new ApiError(400, '時刻のフォーマットが正しくありません。(例: 09:30)');
    }

    if (startMin >= endMin) {
      throw new ApiError(400, '終了時刻は開始時刻よりも後の時間を指定してください。');
    }

    // 連続時間帯として運用する範囲 (8:00〜18:00) を逸脱する予約は拒否
    const DAY_START_MIN = 8 * 60;
    const DAY_END_MIN = 18 * 60;
    if (startMin < DAY_START_MIN || endMin > DAY_END_MIN) {
      throw new ApiError(400, '施設・備品の利用は 8:00〜18:00 の連続時間帯で登録してください。');
    }

    // 時間枠は期間・時限の区切りに依存せず、開始・終了時刻の連続時間帯として扱う
    const fullStart = `${targetDate} ${startHHMM}:00`;
    const fullEnd = `${targetDate} ${endHHMM}:00`;

    // 重複予約判定 (Overlap Validation)
    // 条件: (既存Start < 新規End) AND (既存End > 新規Start)
    const overlappingReservation = await facilityModel.checkOverlap(
      facility_id,
      targetDate,
      fullStart,
      fullEnd
    );

    if (overlappingReservation) {
      throw new ApiError(
        409,
        `指定された時間帯 (${startHHMM}〜${endHHMM}) には既に予約「${overlappingReservation.title}」（予約者: ${overlappingReservation.user_name || '他教員'}）が入っています。`
      );
    }

    // 予約の確定処理
    const newReservation = await facilityModel.createReservation({
      resource_id: facility_id,
      facility_id,
      facility_name: facility.name,
      user_id: user.id || reservationData.user_id,
      user_name: user.name || reservationData.user_name,
      title: titleRaw,
      target_date: targetDate,
      start_time: fullStart,
      end_time: fullEnd,
    });

    // 監査ログ記録
    await auditModel.logAction({
      userId: user.id,
      action: 'CREATE_FACILITY_RESERVATION',
      targetEntity: 'FACILITY_RESERVATION',
      targetId: newReservation.id,
      changesJson: JSON.stringify({
        facilityName: facility.name,
        targetDate: targetDate,
        timeSlot: `${startHHMM}-${endHHMM}`,
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