/**
 * ISSystem Authentication & User Profile Controller
 * ログイン認証 (staff_code基盤)・自主分散招待コード発行/検証・プロファイル取得・パスワード変更・在席ステータス更新API
 */

import authService from '../services/auth.service.js';
import userModel from '../models/user.model.js';
import jwt from 'jsonwebtoken';
import config from '../../config/default.js';

export const authController = {
  /**
   * 教職員ログイン認証
   * POST /api/auth/login
   */
  async login(req, res, next) {
    try {
      // データベース仕様書 v2.1.0 に基づき staff_code を主体として取得
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
      const { invitationCode, staff_code, staffCode, password, name, email, grade, department } = req.body;
      const targetStaffCode = staff_code || staffCode;

      if (!invitationCode || !targetStaffCode || !password) {
        return res.status(400).json({
          success: false,
          message: '招待コード、教職員番号、およびパスワードは必須です。',
        });
      }

      const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket.remoteAddress;

      const result = await authService.registerWithInvitation(
        { 
          invitationCode, 
          staff_code: targetStaffCode, 
          password, 
          name: name || '', // 初回未設定時は空文字（ログイン後に設定可能）
          email: email || null, // email は任意
          grade, 
          department 
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
      const createdByUserId = req.user.id || req.user._id;
      const result = await authService.generateInvitationCode(createdByUserId);

      return res.status(201).json({
        success: true,
        message: '招待コードを発行しました。(有効期限: 24時間)',
        invitation: result,
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
          status: user.status || 'PRESENT',
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
      const { name, email, department, extension_number, avatar_url } = req.body;
      const updated = await userModel.updateProfile(userId, { name, email, department, extension_number, avatar_url });
      
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
      return res.status(200).json({ success: true, users });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 新規ユーザーの追加 (誰でも追加可能)
   * POST /api/users
   */
  async createUser(req, res, next) {
    try {
      const { staff_code, name, email, password, role, grade, department, extension_number, avatar_url } = req.body;
      if (!staff_code || !password || !name) {
        return res.status(400).json({ success: false, message: '教職員番号、氏名、パスワードは必須です。' });
      }
      const bcrypt = await import('bcrypt');
      const password_hash = await bcrypt.default.hash(password, 10);
      
      const newUser = await userModel.create({
        staff_code,
        name,
        email,
        password_hash,
        role: role || 'TEACHER',
        grade,
        department,
        extension_number,
        avatar_url
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
   * ユーザーの削除 (誰でも削除可能)
   * DELETE /api/users/:id
   */
  async deleteUser(req, res, next) {
    try {
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