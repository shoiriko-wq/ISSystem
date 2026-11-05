/**
 * ISSystem 定期考査 基本情報マスタ Business Service
 * クラス・コース（自由文字列名）・教科・科目・教室の登録（教務部 KYOMU のみ）、
 * 改名の考査計画への CASCADE、使用中削除ガード、監査ログ記録を行う。
 * クラスとコースは分離せず「1-3理」「1-6看」「1-6保育」のような学校固有の名称で登録する。
 */

import basicinfoModel from '../models/basicinfo.model.js';
import auditModel from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

const KINDS = {
  class: { label: 'クラス・コース', resource: 'curriculum_class' },
  subject: { label: '科目', resource: 'curriculum_subject' },
  room: { label: '教室', resource: 'basic_room' },
};

/** 初期設定（デフォルト）のクラス・コース名。これ以外の名称は登録・改名不可 */
export const DEFAULT_CLASS_NAMES = [
  '1-1', '1-2', '1-3', '1-4', '1-5', '1-6', '1-7',
  '2-1', '2-2', '2-3', '2-4文', '2-4理', '2-5', '2-6看', '2-6文', '2-7',
  '3-1総', '3-1人', '3-2', '3-3', '3-4人', '3-4数', '3-5', '3-6数', '3-6環',
  '3-7看', '3-7総', '3-7人', '3-8総', '3-8人',
];

function isDefaultClassName(name) {
  return DEFAULT_CLASS_NAMES.includes(String(name || '').trim());
}

function isKyomu(user) {
  const role = String(user?.role || '').toUpperCase();
  return user?.is_kyomu === true || role === 'KYOMU' || role === 'ADMIN';
}

function requireKyomu(user) {
  if (!isKyomu(user)) {
    throw new ApiError(403, '基本情報の登録・改名・削除は教務部 (KYOMU) の権限が必要です。');
  }
}

/** UI から受け取った「実施クラス・コース ID 一覧」を科目開講リストへ変換（学年はクラス側から導出、標準教室は既存値を維持） */
async function resolveOfferings(classCourseIds, existing = []) {
  const ids = Array.isArray(classCourseIds) ? classCourseIds : [];
  if (ids.length === 0) return [];
  const classes = await basicinfoModel.listClasses();
  const byId = new Map(classes.map((c) => [String(c.id), c]));
  const prev = new Map((existing || []).map((o) => [String(o?.class_course_id), o]));
  const out = [];
  for (const raw of ids) {
    const c = byId.get(String(raw));
    if (!c) continue;
    const before = prev.get(String(c.id));
    out.push({
      grade: Number(c.grade) || 0,
      class_course_id: String(c.id),
      room_id: before?.room_id ? String(before.room_id) : null,
    });
  }
  out.sort((a, b) => a.grade - b.grade || a.class_course_id.localeCompare(b.class_course_id, 'ja'));
  return out;
}

/** 同一学年内のクラス・コース名重複チェック（名前が変更される場合） */
async function checkClassNameDup(grade, name, excludeId = null) {
  const lower = String(name || '').toLowerCase();
  const rows = await basicinfoModel.listClasses(grade);
  const dup = rows.find((c) => String(c.id) !== String(excludeId) && String(c.name).toLowerCase() === lower);
  if (dup) {
    throw new ApiError(409, `クラス・コース「${name}」は ${grade}年に既に登録されています。`);
  }
}

/** 教室名の重複チェック（改名時・basic_rooms のユニーク制約より先に検証） */
async function checkRoomNameDup(name, excludeId = null) {
  const lower = String(name || '').toLowerCase();
  const rows = await basicinfoModel.listRooms();
  const dup = rows.find((r) => String(r.id) !== String(excludeId) && String(r.name).toLowerCase() === lower);
  if (dup) {
    throw new ApiError(409, `教室「${name}」は既に登録されています。`);
  }
}

