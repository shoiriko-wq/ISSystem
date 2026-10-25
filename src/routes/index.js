/**
 * ISSystem Master API Router
 * 全コンポーネント APIルーティング統合 (関数の存在チェック・安全呼び出し版)
 */

import { Router } from 'express';
import { authenticateToken, requireKyomuRole } from '../middlewares/auth.middleware.js';
import { checkEditingLock } from '../middlewares/lock.middleware.js';

import authController from '../controllers/auth.controller.js';
import bulletinController from '../controllers/bulletin.controller.js';
import chatController from '../controllers/chat.controller.js';
import facilityController from '../controllers/facility.controller.js';

// スケジュールコントローラーの個別インポート
import {
  getSchedulesByRange,
  getTodayTimeline,
  createSchedule,
  updateSchedule,
  deleteSchedule
} from '../controllers/schedule.controller.js';

import approvalController from '../controllers/approval.controller.js';
import seatingController from '../controllers/seating.controller.js';
import examController from '../controllers/exam.controller.js';
import newsController from '../controllers/news.controller.js';
import absenceController from '../controllers/absence.controller.js';
import auditService from '../services/audit.service.js';

const router = Router();

// コントローラーメソッドの安全ラッパー（万が一undefinedでもサーバークラッシュを防ぐ）
const safe = (fn) => (req, res, next) => {
  if (typeof fn === 'function') {
    return fn(req, res, next);
  }
  console.error('[Router Error] 定義されていないコントローラー関数が呼び出されました');
  return res.status(500).json({ success: false, message: '内部ルーティングエラー: ハンドラーが未定義です。' });
};

// ==========================================
// 1. 認証 & ユーザー管理 API (/api/auth)
// ==========================================
router.post('/auth/login', safe(authController?.login));
router.post('/auth/register-invitation', safe(authController?.registerWithInvitation));
router.post('/auth/generate-invitation', authenticateToken, safe(authController?.generateInvitation));
router.get('/auth/me', authenticateToken, safe(authController?.getProfile));
router.put('/auth/profile', authenticateToken, safe(authController?.updateProfile));
router.put('/auth/change-password', authenticateToken, safe(authController?.changePassword));
router.put('/auth/status', authenticateToken, safe(authController?.updateStatus));
router.post('/auth/logout', authenticateToken, safe(authController?.logout));

// ユーザー一覧・追加・削除 API
router.get('/users', authenticateToken, safe(authController?.listUsers));
router.post('/users', authenticateToken, safe(authController?.createUser));
router.delete('/users/:id', authenticateToken, safe(authController?.deleteUser));

// エイリアス
router.post('/auth/register', safe(authController?.registerWithInvitation));
router.post('/auth/invite-code', authenticateToken, safe(authController?.generateInvitation));

// ==========================================
// 2. 掲示板 & 回覧板 API (/api/bulletins)
// ==========================================
// 添付ファイル関連（multipart アップロード / ダウンロード / 削除）※ /: より先に登録
router.post('/bulletins/upload', authenticateToken, safe(bulletinController?.createBulletinWithUpload));
router.get('/bulletins/attachments/:attachmentId', authenticateToken, safe(bulletinController?.downloadBulletinAttachment));
router.delete('/bulletins/attachments/:attachmentId', authenticateToken, safe(bulletinController?.deleteBulletinAttachment));
router.post('/bulletins/:id/attachments', authenticateToken, safe(bulletinController?.addAttachmentsToBulletin));

router.get('/bulletins', authenticateToken, safe(bulletinController?.getBulletins));
router.get('/bulletins/:id', authenticateToken, safe(bulletinController?.getBulletinDetail));
router.post('/bulletins', authenticateToken, safe(bulletinController?.createBulletin));
router.post('/bulletins/:id/comments', authenticateToken, safe(bulletinController?.addComment));
router.put('/bulletins/:id/read', authenticateToken, safe(bulletinController?.markAsRead));
router.put('/bulletins/:id/approve', authenticateToken, safe(bulletinController?.digitallyApprove));
router.post('/bulletins/:id/remind', authenticateToken, safe(bulletinController?.remindUnapprovedMembers));

// ==========================================
// 3. チャット & 協議室 API (/api/chat)
// ==========================================
router.get('/chat/channels', authenticateToken, safe(chatController?.getChannels));
router.post('/chat/channels', authenticateToken, safe(chatController?.createChannel));
router.get('/chat/channels/:channelId/members', authenticateToken, safe(chatController?.getChannelMembers));
router.get('/chat/channels/:channelId/messages', authenticateToken, safe(chatController?.getMessages));
router.post('/chat/channels/:channelId/messages', authenticateToken, safe(chatController?.sendMessage));
router.put('/chat/channels/:channelId/read', authenticateToken, safe(chatController?.updateLastRead));
// グループの「非表示 / 表示」切り替え（削除機能は廃止済み）
router.put('/chat/channels/:channelId/hide', authenticateToken, safe(chatController?.toggleHideChannel));
// コメント（メッセージ）の取り消し
router.delete('/chat/messages/:messageId', authenticateToken, safe(chatController?.cancelMessage));
router.post('/chat/renotify', authenticateToken, (req, res) => {
  return res.status(200).json({ success: true, message: '未読者へ再通知を送信しました。' });
});

// ==========================================
// 4. 施設 & 備品予約 API (/api/facilities)
// ==========================================
router.get('/facilities', authenticateToken, safe(facilityController?.getAllFacilities));
router.get('/facilities/daily-overview', authenticateToken, safe(facilityController?.getDailyOverview));
router.get('/facilities/:facilityId/reservations', authenticateToken, safe(facilityController?.getReservations));
router.post('/facilities/reservations', authenticateToken, safe(facilityController?.createReservation));
router.delete('/facilities/reservations/:reservationId', authenticateToken, safe(facilityController?.cancelReservation));

