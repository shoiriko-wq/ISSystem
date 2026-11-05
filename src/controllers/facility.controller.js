/**
 * ISSystem Facility Controller
 * 施設・備品予約管理コントローラー
 */

import facilityModel from '../models/facility.model.js';
import { facilityService } from '../services/facility.service.js';

export const facilityController = {
  /**
   * 施設マスター一覧取得 (GET /api/facilities)
   */
  async getAllFacilities(req, res) {
    try {
      const { facilities } = await facilityService.listFacilitiesWithUsage();
      return res.status(200).json({
        success: true,
        count: facilities.length,
        facilities,
        data: facilities
      });
    } catch (err) {
      console.error('[FacilityController Error]:', err);
      return res.status(200).json({
        success: true,
        count: 0,
        facilities: [],
        data: []
      });
    }
  },

  /**
   * 指定日時のタイムライン概要取得 (GET /api/facilities/daily-overview)
   */
  async getDailyOverview(req, res) {
    try {
      const targetDate = req.query.date || new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
      const overview = await facilityModel.getDailyOverview(targetDate);
      return res.status(200).json({
        success: true,
        targetDate,
        facilitiesOverview: overview,
        data: overview
      });
    } catch (err) {
      console.error('[FacilityController Overview Error]:', err);
      return res.status(200).json({
        success: true,
        facilitiesOverview: [],
        data: []
      });
    }
  },

  /**
   * 個別施設の予約一覧取得 (GET /api/facilities/:facilityId/reservations)
   */
  async getReservations(req, res) {
    try {
      const { facilityId } = req.params;
      const { date } = req.query;
      const reservations = await facilityModel.findReservationsByFacility(facilityId, date);
      return res.status(200).json({
        success: true,
        reservations,
        data: reservations
      });
    } catch (err) {
      return res.status(200).json({ success: true, reservations: [], data: [] });
    }
  },

  /**
   * 新規予約作成 (POST /api/facilities/reservations)
   */
  async createReservation(req, res) {
    try {
      const user = req.user || { id: 'kyomu01', name: '教務 主任' };
      const reservation = await facilityService.createReservation(req.body, user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('facility:reservation_changed', { action: 'create', reservation, userId: user.id || user._id, userName: user.name || '教員' });
      }

      return res.status(201).json({
        success: true,
        message: '施設予約が完了しました。',
        reservation,
        data: reservation
      });
    } catch (err) {
      const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
      if (status === 409) {
        console.warn('[FacilityController] 予約時間帯の重複:', err.message);
      }
      return res.status(status).json({
        success: false,
        message: err.message || '重複予約があるため登録できません。'
      });
    }
  },

  /**
   * 予約内容の変更 (PUT /api/facilities/reservations/:reservationId)
   * 投稿者（予約者）本人または教務部のみ
   */
  async updateReservation(req, res) {
    try {
      const user = req.user || { name: '教員' };
      const { reservationId } = req.params;
      const updated = await facilityService.updateReservation(reservationId, req.body || {}, user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('facility:reservation_changed', { action: 'update', reservation: updated, userId: user.id || user._id, userName: user.name || '教員' });
      }

      return res.status(200).json({
        success: true,
        message: '予約を更新しました。',
        reservation: updated,
        data: updated
      });
    } catch (err) {
      const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
      return res.status(status).json({
        success: false,
        message: err.message || '予約の更新に失敗しました。'
      });
    }
  },

  /**
   * 予約キャンセル (DELETE /api/facilities/reservations/:reservationId)
   */
  async cancelReservation(req, res) {
    try {
      const user = req.user || { name: '教員' };
      const { reservationId } = req.params;
      await facilityService.cancelReservation(reservationId, user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('facility:reservation_changed', { action: 'cancel', reservationId, userId: user.id || user._id, userName: user.name || '教員' });
      }

      return res.status(200).json({
        success: true,
        message: '予約をキャンセルしました。'
      });
    } catch (err) {
      const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
      return res.status(status).json({
        success: false,
        message: err.message || '予約のキャンセルに失敗しました。'
      });
    }
  },

  // ================= 施設・備品マスター CRUD (教務部 KYOMU のみ) =================

  /**
   * 施設・備品の追加 (POST /api/facilities)
   */
  async createFacility(req, res) {
    try {
      const user = req.user;
      const facility = await facilityService.createFacility(req.body, user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('facility:master_changed', {
          action: 'create',
          facility,
          userId: user.id || user._id,
          userName: user.name || '教務部'
        });
      }

      return res.status(201).json({
        success: true,
        message: `施設・備品「${facility.name}」を追加しました。`,
        facility,
        data: facility
      });
    } catch (err) {
      const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
      return res.status(status).json({
        success: false,
        message: err.message || '施設・備品の追加に失敗しました。'
      });
    }
  },

  /**
   * 施設・備品の改名・カテゴリ変更 (PUT /api/facilities/:facilityId)
   */
  async updateFacility(req, res) {
    try {
      const user = req.user;
      const { facilityId } = req.params;
      const facility = await facilityService.updateFacility(facilityId, req.body, user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('facility:master_changed', {
          action: 'update',
          facility,
          userId: user.id || user._id,
          userName: user.name || '教務部'
        });
      }

      return res.status(200).json({
        success: true,
        message: `施設・備品「${facility.name}」を更新しました。`,
        facility,
        data: facility
      });
    } catch (err) {
      const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
      return res.status(status).json({
        success: false,
        message: err.message || '施設・備品の変更に失敗しました。'
      });
    }
  },

  /**
   * 施設・備品の表示順変更 (PUT /api/facilities/order)
   * 教務部のみ。タイムライン・予約フォーム select の並び順へ反映される
   */
  async reorderFacilities(req, res) {
    try {
      const user = req.user;
      const { facilities } = await facilityService.reorderFacilities(req.body, user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('facility:master_changed', {
          action: 'reorder',
          facilities,
          userId: user.id || user._id,
          userName: user.name || '教務部'
        });
      }

      return res.status(200).json({
        success: true,
        message: '施設・備品の表示順を変更しました。',
        count: facilities.length,
        facilities,
        data: facilities
      });
    } catch (err) {
      const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
      return res.status(status).json({
        success: false,
        message: err.message || '施設・備品の表示順の変更に失敗しました。'
      });
    }
  },

  /**
   * 施設・備品の削除 (DELETE /api/facilities/:facilityId)
   * 有効な予約が残る場合は 409 で拒否される
   */
  async deleteFacility(req, res) {
    try {
      const user = req.user;
      const { facilityId } = req.params;
      const removed = await facilityService.deleteFacility(facilityId, user);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('facility:master_changed', {
          action: 'delete',
          facilityId: removed.id,
          facilityName: removed.name,
          userId: user.id || user._id,
          userName: user.name || '教務部'
        });
      }

      return res.status(200).json({
        success: true,
        message: `施設・備品「${removed.name}」を削除しました。`,
        data: removed
      });
    } catch (err) {
      const status = err.statusCode >= 400 && err.statusCode < 600 ? err.statusCode : 400;
      return res.status(status).json({
        success: false,
        message: err.message || '施設・備品の削除に失敗しました。'
      });
    }
  }
};

export default facilityController;