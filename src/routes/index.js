/**
 * ISSystem Master API Router
 * 全コンポーネント APIルーティング統合 (関数の存在チェック・安全呼び出し版)
 */

import { Router } from 'express';
import { authenticateToken, requireKyomuRole, requireKyomuOnlyRole, requireAdminRole } from '../middlewares/auth.middleware.js';
import { checkEditingLock } from '../middlewares/lock.middleware.js';
import {
  loginLimiter,
  authIpLimiter,
  registerInvitationLimiter,
  resetInvitationLimiter,
  generateInvitationLimiter,
} from '../middlewares/rate-limit.middleware.js';

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
  deleteSchedule,
  getScheduleCategories,
  createScheduleCategory,
  updateScheduleCategory,
  deleteScheduleCategory
} from '../controllers/schedule.controller.js';

import approvalController from '../controllers/approval.controller.js';
import seatingController from '../controllers/seating.controller.js';
import examController from '../controllers/exam.controller.js';
import newsController from '../controllers/news.controller.js';
import mailController from '../controllers/mail.controller.js';
import absenceController from '../controllers/absence.controller.js';
import subjectController from '../controllers/subject.controller.js';
import basicinfoController from '../controllers/basicinfo.controller.js';
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
// レート制限 (v3.0.7 監査 High 対策): IP+識別子 15分5回（失敗のみカウント）、IP グローバル 1h20回、
// 招待コード 15分5試行。ユーザー単位ロックアウトは auth.service.js で実装（423）。
router.post('/auth/login', authIpLimiter, loginLimiter, safe(authController?.login));
router.post('/auth/register-invitation', authIpLimiter, registerInvitationLimiter, safe(authController?.registerWithInvitation));
router.post('/auth/reset-password-invitation', authIpLimiter, resetInvitationLimiter, safe(authController?.resetPasswordWithInvitation));
router.post('/auth/generate-invitation', authenticateToken, requireKyomuRole, generateInvitationLimiter, safe(authController?.generateInvitation));
router.get('/auth/me', authenticateToken, safe(authController?.getProfile));
router.put('/auth/profile', authenticateToken, safe(authController?.updateProfile));
router.put('/auth/change-password', authenticateToken, safe(authController?.changePassword));
router.put('/auth/status', authenticateToken, safe(authController?.updateStatus));
router.post('/auth/logout', authenticateToken, safe(authController?.logout));

// ユーザー一覧・追加・削除 API (2026/11/8 RBAC 強化)
// 一覧: 全員取得可だがコントローラでロール再検証（KYOMU/ADMIN は全件、TEACHER は名簿最小フィールドのみ）
// 追加: 教務部 (KYOMU/ADMIN) のみ。TEACHER はアカウント作成不可、role 昇格も制御で抑制
// 削除: システム管理者 (ADMIN) のみ
router.get('/users', authenticateToken, safe(authController?.listUsers));
router.post('/users', authenticateToken, requireKyomuRole, safe(authController?.createUser));
router.delete('/users/:id', authenticateToken, requireAdminRole, safe(authController?.deleteUser));

// 教科マスタ API (一覧は全教職員 / 追加・改名・削除は教務部 KYOMU のみ)
router.get('/subjects', authenticateToken, safe(subjectController?.listSubjects));
router.post('/subjects', authenticateToken, requireKyomuRole, safe(subjectController?.createSubject));
router.put('/subjects/:id', authenticateToken, requireKyomuRole, safe(subjectController?.updateSubject));
router.delete('/subjects/:id', authenticateToken, requireKyomuRole, safe(subjectController?.deleteSubject));

// 教員の担当教科設定 (自分自身は全教職員、他教員の変更は教務部のみ service 側で検証)
router.put('/users/:id/subjects', authenticateToken, safe(subjectController?.setUserSubjects));

// 定期考査 基本情報マスタ API (一覧・使用件数は全教職員 / 登録・改名・削除は教務部 KYOMU のみ)
router.get('/basic-info', authenticateToken, safe(basicinfoController?.listBasicInfo));
router.get('/basic-info/usage/:kind/:id', authenticateToken, safe(basicinfoController?.getUsage));
router.post('/basic-info/:kind', authenticateToken, requireKyomuRole, safe(basicinfoController?.createItem));
router.put('/basic-info/:kind/:id', authenticateToken, requireKyomuRole, safe(basicinfoController?.updateItem));
router.delete('/basic-info/:kind/:id', authenticateToken, requireKyomuRole, safe(basicinfoController?.deleteItem));

