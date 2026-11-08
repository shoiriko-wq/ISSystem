/**
 * ISSystem Authentication & User Profile Controller
 * ログイン認証 (staff_code基盤)・自主分散招待コード発行/検証・プロファイル取得・パスワード変更・在席ステータス更新API
 */

import authService from '../services/auth.service.js';
import userModel from '../models/user.model.js';
import subjectService from '../services/subject.service.js';
import jwt from 'jsonwebtoken';
import config from '../../config/default.js';

// 教務部以上 (KYOMU / ADMIN / is_kyomu 教務主任) の権限判定。ルートミドルウェアの第二防衛線としてコントローラ内でも再検証する
const isPrivilegedUser = (u) => !!u && (u.role === 'ADMIN' || u.role === 'KYOMU' || u.is_kyomu === true || u.is_kyomu === 1);

export const authController = {
  /**
   * 教職員ログイン認証
   * POST /api/auth/login
   */
  async login(req, res, next) {
    try {
      // ISSystem仕様書 §9 (users) に基づき staff_code を主体として取得
      const { staff_code, staffCode, username, userId, email, password } = req.body;
      const targetStaffCode = staff_code || staffCode || username || userId || email;

      if (!targetStaffCode) {
        return res.status(400).json({
          success: false,
          message: '教職員番号 (staff_code) を入力してください。',
        });
      }

      if (!password) {
        return res.status(400).json({
          success: false,
          message: 'パスワードを入力してください。',
        });
      }

      const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

      // authService へ staff_code とパスワードを渡して認証
      const result = await authService.login(targetStaffCode, password, ipAddress);

      return res.status(200).json({
        success: true,
        message: 'ログインに成功しました。',
        token: result.token,
        user: result.user,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 自主分散招待コードを利用した新規教職員アカウント登録
   * POST /api/auth/register-invitation
   */
  async registerWithInvitation(req, res, next) {
    try {
      // staff_code を必須登録項目として受け取る (email は任意)
      const { invitationCode, staff_code, staffCode, password, name, email, grade, department, subjects } = req.body;
      const targetStaffCode = staff_code || staffCode;

      if (!invitationCode || !targetStaffCode || !password) {
        return res.status(400).json({
          success: false,
          message: '招待コード、教職員番号、およびパスワードは必須です。',
        });
      }

      const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

      // 担当教科は教科マスタの名称のみ採用 (複数選択)
      const normalizedSubjects = subjects !== undefined
        ? await subjectService.normalizeUserSubjects(subjects)
        : [];

      const result = await authService.registerWithInvitation(
        { 
          invitationCode, 
          staff_code: targetStaffCode, 
          password, 
          name: name || '', // 初回未設定時は空文字（ログイン後に設定可能）
          email: email || null, // email は任意
          grade, 
          department,
          subjects: normalizedSubjects
        },
        ipAddress
      );

      return res.status(201).json({
        success: true,
        message: 'アカウント登録が完了しました。',
        token: result.token,
        user: result.user,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 自主分散招待コードの発行 (既存教員用)
   * POST /api/auth/generate-invitation
   */
  async generateInvitation(req, res, next) {
    try {
      // 招待コード発行は教務部 (KYOMU/ADMIN) 限定。コントローラでも req.user.role を再検証する
      if (!isPrivilegedUser(req.user)) {
        return res.status(403).json({
          success: false,
          message: '招待コードの発行は教務部 (KYOMU) またはシステム管理者 (ADMIN) の権限が必要です。',
        });
      }
      const createdByUserId = req.user.id || req.user._id;
      const result = await authService.generateInvitationCode(createdByUserId);

      return res.status(201).json({
        success: true,
        message: '招待コードを発行しました。(有効期限: 24時間 / 新規登録・パスワード再設定のどちらでも利用可能)',
        // フロントエンドが code / expiresAt をトップレベルで参照するため両形式で返す
        code: result.code,
        expiresAt: result.expiresAt,
        createdBy: result.createdBy,
        invitation: result,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 招待コードを利用したパスワード再設定 (公開エンドポイント / ログイン不要)
   * POST /api/auth/reset-password-invitation
   */
  async resetPasswordWithInvitation(req, res, next) {
    try {
      const { invitationCode, staff_code, staffCode, newPassword } = req.body;
      const targetStaffCode = staff_code || staffCode;
      const newPass = newPassword;

      if (!invitationCode || !targetStaffCode || !newPass) {
        return res.status(400).json({
          success: false,
          message: '招待コード、教職員番号、新しいパスワードは必須です。',
        });
      }

      if (String(newPass).trim().length < 8) {
        return res.status(400).json({
          success: false,
          message: '新しいパスワードは8文字以上で入力してください。',
        });
      }

      const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

      const result = await authService.resetPasswordWithInvitation(
        { invitationCode, staff_code: targetStaffCode, newPassword: newPass },
        ipAddress
      );

      return res.status(200).json({
        success: true,
        message: 'パスワードを再設定しました。新しいパスワードでログインしました。',
        token: result.token,
        user: result.user,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * ログイン中教員のプロファイル情報取得
   * GET /api/auth/me
   */
  async getProfile(req, res, next) {
    try {
      const user = req.user;
      // v3.1: 登録日 (users.created_at) は JWT ペイロードに含まれないため DB から取得する。
      // フロントはこれを 'YYYY-MM-DD' (JST) に正規化し、未読バッヂの「登録日以降」条件に使う。
      const dbUser = typeof userModel.findById === 'function'
        ? await userModel.findById(user.id || user._id)
        : null;
      return res.status(200).json({
        success: true,
        user: {
          id: user.id || user._id,
          staff_code: user.staff_code, // 仕様に基づき教職員番号を追加
          name: user.name || '',
          email: user.email || '',
          role: user.role,
          is_kyomu: user.is_kyomu || user.role === 'KYOMU',
          grade: user.grade,
          department: user.department,
          subjects: user.subjects || [],
          status: user.status || 'PRESENT',
          created_at: dbUser?.created_at ?? user.created_at ?? null,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * セルフプロファイル更新 (AUTH-02)
   * PUT /api/auth/profile
   */
  async updateProfile(req, res, next) {
    try {
      const userId = req.user.id || req.user._id;
      const { name, email, department, extension_number, avatar_url, subjects } = req.body;

      // 担当教科は教科マスタに登録された名称のみ採用 (複数選択)
      const normalizedSubjects = subjects !== undefined
        ? await subjectService.normalizeUserSubjects(subjects)
        : undefined;

      const updated = await userModel.updateProfile(userId, {
        name, email, department, extension_number, avatar_url,
        ...(normalizedSubjects !== undefined ? { subjects: normalizedSubjects } : {}),
      });
      
      if (!updated) {
        return res.status(400).json({ success: false, message: 'プロファイルの更新に失敗しました。ユーザーが見つからないかデータ形式に問題があります。' });
      }

      const token = authService.generateTokenForUser(updated);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('user:updated', updated);
      }

      return res.status(200).json({
        success: true,
        message: 'プロファイルを更新しました。',
        token,
        user: updated,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * パスワード変更
   * PUT /api/auth/change-password
   */
  async changePassword(req, res, next) {
    try {
      const userId = req.user.id || req.user._id;
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({
          success: false,
          message: '現在のパスワードおよび新しいパスワードを入力してください。',
        });
      }

      if (String(newPassword).trim().length < 8) {
        return res.status(400).json({
          success: false,
          message: '新しいパスワードは8文字以上で入力してください。',
        });
      }

      const result = await authService.changePassword(userId, currentPassword, newPassword);

      return res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 教員在席ステータス (在席/離席/授業中/出張) 更新
   * PUT /api/auth/status
   */
  async updateStatus(req, res, next) {
    try {
      const userId = req.user.id || req.user._id;
      const { status } = req.body;

      if (!status) {
        return res.status(400).json({
          success: false,
          message: 'ステータス区分を指定してください。',
        });
      }

      const updatedUser = await authService.updateStatus(userId, status);

      return res.status(200).json({
        success: true,
        message: '在席ステータスを更新しました。',
        user: {
          id: updatedUser.id || updatedUser._id,
          staff_code: updatedUser.staff_code,
          name: updatedUser.name,
          status: updatedUser.status,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * ログアウトレスポンス (クライアント側トークン破棄用)
   * POST /api/auth/logout
   */
  async logout(req, res, next) {
    try {
      return res.status(200).json({
        success: true,
        message: 'ログアウトしました。',
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 全ユーザー一覧の取得
   * GET /api/users
   */
  async listUsers(req, res, next) {
    try {
      const users = await userModel.listAll();
      // 2026/11/8 RBAC: password_hash はいかなるロールにも返さない。
      // 教務部以上は全件（連絡用メール・内線含む）、一般教員は名簿表示に必要な最小フィールドのみ返す
      const privileged = isPrivilegedUser(req.user);
      const safeUsers = users.map((u) => {
        const { password_hash, ...rest } = u;
        if (privileged) return rest;
        const { id, staff_code, name, role, grade, department, subjects, avatar_url, is_kyomu, is_parttime } = rest;
        return { id, staff_code, name, role, grade, department, subjects, avatar_url, is_kyomu, is_parttime };
      });
      return res.status(200).json({ success: true, users: safeUsers });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 新規ユーザーの追加 (教務部 KYOMU/ADMIN のみ。ADMIN は role 指定可、教務部は TEACHER 固定＝権限昇格不能)
   * POST /api/users
   */
  async createUser(req, res, next) {
    try {
      const { staff_code, name, email, password, role, grade, department, extension_number, avatar_url, subjects } = req.body;
      // 2026/11/8 RBAC: ルートの requireKyomuRole に加えコントローラで再検証（第二防衛線）
      if (!isPrivilegedUser(req.user)) {
        return res.status(403).json({ success: false, message: '教職員アカウントの追加は教務部 (KYOMU) またはシステム管理者 (ADMIN) の権限が必要です。' });
      }
      if (!staff_code || !password || !name) {
        return res.status(400).json({ success: false, message: '教職員番号、氏名、パスワードは必須です。' });
      }
      // 権限昇格抑止: ADMIN が作成する場合のみ ADMIN/KYOMU 等の role を認める。教務部は TEACHER 固定
      const effectiveRole = req.user.role === 'ADMIN' ? (role || 'TEACHER') : 'TEACHER';
      const bcrypt = await import('bcrypt');
      const password_hash = await bcrypt.default.hash(password, 10);

      // 担当教科は教科マスタの名称のみ (教務部は他教員分も設定可能)
      const normalizedSubjects = subjects !== undefined
        ? await subjectService.normalizeUserSubjects(subjects)
        : [];

      const newUser = await userModel.create({
        staff_code,
        name,
        email,
        password_hash,
        role: effectiveRole,
        grade,
        department,
        extension_number,
        avatar_url,
        subjects: normalizedSubjects
      });

      const operator = req.user || { name: '管理者' };
      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('user:added', { user: newUser, operatorName: operator.name || '教員' });
      }

      return res.status(201).json({ success: true, message: 'ユーザーを追加しました。', user: newUser });
    } catch (error) {
      next(error);
    }
  },

  /**
   * ユーザーの削除 (システム管理者 ADMIN のみ)
   * DELETE /api/users/:id
   */
  async deleteUser(req, res, next) {
    try {
      // 2026/11/8 RBAC: ルートの requireAdminRole に加えコントローラで ADMIN を再検証（第二防衛線）
      if (!req.user || req.user.role !== 'ADMIN') {
        return res.status(403).json({ success: false, message: '教職員アカウントの削除はシステム管理者 (ADMIN) の権限が必要です。' });
      }
      const operator = req.user || { name: '管理者' };
      const { id } = req.params;
      await userModel.delete(id);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('user:deleted', { id, operatorName: operator.name || '教員' });
      }

      return res.status(200).json({ success: true, message: 'ユーザーを削除しました。' });
    } catch (error) {
      next(error);
    }
  },
};

export default authController;