/**
 * ISSystem Authentication & User Account Service
 * 教員ログイン認証(staff_code/id/email完全互換基盤)・JWTトークン発行・自主分散招待コード生成 & 検証・パスワード管理
 */

import crypto from 'crypto';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import config from '../../config/default.js';
import userModel from '../models/user.model.js';
import auditModel from '../models/audit.model.js';
import { parseSubjectList } from '../models/subject.model.js';
import { ApiError } from '../middlewares/error.middleware.js';

const BCRYPT_ROUNDS = 10;

// === v3.0.7 ログイン総当たり対策: ユーザー単位ロックアウト（プロセス内メモリ・単一サーバー運用） ===
// key = 正規化識別子（小文字）。value = { count, firstAt, lockedUntil }
// 15分のウィンドウで 5 回失敗すると 15 分間ロック。成功ログインで解除。サーバー再起動で解除される
// （単一サーバー実運用での十分性。DB 永続化は行わない — 監査 LOGIN_FAILED で検知可能）。
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LOCK_MS = 15 * 60 * 1000;
const loginFailures = new Map();

function sweepLoginFailures() {
  const now = Date.now();
  for (const [key, st] of loginFailures) {
    const expired = st.lockedUntil > 0 ? st.lockedUntil < now : st.firstAt + LOGIN_FAIL_WINDOW_MS < now;
    if (expired) loginFailures.delete(key);
  }
}

function isLocked(key) {
  const st = loginFailures.get(key);
  return !!st && st.lockedUntil > Date.now();
}

function recordLoginFailure(key) {
  if (loginFailures.size > 1000) sweepLoginFailures();
  const now = Date.now();
  let st = loginFailures.get(key);
  if (!st || st.lockedUntil > 0 || st.firstAt + LOGIN_FAIL_WINDOW_MS < now) {
    st = { count: 0, firstAt: now, lockedUntil: 0 };
    loginFailures.set(key, st);
  }
  st.count += 1;
  if (st.count >= LOGIN_FAIL_LIMIT) {
    st.lockedUntil = now + LOGIN_LOCK_MS;
    console.warn('[AuthService] ログイン失敗により一時ロック:', { key, count: st.count });
  }
}

function recordLoginSuccess(key) {
  loginFailures.delete(key);
}

// 失敗ログインを監査ログ LOGIN_FAILED として記録（成功 LOGIN のみの旧実装からの拡張）
async function logLoginFailure(ipAddress, identifier, reason, userId = null) {
  try {
    if (auditModel && typeof auditModel.logAction === 'function') {
      await auditModel.logAction({
        userId,
        action: 'LOGIN_FAILED',
        targetEntity: 'USER',
        targetId: userId ?? identifier,
        ipAddress,
        changesJson: JSON.stringify({ identifier, reason }),
      });
    }
  } catch (auditErr) {
    console.warn('[Audit Log Warning]', auditErr.message);
  }
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
    return bcrypt.compare(password, storedHash);
  }
  // 2026/11/8 監査 Critical 対策: legacySha256(password+secret) と
  // storedHash === password（平文一致）のフォールバックを撤去。
  // bcrypt 以外のハッシュはすべて拒否する（seed は bcrypt のみ）。
  return false;
}

