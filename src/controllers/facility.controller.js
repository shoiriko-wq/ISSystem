/**
 * ISSystem Facility Controller
 * 施設・備品予約管理コントローラー
 */

import facilityModel from '../models/facility.model.js';

export const facilityController = {
  /**
   * 施設マスター一覧取得 (GET /api/facilities)
   */
  async getAllFacilities(req, res) {
    try {
      const facilities = await facilityModel.findAll();
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
      const reservation = await facilityModel.createReservation(req.body, user);
      
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
      // 二重予約は 409 Conflict、モデルが設定した statusCode を尊重する
      return res.status(err.statusCode || 400).json({
        success: false,
        message: err.message || '重複予約があるため登録できません。'
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
      await facilityModel.cancelReservation(reservationId);

      const io = req.app ? req.app.get('io') : null;
      if (io) {
        io.emit('facility:reservation_changed', { action: 'cancel', reservationId, userId: user.id || user._id, userName: user.name || '教員' });
      }

      return res.status(200).json({
        success: true,
        message: '予約をキャンセルしました。'
      });
    } catch (err) {
      return res.status(400).json({
        success: false,
        message: err.message || '予約のキャンセルに失敗しました。'
      });
    }
  }
};

export default facilityController;