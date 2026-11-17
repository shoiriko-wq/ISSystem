/**
 * ISSystem 管理者によるユーザ情報更新 (v3.2.0追加5 / 仕様書 §5・§7)
 *
 * 職員一覧・ユーザー管理画面で管理者 (ADMIN) が担当教科以外のユーザ情報も編集する。
 *  - 編集できるのは ADMIN のみ (`PUT /api/users/:id` に requireAdminRole、コントローラでも再検証)。
 *    教務部 (KYOMU) は担当教科のみ (現行の `PUT /api/users/:id/subjects` を維持)。
 *  - 編集対象: name / email / grade / department / extension_number / is_parttime /
 *    subjects / role / is_kyomu。
 *  - 教職員番号 (staff_code) と password_hash は編集しない。staff_code は seating_status・
 *    chat_channel_members・exam_proctor_assignments が FK で参照するため、改名は座席・チャット・
 *    考査監督の連鎖破壊になる (仕様書 §18 の意図された非実装)。
 *  - role と is_kyomu は ADMIN のみ変更できる。ADMIN を自分自身の role から降格することはできない
 *    (自分のアカウントから ADMIN を外すと誰も ADMIN を編集できなくなる＝ロックアウト)。
 *  - 監査ログ `UPDATE_USER_INFO` に差分（from→to）を残す。監査失敗は保存を止めない。
 */

import userModel from '../models/user.model.js';
import auditModel from '../models/audit.model.js';
import subjectService from './subject.service.js';
import { ApiError } from '../middlewares/error.middleware.js';

const NAME_MAX = 40;
const DEPT_MAX = 40;
const EMAIL_MAX = 120;
const GRADE_RE = /^[0-9]{1,2}$/;
const EXT_RE = /^[0-9-]{1,16}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ROLE_WHITELIST = ['TEACHER', 'KYOMU', 'ADMIN'];

const isTrue = (v) => v === true || v === 1 || v === '1' || v === 'true';

/** ADMIN 権限の再検証（ルートミドルウェアの第二防衛線） */
function ensureAdmin(operator) {
  if (!operator || String(operator.role || '').toUpperCase() !== 'ADMIN') {
    throw new ApiError(403, '教職員のユーザ情報を変更できるのはシステム管理者 (ADMIN) のみです。');
  }
}

/** 送られた項目を検証し、DB へ入れる形へ寄せる（未指定項目は undefined のまま＝部分更新） */
async function buildPatch(body = {}) {
  const patch = {};

  if (body.name !== undefined) {
    const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) throw new ApiError(400, '氏名を入力してください。');
    if (name.length > NAME_MAX) throw new ApiError(400, `氏名は${NAME_MAX}文字以内で入力してください。`);
    patch.name = name;
  }

  if (body.email !== undefined) {
    const email = String(body.email ?? '').trim();
    if (email.length > EMAIL_MAX) throw new ApiError(400, `email は${EMAIL_MAX}文字以内で入力してください。`);
    if (email && !EMAIL_RE.test(email)) throw new ApiError(400, 'email の形式が不正です。');
    patch.email = email || null;
  }

  if (body.grade !== undefined) {
    const grade = String(body.grade ?? '').trim();
    if (grade && grade !== 'NONE' && !GRADE_RE.test(grade)) {
      throw new ApiError(400, '学年は数字1〜2桁、または NONE で指定してください。');
    }
    patch.grade = grade || null;
  }

  if (body.department !== undefined) {
    const department = String(body.department ?? '').trim().replace(/\s+/g, ' ');
    if (department.length > DEPT_MAX) throw new ApiError(400, `所属部局は${DEPT_MAX}文字以内で入力してください。`);
    patch.department = department || null;
  }

  if (body.extension_number !== undefined) {
    const ext = String(body.extension_number ?? '').trim();
    if (ext && !EXT_RE.test(ext)) throw new ApiError(400, '内線番号は数字と - で入力してください。');
    patch.extension_number = ext || null;
  }

  if (body.is_parttime !== undefined) patch.is_parttime = isTrue(body.is_parttime);
  if (body.is_kyomu !== undefined) patch.is_kyomu = isTrue(body.is_kyomu) ? 1 : 0;

  if (body.role !== undefined) {
    const role = String(body.role ?? '').trim().toUpperCase();
    if (!ROLE_WHITELIST.includes(role)) {
      throw new ApiError(400, `role は ${ROLE_WHITELIST.join(' / ')} のいずれかで指定してください。`);
    }
    patch.role = role;
  }

  // 担当教科は教科マスタの正式名のみ（未登録名は subjectService が 400 を出す）
  if (body.subjects !== undefined) {
    patch.subjects = await subjectService.normalizeUserSubjects(body.subjects);
  }

  return patch;
}

