/**
 * ISSystem Authentication & RBAC Middleware
 * JWTトークン検証・ユーザーセッション抽出・ロールベースアクセス制御 (RBAC)
 */

import jwt from 'jsonwebtoken';
import config from '../../config/default.js';

/**
 * Authorization ヘッダーから JWT を検証し req.user に格納するミドルウェア
 */
export function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // "Bearer <token>"

  if (!token) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: 'アクセストークンが提供されていません。ログインしてください。'
    });
  }

  try {
    const decoded = jwt.verify(token, config.auth.jwtSecret);
    req.user = decoded; // { id, name, role, is_kyomu, grade, department }
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'TokenExpired',
        message: 'セッションの有効期限が切れました。再ログインしてください。'
      });
    }

    return res.status(403).json({
      error: 'Forbidden',
      message: '無効なアクセストークonです。'
    });
  }
}

/**
 * 任意の認証ミドルウェア (トークンが存在すれば req.user にセット、無ければ通過)
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      const decoded = jwt.verify(token, config.auth.jwtSecret);
      req.user = decoded;
    } catch (err) {
      // オプション認証のためエラーは無視して通過
    }
  }
  next();
}

/**
 * 特定のロール権限を要求するミドルウェア (RBAC)
 * @param {...string} allowedRoles - 許可されるロール ('ADMIN', 'KYOMU', 'TEACHER' 等)
 */
export function requireRoles(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: '認証情報が存在しません。'
      });
    }

    const { role } = req.user;
    if (allowedRoles.includes(role) || role === 'ADMIN') {
      return next();
    }

    return res.status(403).json({
      error: 'Forbidden',
      message: 'この操作を実行するための権限がありません。'
    });
  };
}

/**
 * 教務主任権限 (is_kyomu フラグ または role === 'KYOMU' / 'ADMIN') を要求するミドルウェア
 */
export function requireKyomuRole(req, res, next) {
  if (!req.user) {
    return res.status(401).json({
      error: 'Unauthorized',
      message: '認証情報が存在しません。'
    });
  }

  const { role, is_kyomu } = req.user;
  const hasKyomuAuth = is_kyomu === true || role === 'KYOMU' || role === 'ADMIN';

  if (hasKyomuAuth) {
    return next();
  }

  return res.status(403).json({
    error: 'Forbidden',
    message: 'この機能は教務主任権限が必要です。'
  });
}

/**
 * システム管理者権限 (ADMIN) を要求するミドルウェア
 */
export function requireAdminRole(req, res, next) {
  if (!req.user || req.user.role !== 'ADMIN') {
    return res.status(403).json({
      error: 'Forbidden',
      message: '管理者権限が必要です。'
    });
  }
  next();
}

export default {
  authenticateToken,
  optionalAuth,
  requireRoles,
  requireKyomuRole,
  requireAdminRole
};