/**
 * ISSystem 考査基本情報の CSV 一括登録 Controller
 * src/services/exam-import.service.js の API を呼ぶ
 *
 * exam_master_id は TEXT の id（'exam_2026_1' 等）。section は class|subject|room|decision。
 */
import { examImportService } from '../services/exam-import.service.js';

const SECTIONS = ['class', 'subject', 'room', 'decision'];

function parseJsonBody(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return raw;
}

function isKyomuUser(user) {
  const role = String(user?.role || '').toUpperCase();
  return user?.is_kyomu === true || role === 'KYOMU' || role === 'ADMIN';
}

function validateParams(body) {
  const b = parseJsonBody(body) || {};
  const section = String(b.section || '').trim();
  const examId = String(b.exam_master_id ?? '').trim();
  const csvBase64 = String(b.csvBase64 || '');
  if (!SECTIONS.includes(section)) {
    const err = new Error('section が不正');
    err.statusCode = 400;
    throw err;
  }
  if (!examId) {
    const err = new Error('exam_master_id 必須');
    err.statusCode = 400;
    throw err;
  }
  if (!csvBase64) {
    const err = new Error('csvBase64 必須');
    err.statusCode = 400;
    throw err;
  }
  return { section, examId, csvBase64 };
}

function emitSocketEvents(io, rows, section, user) {
  const labels = { class: 'クラス・コース', subject: '科目', room: '教室', decision: '実施科目の決定' };
  io.emit('cache:invalidate', { section: 'exam', user_id: user.id, timestamp: Date.now() });
  io.emit('exam:updated', { exam_master_id: rows?.examId, section, updated_by: user.id, timestamp: Date.now() });
  io.emit('exam:changed', { exam_master_id: rows?.examId, section, updated_by: user.id, timestamp: Date.now() });
  io.emit('basicinfo:changed', { section, label: labels[section], updated_by: user.id, timestamp: Date.now() });
  io.emit('cache:invalidate', { section: 'exam_master', exam_master_id: rows?.examId, timestamp: Date.now() });
}

export const examImportController = {
  async preview(req, res, next) {
    try {
      const { section, examId, csvBase64 } = validateParams(req.body);
      const b = parseJsonBody(req.body) || {};
      const fileName = String(b.fileName || 'import.csv');
      const user = req.user;
      const result = await examImportService.previewCsv({ section, examId, csvBase64, fileName }, user);
      return res.status(200).json({ success: true, data: result });
    } catch (e) {
      const code = e?.statusCode || 400;
      return res.status(code).json({ success: false, message: e?.message || 'preview 失敗' });
    }
  },

  async commit(req, res, next) {
    try {
      const { section, examId, csvBase64 } = validateParams(req.body);
      const b = parseJsonBody(req.body) || {};
      const rows = Array.isArray(b.rows) ? b.rows : [];
      const user = req.user;
      const result = await examImportService.commitRows({ section, examId, csvBase64, rows }, user);
      const io = req.app?.get('io');
      if (io) emitSocketEvents(io, result, section, user);
      return res.status(201).json({ success: true, data: result });
    } catch (e) {
      const code = e?.statusCode || 400;
      return res.status(code).json({ success: false, message: e?.message || 'commit 失敗' });
    }
  },

  async cancel(req, res, next) {
    try {
      const { section, examId, csvBase64 } = validateParams(req.body);
      const user = req.user;
      const result = await examImportService.cancelPreview({ section, examId, csvBase64 }, user);
      return res.status(200).json({ success: true, data: result });
    } catch (e) {
      const code = e?.statusCode || 400;
      return res.status(code).json({ success: false, message: e?.message || 'cancel 失敗' });
    }
  },

  async template(req, res, next) {
    try {
      const section = String(req.params?.section || 'class').trim();
      if (!SECTIONS.includes(section)) {
        return res.status(400).json({ success: false, message: 'section が不正' });
      }
      const data = await examImportService.getTemplate(section);
      return res.status(200).json({ success: true, data });
    } catch (e) {
      return res.status(400).json({ success: false, message: e?.message || 'template 失敗' });
    }
  },

  async cleanup(req, res, next) {
    try {
      const user = req.user;
      if (!isKyomuUser(user)) {
        return res.status(403).json({ success: false, message: 'cleanup は ADMIN 専用' });
      }
      const data = await examImportService.cleanupStagedPreviews();
      return res.status(200).json({ success: true, data });
    } catch (e) {
      return res.status(400).json({ success: false, message: e?.message || 'cleanup 失敗' });
    }
  },
};

export default examImportController;