// ==========================================
// 5. 校内行事 & スケジュール API (/api/schedules)
// ==========================================
router.get('/schedules', authenticateToken, safe(getSchedulesByRange));
router.get('/schedules/today', authenticateToken, safe(getTodayTimeline));
router.post('/schedules', authenticateToken, safe(createSchedule));
router.put('/schedules/:id', authenticateToken, safe(updateSchedule));
router.delete('/schedules/:id', authenticateToken, safe(deleteSchedule));

// ==========================================
// 6. 簡易決裁・承認申請 API (/api/approvals)
// ==========================================
router.get('/approvals', authenticateToken, safe(approvalController?.getApprovals));
router.get('/approvals/:id', authenticateToken, safe(approvalController?.getApprovalDetail));
router.post('/approvals', authenticateToken, safe(approvalController?.createApproval));
router.put('/approvals/:id/process', authenticateToken, safe(approvalController?.processApproval));
router.put('/approvals/:id/status', authenticateToken, safe(approvalController?.processApproval));
router.post('/approvals/:id/remind', authenticateToken, safe(approvalController?.remindApprover));

// ==========================================
// 7. 座席表 & 生徒検索 API (/api/seating)
// ==========================================
router.get('/seating/layouts', authenticateToken, safe(seatingController?.getLayouts));
router.get('/seating/layouts/:id', authenticateToken, safe(seatingController?.getLayoutDetail));
router.post('/seating/layouts', authenticateToken, safe(seatingController?.createLayout));
router.put(
  '/seating/layouts/:id/cells',
  authenticateToken,
  checkEditingLock('seating'),
  safe(seatingController?.saveSeatingCells)
);
router.put('/seating/layouts', authenticateToken, safe(seatingController?.saveSeatingCells));
router.put('/seating/master', authenticateToken, safe(seatingController?.saveSeatingCells));
router.get('/seating/master', authenticateToken, safe(seatingController?.getLayouts));
router.get('/seating/students/code/:code', authenticateToken, safe(seatingController?.getStudentByCode));
router.get('/seating/students/search', authenticateToken, safe(seatingController?.searchStudents));
router.post('/seating/layouts/:id/lock', authenticateToken, safe(seatingController?.acquireEditingLock));
router.delete('/seating/layouts/:id/lock', authenticateToken, safe(seatingController?.releaseEditingLock));

// ==========================================
// 8. 定期考査最適化 API (/api/exams)
// ==========================================
router.get('/exams', authenticateToken, safe(examController?.getExamMasters));
router.get('/exams/:id/matrix', authenticateToken, safe(examController?.getExamMatrixWithValidation));
router.get('/exam/matrix', authenticateToken, async (req, res, next) => {
  req.params.id = 'exam_2026_1';
  return safe(examController?.getExamMatrixWithValidation)(req, res, next);
});
router.get('/exam/status', authenticateToken, safe(examController?.getExamMasters));
router.post('/exam/optimize', authenticateToken, requireKyomuRole, async (req, res, next) => {
  req.params.id = req.body?.id || 'exam_2026_1';
  return safe(examController?.autoAssignProctors)(req, res, next);
});
router.get('/exams/:id/diagnose', authenticateToken, safe(examController?.diagnoseConflicts));
router.post('/exams/:id/auto-assign', authenticateToken, requireKyomuRole, safe(examController?.autoAssignProctors));
router.put(
  '/exams/:id/proctor',
  authenticateToken,
  checkEditingLock('exam'),
  safe(examController?.updateProctorAssignment)
);
router.put('/exams/:id/slots', authenticateToken, checkEditingLock('exam'), safe(examController?.saveExamSlots));

// ==========================================
// 9. 教育ニュース・天気・ヘルスチェック API (/api/news)
// ==========================================
router.get('/news', authenticateToken, safe(newsController?.getEducationNews));
router.get('/news/weather', authenticateToken, safe(newsController?.getWeatherForecast));
router.get('/external/news', authenticateToken, safe(newsController?.getEducationNews));
router.get('/external/weather', authenticateToken, safe(newsController?.getWeatherForecast));
router.get('/news/dashboard-widget', authenticateToken, safe(newsController?.getDashboardWidgetFeed));
router.get('/news/health', safe(newsController?.checkHealth));
router.post('/news/cache/clear', authenticateToken, requireKyomuRole, safe(newsController?.clearCache));

// ==========================================
// 10. 年休等・出張 欠席登録 API (/api/absences)
// 教務・管理職は全教員分を登録可、一般教員は本人分のみ登録可 (権限判定は Service 側)
// ==========================================
router.get('/absences', authenticateToken, safe(absenceController?.getSummary));
router.get('/absences/teachers', authenticateToken, safe(absenceController?.getTeachers));
router.post('/absences', authenticateToken, safe(absenceController?.recordAbsence));
router.delete('/absences/:id', authenticateToken, safe(absenceController?.deleteAbsence));

// ==========================================
// 11. システム監査ログ API (/api/audit)
// ==========================================
router.get('/audit/logs', authenticateToken, requireKyomuRole, async (req, res, next) => {
  try {
    const { action, target, userId, startDate, endDate, page, limit } = req.query;
    const result = await auditService.getAuditLogs({
      action,
      target,
      userId,
      startDate,
      endDate,
      page: Number(page) || 1,
      limit: Number(limit) || 50,
    });
    return res.status(200).json({ success: true, ...result });
  } catch (error) {
    next(error);
  }
});

export default router;