/**
 * ISSystem Error Handling Middleware & Custom Error Class
 * 共通エラーハンドリング・カスタムAPIエラークラス・監査ログ自動出力
 */

import logger from '../utils/logger.js';

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
    logger.error(`[Server Error] ${req.method} ${req.originalUrl}:`, {
      message: err.message,
      stack: err.stack,
      userId: req.user?.id || null,
    });
  }

  res.status(statusCode).json({
    success: false,
    error: message,
    ...(err.details && { details: err.details }),
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
}

export default {
  ApiError,
  notFoundHandler,
  errorHandler,
};