/**
 * ISSystem Periodic Exam & Supervisor Assignment Data Access Model
 * 定期考査コマ・科目時間割・試験監督割当マトリクス・制約条件データ操作
 */

import { query } from '../../config/database.js';

// デモ・開発用インメモリキャッシュストア
const mockExamMasters = new Map([
  ['exam_2026_1', { id: 'exam_2026_1', title: '2026年度 1学期中間考査', start_date: '2026-05-20', end_date: '2026-05-22', days_count: 3, daily_slots: 3, is_active: true }]
]);
const mockExamSlots = new Map(); // key: examMasterId, value: Array
const mockProctorAssignments = new Map(); // key: examMasterId, value: Array
const mockTeacherExemptions = new Map(); // key: examMasterId, value: Array

export const examModel = {
  /**
   * 考査マスター一覧の取得
   */
  async listExamMasters() {
    if (mockExamMasters.size > 0) return Array.from(mockExamMasters.values());
    const sql = `SELECT * FROM exam_masters WHERE is_active = true ORDER BY start_date DESC`;
    const res = await query(sql);
    return res.rows;
  },

  /**
   * 考査マスターの取得 (ID指定)
   * @param {string} id
   */
  async findExamMasterById(id) {
    if (mockExamMasters.has(id)) return mockExamMasters.get(id);
    const sql = `SELECT * FROM exam_masters WHERE id = $1`;
    const res = await query(sql, [id]);
    return res.rows[0] || null;
  },

  /**
   * 新規考査マスターの作成
   * @param {Object} data
   */
  async createExamMaster(data) {
    const id = data.id || `exam_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newMaster = {
      id,
      title: data.title,
      start_date: data.start_date,
      end_date: data.end_date,
      days_count: data.days_count || 3,
      daily_slots: data.daily_slots || 3,
      is_active: true,
      created_at: new Date(),
      updated_at: new Date()
    };

    mockExamMasters.set(id, newMaster);

    const sql = `
      INSERT INTO exam_masters (id, title, start_date, end_date, days_count, daily_slots, is_active, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8)
      RETURNING *
    `;
    await query(sql, [id, newMaster.title, newMaster.start_date, newMaster.end_date, newMaster.days_count, newMaster.daily_slots, newMaster.created_at, newMaster.updated_at]);

    return newMaster;
  },

  /**
   * 考査コマ・科目時間割スロットの取得
   * @param {string} examMasterId
   */
  async getExamSlots(examMasterId) {
    if (mockExamSlots.has(examMasterId)) return mockExamSlots.get(examMasterId);

    const sql = `
      SELECT es.*, c.name as class_name, s.name as subject_name
      FROM exam_slots es
      LEFT JOIN classes c ON es.class_id = c.id
      LEFT JOIN subjects s ON es.subject_id = s.id
      WHERE es.exam_master_id = $1
      ORDER BY es.day_number ASC, es.slot_number ASC, es.class_id ASC
    `;
    const res = await query(sql, [examMasterId]);
    return res.rows;
  },

  /**
   * 考査コマ・科目時間割スロットの一括保存
   * @param {string} examMasterId
   * @param {Array<Object>} slots - [{ day_number, slot_number, class_id, subject_id, subject_name, subject_teacher_id }]
   */
  async saveExamSlots(examMasterId, slots) {
    mockExamSlots.set(examMasterId, slots.map(s => ({ ...s, exam_master_id: examMasterId })));

    await query(`DELETE FROM exam_slots WHERE exam_master_id = $1`, [examMasterId]);

    for (const slot of slots) {
      const sql = `
        INSERT INTO exam_slots (exam_master_id, day_number, slot_number, class_id, subject_id, subject_teacher_id)
        VALUES ($1, $2, $3, $4, $5, $6)
      `;
      await query(sql, [
        examMasterId,
        slot.day_number,
        slot.slot_number,
        slot.class_id,
        slot.subject_id || null,
        slot.subject_teacher_id || null
      ]);
    }

    return slots;
  },

  /**
   * 試験監督割当データの取得
   * @param {string} examMasterId
   */
  async getProctorAssignments(examMasterId) {
    if (mockProctorAssignments.has(examMasterId)) return mockProctorAssignments.get(examMasterId);

    const sql = `
      SELECT pa.*, u.name as proctor_teacher_name
      FROM exam_proctor_assignments pa
      LEFT JOIN users u ON pa.proctor_teacher_id = u.id
      WHERE pa.exam_master_id = $1
      ORDER BY pa.day_number ASC, pa.slot_number ASC, pa.class_id ASC
    `;
    const res = await query(sql, [examMasterId]);
    return res.rows;
  },

  /**
   * 試験監督割当の一括保存 (自動最適化アルゴリズム結果の保存)
   * @param {string} examMasterId
   * @param {Array<Object>} assignments - [{ day_number, slot_number, class_id, proctor_teacher_id }]
   */
  async saveProctorAssignments(examMasterId, assignments) {
    mockProctorAssignments.set(examMasterId, assignments.map(a => ({ ...a, exam_master_id: examMasterId })));

    await query(`DELETE FROM exam_proctor_assignments WHERE exam_master_id = $1`, [examMasterId]);

    for (const item of assignments) {
      const sql = `
        INSERT INTO exam_proctor_assignments (exam_master_id, day_number, slot_number, class_id, proctor_teacher_id)
        VALUES ($1, $2, $3, $4, $5)
      `;
      await query(sql, [
        examMasterId,
        item.day_number,
        item.slot_number,
        item.class_id,
        item.proctor_teacher_id
      ]);
    }

    return assignments;
  },

  /**
   * 単一コマの監督手動変更
   * @param {string} examMasterId
   * @param {number} dayNumber
   * @param {number} slotNumber
   * @param {string} classId
   * @param {string} teacherId
   */
  async updateSingleProctor(examMasterId, dayNumber, slotNumber, classId, teacherId) {
    let list = mockProctorAssignments.get(examMasterId) || [];
    const idx = list.findIndex(a => a.day_number === dayNumber && a.slot_number === slotNumber && a.class_id === classId);

    if (idx >= 0) {
      list[idx].proctor_teacher_id = teacherId;
    } else {
      list.push({ exam_master_id: examMasterId, day_number: dayNumber, slot_number: slotNumber, class_id: classId, proctor_teacher_id: teacherId });
    }
    mockProctorAssignments.set(examMasterId, list);

    const sql = `
      INSERT INTO exam_proctor_assignments (exam_master_id, day_number, slot_number, class_id, proctor_teacher_id)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (exam_master_id, day_number, slot_number, class_id)
      DO UPDATE SET proctor_teacher_id = EXCLUDED.proctor_teacher_id
    `;
    await query(sql, [examMasterId, dayNumber, slotNumber, classId, teacherId]);
  },

  /**
   * 監督除外・配慮教員一覧の取得
   * @param {string} examMasterId
   */
  async getTeacherExemptions(examMasterId) {
    if (mockTeacherExemptions.has(examMasterId)) return mockTeacherExemptions.get(examMasterId);

    const sql = `
      SELECT te.*, u.name as teacher_name
      FROM exam_teacher_exemptions te
      JOIN users u ON te.teacher_id = u.id
      WHERE te.exam_master_id = $1
    `;
    const res = await query(sql, [examMasterId]);
    return res.rows;
  },

  /**
   * 考査マトリクス統合表示用データの生成 (日・コマ・クラスごとの科目と監督教員の統合データ)
   * @param {string} examMasterId
   */
  async getExamMatrix(examMasterId) {
    const slots = await this.getExamSlots(examMasterId);
    const proctors = await this.getProctorAssignments(examMasterId);

    const proctorMap = new Map();
    for (const p of proctors) {
      const key = `${p.day_number}_${p.slot_number}_${p.class_id}`;
      proctorMap.set(key, p);
    }

    const matrix = slots.map(s => {
      const key = `${s.day_number}_${s.slot_number}_${s.class_id}`;
      const p = proctorMap.get(key);
      return {
        ...s,
        proctor_teacher_id: p ? p.proctor_teacher_id : null,
        proctor_teacher_name: p ? p.proctor_teacher_name : null
      };
    });

    return matrix;
  }
};

export default examModel;