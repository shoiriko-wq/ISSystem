/**
 * ISSystem Scheduled Cron Jobs
 * 3分無操作編集ロックのバックグラウンド自動解放 & 外部教育ニュース/天気予報の定期TTL自動更新ジョブ
 */

import cron from 'node-cron';
import auditModel from '../models/audit.model.js';
import newsService from '../services/news.service.js';

/**
 * ISSystem 定期バックグラウンドタスクの初期化
 * @param {import('socket.io').Server} [io] - オプションのSocket.ioインスタンス (リアルタイム通知用)
 */
export function initializeCronJobs(io = null) {
  console.log('[Cron Jobs] 定期バックグラウンドタスクを初期化しています...');

  /**
   * 1. 無操作3分経過編集ロックの自動解放タスク
   * 実行周期: 毎分 (0秒時点)
   */
  cron.schedule('0 * * * * *', async () => {
    try {
      // 3分(180秒)以上更新がないアクティブな編集ロックを取得
      const expiredLocks = await auditModel.getExpiredEditingLocks(180);

      if (expiredLocks && expiredLocks.length > 0) {
        for (const lock of expiredLocks) {
          // DB上のロックを解放
          await auditModel.releaseEditingLock(lock.resource_type, lock.resource_id);

          console.log(
            `[Cron Lock Auto-Release] 無操作タイムアウトにより編集ロックを自動解放しました: ${lock.resource_type}:${lock.resource_id}`
          );

          // Socket.ioでリアルタイム全一斉通知 (クライアントの編集モード自動解除用)
          if (io) {
            io.emit('lock:status_changed', {
              resourceType: lock.resource_type,
              resourceId: lock.resource_id,
              isLocked: false,
              isTimeout: true,
              message: '3分間無操作のため、編集ロックがシステムにより自動解放されました。',
            });
          }
        }
      }
    } catch (error) {
      console.error('[Cron Job Error] 編集ロック自動解放処理中にエラーが発生しました:', error);
    }
  });

  /**
   * 2. 外部教育ニュース & 天気予報データの定期TTL自動更新タスク
   * 実行周期: 毎時0分 (1時間ごと)
   */
  cron.schedule('0 0 * * * *', async () => {
    try {
      console.log('[Cron News Refresher] 外部教育ニュースおよび天気予報データを自動更新しています...');

      // キャッシュを強制更新 (forceRefresh = true)
      await newsService.getEducationNews(true);
      const weatherResult = await newsService.getWeatherForecast('280010', true);

      console.log('[Cron News Refresher] 教育ニュースおよび天気予報のキャッシュ更新が完了しました。');

      // 接続中のクライアントへリアルタイムプッシュ通知
      if (io) {
        io.emit('weather:updated', {
          weather: weatherResult.weather,
          lastFetchedAt: weatherResult.lastFetchedAt,
        });
        console.log('[Cron News Refresher] 接続中のクライアントへ天気情報の自動更新をブロードキャストしました。');
      }
    } catch (error) {
      console.error('[Cron Job Error] 外部ニュース・天気予報自動更新中にエラーが発生しました:', error);
    }
  });

  /**
   * 3. 古い監査ログのアーカイブ/クリーンアップタスク (保持期間: 90日)
   * 実行周期: 毎日深夜 3:00 AM
   */
  cron.schedule('0 0 3 * * *', async () => {
    try {
      console.log('[Cron Maintenance] 90日以上経過した古い監査ログの整理を実行します...');
      
      const cleanedCount = await auditModel.cleanOldAuditLogs(90);
      console.log(`[Cron Maintenance] 古い監査ログ ${cleanedCount} 件を正常にクリーンアップしました。`);
    } catch (error) {
      console.error('[Cron Job Error] 監査ログ定期クリーンアップ中にエラーが発生しました:', error);
    }
  });

  console.log('[Cron Jobs] 全定期タスクの登録が完了しました。');
}

export default initializeCronJobs;