/** 種別ごとの入力検証（name は必須・その他の項目は正規化） */
function validatePayload(kind, payload) {
  const p = { ...payload };
  const label = KINDS[kind].label;

  p.name = String(p.name || '').trim();
  if (!p.name) throw new ApiError(400, `${label}名は必須です。`);
  if (p.name.length > 60) throw new ApiError(400, `${label}名は 60 文字以内で入力してください。`);

  if (kind === 'class') {
    const grade = Number(p.grade);
    if (!Number.isInteger(grade) || grade < 1 || grade > 6) {
      throw new ApiError(400, 'クラス・コースの学年は 1〜6 の整数で指定してください。');
    }
    p.grade = grade;
    // クラス番号・コースは分離しない（ school 固有の自由文字列名、内部IDは学年内で自動採番）
    p.short_name = p.short_name ? String(p.short_name).trim() : p.name;
    p.is_active = p.is_active !== false;
  }

  if (kind === 'subject') {
    // 学年・表示順は持たない（科目名に学年・単位数を含め、並びは教科順でソートする）
    p.grade = 0;
    p.sort_order = 0;
    p.default_duration = parseInt(p.default_duration, 10) || 50;
    if (p.default_duration < 10 || p.default_duration > 120) {
      throw new ApiError(400, '標準試験時間は 10〜120 分の範囲で指定してください（既定 50分）。');
    }
    p.short_name = p.short_name ? String(p.short_name).trim() : p.name;
    p.subject_id = p.subject_id ? String(p.subject_id) : null;
    p.default_room_id = p.default_room_id ? String(p.default_room_id) : null;
    p.is_active = p.is_active !== false;
    p.notes = p.notes ? String(p.notes).trim() : null;
  }

  if (kind === 'room') {
    // 種別・使用学年は登録項目から削除（DB列は既定値を維持）
    p.room_type = 'CLASS';
    p.grades = [];
    p.seats = parseInt(p.seats, 10) || 40;
    if (p.seats < 1 || p.seats > 200) throw new ApiError(400, '座席数は 1〜200 で指定してください。');
    p.is_active = p.is_active !== false;
    p.notes = p.notes ? String(p.notes).trim() : null;
  }

  return p;
}

/** 使用中件数のラベル化 */
function usageMessage(kind, counts) {
  const label = KINDS[kind].label;
  if (kind === 'class') {
    const parts = [];
    if (counts.slots) parts.push(`時間割 ${counts.slots}件`);
    if (counts.proctors) parts.push(`監督割 ${counts.proctors}件`);
    if (counts.plans) parts.push(`実施科目 ${counts.plans}件`);
    if (counts.offerings) parts.push(`開講科目 ${counts.offerings}件`);
    return parts.length ? `（${parts.join(' / ')}で使用）` : '';
  }
  if (kind === 'subject') {
    const parts = [];
    if (counts.plan) parts.push(`実施科目 ${counts.plan}件`);
    if (counts.slots) parts.push(`時間割 ${counts.slots}件`);
    if (counts.room_config) parts.push(`教室設定 ${counts.room_config}件`);
    if (counts.room_assignments) parts.push(`教室割 ${counts.room_assignments}件`);
    if (counts.proctors) parts.push(`監督割 ${counts.proctors}件`);
    return parts.length ? `（${parts.join(' / ')}で使用）` : '';
  }
  const parts = [];
  if (counts.subject_defaults) parts.push(`科目の標準教室 ${counts.subject_defaults}件`);
  if (counts.offerings) parts.push(`クラス・コース別標準教室 ${counts.offerings}件`);
  if (counts.exam_rooms) parts.push(`考査教室 ${counts.exam_rooms}件`);
  if (counts.room_config) parts.push(`教室設定 ${counts.room_config}件`);
  if (counts.room_assignments) parts.push(`教室割 ${counts.room_assignments}件`);
  if (counts.plan_rows) parts.push(`実施科目 ${counts.plan_rows}件`);
  return parts.length ? `（${parts.join(' / ')}で使用）` : '';
}

