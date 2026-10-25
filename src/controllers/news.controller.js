/**
 * ISSystem Education News & System Health Controller
 * 外部教育ニュース・天気予報データ・システムヘルスチェックAPI
 */

import newsService from '../services/news.service.js';

export const newsController = {
  /**
   * 外部教育ニュース一覧の取得 (TTLキャッシュ適用)
   * GET /api/news
   */
  async getEducationNews(req, res, next) {
    try {
      const { refresh } = req.query;
      const forceRefresh = refresh === 'true';

      const result = await newsService.getEducationNews(forceRefresh);

      return res.status(200).json({
        success: true,
        cached: result.cached,
        lastFetchedAt: result.lastFetchedAt,
        items: result.items,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 地域別天気予報データの取得
   * GET /api/news/weather
   */
  async getWeatherForecast(req, res, next) {
    try {
      const { locationCode, refresh } = req.query;
      const forceRefresh = refresh === 'true';

      const result = await newsService.getWeatherForecast(
        locationCode || '280010',
        forceRefresh
      );

      return res.status(200).json({
        success: true,
        cached: result.cached,
        lastFetchedAt: result.lastFetchedAt,
        weather: result.weather,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * 職員室トップ画面・ダッシュボードウィジェット用フィード統合取得
   * GET /api/news/dashboard-widget
   */
  async getDashboardWidgetFeed(req, res, next) {
    try {
      const feed = await newsService.getDashboardWidgetFeed();

      return res.status(200).json({
        success: true,
        data: feed,
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * システムヘルスチェック・稼働状況API
   * GET /api/news/health
   */
  async checkHealth(req, res, next) {
    try {
      const uptime = process.uptime();
      const memoryUsage = process.memoryUsage();

      return res.status(200).json({
        success: true,
        status: 'UP',
        system: 'ISSystem Backend API',
        timestamp: new Date().toISOString(),
        uptimeSeconds: Math.floor(uptime),
        memoryUsage: {
          rssMB: Math.round((memoryUsage.rss / 1024 / 1024) * 100) / 100,
          heapTotalMB: Math.round((memoryUsage.heapTotal / 1024 / 1024) * 100) / 100,
          heapUsedMB: Math.round((memoryUsage.heapUsed / 1024 / 1024) * 100) / 100,
        },
      });
    } catch (error) {
      next(error);
    }
  },

  /**
   * ニュース・天気予報キャッシュの強制全クリア (管理者向け)
   * POST /api/news/cache/clear
   */
  async clearCache(req, res, next) {
    try {
      const user = req.user;

      const result = await newsService.clearCache(user);

      return res.status(200).json({
        success: true,
        message: result.message,
      });
    } catch (error) {
      next(error);
    }
  },
};

export default newsController;