// 基本情報のセクション編集ロック（座席表の編集排他ロックと同一の editing_locks）
// 取得=編集開始（編集可能モード）、解除=編集終了（読み取り専用モード）。
// 他教員がロック中の書き込みと再取得は 423。lock:status_changed で全員へ通知する。
router.post('/exam/basic-lock/:kind', authenticateToken, requireKyomuRole, safe(basicinfoController?.acquireSectionLock));
router.delete('/exam/basic-lock/:kind', authenticateToken, requireKyomuRole, safe(basicinfoController?.releaseSectionLock));

// エイリアス（同じレート制限を適用）
router.post('/auth/register', authIpLimiter, registerInvitationLimiter, safe(authController?.registerWithInvitation));
router.post('/auth/reset-password', authIpLimiter, resetInvitationLimiter, safe(authController?.resetPasswordWithInvitation));
router.post('/auth/invite-code', authenticateToken, generateInvitationLimiter, safe(authController?.generateInvitation));

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
// 掲示の削除（service 側で投稿者本人のみ許可。UI の「削除」ボタンも投稿者にだけ表示される）
router.delete('/bulletins/:id', authenticateToken, safe(bulletinController?.deleteBulletin));

// ==========================================
// 3. チャット & 協議室 API (/api/chat)
// ==========================================
router.get('/chat/channels', authenticateToken, safe(chatController?.getChannels));
router.post('/chat/channels', authenticateToken, safe(chatController?.createChannel));
router.get('/chat/channels/:channelId/members', authenticateToken, safe(chatController?.getChannelMembers));
router.get('/chat/channels/:channelId/messages', authenticateToken, safe(chatController?.getMessages));
router.post('/chat/channels/:channelId/messages', authenticateToken, safe(chatController?.sendMessage));
router.put('/chat/channels/:channelId/read', authenticateToken, safe(chatController?.updateLastRead));
// グループの「非表示 / 表示」切り替え
router.put('/chat/channels/:channelId/hide', authenticateToken, safe(chatController?.toggleHideChannel));
// チャンネルの削除（公開チャンネルは 400、参加者・管理者のみ削除可）
// チャンネル削除は教務部 (KYOMU/ADMIN) のみ (2026/11/8 RBAC。service 側のメンバー/権限検証は第二防衛線として維持)
router.delete('/chat/channels/:channelId', authenticateToken, requireKyomuRole, safe(chatController?.deleteChannel));
// コメント（メッセージ）の取り消し
router.delete('/chat/messages/:messageId', authenticateToken, safe(chatController?.cancelMessage));
// 未読者への再通知（/chat/renotify）は廃止済み。未読者一覧の表示のみ残す

// ==========================================
// 4. 施設 & 備品予約 API (/api/facilities)
// ==========================================
router.get('/facilities', authenticateToken, safe(facilityController?.getAllFacilities));
router.get('/facilities/daily-overview', authenticateToken, safe(facilityController?.getDailyOverview));
// ミニカレンダーの「●」打点用（月内の各日の予約件数）。':facilityId' に食われないよう前に置く
router.get('/facilities/month-counts', authenticateToken, safe(facilityController?.getMonthCounts));
router.get('/facilities/:facilityId/reservations', authenticateToken, safe(facilityController?.getReservations));
router.post('/facilities/reservations', authenticateToken, safe(facilityController?.createReservation));
router.put('/facilities/reservations/:reservationId', authenticateToken, safe(facilityController?.updateReservation));
router.delete('/facilities/reservations/:reservationId', authenticateToken, safe(facilityController?.cancelReservation));

// 施設・備品マスタの追加・改名・削除（教務部 KYOMU / ADMIN のみ・削除は有効予約が残ると 409）
// ※ /facilities/reservations/... を先に登録しているため ':facilityId' より後ろに置く
// ※ '/facilities/order' は ':facilityId' に食われるため必ず前に置く
router.put('/facilities/order', authenticateToken, requireKyomuRole, safe(facilityController?.reorderFacilities));
router.post('/facilities', authenticateToken, requireKyomuRole, safe(facilityController?.createFacility));
router.put('/facilities/:facilityId', authenticateToken, requireKyomuRole, safe(facilityController?.updateFacility));
router.delete('/facilities/:facilityId', authenticateToken, requireKyomuRole, safe(facilityController?.deleteFacility));

