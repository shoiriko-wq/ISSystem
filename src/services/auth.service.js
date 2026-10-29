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
import { ApiError } from '../middlewares/error.middleware.js';

const BCRYPT_ROUNDS = 10;

function legacySha256(password) {
  const secret = (config && config.auth && config.auth.jwtSecret)
    ? config.auth.jwtSecret
    : 'dev-secret-key-change-in-production';
  return crypto.createHash('sha256').update(password + secret).digest('hex');
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password, storedHash) {
  if (!storedHash) return false;
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
    return bcrypt.compare(password, storedHash);
  }
  return storedHash === legacySha256(password) || storedHash === password;
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
      throw new ApiError(401, '教職員番号またはパスワードが正しくありません。');
    }

    const isPasswordValid = await verifyPassword(password, user.password_hash);

    if (!isPasswordValid) {
      console.warn('[AuthService] パスワード照合失敗:', { identifier, dbHash: user.password_hash });
      throw new ApiError(401, '教職員番号またはパスワードが正しくありません。');
    }

    const userId = user._id || user.id;

    // SQLite の 1/0 数値フラグおよび boolean 型に対応した is_kyomu 判定
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
        status: user.status || 'PRESENT',
      },
    };
  },

  /**
   * 自主分散招待コードを用いた新規教職員ユーザー登録
   */
  async registerWithInvitation(registerData, ipAddress = '') {
    const { invitationCode, staff_code, password, name, email, grade, department } = registerData;

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

    const randomCode = crypto.randomBytes(4).toString('hex').toUpperCase();
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