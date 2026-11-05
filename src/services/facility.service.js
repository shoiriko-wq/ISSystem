/**
 * ISSystem Facility & Equipment Reservation Service
 * 施設・備品マスター管理・重複防止時間重複計算バリデーション・予約作成 & キャンセル
 */

import facilityModel from '../models/facility.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

/** 施設名・カテゴリの制約 (マスタ管理用) */
const FACILITY_NAME_MAX = 30;

/** カテゴリキー → 表示名 (教務部マスタ管理UIのセレクトと同一) */
export const FACILITY_CATEGORY_LABELS = {
  ROOM: '教室・会議室',
  GYM: '体育施設 (体育館・武道場)',
  OUTDOOR: '屋外施設 (運動場・体育広場)',
  EQUIPMENT: '備品・設備 (プロジェクター等)',
  VEHICLE: '車両 (マイクロバス等)',
  SPECIAL: '特別教室 (PC教室・理科室等)',
};

const CATEGORY_KEYS = Object.keys(FACILITY_CATEGORY_LABELS);

/** 施設予約の施設名（初期設定・デフォルト）。これ以外の名前は登録不可 */
export const DEFAULT_FACILITY_NAMES = [
  '学文館会議室',
  '西会議室',
  '東会議室',
  '応接室',
  '図書室',
  '食堂',
  '多目的教室',
  '４０５教室（西社会科教室）',
  '４０９教室（東社会科教室）',
  '２１２教室',
  '３１２教室',
  '２２７教室',
  '２２８教室（ＤＸルーム）',
  '視聴覚教室',
  '化学教室',
  '生物教室',
  '地学教室',
];

/** 初期設定の施設行 (ascii ID + カテゴリ: 7件=ROOM, 10件=SPECIAL) */
export const DEFAULT_FACILITY_ROWS = DEFAULT_FACILITY_NAMES.map((name, i) => ({
  id: `fac_${i + 1}`,
  name,
  category: i < 7 ? 'ROOM' : 'SPECIAL',
}));

function isDefaultFacilityName(name) {
  return DEFAULT_FACILITY_NAMES.includes(String(name || '').trim());
}

/** 未登録の初期設定施設を自動補完する (一覧取得時に呼び出し) */
async function ensureDefaultFacilities() {
  const list = await facilityModel.listFacilities();
  const existing = new Set(list.map((f) => String(f.name)));
  for (const r of DEFAULT_FACILITY_ROWS) {
    if (!existing.has(r.name)) {
      await facilityModel.createFacility({ id: r.id, name: r.name, category: r.category });
    }
  }
}

/** 教務主任権限 (KYOMU / ADMIN / is_kyomu) の判定 */
function isKyomu(user) {
  if (!user) return false;
  const role = String(user.role || '').toUpperCase();
  return user.is_kyomu === true || user.is_kyomu === 1 || role === 'KYOMU' || role === 'ADMIN';
}

function ensureKyomu(user) {
  if (!isKyomu(user)) {
    throw new ApiError(403, '施設・備品マスターの追加・改名・削除は教務部 (KYOMU) のみです。');
  }
}

/** 施設名を正規化 (空・長文は 400) */
function normalizeFacilityName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!name) {
    throw new ApiError(400, '施設・備品名を入力してください。');
  }
  if (name.length > FACILITY_NAME_MAX) {
    throw new ApiError(400, `施設・備品名は${FACILITY_NAME_MAX}文字以内で入力してください。`);
  }
  return name;
}

/** カテゴリキーを検証して正規化 (未定義キーは 400) */
function normalizeFacilityCategory(raw) {
  const key = String(raw || '').trim().toUpperCase();
  if (!CATEGORY_KEYS.includes(key)) {
    throw new ApiError(400, `カテゴリ「${raw}」は定義されていません。 (${CATEGORY_KEYS.join(' / ')})`);
  }
  return key;
}