// メール接続設定 API (/api/mail)
// 自分の設定のみ閲覧・変更・削除可 (初回は未設定 → UI でメールアドレスとパスワードを入力)
// ※ GET /mail/accounts は複数アカウントの一覧（アカウントタブ描画用。/mail/account は1件目の設定）
router.get('/mail/account', authenticateToken, safe(mailController?.getAccount));
router.get('/mail/accounts', authenticateToken, safe(mailController?.listAccounts));
router.post('/mail/account', authenticateToken, safe(mailController?.saveAccount));
router.delete('/mail/account', authenticateToken, safe(mailController?.deleteAccount));
// ?account_id= 指定はそのアカウントだけ、未指定は1件目のアカウントを削除する

// 接続テスト API (フォーム値でのプレテスト / 保存済み設定の IMAP・SMTP 接続確認)
router.post('/mail/test', authenticateToken, safe(mailController?.testConnection));

// 受信箱 API (左：件名と日時、右：本文 / 既読記録)
// ?account_id= 未指定はそのユーザーの1件目のアカウント。refresh は受信ボックスの IMAP 取得 (自動受信を含む)、
// send は SMTP 送信 + 送信済みボックス保存 (POST body.account_id で送信元アカウントを選ぶ)
router.get('/mail/messages', authenticateToken, safe(mailController?.getInbox));
router.post('/mail/inbox/refresh', authenticateToken, safe(mailController?.refreshInbox));
// 受信ボックスの過去分（無限スクロール。IMAP のまだ DB に無い UID を1ページ分取り込む）
router.post('/mail/inbox/older', authenticateToken, safe(mailController?.loadOlderInbox));
router.post('/mail/send', authenticateToken, safe(mailController?.sendMessage));
router.post('/mail/messages/:id/read', authenticateToken, safe(mailController?.markMessageRead));

// ==========================================
// 5. 校内行事 & スケジュール API (/api/schedules)
// ==========================================
// カテゴリマスタ (＝プロフィールの部署マスタ。追加・改名・削除は教務部 KYOMU のみ)
router.get('/schedules/categories', authenticateToken, safe(getScheduleCategories));
router.post('/schedules/categories', authenticateToken, requireKyomuOnlyRole, safe(createScheduleCategory));
router.put('/schedules/categories/:id', authenticateToken, requireKyomuOnlyRole, safe(updateScheduleCategory));
router.delete('/schedules/categories/:id', authenticateToken, requireKyomuOnlyRole, safe(deleteScheduleCategory));

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
// 座席表マトリクス（rows/cols と席割当て、編集可能モードのみ保存）
router.get('/seating/matrix', authenticateToken, safe(seatingController?.getMatrix));
router.put(
  '/seating/matrix',
  authenticateToken,
  checkEditingLock('seating'),
  safe(seatingController?.saveMatrix)
);
router.post('/seating/matrix/lock', authenticateToken, safe(seatingController?.acquireMatrixLock));
router.delete('/seating/matrix/lock', authenticateToken, safe(seatingController?.releaseMatrixLock));
router.get('/seating/layouts', authenticateToken, safe(seatingController?.getLayouts));

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
// 8. 定期考査 API (/api/exam)
// ==========================================
router.get('/exam', authenticateToken, safe(examController?.getActiveExam));
router.get('/exam/masters', authenticateToken, safe(examController?.listMasters));
router.post('/exam', authenticateToken, safe(examController?.createMaster));
router.put('/exam/:id', authenticateToken, safe(examController?.updateMaster));
router.post('/exam/:id/deactivate', authenticateToken, safe(examController?.deactivateMaster));
router.get('/exam/:id/board', authenticateToken, safe(examController?.getBoard));
router.get('/exam/:id/view', authenticateToken, safe(examController?.getPublishedView));
router.get('/exam/:id/view/timetable', authenticateToken, safe(examController?.getPublishedTimetable));
router.get('/exam/:id/view/rooms', authenticateToken, safe(examController?.getPublishedRooms));
router.get('/exam/:id/view/proctors', authenticateToken, safe(examController?.getPublishedProctors));
router.get('/exam/:id/view/trips', authenticateToken, safe(examController?.getPublishedTrips));
router.post('/exam/:id/phase', authenticateToken, safe(examController?.setPhase));

