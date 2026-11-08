/**
 * ISSystem Error Handling Middleware & Custom Error Class
 * 共通エラーハンドリング・カスタムAPIエラークラス・監査ログ自動出力
 */

import logger from '../utils/logger.js';

/**
 * ループバック IP 判定 (v3.0.8, §15 監査 #5: stack 出力秘匿)
 * trust proxy 未設定 = req.ip はソケット直結地址。X-Forwarded-For は信用しない。
 * 127.x / ::1 / ::ffff:127.x をローカルとみなす。
 */
function isLoopbackIp(ip) {
  if (!ip) return false;
  const normalized = ip.replace(/^::ffff:/, '');
  return normalized === '::1' || normalized.startsWith('127.');
}

/**
 * カスタムAPIエラークラス (ステータスコード & 詳細情報を保持)
 */
export class ApiError extends Error {
  constructor(statusCode, message, details = null) {
    super(message);
    this.statusCode = statusCode;
    this.details = details;
    this.name = 'ApiError';
  }
}

/**
 * 404 Not Found ハンドラー
 */
export function notFoundHandler(req, res, next) {
  const error = new ApiError(404, `リクエストされたリソースが見つかりません: ${req.originalUrl}`);
  next(error);
}

/**
 * 全体共通エラーハンドリングミドルウェア
 */
export function errorHandler(err, req, res, next) {
  const statusCode = err.statusCode || 500;
  const message = err.message || '内部サーバーエラーが発生しました。';

  // 深刻なエラー (500系) はシステム監査ログに自動出力
  if (statusCode >= 500) {
    logger.log({
      userId: req.user?.id || null,
      action: 'SERVER_ERROR',
      target: `${req.method} ${req.originalUrl}`,
      details: {
        message: err.message,
        stack: err.stack,
      },
    });
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(err.details && { details: err.details }),
    // v3.0.8 (§15 #5): stack は development かつループバック要求のみ。本番・LAN 越し開発では絶対に返さない。
    ...(process.env.NODE_ENV === 'development' && isLoopbackIp(req.ip || req.socket?.remoteAddress) && { stack: err.stack }),
  });
}

export default {
  ApiError,
  notFoundHandler,
  errorHandler,
};