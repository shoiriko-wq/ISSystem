/**
 * ISSystem Periodic Exam Data Access Model
 * 定期考査（考査登録・実施科目/出題者調査・時間割・教室割・出張登録・監督割）の実テーブルデータ操作
 * PostgreSQL 準拠（config/database.js の共有プール利用）
 */

import { query } from '../../config/database.js';
import { parseJson } from '../utils/db.js';

const PHASE_KEYS = ['subject_phase', 'timetable_phase', 'room_phase', 'trip_phase', 'proctor_phase'];

function safeJson(value, fallback) {
  return parseJson(value, fallback);
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
}

let phaseHistoryReady = false;

export const examModel = {
  // ==========================================================
  // 考査マスター
  // ==========================================================
  async listExamMasters() {
    const res = await query(
      `SELECT * FROM exam_masters WHERE is_active = true ORDER BY start_date DESC`
    );
    return res.rows.map((r) => ({ ...r, grades: safeJson(r.grades, [1, 2, 3]), period_times: safeJson(r.period_times, []) }));
  },

  async findExamMasterById(id) {
    const res = await query(`SELECT * FROM exam_masters WHERE id = ?`, [id]);
    const row = res.rows[0];
    if (!row) return null;
    return { ...row, grades: safeJson(row.grades, [1, 2, 3]), period_times: safeJson(row.period_times, []) };
  },

  async createExamMaster(data) {
    const id = data.id || genId('exam');
    const res = await query(
      `INSERT INTO exam_masters (id, title, start_date, end_date, days_count, daily_slots, is_active, grades, period_times, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, true, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        id,
        data.title,
        data.start_date,
        data.end_date,
        Number(data.days_count) || 3,
        Number(data.daily_slots) || 3,
        JSON.stringify(data.grades || [1, 2, 3]),
        JSON.stringify(data.period_times || []),
        data.created_by || null,
      ]
    );
    await examModel.ensurePhaseRow(id, data.created_by);
    const row = res.rows[0];
    return { ...row, grades: safeJson(row.grades, [1, 2, 3]), period_times: safeJson(row.period_times, []) };
  },

  async updateExamMaster(id, data) {
    const sets = [];
    const params = [];
    const map = {
      title: 'title',
      start_date: 'start_date',
      end_date: 'end_date',
      days_count: 'days_count',
      daily_slots: 'daily_slots',
      is_active: 'is_active',
    };
    for (const [key, col] of Object.entries(map)) {
      if (data[key] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(data[key]);
      }
    }
    if (data.grades !== undefined) {
      sets.push('grades = ?');
      params.push(JSON.stringify(data.grades));
    }
    if (data.period_times !== undefined) {
      sets.push('period_times = ?');
      params.push(JSON.stringify(data.period_times));
    }
    if (sets.length === 0) return examModel.findExamMasterById(id);

    params.push(id);
    const res = await query(
      `UPDATE exam_masters SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *`,
      params
    );
    const row = res.rows[0];
    return row ? { ...row, grades: safeJson(row.grades, [1, 2, 3]), period_times: safeJson(row.period_times, []) } : null;
  },

  async deactivateExamMaster(id) {
    await query(`UPDATE exam_masters SET is_active = false, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [id]);
    return true;
  },

  // ==========================================================
  // フェーズ（調査/公表状態）
  // ==========================================================
  async ensurePhaseRow(examMasterId, updatedBy = null) {
    await query(
      `INSERT INTO exam_phases (exam_master_id, subject_phase, timetable_phase, room_phase, trip_phase, proctor_phase, updated_by, updated_at)
       VALUES (?, 'DRAFT', 'DRAFT', 'DRAFT', 'DRAFT', 'DRAFT', ?, CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id) DO NOTHING`,
      [examMasterId, updatedBy]
    );
  },

  async getPhases(examMasterId) {
    const res = await query(`SELECT * FROM exam_phases WHERE exam_master_id = ?`, [examMasterId]);
    const row = res.rows[0];
    if (!row) {
      const base = { exam_master_id: examMasterId };
      for (const k of PHASE_KEYS) base[k] = 'DRAFT';
      return base;
    }
    return row;
  },

  async setPhase(examMasterId, phaseKey, value, updatedBy) {
    if (!PHASE_KEYS.includes(phaseKey)) {
      throw new Error(`不正なフェーズキーです: ${phaseKey}`);
    }
    await examModel.ensurePhaseRow(examMasterId, updatedBy);
    const res = await query(
      `UPDATE exam_phases SET ${phaseKey} = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE exam_master_id = ? RETURNING *`,
      [value, updatedBy, examMasterId]
    );
    return res.rows[0];
  },

  /** フェーズ変更履歴の記録（exam_phase_history / 存在しなければ惰性作成、失敗は無視） */
  async logPhaseChange(examMasterId, phaseKey, fromValue, toValue, userId) {
    try {
      if (!phaseHistoryReady) {
        await query(
          `CREATE TABLE IF NOT EXISTS exam_phase_history (
            id SERIAL PRIMARY KEY,
            exam_master_id TEXT NOT NULL,
            phase_key TEXT NOT NULL,
            from_value TEXT,
            to_value TEXT,
            changed_by TEXT,
            changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
          )`
        );
        phaseHistoryReady = true;
      }
      await query(
        `INSERT INTO exam_phase_history (exam_master_id, phase_key, from_value, to_value, changed_by, changed_at)
         VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [examMasterId, phaseKey, fromValue ?? null, toValue ?? null, userId ?? null]
      );
    } catch (error) {
      console.warn('[ExamModel] logPhaseChange skipped:', error.message);
    }
    return true;
  },

  // ==========================================================
  // 実施科目・出題者プラン (exam_subject_plan)
  // ==========================================================
  async listSubjectPlan(examMasterId) {
    const res = await query(
      `SELECT sp.*, u1.name AS setter_teacher_name
       FROM exam_subject_plan sp
       LEFT JOIN users u1 ON sp.setter_teacher_id = u1.id
       WHERE sp.exam_master_id = ?
       ORDER BY sp.grade ASC, sp.subject_name ASC`,
      [examMasterId]
    );
    return res.rows;
  },

  async upsertSubjectPlanRow(row) {
    const id = row.id || genId('sp');
    const res = await query(
      `INSERT INTO exam_subject_plan
        (id, exam_master_id, subject_name, subject_id, grade, stream, scope, setter_teacher_id,
         duration_slots, fixed_slot, shared_slot, broadcast_slot, solo_subject, notes,
         submit_status, student_count, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, subject_name, grade) DO UPDATE SET
         subject_id = EXCLUDED.subject_id,
         stream = EXCLUDED.stream,
         scope = EXCLUDED.scope,
         setter_teacher_id = EXCLUDED.setter_teacher_id,
         duration_slots = EXCLUDED.duration_slots,
         fixed_slot = EXCLUDED.fixed_slot,
         shared_slot = EXCLUDED.shared_slot,
         broadcast_slot = EXCLUDED.broadcast_slot,
         solo_subject = EXCLUDED.solo_subject,
         notes = EXCLUDED.notes,
         submit_status = EXCLUDED.submit_status,
         student_count = EXCLUDED.student_count,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        id,
        row.exam_master_id,
        row.subject_name,
        row.subject_id || null,
        Number(row.grade) || 0,
        row.stream || 'OTHER',
        row.scope || 'GRADE',
        row.setter_teacher_id || null,
        Number(row.duration_slots) || 1,
        row.fixed_slot ? Number(row.fixed_slot) : null,
        !!row.shared_slot,
        !!row.broadcast_slot,
        !!row.solo_subject,
        row.notes || null,
        row.submit_status || 'PENDING',
        row.student_count ? Number(row.student_count) : null,
        row.updated_by || null,
      ]
    );
    return res.rows[0];
  },

  async deleteSubjectPlan(id) {
    await query(`DELETE FROM exam_subject_plan WHERE id = ?`, [id]);
    return true;
  },

  async bulkInsertSubjectPlan(examMasterId, rows, updatedBy) {
    await query(`DELETE FROM exam_subject_plan WHERE exam_master_id = ?`, [examMasterId]);
    const created = [];
    for (const r of rows) {
      created.push(await examModel.upsertSubjectPlanRow({ ...r, exam_master_id: examMasterId, updated_by: updatedBy }));
    }
    return created;
  },

  // ==========================================================
  // 出張・欠席コマ登録 (exam_trips)
  // ==========================================================
  async listTrips(examMasterId) {
    const res = await query(
      `SELECT t.*, u.name AS teacher_name
       FROM exam_trips t
       JOIN users u ON t.teacher_id = u.id
       WHERE t.exam_master_id = ?
       ORDER BY t.day_number ASC, t.slot_number ASC, u.name ASC`,
      [examMasterId]
    );
    return res.rows;
  },

  async upsertTrip(row) {
    const id = row.id || genId('trip');
    // 同一教員・同一コマの重複登録を防ぐ（uniqueキーに reason が含まれるため先に削除）
    await query(
      `DELETE FROM exam_trips WHERE exam_master_id = ? AND teacher_id = ? AND day_number = ? AND slot_number = ?`,
      [row.exam_master_id, row.teacher_id, Number(row.day_number), Number(row.slot_number)]
    );
    const res = await query(
      `INSERT INTO exam_trips (id, exam_master_id, teacher_id, day_number, slot_number, reason, from_absence, recorded_by, recorded_by_name, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        id,
        row.exam_master_id,
        row.teacher_id,
        Number(row.day_number),
        Number(row.slot_number),
        row.reason || '',
        !!row.from_absence,
        row.recorded_by || null,
        row.recorded_by_name || null,
      ]
    );
    return res.rows[0];
  },

  async deleteTrip(examMasterId, teacherId, dayNumber, slotNumber) {
    await query(
      `DELETE FROM exam_trips WHERE exam_master_id = ? AND teacher_id = ? AND day_number = ? AND slot_number = ?`,
      [examMasterId, teacherId, Number(dayNumber), Number(slotNumber)]
    );
    return true;
  },

  // ==========================================================
  // 制約ルール (exam_timetable_rules / exam_proctor_rules)
  // ==========================================================
  async getRulesTable(table, examMasterId, defaultRules) {
    const res = await query(`SELECT rules FROM ${table} WHERE exam_master_id = ?`, [examMasterId]);
    const row = res.rows[0];
    if (!row) return { ...defaultRules };
    return { ...defaultRules, ...safeJson(row.rules, {}) };
  },

  async saveRulesTable(table, examMasterId, rules, updatedBy) {
    await query(
      `INSERT INTO ${table} (exam_master_id, rules, updated_by, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id) DO UPDATE SET
         rules = EXCLUDED.rules,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [examMasterId, JSON.stringify(rules), updatedBy]
    );
    return true;
  },

  // ==========================================================
  // 時間割スロット (exam_slots)
  // ==========================================================
  async listSlots(examMasterId) {
    const res = await query(
      `SELECT es.*, u.name AS setter_teacher_name
       FROM exam_slots es
       LEFT JOIN users u ON es.subject_teacher_id = u.id
       WHERE es.exam_master_id = ?
       ORDER BY es.day_number ASC, es.slot_number ASC, es.grade ASC`,
      [examMasterId]
    );
    return res.rows;
  },

  async saveSlots(examMasterId, rows, updatedBy) {
    await query(`DELETE FROM exam_slots WHERE exam_master_id = ?`, [examMasterId]);
    const saved = [];
    for (const r of rows) {
      const res = await query(
        `INSERT INTO exam_slots (exam_master_id, unit_id, day_number, slot_number, class_id, grade, subject_id, subject_name, subject_teacher_id, setter_teacher_name, slot_span, duration_slots, room_type, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (exam_master_id, day_number, slot_number, class_id) DO UPDATE SET
           unit_id = EXCLUDED.unit_id,
           grade = EXCLUDED.grade,
           subject_id = EXCLUDED.subject_id,
           subject_name = EXCLUDED.subject_name,
           subject_teacher_id = EXCLUDED.subject_teacher_id,
           setter_teacher_name = EXCLUDED.setter_teacher_name,
           slot_span = EXCLUDED.slot_span,
           duration_slots = EXCLUDED.duration_slots,
           room_type = EXCLUDED.room_type,
           updated_by = EXCLUDED.updated_by,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [
          examMasterId,
          r.unit_id || null,
          Number(r.day_number),
          Number(r.slot_number),
          r.class_id,
          Number(r.grade) || 0,
          r.subject_id || null,
          r.subject_name || null,
          r.subject_teacher_id || null,
          r.setter_teacher_name || null,
          Number(r.slot_span) || 1,
          Number(r.duration_slots) || Number(r.slot_span) || 1,
          r.room_type || 'CLASS',
          updatedBy,
        ]
      );
      saved.push(res.rows[0]);
    }
    return saved;
  },


  // ==========================================================
  // 教室マスタ・科目別標準教室設定
  // ==========================================================
  async listRooms(examMasterId) {
    const res = await query(
      `SELECT * FROM exam_rooms WHERE exam_master_id = ? ORDER BY room_type ASC, name ASC`,
      [examMasterId]
    );
    return res.rows.map((r) => ({
      ...r,
      capacity: r.capacity ? Number(r.capacity) : null,
      grades: safeJson(r.grades, []),
      is_alternate: !!r.is_alternate,
    }));
  },

  async upsertRoom(row) {
    const id = row.id || genId('room');
    const res = await query(
      `INSERT INTO exam_rooms (id, exam_master_id, name, room_type, capacity, grades, is_alternate, notes, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, name) DO UPDATE SET
         room_type = EXCLUDED.room_type,
         capacity = EXCLUDED.capacity,
         grades = EXCLUDED.grades,
         is_alternate = EXCLUDED.is_alternate,
         notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        id,
        row.exam_master_id,
        row.name,
        row.room_type || 'CLASS',
        row.capacity ? Number(row.capacity) : null,
        JSON.stringify(row.grades || []),
        !!row.is_alternate,
        row.notes || null,
        row.updated_by || null,
      ]
    );
    const r = res.rows[0];
    return { ...r, capacity: r.capacity ? Number(r.capacity) : null, grades: safeJson(r.grades, []), is_alternate: !!r.is_alternate };
  },

  async saveRoomsBulk(examMasterId, rows, updatedBy) {
    const saved = [];
    for (const r of rows || []) {
      if (!r.name) continue;
      saved.push(
        await examModel.upsertRoom({
          ...r,
          exam_master_id: examMasterId,
          room_type: r.room_type || 'CLASS',
          capacity: Number(r.capacity) || null,
          grades: (r.grades || []).map(Number),
          updated_by: updatedBy,
        })
      );
    }
    return saved;
  },


  async deleteRoom(id) {
    await query(`DELETE FROM exam_rooms WHERE id = ?`, [id]);
    return true;
  },

  async listRoomConfig(examMasterId) {
    const res = await query(
      `SELECT * FROM exam_room_config WHERE exam_master_id = ? ORDER BY subject_name ASC, grade ASC`,
      [examMasterId]
    );
    return res.rows.map((r) => ({ ...r, alt_rooms: safeJson(r.alt_rooms, []) }));
  },

  async upsertRoomConfigRow(row) {
    const id = row.id || genId('rcfg');
    const res = await query(
      `INSERT INTO exam_room_config (id, exam_master_id, subject_name, grade, standard_room, alt_rooms, notes, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, subject_name, grade) DO UPDATE SET
         standard_room = EXCLUDED.standard_room,
         alt_rooms = EXCLUDED.alt_rooms,
         notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        id,
        row.exam_master_id,
        row.subject_name,
        Number(row.grade) || 0,
        row.standard_room || null,
        JSON.stringify(row.alt_rooms || []),
        row.notes || null,
        row.updated_by || null,
      ]
    );
    const r = res.rows[0];
    return { ...r, alt_rooms: safeJson(r.alt_rooms, []) };
  },

  async listRoomAssignments(examMasterId) {
    const res = await query(
      `SELECT * FROM exam_room_assignments WHERE exam_master_id = ?
       ORDER BY day_number ASC, slot_number ASC, grade ASC`,
      [examMasterId]
    );
    return res.rows;
  },

  async saveRoomAssignments(examMasterId, rows, updatedBy) {
    await query(`DELETE FROM exam_room_assignments WHERE exam_master_id = ?`, [examMasterId]);
    const saved = [];
    for (const r of rows) {
      const res = await query(
        `INSERT INTO exam_room_assignments
          (id, exam_master_id, unit_id, subject_name, grade, day_number, slot_number, room_id, room_name, is_standard, notes, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (exam_master_id, grade, day_number, slot_number) DO UPDATE SET
           unit_id = EXCLUDED.unit_id,
           subject_name = EXCLUDED.subject_name,
           room_id = EXCLUDED.room_id,
           room_name = EXCLUDED.room_name,
           is_standard = EXCLUDED.is_standard,
           notes = EXCLUDED.notes,
           updated_by = EXCLUDED.updated_by,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [
          r.id || genId('rasg'),
          examMasterId,
          r.unit_id || null,
          r.subject_name,
          Number(r.grade),
          Number(r.day_number),
          Number(r.slot_number),
          r.room_id || null,
          r.room_name,
          r.is_standard !== false,
          r.notes || null,
          updatedBy,
        ]
      );
      saved.push(res.rows[0]);
    }
    return saved;
  },

  // ==========================================================
  // 非常勤スタッフ・出勤可能コマ
  // ==========================================================
  async listParttimeStaff(examMasterId) {
    const res = await query(
      `SELECT ps.*, u.name AS staff_name
       FROM exam_parttime_staff ps
       JOIN users u ON ps.teacher_id = u.id
       WHERE ps.exam_master_id = ?
       ORDER BY u.name ASC`,
      [examMasterId]
    );
    return res.rows.map((r) => {
      const dailyLimit = Number(r.daily_limit) || 1;
      const maxConsecutive = Number(r.max_consecutive) || 1;
      const rule = r.consecutive_rule || 'MAX1';
      return {
        ...r,
        staff_id: r.teacher_id,
        daily_limit: dailyLimit,
        max_consecutive: maxConsecutive,
        consecutive_rule: rule,
        slot_condition: { max_slots_per_day: dailyLimit, max_consecutive_slots: maxConsecutive, consecutive_rule: rule },
      };
    });
  },

  async upsertParttimeStaff(row) {
    const teacherId = row.teacher_id || row.staff_id;
    const dailyLimit = Number(row.daily_limit ?? row.max_slots_per_day ?? row.slot_condition?.max_slots_per_day) || 1;
    const maxConsecutive = Number(row.max_consecutive ?? row.max_consecutive_slots ?? row.slot_condition?.max_consecutive_slots) || 1;
    const rule = row.consecutive_rule || row.slot_condition?.consecutive_rule || 'MAX1';
    const res = await query(
      `INSERT INTO exam_parttime_staff (exam_master_id, teacher_id, daily_limit, max_consecutive, consecutive_rule, notes, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, teacher_id) DO UPDATE SET
         daily_limit = EXCLUDED.daily_limit,
         max_consecutive = EXCLUDED.max_consecutive,
         consecutive_rule = EXCLUDED.consecutive_rule,
         notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [row.exam_master_id, teacherId, dailyLimit, maxConsecutive, rule, row.notes || null, row.updated_by || null]
    );
    const r = res.rows[0];
    return {
      ...r,
      staff_id: r.teacher_id,
      slot_condition: { max_slots_per_day: dailyLimit, max_consecutive_slots: maxConsecutive, consecutive_rule: rule },
    };
  },

  async deleteParttimeStaff(examMasterId, teacherId) {
    await query(`DELETE FROM exam_parttime_staff WHERE exam_master_id = ? AND teacher_id = ?`, [examMasterId, teacherId]);
    return true;
  },

  async listParttimeAvailability(examMasterId) {
    const res = await query(
      `SELECT pa.*, u.name AS staff_name
       FROM exam_parttime_availability pa
       JOIN users u ON pa.teacher_id = u.id
       WHERE pa.exam_master_id = ?
       ORDER BY u.name ASC, pa.day_number ASC, pa.slot_number ASC`,
      [examMasterId]
    );
    return res.rows.map((r) => ({ ...r, staff_id: r.teacher_id, available: r.can_work !== false }));
  },

  async setParttimeAvailability(examMasterId, teacherId, dayNumber, slotNumber, available, updatedBy) {
    await query(
      `INSERT INTO exam_parttime_availability (exam_master_id, teacher_id, day_number, slot_number, can_work, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, teacher_id, day_number, slot_number) DO UPDATE SET
         can_work = EXCLUDED.can_work,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP`,
      [examMasterId, teacherId, Number(dayNumber), Number(slotNumber), !!available, updatedBy]
    );
    return true;
  },

  // ==========================================================
  // 学年別実施人数（教室容量判定用。クラス数×25をデフォルト値とする）
  // ==========================================================
  async getGradeStudents(grades = [1, 2, 3]) {
    const nums = (grades || []).map((g) => Number(g));
    const res = await query(
      `SELECT grade, COUNT(*) AS cnt FROM classes WHERE grade = ANY(?) GROUP BY grade`,
      [nums]
    );
    const out = {};
    for (const r of res.rows) out[Number(r.grade)] = Number(r.cnt) * 25;
    return out;
  },


  // ==========================================================
  // 監督割当
  // ==========================================================
  async listProctorAssignments(examMasterId) {
    const res = await query(
      `SELECT pa.*, u.name AS proctor_name
       FROM exam_proctor_assignments pa
       LEFT JOIN users u ON pa.proctor_teacher_id = u.id
       WHERE pa.exam_master_id = ?
       ORDER BY pa.day_number ASC, pa.slot_number ASC, pa.grade ASC`,
      [examMasterId]
    );
    return res.rows;
  },

  async saveProctorAssignments(examMasterId, rows, updatedBy) {
    await query(`DELETE FROM exam_proctor_assignments WHERE exam_master_id = ?`, [examMasterId]);
    const saved = [];
    // (exam_master_id, day_number, slot_number, class_id) が重複する行は後ろの行を優先して insertion 前に正規化
    const dedupMap = new Map();
    for (const r of rows) {
      const dayNumber = Number(r.day_number);
      const slotNumber = Number(r.slot_number);
      const classId = r.class_id || `G${Number(r.grade)}`;
      dedupMap.set(`${dayNumber}|${slotNumber}|${classId}`, { ...r, day_number: dayNumber, slot_number: slotNumber, class_id: classId });
    }
    for (const r of dedupMap.values()) {
      const res = await query(
        `INSERT INTO exam_proctor_assignments
          (exam_master_id, day_number, slot_number, grade, class_id, subject_name, proctor_teacher_id,
           setter_teacher_id, setter_teacher_name, room_name, notes, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         RETURNING *`,
        [
          examMasterId,
          r.day_number,
          r.slot_number,
          Number(r.grade),
          r.class_id,
          r.subject_name || null,
          r.proctor_teacher_id || null,
          r.setter_teacher_id || null,
          r.setter_teacher_name || null,
          r.room_name || null,
          r.notes || null,
          updatedBy,
        ]
      );
      saved.push(res.rows[0]);
    }
    return saved;
  },

  async deleteProctorAssignment(id) {
    await query(`DELETE FROM exam_proctor_assignments WHERE id = ?`, [id]);
    return true;
  },

  // ==========================================================
  // 教員別コマ制限・監督免除
  // ==========================================================
  async listTeacherConstraints(examMasterId) {
    const res = await query(
      `SELECT tc.*, u.name AS teacher_name
       FROM exam_teacher_constraints tc
       JOIN users u ON tc.teacher_id = u.id
       WHERE tc.exam_master_id = ?
       ORDER BY u.name ASC`,
      [examMasterId]
    );
    return res.rows.map((r) => ({ ...r, constraint_type: safeJson(r.constraint_type, {}) }));
  },

  async upsertTeacherConstraint(row) {
    const id = row.id || genId('tc');
    const res = await query(
      `INSERT INTO exam_teacher_constraints (id, exam_master_id, teacher_id, constraint_type, notes, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, teacher_id) DO UPDATE SET
         constraint_type = EXCLUDED.constraint_type,
         notes = EXCLUDED.notes,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        id,
        row.exam_master_id,
        row.teacher_id,
        JSON.stringify(row.constraint_type || {}),
        row.notes || null,
        row.updated_by || null,
      ]
    );
    const r = res.rows[0];
    return { ...r, constraint_type: safeJson(r.constraint_type, {}) };
  },

  async listExemptions(examMasterId) {
    const res = await query(
      `SELECT te.*, u.name AS teacher_name
       FROM exam_teacher_exemptions te
       JOIN users u ON te.teacher_id = u.id
       WHERE te.exam_master_id = ?
       ORDER BY u.name ASC`,
      [examMasterId]
    );
    return res.rows;
  },

  async addExemption(row) {
    await query(
      `INSERT INTO exam_teacher_exemptions (exam_master_id, teacher_id, reason)
       VALUES (?, ?, ?)
       ON CONFLICT (exam_master_id, teacher_id) DO UPDATE SET
         reason = EXCLUDED.reason`,
      [row.exam_master_id, row.teacher_id, row.reason || '']
    );
    return true;
  },

  async removeExemption(examMasterId, teacherId) {
    await query(
      `DELETE FROM exam_teacher_exemptions WHERE exam_master_id = ? AND teacher_id = ?`,
      [examMasterId, teacherId]
    );
    return true;
  },

  // ==========================================================
  // 出欠（absence_records）・過去考査スロット・教員プール・クラス
  // ==========================================================
  async listAbsencesByDateRange(startDate, endDate) {
    const res = await query(
      `SELECT * FROM absence_records WHERE record_date BETWEEN ? AND ? ORDER BY record_date ASC`,
      [startDate, endDate]
    );
    return res.rows;
  },

  async fetchSlotHistory(limit = 200) {
    const res = await query(
      `SELECT es.day_number, es.slot_number, es.grade, es.subject_name, es.slot_span, em.title, em.start_date
       FROM exam_slots es
       JOIN exam_masters em ON es.exam_master_id = em.id
       WHERE em.is_active = false
       ORDER BY em.start_date DESC
       LIMIT ?`,
      [Number(limit) || 200]
    );
    return res.rows.map((r) => ({
      subject_name: r.subject_name,
      grade: r.grade,
      day_number: r.day_number,
      slot_number: r.slot_number,
      slot_span: r.slot_span,
      exam_title: r.title,
      exam_start: r.start_date,
    }));
  },

  async fetchStaffPool() {
    const res = await query(
      `SELECT id, name, staff_code, grade, role, is_parttime FROM users ORDER BY name ASC`
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      staff_code: r.staff_code,
      grade: Number(r.grade) || 0,
      role: r.role,
      is_parttime: !!r.is_parttime,
      is_kyomu: String(r.role).toUpperCase() === 'KYOMU' || String(r.role).toUpperCase() === 'ADMIN',
    }));
  },

  async fetchClasses(examMasterId) {
    const exam = await examModel.findExamMasterById(examMasterId);
    const grades = exam ? exam.grades : [1, 2, 3];
    const res = await query(
      `SELECT * FROM classes WHERE grade = ANY(?) ORDER BY grade ASC, class_num ASC`,
      [grades]
    );
    return res.rows;
  },
};

export default examModel;