// 実施科目・出題者登録／調査
router.get('/exam/:id/subjects', authenticateToken, safe(examController?.getSubjects));
// 実施科目の決定（② の調査値がデフォルト値、教務が 1 考査分を決定して編集する）
router.get('/exam/:id/decisions', authenticateToken, safe(examController?.listSubjectDecisions));
router.post('/exam/:id/decisions/seed', authenticateToken, requireKyomuRole, safe(examController?.seedSubjectDecisions));
router.post('/exam/:id/decisions', authenticateToken, requireKyomuRole, safe(examController?.addDecisionRow));
router.post('/exam/:id/decision-rows', authenticateToken, safe(examController?.saveDecisionRow));
router.post('/exam/:id/decisions/survey/start', authenticateToken, requireKyomuRole, safe(examController?.startDecisionSurvey));
router.post('/exam/:id/decisions/survey/end', authenticateToken, requireKyomuRole, safe(examController?.endDecisionSurvey));
router.post('/exam/:id/decisions/decide', authenticateToken, requireKyomuRole, safe(examController?.decideSubjects));
router.post('/exam/decision/:id/submit', authenticateToken, safe(examController?.submitDecisionRow));
router.post('/exam/decision/:id/reset-default', authenticateToken, requireKyomuRole, safe(examController?.resetDecisionToDefault));
router.delete('/exam/decision/:id', authenticateToken, requireKyomuRole, safe(examController?.deleteDecisionRow));
router.get('/exam-survey-status', authenticateToken, safe(examController?.examSurveyStatus));
router.post('/exam/:id/subject-survey/start', authenticateToken, safe(examController?.startSubjectSurvey));
router.post('/exam/:id/subject-row', authenticateToken, safe(examController?.saveSubjectRow));
router.post('/exam/:id/subject-row/:rowId/submit', authenticateToken, safe(examController?.submitSubjectRow));
router.delete('/exam/:id/subject-row/:rowId', authenticateToken, safe(examController?.deleteSubjectRow));
router.post('/exam/:id/subject-survey/end', authenticateToken, safe(examController?.endSubjectSurvey));
router.post('/exam/:id/subject-row/:rowId/decide', authenticateToken, safe(examController?.setSubjectDecision));

// 年間考査計画（試験期間登録・教員調査開始・実施科目決定）
router.post('/exam/:id/plan/register', authenticateToken, safe(examController?.registerPlan));
router.post('/exam/:id/plan/survey-start', authenticateToken, safe(examController?.startPlanSurvey));
router.post('/exam/:id/plan/decide', authenticateToken, safe(examController?.decideSubjects));
router.get('/exam/:id/survey-summary', authenticateToken, safe(examController?.surveySummary));

// 試験時間割
router.get('/exam/:id/slots', authenticateToken, safe(examController?.getSlots));
router.post('/exam/:id/timetable-rules', authenticateToken, safe(examController?.saveTimetableRules));
router.post('/exam/:id/timetable', authenticateToken, safe(examController?.solveTimetable));
  router.post('/exam/:id/timetable/slots', authenticateToken, safe(examController?.saveTimetableSlots));

router.post('/exam/:id/timetable/publish', authenticateToken, safe(examController?.publishTimetable));
router.post('/exam/:id/timetable/end', authenticateToken, safe(examController?.endTimetable));
router.post('/exam/:id/timetable/validate', authenticateToken, safe(examController?.validateTimetableRows));
router.get('/exam/:id/schedule-cells', authenticateToken, safe(examController?.getScheduleCells));
router.put('/exam/:id/schedule-cells', authenticateToken, safe(examController?.saveScheduleCells));
router.put('/exam/:id/timetable/blocked', authenticateToken, safe(examController?.saveGradeBlocked));

// コマ組み（block）ベース時間割
router.get('/exam/:id/commands', authenticateToken, safe(examController?.listBlockCommands));
router.post('/exam/:id/commands/generate', authenticateToken, requireKyomuRole, safe(examController?.generateCommands));
router.post('/exam/:id/command', authenticateToken, requireKyomuRole, safe(examController?.saveBlockCommand));
router.delete('/exam/:id/command/:commandId', authenticateToken, requireKyomuRole, safe(examController?.deleteBlockCommand));
router.get('/exam/:id/block-shapes', authenticateToken, safe(examController?.listBlockShapes));
router.post('/exam/:id/block-shapes/generate', authenticateToken, requireKyomuRole, safe(examController?.generateBlockShapes));
router.post('/exam/:id/block-shape', authenticateToken, requireKyomuRole, safe(examController?.saveBlockShape));
router.delete('/exam/:id/block-shape/:shapeId', authenticateToken, requireKyomuRole, safe(examController?.deleteBlockShape));
router.get('/exam/:id/block-groups', authenticateToken, safe(examController?.listBlockGroups));
router.post('/exam/:id/block-groups/seed', authenticateToken, requireKyomuRole, safe(examController?.seedBlockGroups));
router.post('/exam/:id/block-group', authenticateToken, requireKyomuRole, safe(examController?.saveBlockGroup));
router.delete('/exam/:id/block-group/:groupId', authenticateToken, requireKyomuRole, safe(examController?.deleteBlockGroup));
router.get('/exam/:id/block-conditions', authenticateToken, safe(examController?.listBlockConditions));
router.put('/exam/:id/block-conditions/:shapeId', authenticateToken, requireKyomuRole, safe(examController?.saveBlockConditions));
router.put('/exam/:id/block-shapes/:shapeId/placements', authenticateToken, requireKyomuRole, safe(examController?.placeBlockShape));
router.post('/exam/:id/timetable/solve', authenticateToken, requireKyomuRole, safe(examController?.solveBlockTimetable));
router.post('/exam/:id/timetable/validate-block', authenticateToken, safe(examController?.validateBlockTimetable));