/** 名称の重複チェック (case-insensitive。excludeId 以外の同名が存在すれば 409) */
function ensureNameAvailable(list, name, excludeId = null) {
  const conflict = list.find(
    (f) => String(f.name).toLowerCase() === String(name).toLowerCase() && String(f.id) !== String(excludeId)
  );
  if (conflict) {
    throw new ApiError(409, `施設・備品「${name}」は既に登録されています。`);
  }
}

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
    await ensureDefaultFacilities();
    return await facilityModel.listFacilities();
  },

  /**
   * 施設マスター一覧＋予約使用件数 (マスタ管理UI・削除確認用)
   * active = 有効予約件数 (削除ガードの基準), total = キャンセル履歴含む全件数
   */
  async listFacilitiesWithUsage() {
    await ensureDefaultFacilities();
    const facilities = await facilityModel.listFacilities();
    const withUsage = await Promise.all(
      facilities.map(async (fac) => {
        const counts = await facilityModel.countReservations(fac.id);
        return {
          ...fac,
          reservation_count: counts.active,
          reservation_total: counts.total,
        };
      })
    );
    return { facilities: withUsage };
  },

  /**
   * 施設・備品の追加 (教務部のみ)
   * @param {Object} payload - { name, category }
   * @param {Object} user - { id, name, role, is_kyomu }
   */
  async createFacility(payload, user) {
    ensureKyomu(user);
    const name = normalizeFacilityName(payload.name);
    const category = normalizeFacilityCategory(payload.category || 'ROOM');

    if (!isDefaultFacilityName(name)) {
      throw new ApiError(400, `施設名は「${DEFAULT_FACILITY_NAMES.join('・')}」の範囲内で指定してください。`);
    }

    const existing = await facilityModel.listFacilities();
    ensureNameAvailable(existing, name);

    const facility = await facilityModel.createFacility({ id: payload.id, name, category });

    await auditModel.logAction({
      userId: user.id,
      action: 'CREATE_FACILITY',
      targetEntity: 'FACILITY',
      targetId: facility.id,
      changesJson: JSON.stringify({ name, category }),
    });

    return facility;
  },

  /**
   * 施設・備品の改名・カテゴリ変更 (教務部のみ)
   * 改名は既存予約の表示 (resource_id 参照の JOIN) へ自動反映される
   * @param {string} id
   * @param {Object} payload - { name?, category? }
   * @param {Object} user
   */
  async updateFacility(id, payload, user) {
    ensureKyomu(user);

    const target = await facilityModel.findFacilityById(id);
    if (!target) {
      throw new ApiError(404, '施設・備品が見つかりません。');
    }

    const name = payload.name !== undefined ? normalizeFacilityName(payload.name) : undefined;
    const category =
      payload.category !== undefined ? normalizeFacilityCategory(payload.category) : undefined;

    if (name) {
      if (!isDefaultFacilityName(name)) {
        throw new ApiError(400, `施設名は「${DEFAULT_FACILITY_NAMES.join('・')}」の範囲内で指定してください。`);
      }
      const existing = await facilityModel.listFacilities();
      ensureNameAvailable(existing, name, id);
    }

    const updated = await facilityModel.updateFacility(id, { name, category });
    if (!updated) {
      throw new ApiError(404, '施設・備品が見つかりません。');
    }

    await auditModel.logAction({
      userId: user.id,
      action: 'UPDATE_FACILITY',
      targetEntity: 'FACILITY',
      targetId: String(id),
      changesJson: JSON.stringify({
        from: { name: target.name, category: target.category },
        to: { name: updated.name, category: updated.category },
      }),
    });

    return updated;
  },

  /**
   * 施設・備品の削除 (教務部のみ)
   * 有効な予約が残る施設は削除不可 (先に予約をキャンセルさせる)。
   * 削除時は FK 制約を満たすためキャンセル済み予約履歴・編集ロック・セル値も除去する。
   * @param {string} id
   * @param {Object} user
   */
  async deleteFacility(id, user) {
    ensureKyomu(user);

    const target = await facilityModel.findFacilityById(id);
    if (!target) {
      throw new ApiError(404, '施設・備品が見つかりません。');
    }

    if (isDefaultFacilityName(target.name)) {
      throw new ApiError(409, `初期設定の施設「${target.name}」は削除できません。`);
    }

    const counts = await facilityModel.countReservations(id);
    if (counts.active > 0) {
      throw new ApiError(
        409,
        `施設「${target.name}」は有効な予約が ${counts.active} 件残っているため削除できません。先に予約をキャンセルしてください。`
      );
    }

    const removed = await facilityModel.deleteFacility(id);

    await auditModel.logAction({
      userId: user.id,
      action: 'DELETE_FACILITY',
      targetEntity: 'FACILITY',
      targetId: String(id),
      changesJson: JSON.stringify({
        name: target.name,
        category: target.category,
        deleted_reservations: removed.deleted_reservations,
        deleted_locks: removed.deleted_locks,
        deleted_cells: removed.deleted_cells,
      }),
    });

    return removed;
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
        `指定された時間帯 (${startHHMM}〜${endHHMM}) は既存予約「${overlappingReservation.title}」（予約者: ${overlappingReservation.user_name || '他教員'}）と時間帯が重複しています。`
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
  /**
   * 予約の変更 (予約者本人または教務部のみ)。時間帯重複は自己予約を除外して照会
   * @param {string} reservationId
   * @param {Object} payload
   * @param {Object} user - { id, role, is_kyomu }
   */
  async updateReservation(reservationId, payload, user) {
    if (!reservationId) {
      throw new ApiError(400, '予約IDが指定されていません。');
    }

    const target = await facilityModel.findReservationById(reservationId);
    if (!target) {
      throw new ApiError(404, '対象の予約が見つかりません。');
    }
    if (Number(target.is_cancelled) === 1) {
      throw new ApiError(410, 'キャンセル済みの予約は変更できません。');
    }

    // ★ 投稿者（予約者）本人か教務部のみ変更できる
    const isOwner = String(target.user_id) === String(user.id || user._id);
    if (!isOwner && !isKyomu(user)) {
      throw new ApiError(403, '予約の変更・削除は予約を投稿した本人（教務部を含む）のみ利用できます。');
    }

    const updated = await facilityModel.updateReservation(reservationId, payload || {});
    if (!updated) {
      throw new ApiError(404, '対象の予約が見つかりません。');
    }

    await auditModel.logAction({
      userId: user.id || user._id,
      action: 'UPDATE_RESERVATION',
      targetEntity: 'RESERVATION',
      targetId: reservationId,
      changesJson: JSON.stringify({
        title: updated.title,
        target_date: updated.target_date,
        start_time: updated.start_time,
        end_time: updated.end_time,
      }),
    });

    return updated;
  },

  async cancelReservation(reservationId, user) {
    if (!reservationId) {
      throw new ApiError(400, '予約IDが指定されていません。');
    }

    // ★ 投稿者（予約者）本人か教務部のみ削除できる
    const target = await facilityModel.findReservationById(reservationId);
    if (!target) {
      throw new ApiError(404, '対象の予約が見つかりません。');
    }
    const isOwner = String(target.user_id) === String(user.id || user._id);
    if (!isOwner && !isKyomu(user)) {
      throw new ApiError(403, '予約の変更・削除は予約を投稿した本人（教務部を含む）のみ利用できます。');
    }

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