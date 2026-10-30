/**
 * ISSystem Subject Catalog Service (教科マスタ管理)
 * 教科マスタの追加・改名・削除は教務部 (KYOMU) のみ。
 * 教員の担当教科 (users.subjects) は複数選択で、教務部は他教員の設定も変更できる。
 */

import { subjectModel, parseSubjectList } from '../models/subject.model.js';
import { logAction } from '../models/audit.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

const NAME_MAX = 20;

function isKyomu(user) {
  if (!user) return false;
  const role = String(user.role || '').toUpperCase();
  return user.is_kyomu === true || user.is_kyomu === 1 || role === 'KYOMU' || role === 'ADMIN';
}

function ensureKyomu(user) {
  if (!isKyomu(user)) {
    throw new ApiError(403, '教科マスタの追加・改名・削除は教務部 (KYOMU) のみです。');
  }
}

function normalizeName(raw) {
  const name = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!name) {
    throw new ApiError(400, '教科名を入力してください。');
  }
  if (name.length > NAME_MAX) {
    throw new ApiError(400, `教科名は${NAME_MAX}文字以内で入力してください。`);
  }
  return name;
}

/** 担当教科リストを教科マスタの名称へ正規化する */
function normalizeSubjects(rawSubjects, allowedNames) {
  const list = parseSubjectList(rawSubjects);
  const seen = new Set();
  const result = [];
  for (const n of list) {
    const match = Array.from(allowedNames).find((name) => String(name).toLowerCase() === String(n).toLowerCase());
    if (!match) {
      throw new ApiError(400, `教科「${n}」は教科マスタに登録されていません。`);
    }
    const key = String(match).toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(match);
    }
  }
  return result;
}

export const subjectService = {
  /** 教科マスタ一覧 (全教職員が参照可能) */
  async listSubjects() {
    const subjects = await subjectModel.listSubjects();
    return { subjects };
  },

  /** 教科の追加 (教務部のみ) */
  async createSubject(rawName, user, { color_key = 'SLATE', sort_order = 0 } = {}) {
    ensureKyomu(user);
    const name = normalizeName(rawName);
    const names = await subjectModel.subjectNames();
    const duplicated = Array.from(names).some((n) => String(n).toLowerCase() === name.toLowerCase());
    if (duplicated) {
      throw new ApiError(409, `教科「${name}」は既に登録されています。`);
    }
    const subject = await subjectModel.createSubject({ name, color_key, sort_order });
    await logAction({
      userId: user.id,
      action: 'CREATE_SUBJECT',
      targetEntity: 'SUBJECT',
      targetId: subject.id,
      changesJson: JSON.stringify({ name }),
    });
    return subject;
  },

  /** 教科の改名・色・表示順変更 (教務部のみ・改名は担当教科等へCASCADE) */
  async updateSubject(id, payload, user) {
    ensureKyomu(user);
    const names = await subjectModel.subjectNames();

    let name = payload.name !== undefined ? normalizeName(payload.name) : undefined;
    if (name) {
      const normalizedName = name;
      // 改名後の重複チェック (同一名称への改名はOK)
      const target = Array.from(names).find((n) => String(n).toLowerCase() === normalizedName.toLowerCase());
      if (target && String(target) !== normalizedName) {
        throw new ApiError(409, `教科「${normalizedName}」は既に登録されています。`);
      }
      name = normalizedName;
    }

    const updated = await subjectModel.updateSubject(id, {
      name,
      color_key: payload.color_key,
      sort_order: payload.sort_order,
    });
    if (!updated) {
      throw new ApiError(404, '教科が見つかりません。');
    }

    await logAction({
      userId: user.id,
      action: 'UPDATE_SUBJECT',
      targetEntity: 'SUBJECT',
      targetId: String(id),
      changesJson: JSON.stringify({ name, color_key: payload.color_key, sort_order: payload.sort_order }),
    });
    return updated;
  },

  /** 教科の削除 (教務部のみ・考査計画で使用中は削除不可) */
  async deleteSubject(id, user) {
    ensureKyomu(user);
    const list = await subjectModel.listSubjects();
    const target = list.find((s) => String(s.id) === String(id));
    if (!target) {
      throw new ApiError(404, '教科が見つかりません。');
    }
    if (Number(target.plan_count) > 0) {
      throw new ApiError(409, `教科「${target.name}」は考査計画で ${target.plan_count}件使用されているため削除できません。`);
    }

    const removed = await subjectModel.deleteSubject(id);
    await logAction({
      userId: user.id,
      action: 'DELETE_SUBJECT',
      targetEntity: 'SUBJECT',
      targetId: String(id),
      changesJson: JSON.stringify({ name: target.name, removed_from_users: removed.removed_from_users }),
    });
    return removed;
  },

  /**
   * 教員の担当教科設定
   * @param {Object} user 操作者 (教務部なら他教員も、そうでなければ自分自身のみ)
   * @param {string} targetUserId 対象教員ID
   * @param {string[]|string} subjects 担当教科 (複数選択)
   */
  async setUserSubjects(user, targetUserId, subjects) {
    if (!targetUserId) {
      throw new ApiError(400, '対象教員が指定されていません。');
    }
    const self = String(targetUserId) === String(user.id);
    if (!self && !isKyomu(user)) {
      throw new ApiError(403, '他の教員の担当教科を変更できるのは教務部 (KYOMU) のみです。');
    }

    const allowed = await subjectModel.subjectNames();
    const normalized = normalizeSubjects(subjects, allowed);
    const updated = await subjectModel.setUserSubjects(targetUserId, normalized);

    await logAction({
      userId: user.id,
      action: self ? 'SET_MY_SUBJECTS' : 'SET_USER_SUBJECTS',
      targetEntity: 'USER',
      targetId: targetUserId,
      changesJson: JSON.stringify({ subjects: normalized }),
    });

    return { ...updated, subjects: normalized };
  },

  /**
   * プロフィール更新時の担当教科正規化 (auth側から呼ぶ)
   */
  async normalizeUserSubjects(subjects) {
    const allowed = await subjectModel.subjectNames();
    return normalizeSubjects(subjects, allowed);
  },

  parseSubjectList,
};

export default subjectService;
