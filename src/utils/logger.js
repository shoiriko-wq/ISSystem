/**
 * ISSystem Audit Logger Utility
 * 監査ログ (`system_audit_logs`) 記録・システム操作追跡モジュール
 */

import auditModel from '../models/audit.model.js';

export const logger = {
  /**
   * 監査ログの記録 (非同期・例外安全処理)
   * @param {Object} params
   * @param {string|number} params.userId - 操作を実行したユーザーID
   * @param {string} params.action - 操作種別 (例: 'LOGIN', 'CREATE_BULLETIN', 'EXAM_AUTO_ASSIGN')
   * @param {string} params.target - 操作対象リソース (例: 'USER', 'BULLETIN:12', 'EXAM_MATRIX:2026')
   * @param {Object} [params.details={}] - 詳細データ (変更前後の差分、検索パラメータ等)
   * @param {string} [params.ipAddress=null] - クライアントIPアドレス
   * @param {string} [params.userAgent=null] - User-Agent ヘッダー
   */
  async log({ userId, action, target, details = {}, ipAddress = null, userAgent = null }) {
    try {
      const logEntry = {
        user_id: userId || null,
        action: action || 'UNKNOWN_ACTION',
        target: target || 'SYSTEM',
        details: typeof details === 'object' ? JSON.stringify(details) : String(details),
        ip_address: ipAddress,
        user_agent: userAgent,
        created_at: new Date().toISOString(),
      };

      // auditModelを通してデータベースに保存
      await auditModel.createAuditLog(logEntry);

      // コンソール出力 (デバッグ/開発用)
      if (process.env.NODE_ENV !== 'production') {
        console.log(`[AUDIT LOG] ${logEntry.created_at} | User:${userId} | ${action} -> ${target}`);
      }
    } catch (error) {
      // 監査ログ書き込み失敗時もメイン処理を止めないようエラーレスポンスは投げずにログ出力のみ行う
      console.error('[AUDIT LOGGER ERROR] 監査ログの記録に失敗しました:', error);
    }
  },

  /**
   * Express リクエストオブジェクトから自動でIP/UserAgentを抽出してログを記録するショートカット関数
   * @param {import('express').Request} req - Express Request
   * @param {string} action - 操作種別
   * @param {string} target - 操作対象リソース
   * @param {Object} [details={}] - 詳細情報
   */
  async logFromRequest(req, action, target, details = {}) {
    const userId = req.user?.id || null;
    const ipAddress = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
    const userAgent = req.headers['user-agent'] || null;

    return this.log({
      userId,
      action,
      target,
      details,
      ipAddress,
      userAgent,
    });
  },
};

export default logger;