export const authService = {
  /**
   * 教職員ユーザーログイン認証
   * @param {string|Object} staffCodeOrBody - 教職員番号、ID、または req.body オブジェクト
   * @param {string} [passParam] - パスワード
   * @param {string} [ipAddress] - IPアドレス
   */
  async login(staffCodeOrBody, passParam, ipAddress = '') {
    // 引数がオブジェクト形式 (req.body 直接渡し) で来た場合の柔軟な展開
    let identifier = typeof staffCodeOrBody === 'object' 
      ? (staffCodeOrBody.staff_code || staffCodeOrBody.staffCode || staffCodeOrBody.identifier || staffCodeOrBody.email || staffCodeOrBody.id)
      : staffCodeOrBody;
      
    let password = typeof staffCodeOrBody === 'object' 
      ? staffCodeOrBody.password 
      : passParam;

    // 入力チェック
    if (!identifier || !password) {
      console.warn('[AuthService] ログイン失敗: 入力不足', { identifier, hasPassword: !!password });
      throw new ApiError(400, '教職員番号およびパスワードを入力してください。');
    }

    identifier = String(identifier).trim();
    password = String(password).trim();

    // v3.0.7: ユーザー単位ロックアウトチェック（423）
    const normalizedKey = identifier.toLowerCase();
    if (isLocked(normalizedKey)) {
      await logLoginFailure(ipAddress, identifier, 'locked_out');
      throw new ApiError(423, 'アカウントは一時ロックされています。15分後に再試行してください。');
    }

    let user = null;

    // 1. staff_code で検索 (例: T2026001)
    if (typeof userModel.findByStaffCode === 'function') {
      user = await userModel.findByStaffCode(identifier);
    }

    // 2. id で検索 (例: kyomu01)
    if (!user && typeof userModel.findById === 'function') {
      user = await userModel.findById(identifier);
    }

    // 3. email で検索 (フォールバック)
    if (!user && typeof userModel.findByEmail === 'function') {
      user = await userModel.findByEmail(identifier);
    }

    if (!user) {
      recordLoginFailure(identifier.toLowerCase());
      await logLoginFailure(ipAddress, identifier, 'user_not_found');
      throw new ApiError(401, '教職員番号またはパスワードが正しくありません。');
    }

    const isPasswordValid = await verifyPassword(password, user.password_hash);

    if (!isPasswordValid) {
      // dbHash をログに出さない（秘匿）
      console.warn('[AuthService] パスワード照合失敗:', { identifier });
      recordLoginFailure(identifier.toLowerCase());
      await logLoginFailure(ipAddress, identifier, 'bad_password', user._id || user.id);
      throw new ApiError(401, '教職員番号またはパスワードが正しくありません。');
    }

    const userId = user._id || user.id;
    recordLoginSuccess(identifier.toLowerCase());

    // PostgreSQL の INTEGER(1/0)・BOOLEAN・TEXT いずれの is_kyomu 値にも対応した判定
    const isKyomuRole = user.is_kyomu === 1 || user.is_kyomu === true || user.role === 'KYOMU';

    const token = this.generateTokenForUser(user);

    // ログイン監査ログ記録
    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId: userId,
          action: 'LOGIN',
          targetEntity: 'USER',
          targetId: userId,
          ipAddress,
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    return {
      token,
      user: {
        id: userId,
        staff_code: user.staff_code || identifier,
        name: user.name || '',
        email: user.email || '',
        role: user.role || 'TEACHER',
        is_kyomu: isKyomuRole,
        grade: user.grade,
        department: user.department,
        subjects: parseSubjectList(user.subjects),
        status: user.status || 'PRESENT',
        // v3.1: 登録日 (users.created_at)。フロント側で 'YYYY-MM-DD' (JST) に正規化して未読バッヂの登録日以降条件に使う
        created_at: user.created_at || null,
      },
    };
  },

  /**
   * 自主分散招待コードを用いた新規教職員ユーザー登録
   */
  async registerWithInvitation(registerData, ipAddress = '') {
    const { invitationCode, staff_code, password, name, email, grade, department, subjects } = registerData;

    if (!invitationCode || !staff_code || !password) {
      throw new ApiError(400, '招待コード、教職員番号、パスワードは必須です。');
    }

    const validCode = await userModel.findInvitationCode(invitationCode);
    if (!validCode) {
      throw new ApiError(400, '無効または有効期限切れの招待コードです。');
    }

    const existingUser = typeof userModel.findByStaffCode === 'function' 
      ? await userModel.findByStaffCode(staff_code) 
      : null;
      
    if (existingUser) {
      throw new ApiError(409, 'この教職員番号は既に登録されています。');
    }

    const passwordHash = await hashPassword(password);

    const newUser = await userModel.create({
      staff_code,
      email: email || null,
      password_hash: passwordHash,
      name: name || '',
      role: 'TEACHER',
      grade: grade ? String(grade) : null,
      department: department || null,
      subjects: subjects || [],
      is_kyomu: false,
      invited_by_user_id: validCode.created_by_user_id,
    });

    const newUserId = newUser._id || newUser.id;

    await userModel.markInvitationCodeUsed(invitationCode, newUserId, 'REGISTER');

    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId: newUserId,
          action: 'REGISTER_VIA_INVITATION',
          targetEntity: 'USER',
          targetId: newUserId,
          changesJson: JSON.stringify({ invitedBy: validCode.created_by_user_id, code: invitationCode }),
          ipAddress,
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    return this.login(staff_code, password, ipAddress);
  },

  /**
   * 招待コードを利用したパスワード再設定 (パスワード忘れた方向け)
   * 招待コードは発行時点で利用目的が確定しないため、ログイン画面でユーザーが目的を選ぶ
   * 消費済みコードは再利用不可 (markInvitationCodeUsed で used_for を記録)
   */
  async resetPasswordWithInvitation(resetData, ipAddress = '') {
    const { invitationCode, staff_code, newPassword } = resetData;

    if (!invitationCode || !staff_code || !newPassword) {
      throw new ApiError(400, '招待コード、教職員番号、新しいパスワードは必須です。');
    }

    if (String(newPassword).trim().length < 8) {
      throw new ApiError(400, '新しいパスワードは8文字以上で入力してください。');
    }

    const validCode = await userModel.findInvitationCode(invitationCode);
    if (!validCode) {
      throw new ApiError(400, '無効または有効期限切れの招待コードです。');
    }

    const targetUser = await userModel.findByStaffCode(staff_code);
    if (!targetUser) {
      throw new ApiError(404, 'この教職員番号のアカウントは登録されていません。「招待コードで新規登録」タブで登録してください。');
    }

    const targetId = targetUser._id || targetUser.id;
    const newHash = await hashPassword(newPassword);
    await userModel.updatePasswordHash(targetId, newHash);
    await userModel.markInvitationCodeUsed(invitationCode, targetId, 'PASSWORD_RESET');

    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId: targetId,
          action: 'RESET_PASSWORD_VIA_INVITATION',
          targetEntity: 'USER',
          targetId,
          changesJson: JSON.stringify({ invitedBy: validCode.created_by_user_id, code: invitationCode }),
          ipAddress,
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    // 再設定後は新パスワードで即ログイン (ログイン画面でそのままアプリへ入れる)
    return this.login(staff_code, newPassword, ipAddress);
  },

  /**
   * 既存教員による「自主分散招待コード」の発行 (有効期間24時間)
   */
  async generateInvitationCode(createdByUserId) {
    const creator = await userModel.findById(createdByUserId);
    if (!creator) {
      throw new ApiError(404, '発行ユーザーが見つかりません。');
    }

    // v3.0.7: 128bit 系（32文字16進大写・crypto.randomBytes(16)）。総当たり 3.4×10^38 通り、
    // 24時間有効期限 + コード単位 15分5試行（rate-limit）で総当たりを実務不可能にする
    const randomCode = crypto.randomBytes(16).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const invitation = await userModel.createInvitationCode(randomCode, createdByUserId, expiresAt);

    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId: createdByUserId,
          action: 'GENERATE_INVITATION_CODE',
          targetEntity: 'INVITATION_CODE',
          targetId: randomCode,
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    return {
      code: invitation.code,
      expiresAt: invitation.expires_at,
      createdBy: creator.name || creator.staff_code,
    };
  },

  /**
   * パスワードの変更
   */
  async changePassword(userId, currentPassword, newPassword) {
    const user = await userModel.findById(userId);
    if (!user) {
      throw new ApiError(404, 'ユーザーが見つかりません。');
    }

    const currentOk = await verifyPassword(currentPassword, user.password_hash);
    if (!currentOk) {
      throw new ApiError(401, '現在のパスワードが正しくありません。');
    }

    const newHash = await hashPassword(newPassword);
    await userModel.updatePasswordHash(userId, newHash);

    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId,
          action: 'CHANGE_PASSWORD',
          targetEntity: 'USER',
          targetId: userId,
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    return { message: 'パスワードが正常に変更されました。' };
  },

  /**
   * 任意のユーザーオブジェクトからJWTトークンを生成するヘルパー
   */
  generateTokenForUser(user) {
    const userId = user._id || user.id;
    const isKyomuRole = user.is_kyomu === 1 || user.is_kyomu === true || user.role === 'KYOMU';
    const payload = {
      id: userId,
      staff_code: user.staff_code,
      name: user.name || '',
      role: user.role || 'TEACHER',
      is_kyomu: isKyomuRole,
      department: user.department || null,
      subjects: parseSubjectList(user.subjects),
    };

    const jwtSecret = (config && config.auth && config.auth.jwtSecret)
      ? config.auth.jwtSecret
      : 'dev-secret-key-change-in-production';

    return jwt.sign(payload, jwtSecret, {
      expiresIn: (config && config.auth && config.auth.jwtExpiresIn) || '24h',
    });
  },

  /**
   * 教員在席ステータス（在席/離席/授業中/出張）の更新
   */
  async updateStatus(userId, status) {
    const validStatuses = ['PRESENT', 'CLASS', 'TRIP', 'LEAVE', 'IN', 'OUT'];
    // 仕様の正規値は PRESENT / CLASS / TRIP / LEAVE。IN/OUT は互換エイリアス。
    if (!validStatuses.includes(status)) {
      throw new ApiError(400, '無効なステータス区分です。');
    }

    const updatedUser = await userModel.updateStatus(userId, status);

    try {
      if (auditModel && typeof auditModel.logAction === 'function') {
        await auditModel.logAction({
          userId,
          action: 'UPDATE_STATUS',
          targetEntity: 'USER',
          targetId: userId,
          changesJson: JSON.stringify({ status }),
        });
      }
    } catch (auditErr) {
      console.warn('[Audit Log Warning]', auditErr.message);
    }

    return updatedUser;
  },
};

export default authService;

// テスト用フック: ユーザー単位ロックアウトの Map を消す（jest のロックアウト検証後など）
export function clearLoginLockForTests(identifier) {
  loginFailures.delete(String(identifier).trim().toLowerCase());
}