export const basicinfoService = {
  /**
   * 基本情報一括取得（全教職員）
   * @param {number} grade 学年で絞り込む場合 (0/undefined = 全件)
   */
  async getBasicInfo(grade = null, user = null) {
    if (!user) throw new ApiError(401, '認証情報が存在しません。');
    const gradeFilter = Number(grade) > 0 ? Number(grade) : null;
    return await basicinfoModel.getBasicInfo(gradeFilter);
  },

  /** 使用件数の取得（削除可否表示用） */
  async getUsage(kind, id, user = null) {
    if (!user) throw new ApiError(401, '認証情報が存在しません。');
    if (!KINDS[kind]) throw new ApiError(400, '不明なマスタ種別です。');

    if (kind === 'class') {
      const counts = await basicinfoModel.classUsage(id);
      const row = (await basicinfoModel.listClasses()).find((c) => String(c.id) === String(id));
      counts.name = row ? row.name : null;
      return counts;
    }

    if (kind === 'subject') {
      const row = (await basicinfoModel.listSubjects()).find((s) => String(s.id) === String(id));
      if (!row) throw new ApiError(404, `対象の${KINDS[kind].label}が見つかりません。`);
      const counts = await basicinfoModel.subjectUsage(row.name);
      counts.name = row.name;
      return counts;
    }

    const roomRow = (await basicinfoModel.listRooms()).find((r) => String(r.id) === String(id));
    if (!roomRow) throw new ApiError(404, `対象の${KINDS[kind].label}が見つかりません。`);
    const counts = await basicinfoModel.roomUsage(roomRow.id, roomRow.name);
    counts.name = roomRow.name;
    return counts;
  },

  // ==========================================================
  // 登録（教務部のみ）
  // ==========================================================
  async createItem(kind, payload, user) {
    requireKyomu(user);
    if (!KINDS[kind]) throw new ApiError(400, '不明なマスタ種別です。');
    const p = validatePayload(kind, payload);
    if (kind === 'subject' && p.class_course_ids !== undefined) {
      p.offerings = await resolveOfferings(p.class_course_ids);
      delete p.class_course_ids;
    }
    if (kind === 'class') await checkClassNameDup(p.grade, p.name);
    if (kind === 'class' && !DEFAULT_CLASS_NAMES.includes(String(p.name).trim())) {
      throw new ApiError(400, `クラス・コース名は「${DEFAULT_CLASS_NAMES.join('・')}」の範囲内で指定してください。`);
    }
    if (kind === 'room') await checkRoomNameDup(p.name);

    let created = null;
    if (kind === 'class') created = await basicinfoModel.createClass({ ...p, updated_by: user.id });
    if (kind === 'subject') created = await basicinfoModel.createSubject({ ...p, updated_by: user.id });
    if (kind === 'room') created = await basicinfoModel.createRoom({ ...p, updated_by: user.id });

    if (!created) throw new ApiError(400, `${KINDS[kind].label}の登録に失敗しました。`);

    await auditModel.logAction({
      userId: user.id,
      userName: user.name,
      action: `CREATE_${kind.toUpperCase()}`,
      resourceType: KINDS[kind].resource,
      resourceId: created.id,
      newValue: created,
    });
    return created;
  },

  // ==========================================================
  // 改名・属性更新（教務部のみ・科目と教室は考査計画へ CASCADE）
  // ==========================================================
  async updateItem(kind, id, payload, user) {
    requireKyomu(user);
    if (!KINDS[kind]) throw new ApiError(400, '不明なマスタ種別です。');

    const partial = {};
    for (const key of Object.keys(payload || {})) {
      const value = payload[key];
      if (value === undefined) continue;
      if (key === 'name' && typeof value !== 'string') {
        throw new ApiError(400, `${KINDS[kind].label}名は文字列で指定してください。`);
      }
      if (key === 'name' && !String(value).trim()) {
        throw new ApiError(400, `${KINDS[kind].label}名は空にできません。`);
      }
      partial[key] = value;
    }
    if (partial.name) partial.name = String(partial.name).trim();
    if (kind === 'subject' && partial.class_course_ids !== undefined) {
      const cur = (await basicinfoModel.listSubjects()).find((s) => String(s.id) === String(id));
      if (!cur) throw new ApiError(404, `対象の${KINDS[kind].label}が見つかりません。`);
      partial.offerings = await resolveOfferings(partial.class_course_ids, cur.offerings || []);
      delete partial.class_course_ids;
    }
    if (kind === 'class' && partial.name) {
      const row = (await basicinfoModel.listClasses()).find((c) => String(c.id) === String(id));
      if (!row) throw new ApiError(404, `対象の${KINDS[kind].label}が見つかりません。`);
      if (!DEFAULT_CLASS_NAMES.includes(partial.name)) {
        throw new ApiError(400, `クラス・コース名は「${DEFAULT_CLASS_NAMES.join('・')}」の範囲内で指定してください。`);
      }
      await checkClassNameDup(partial.grade !== undefined ? Number(partial.grade) : row.grade, partial.name, id);
    }
    if (kind === 'room' && partial.name) await checkRoomNameDup(partial.name, id);

    let updated = null;
    if (kind === 'class') updated = await basicinfoModel.updateClass(id, partial, user.id);
    if (kind === 'subject') updated = await basicinfoModel.updateSubject(id, partial, user.id);
    if (kind === 'room') updated = await basicinfoModel.updateRoom(id, partial, user.id);

    if (!updated) throw new ApiError(404, `対象の${KINDS[kind].label}が見つかりません。`);

    await auditModel.logAction({
      userId: user.id,
      userName: user.name,
      action: `UPDATE_${kind.toUpperCase()}`,
      resourceType: KINDS[kind].resource,
      resourceId: String(id),
      oldValue: partial,
      newValue: updated,
    });
    return updated;
  },

  // ==========================================================
  // 削除（教務部のみ・考査計画等で使用中は削除不可）
  // ==========================================================
  async deleteItem(kind, id, user) {
    requireKyomu(user);
    if (!KINDS[kind]) throw new ApiError(400, '不明なマスタ種別です。');

    const label = KINDS[kind].label;

    if (kind === 'class') {
      const row = (await basicinfoModel.listClasses()).find((c) => String(c.id) === String(id));
      if (row && isDefaultClassName(row.name)) {
        throw new ApiError(409, `初期設定のクラス・コース「${row.name}」は削除できません。`);
      }
      const counts = await basicinfoModel.classUsage(id);
      if (counts.total > 0) {
        throw new ApiError(409, `このクラスは考査データ${usageMessage('class', counts)}で使用されているため削除できません。`);
      }
      const cascaded = await basicinfoModel.deleteClass(id);
      await auditModel.logAction({
        userId: user.id,
        userName: user.name,
        action: 'DELETE_CLASS',
        resourceType: KINDS[kind].resource,
        resourceId: String(id),
        oldValue: { cascaded },
      });
      return { id: String(id), cascaded };
    }

    if (kind === 'subject') {
      const row = (await basicinfoModel.listSubjects()).find((s) => String(s.id) === String(id));
      if (!row) throw new ApiError(404, `対象の${label}が見つかりません。`);
      const counts = await basicinfoModel.subjectUsage(row.name);
      if (counts.total > 0) {
        throw new ApiError(409, `科目「${row.name}」は考査計画${usageMessage('subject', counts)}で使用されているため削除できません。`);
      }
      await basicinfoModel.deleteSubject(id);
      await auditModel.logAction({
        userId: user.id,
        userName: user.name,
        action: 'DELETE_SUBJECT',
        resourceType: KINDS[kind].resource,
        resourceId: String(id),
        oldValue: { name: row.name },
      });
      return { id: String(id), name: row.name };
    }

    const row = (await basicinfoModel.listRooms()).find((r) => String(r.id) === String(id));
    if (!row) throw new ApiError(404, `対象の${label}が見つかりません。`);
    const counts = await basicinfoModel.roomUsage(row.id, row.name);
    if (counts.total > 0) {
      throw new ApiError(409, `教室「${row.name}」は考査計画${usageMessage('room', counts)}で使用されているため削除できません。`);
    }
    await basicinfoModel.deleteRoom(id);
    await auditModel.logAction({
      userId: user.id,
      userName: user.name,
      action: 'DELETE_ROOM',
      resourceType: KINDS[kind].resource,
      resourceId: String(id),
      oldValue: { name: row.name },
    });
    return { id: String(id), name: row.name };
  },
};

export default basicinfoService;