// 試験教室
router.get('/exam/:id/rooms', authenticateToken, safe(examController?.getRooms));
router.get('/exam/:id/room-rules', authenticateToken, safe(examController?.getRoomRules));
router.post('/exam/:id/room-rules', authenticateToken, safe(examController?.saveRoomRules));
router.get('/exam/:id/room-config', authenticateToken, safe(examController?.getRoomConfig));
router.post('/exam/:id/rooms', authenticateToken, safe(examController?.saveRooms));
router.post('/exam/:id/room-config', authenticateToken, safe(examController?.saveRoomConfig));
router.post('/exam/:id/room-assign', authenticateToken, safe(examController?.solveRoomAssignments));
router.put('/exam/:id/room-assign', authenticateToken, safe(examController?.saveRoomAssignments));
router.post('/exam/:id/room-assign/publish', authenticateToken, safe(examController?.publishRoomAssignments));
router.post('/exam/:id/room-assign/end', authenticateToken, safe(examController?.endRoomPhase));

// 出張等
router.get('/exam/:id/trips/preview', authenticateToken, safe(examController?.previewTrips));
router.get('/exam/:id/trips', authenticateToken, safe(examController?.getTrips));
router.post('/exam/:id/trips/start', authenticateToken, safe(examController?.startTripSurvey));
router.post('/exam/:id/trips/publish', authenticateToken, safe(examController?.publishTrips));
router.post('/exam/:id/trips', authenticateToken, safe(examController?.saveTrips));
router.delete('/exam/:id/trips/:tripId', authenticateToken, safe(examController?.deleteTrip));
router.post('/exam/:id/trips/end', authenticateToken, safe(examController?.endTripPhase));

// 試験監督
router.get('/staff/pool', authenticateToken, safe(examController?.getStaffPool));
router.get('/exam/:id/proctor-board', authenticateToken, safe(examController?.getProctorBoard));
router.post('/exam/:id/proctor-rules', authenticateToken, safe(examController?.saveProctorRules));
router.post('/exam/:id/parttime-staff', authenticateToken, safe(examController?.saveParttimeStaff));
router.delete('/exam/:id/parttime-staff/:staffRowId', authenticateToken, safe(examController?.deleteParttimeStaff));
router.post('/exam/:id/parttime-availability', authenticateToken, safe(examController?.setParttimeAvailability));
router.post('/exam/:id/teacher-constraint', authenticateToken, safe(examController?.saveTeacherConstraint));
router.post('/exam/:id/exemption', authenticateToken, safe(examController?.addExemption));
router.delete('/exam/:id/exemption/:teacherId', authenticateToken, safe(examController?.removeExemption));
router.post('/exam/:id/proctor-assign', authenticateToken, safe(examController?.solveProctors));
router.put('/exam/:id/proctor-assign', authenticateToken, safe(examController?.saveProctors));
router.post('/exam/:id/proctor-assign/validate', authenticateToken, safe(examController?.validateProctorRows));
router.post('/exam/:id/proctor-assign/publish', authenticateToken, safe(examController?.publishProctors));
router.post('/exam/:id/proctor-assign/end', authenticateToken, safe(examController?.endProctorPhase));


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
// ★ 「記事を共有」はチャットへ投稿しない。共有リンクを1件追加するだけ（news_links）
router.get('/news/links', authenticateToken, safe(newsController?.getSharedLinks));
router.post('/news/links', authenticateToken, safe(newsController?.addSharedLink));

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