/** 差分（from→to）を作る。変化が無い項目は入れない */
function buildDiff(current, patch) {
  const diff = {};
  const norm = (v) => (v === null || v === undefined ? null : String(v));
  for (const key of Object.keys(patch)) {
    const from = current[key] === undefined ? null : current[key];
    const to = patch[key];
    const same =
      key === 'is_parttime'
        ? isTrue(from) === isTrue(to)
        : key === 'is_kyomu'
          ? Number(from) === 1 && Number(to) === 1
          : key === 'subjects'
            ? Array.from(from || []).sort().join(',') === Array.from(to || []).sort().join(',')
            : norm(from) === norm(to);
    if (!same) diff[key] = { from: norm(from), to: norm(to) };
  }
  return diff;
}

export const userInfoService = {
  /**
   * 管理者によるユーザ情報更新
   * @param {Object} operator 操作者 (req.user。ADMIN のみ)
   * @param {string} targetUserId 対象教職員id
   * @param {Object} body 更新したい項目（部分更新）
   * @returns {Promise<{user: Object, changes: Object}>} 更新後のユーザー（password_hash 除く）と差分
   */
  async updateByAdmin(operator, targetUserId, body = {}) {
    ensureAdmin(operator);
    if (!targetUserId) throw new ApiError(400, '対象教職員が指定されていません。');

    const users = await userModel.listAll();
    const target = users.find((u) => String(u.id) === String(targetUserId));
    if (!target) throw new ApiError(404, '対象教職員が見つかりません。');

    const patch = await buildPatch(body);
    if (Object.keys(patch).length === 0) throw new ApiError(400, '変更する項目が指定されていません。');

    // role と is_kyomu は ADMIN のみ（route/コントローラで ADMIN を検証済み）
    const targetIsAdmin = String(target.role).toUpperCase() === 'ADMIN';
    const selfEdit = String(targetUserId) === String(operator.id);
    if (patch.role && patch.role !== 'ADMIN') {
      if (targetIsAdmin && selfEdit) {
        throw new ApiError(400, '自分自身の ADMIN を外すことはできません（管理者が消滅するため）。');
      }
      if (targetIsAdmin && (await userModel.countByRole('ADMIN')) <= 1) {
        throw new ApiError(409, 'ADMIN を1人以下へ減らすことはできません。');
      }
    }

    // email は他の教職員と重複させない (users.email は UNIQUE)
    if (patch.email) {
      const dup = users.find(
        (u) =>
          String(u.id) !== String(targetUserId) &&
          String(u.email || '').trim().toLowerCase() === patch.email.toLowerCase()
      );
      if (dup) throw new ApiError(409, `この email は ${dup.name || dup.staff_code} が既に使っています。`);
    }

    const changes = buildDiff(target, patch);
    if (Object.keys(changes).length === 0) {
      const { password_hash, ...safe } = target;
      return { user: safe, changes: {} };
    }

    const updated = await userModel.updateManagedInfo(targetUserId, patch);
    if (!updated) throw new ApiError(400, 'ユーザ情報の更新に失敗しました。');

    try {
      await auditModel.logAction({
        userId: operator.id,
        userName: operator.name,
        action: 'UPDATE_USER_INFO',
        targetEntity: 'USER',
        targetId: targetUserId,
        changesJson: JSON.stringify(changes),
      });
    } catch (err) {
      // 監査失敗は保存を止めない (User Import と同じ流儀)
      console.warn('[Userinfo/Audit Warning] UPDATE_USER_INFO log failed:', err.message);
    }

    const { password_hash, ...safeUser } = updated;
    return { user: safeUser, changes };
  },
};

export default userInfoService;

