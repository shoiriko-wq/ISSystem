/**
 * ISSystem Periodic Exam Data Access Model
 * 定期考査（考査登録・実施科目/出題者調査・時間割・教室割・出張登録・監督割）の実テーブルデータ操作
 * PostgreSQL 準拠（config/database.js の共有プール利用）
 */

import { query } from '../../config/database.js';
import { parseJson } from '../utils/db.js';
import { parseSubjectList } from './subject.model.js';
import { basicinfoModel } from './basicinfo.model.js';

const PHASE_KEYS = ['plan_phase', 'subject_phase', 'timetable_phase', 'room_phase', 'trip_phase', 'proctor_phase', 'decision_phase'];

function safeJson(value, fallback) {
  return parseJson(value, fallback);
}

/**
 * 実施科目の決定で比較する項目（デフォルト値との差分表示に使う）
 * subject_name / grade は UNIQUE キーなので変更対象から除外する。
 */
const DECISION_FIELDS = [
  'subject_short',
  'subject_id',
  'stream',
  'scope',
  'setter_teacher_id',
  'patrol_teacher_id',
  'duration_slots',
  'duration_minutes',
  'fixed_slot',
  'shared_slot',
  'broadcast_slot',
  'solo_subject',
  'class_ids',
  'room_id',
  'room_name',
  'request_note',
];

/** 比較用の正規化（数値・真偽・配列を canonical な形へ） */
function canonicalValue(field, value) {
  if (field === 'class_ids') return [...(value || [])].map(String).sort().join(',');
  if (['shared_slot', 'broadcast_slot', 'solo_subject'].includes(field)) return String(!!value);
  if (['duration_slots', 'duration_minutes', 'fixed_slot'].includes(field)) {
    return value == null || value === '' ? '' : String(Number(value) || 0);
  }
  return value == null ? '' : String(value);
}

/** 決定行からデフォルト値スナップショットを作る */
function decisionSnapshot(row) {
  const snap = {};
  for (const f of DECISION_FIELDS) snap[f] = row[f];
  snap.subject_name = String(row.subject_name || '').trim();
  snap.grade = Number(row.grade) || 0;
  return snap;
}

/** スナップショットの JSON（default_json） */
function snapshotJson(row) {
  return JSON.stringify(decisionSnapshot(row));
}

/** 決定行とデフォルト値の差分項目を列挙する */
function changedFieldsOf(row, defaults) {
  const base = defaults || {};
  const out = [];
  for (const f of DECISION_FIELDS) {
    if (canonicalValue(f, row[f]) !== canonicalValue(f, base[f])) out.push(f);
  }
  return out;
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
}

/**
 * exam_slots / exam_proctor_assignments の class_id をクラスマスタの ID に正規化する。
 * 外部キーは classes(id) を参照するが、UI・ソルバーは学年単位の "G<grade>" を渡すため、
 * クラスマスタに存在しない値は対象学年のクラス ID（複数クラスは最初のクラス）へ読み替える。
 * 解決できない行（該当学年のクラスが未登録）は除外する。
 * @param {Array<object>} rows class_id / grade を持つ行
 * @returns {Promise<Array<object>>} 正規化された行
 */
async function normalizeClassIds(rows) {
  const res = await query(`SELECT id, grade FROM classes ORDER BY grade ASC, id ASC`);
  const known = new Set(res.rows.map((c) => c.id));
  const firstByGrade = new Map();
  for (const c of res.rows) {
    const g = Number(c.grade);
    if (!firstByGrade.has(g)) firstByGrade.set(g, c.id);
  }
  const out = [];
  for (const r of rows) {
    const grade = Number(r.grade) || 0;
    const cid = r.class_id;
    if (cid && known.has(cid)) {
      out.push({ ...r, class_id: cid });
    } else if (firstByGrade.has(grade)) {
      out.push({ ...r, class_id: firstByGrade.get(grade) });
    }
  }
  return out;
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
    return res.rows.map((r) => ({
      ...r,
      grades: safeJson(r.grades, [1, 2, 3]),
      period_times: safeJson(r.period_times, []),
      schedule_cells: safeJson(r.schedule_cells, []),
    }));
  },

  async findExamMasterById(id) {
    const res = await query(`SELECT * FROM exam_masters WHERE id = ?`, [id]);
    const row = res.rows[0];
    if (!row) return null;
    return {
      ...row,
      grades: safeJson(row.grades, [1, 2, 3]),
      period_times: safeJson(row.period_times, []),
      schedule_cells: safeJson(row.schedule_cells, []),
    };
  },

  async createExamMaster(data) {
    const id = data.id || genId('exam');
    const res = await query(
      `INSERT INTO exam_masters (id, title, start_date, end_date, days_count, daily_slots, is_active, grades, period_times, schedule_cells, notes, academic_year, default_duration, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, true, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        id,
        data.title,
        data.start_date ?? null,
        data.end_date ?? null,
        Number(data.days_count) || 0,
        Number(data.daily_slots) || 0,
        JSON.stringify(data.grades || [1, 2, 3]),
        JSON.stringify(data.period_times || []),
        JSON.stringify(data.schedule_cells || []),
        data.notes ?? null,
        data.academic_year ? Number(data.academic_year) : null,
        Number(data.default_duration) || 50,
        data.created_by || null,
      ]
    );
    await examModel.ensurePhaseRow(id, data.created_by);
    const row = res.rows[0];
    return {
      ...row,
      grades: safeJson(row.grades, [1, 2, 3]),
      period_times: safeJson(row.period_times, []),
      schedule_cells: safeJson(row.schedule_cells, []),
    };
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
      academic_year: 'academic_year',
      default_duration: 'default_duration',
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
    if (data.schedule_cells !== undefined) {
      sets.push('schedule_cells = ?');
      params.push(JSON.stringify(data.schedule_cells || []));
    }
    if (data.notes !== undefined) {
      sets.push('notes = ?');
      params.push(data.notes ?? null);
    }
    if (data.updated_by !== undefined) {
      sets.push('updated_by = ?');
      params.push(data.updated_by ?? null);
    }
    if (sets.length === 0) return examModel.findExamMasterById(id);

    params.push(id);
    const res = await query(
      `UPDATE exam_masters SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *`,
      params
    );
    const row = res.rows[0];
    return row
      ? { ...row, grades: safeJson(row.grades, [1, 2, 3]), period_times: safeJson(row.period_times, []), schedule_cells: safeJson(row.schedule_cells, []) }
      : null;
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
      `INSERT INTO exam_phases (exam_master_id, plan_phase, subject_phase, decision_phase, timetable_phase, room_phase, trip_phase, proctor_phase, updated_by, updated_at)
       VALUES (?, 'DRAFT', 'DRAFT', 'DRAFT', 'DRAFT', 'DRAFT', 'DRAFT', 'DRAFT', ?, CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id) DO UPDATE SET plan_phase = COALESCE(exam_phases.plan_phase, 'DRAFT')`,
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
    for (const k of PHASE_KEYS) row[k] = row[k] || 'DRAFT';
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
      `SELECT sp.*, u1.name AS setter_teacher_name, u2.name AS patrol_teacher_name
       FROM exam_subject_plan sp
       LEFT JOIN users u1 ON sp.setter_teacher_id = u1.id
       LEFT JOIN users u2 ON sp.patrol_teacher_id = u2.id
       WHERE sp.exam_master_id = ?
       ORDER BY sp.grade ASC, sp.subject_name ASC`,
      [examMasterId]
    );
    return res.rows.map((r) => ({
      ...r,
      courses: safeJson(r.courses, []),
      class_ids: safeJson(r.class_ids, []),
      duration_minutes: Number(r.duration_minutes) || 50,
      decision_status: r.decision_status || 'PENDING',
    }));
  },

  async upsertSubjectPlanRow(row) {
    const id = row.id || genId('sp');
    const res = await query(
      `INSERT INTO exam_subject_plan
        (id, exam_master_id, subject_name, subject_short, subject_id, grade, stream, scope, setter_teacher_id,
         duration_slots, duration_minutes, fixed_slot, shared_slot, broadcast_slot, solo_subject,
         patrol_teacher_id, courses, class_ids, room_id, room_name, request_note,
         notes, submit_status, decision_status, surveyed_by, surveyed_at, confirmed_by, confirmed_at,
         student_count, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (exam_master_id, subject_name, grade) DO UPDATE SET
         subject_short = EXCLUDED.subject_short,
         subject_id = EXCLUDED.subject_id,
         stream = EXCLUDED.stream,
         scope = EXCLUDED.scope,
         setter_teacher_id = EXCLUDED.setter_teacher_id,
         duration_slots = EXCLUDED.duration_slots,
         duration_minutes = EXCLUDED.duration_minutes,
         fixed_slot = EXCLUDED.fixed_slot,
         shared_slot = EXCLUDED.shared_slot,
         broadcast_slot = EXCLUDED.broadcast_slot,
         solo_subject = EXCLUDED.solo_subject,
         patrol_teacher_id = EXCLUDED.patrol_teacher_id,
         courses = EXCLUDED.courses,
         class_ids = EXCLUDED.class_ids,
         room_id = EXCLUDED.room_id,
         room_name = EXCLUDED.room_name,
         request_note = EXCLUDED.request_note,
         notes = EXCLUDED.notes,
         submit_status = EXCLUDED.submit_status,
         decision_status = EXCLUDED.decision_status,
         surveyed_by = EXCLUDED.surveyed_by,
         surveyed_at = EXCLUDED.surveyed_at,
         confirmed_by = EXCLUDED.confirmed_by,
         confirmed_at = EXCLUDED.confirmed_at,
         student_count = EXCLUDED.student_count,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        id,
        row.exam_master_id,
        row.subject_name,
        row.subject_short || row.subject_name,
        row.subject_id || null,
        Number(row.grade) || 0,
        row.stream || 'OTHER',
        row.scope || 'GRADE',
        row.setter_teacher_id || null,
        Number(row.duration_slots) || 1,
        Number(row.duration_minutes) || 50,
        row.fixed_slot ? Number(row.fixed_slot) : null,
        !!row.shared_slot,
        !!row.broadcast_slot,
        !!row.solo_subject,
        row.patrol_teacher_id || null,
        JSON.stringify((row.courses || []).map(String)),
        JSON.stringify((row.class_ids || []).map(String)),
        row.room_id || null,
        row.room_name || null,
        row.request_note || null,
        row.notes || null,
        row.submit_status || 'PENDING',
        row.decision_status || 'PENDING',
        row.surveyed_by || null,
        row.surveyed_at || null,
        row.confirmed_by || null,
        row.confirmed_at || null,
        row.student_count ? Number(row.student_count) : null,
        row.updated_by || null,
      ]
    );
    const savedRow = res.rows[0];
    return { ...savedRow, courses: safeJson(savedRow.courses, []), class_ids: safeJson(savedRow.class_ids, []) };
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
  // 実施科目の決定 (exam_subject_decisions) ※ 実施科目調査（計画）とは完全に別データ
  // 調査行をデフォルト値として複製し、default_json に調査時の値を保存する。
  // 決定行を編集した後も default_json から「デフォルト値（計画値）」を表示できる。
  // 時間割・教室割・監督割・公表ビューは conductSubjects() の行を正式データとして使う。
  // ==========================================================

  /** 決定行を UI 用の形へ装飾する（defaults と changed を付与） */
  decorateDecisionRow(r) {
    const courses = safeJson(r.courses, []);
    const classIds = safeJson(r.class_ids, []);
    const defaults = safeJson(r.default_json, {});
    const merged = { ...r, courses, class_ids: classIds };
    return {
      ...merged,
      defaults,
      changed_fields: safeJson(r.changed_fields, []),
      changed: changedFieldsOf(merged, defaults),
      duration_minutes: Number(r.duration_minutes) || 50,
      duration_slots: Number(r.duration_slots) || 1,
      submit_status: r.submit_status || 'PENDING',
      decision_status: r.decision_status || 'PENDING',
    };
  },

  async findSubjectDecisionById(id) {
    const res = await query(`SELECT * FROM exam_subject_decisions WHERE id = ?`, [id]);
    const row = res.rows[0];
    return row ? examModel.decorateDecisionRow(row) : null;
  },

  async listSubjectDecisions(examMasterId) {
    const res = await query(
      `SELECT d.*, u1.name AS setter_teacher_name, u2.name AS patrol_teacher_name,
              sp.subject_name AS plan_subject_name, sp.duration_minutes AS plan_duration_minutes
       FROM exam_subject_decisions d
       LEFT JOIN users u1 ON d.setter_teacher_id = u1.id
       LEFT JOIN users u2 ON d.patrol_teacher_id = u2.id
       LEFT JOIN exam_subject_plan sp ON d.source_plan_id = sp.id
       WHERE d.exam_master_id = ?
       ORDER BY d.grade ASC, d.subject_name ASC`,
      [examMasterId]
    );
    return res.rows.map((r) => examModel.decorateDecisionRow(r));
  },

  async upsertSubjectDecisionRow(row) {
    const id = row.id || genId('dec');
    // デフォルト値（調査データのスナップショット default_json）は引き継ぎ、編集値との差分 changed_fields を自動算出する
    // ※ 決定行を編集した後も default_json から「計画値（デフォルト値）」を表示できる
    const prevDecision = row.changed_fields ? null : await examModel.findSubjectDecisionById(id);
    // デフォルト値が未設定の新しい決定行（教務が追加した行など）は自分自身の値をデフォルト値として保存する
    const defaultsJson =
      row.default_json || (prevDecision ? prevDecision.default_json : null) || snapshotJson({ ...row, class_ids: (row.class_ids || []).map(String) });
    const defaults = safeJson(defaultsJson, {});
    const changedJson = JSON.stringify(changedFieldsOf({ ...row, class_ids: (row.class_ids || []).map(String) }, defaults));
    const params = [
      id,
      row.exam_master_id,
      row.source_plan_id || null,
      String(row.subject_name || '').trim(),
      row.subject_short || row.subject_name,
      row.subject_id || null,
      Number(row.grade) || 0,
      row.stream || 'OTHER',
      row.scope || 'GRADE',
      row.setter_teacher_id || null,
      row.patrol_teacher_id || null,
      Number(row.duration_slots) || 1,
      Number(row.duration_minutes) || 50,
      row.fixed_slot ? Number(row.fixed_slot) : null,
      !!row.shared_slot,
      !!row.broadcast_slot,
      !!row.solo_subject,
      JSON.stringify((row.courses || []).map(String)),
      JSON.stringify((row.class_ids || []).map(String)),
      row.room_id || null,
      row.room_name || null,
      row.request_note || null,
      row.notes || null,
      row.student_count ? Number(row.student_count) : null,
      row.submit_status || 'PENDING',
      row.decision_status || 'PENDING',
      defaultsJson,
      changedJson,
      row.surveyed_by || null,
      row.surveyed_at || null,
      row.confirmed_by || null,
      row.confirmed_at || null,
      row.updated_by || null,
    ];
    const existing = await examModel.findSubjectDecisionById(id);
    const res = existing
      ? await query(
          `UPDATE exam_subject_decisions SET
             exam_master_id = ?, source_plan_id = COALESCE(?, source_plan_id),
             subject_name = ?, subject_short = ?, subject_id = ?, grade = ?, stream = ?, scope = ?,
             setter_teacher_id = ?, patrol_teacher_id = ?, duration_slots = ?, duration_minutes = ?,
             fixed_slot = ?, shared_slot = ?, broadcast_slot = ?, solo_subject = ?,
             courses = ?, class_ids = ?, room_id = ?, room_name = ?, request_note = ?, notes = ?,
             student_count = ?, submit_status = ?, decision_status = ?,
             default_json = COALESCE(?, default_json), changed_fields = ?,
             surveyed_by = ?, surveyed_at = ?, confirmed_by = ?, confirmed_at = ?,
             updated_by = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? RETURNING *`,
          [...params.slice(1), id]
        )
      : await query(
          `INSERT INTO exam_subject_decisions
            (id, exam_master_id, source_plan_id, subject_name, subject_short, subject_id, grade, stream, scope,
             setter_teacher_id, patrol_teacher_id, duration_slots, duration_minutes, fixed_slot,
             shared_slot, broadcast_slot, solo_subject, courses, class_ids, room_id, room_name, request_note,
             notes, student_count, submit_status, decision_status, default_json, changed_fields,
             surveyed_by, surveyed_at, confirmed_by, confirmed_at, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           ON CONFLICT (exam_master_id, subject_name, grade) DO UPDATE SET
             subject_short = EXCLUDED.subject_short,
             subject_id = EXCLUDED.subject_id,
             stream = EXCLUDED.stream,
             scope = EXCLUDED.scope,
             setter_teacher_id = EXCLUDED.setter_teacher_id,
             patrol_teacher_id = EXCLUDED.patrol_teacher_id,
             duration_slots = EXCLUDED.duration_slots,
             duration_minutes = EXCLUDED.duration_minutes,
             fixed_slot = EXCLUDED.fixed_slot,
             shared_slot = EXCLUDED.shared_slot,
             broadcast_slot = EXCLUDED.broadcast_slot,
             solo_subject = EXCLUDED.solo_subject,
             courses = EXCLUDED.courses,
             class_ids = EXCLUDED.class_ids,
             room_id = EXCLUDED.room_id,
             room_name = EXCLUDED.room_name,
             request_note = EXCLUDED.request_note,
             notes = EXCLUDED.notes,
             student_count = EXCLUDED.student_count,
             submit_status = EXCLUDED.submit_status,
             decision_status = EXCLUDED.decision_status,
             default_json = COALESCE(EXCLUDED.default_json, exam_subject_decisions.default_json),
             changed_fields = EXCLUDED.changed_fields,
             surveyed_by = EXCLUDED.surveyed_by,
             surveyed_at = EXCLUDED.surveyed_at,
             confirmed_by = EXCLUDED.confirmed_by,
             confirmed_at = EXCLUDED.confirmed_at,
             updated_by = EXCLUDED.updated_by,
             updated_at = CURRENT_TIMESTAMP
           RETURNING *`,
          params
        );
    const saved = res.rows[0];
    return saved ? examModel.decorateDecisionRow(saved) : null;
  },

  async deleteSubjectDecision(id) {
    await query(`DELETE FROM exam_subject_decisions WHERE id = ?`, [id]);
    return true;
  },

  /**
   * 実施科目調査（exam_subject_plan）のデータを決定へ取り込む。
   * デフォルト値（default_json）は調査の最新値で更新し、決定行の編集値は維持する。
   * 決定行の ID は調査行の ID を共有する（時間割スロットの unit_id 参照を保つ）。
   */
  async seedSubjectDecisionsFromPlan(examMasterId, updatedBy) {
    const plan = await examModel.listSubjectPlan(examMasterId);
    const existing = await examModel.listSubjectDecisions(examMasterId);
    const bySource = new Map(existing.map((r) => [String(r.source_plan_id), r]));
    const byKey = new Map(
      existing.map((r) => [`${String(r.subject_name).toLowerCase()}#${Number(r.grade)}`, r])
    );
    let added = 0;
    let refreshed = 0;
    for (const p of plan) {
      const snap = decisionSnapshot(p);
      const json = JSON.stringify(snap);
      const key = `${String(p.subject_name).toLowerCase()}#${Number(p.grade)}`;
      const prev = bySource.get(String(p.id)) || byKey.get(key) || null;
      const base = prev ? { ...prev } : { ...p };
      const row = {
        ...base,
        id: prev ? prev.id : p.id,
        exam_master_id: examMasterId,
        source_plan_id: p.id,
        subject_name: prev ? prev.subject_name : p.subject_name,
        grade: prev ? Number(prev.grade) || 0 : Number(p.grade) || 0,
        default_json: json,
        changed_fields: changedFieldsOf({ ...base, class_ids: safeJson(base.class_ids, []) }, snap),
        updated_by: updatedBy,
      };
      await examModel.upsertSubjectDecisionRow(row);
      if (prev) refreshed += 1;
      else added += 1;
    }
    return { total: plan.length, added, refreshed };
  },

  /** 決定行をデフォルト値（調査データ）へ戻す */
  async resetSubjectDecisionToDefault(id, updatedBy) {
    const row = await examModel.findSubjectDecisionById(id);
    if (!row) return null;
    const defaults = row.defaults || {};
    const merged = {
      ...row,
      ...defaults,
      courses: defaults.courses || row.courses,
      class_ids: defaults.class_ids || row.class_ids,
    };
    return examModel.upsertSubjectDecisionRow({
      ...merged,
      default_json: JSON.stringify(decisionSnapshot(merged)),
      changed_fields: [],
      updated_by: updatedBy,
    });
  },

  /** 考査実施に使う実施科目データ（決定があれば決定、無ければ調査プラン） */
  async conductSubjects(examMasterId) {
    const decisions = await examModel.listSubjectDecisions(examMasterId);
    if (decisions.length > 0) return decisions;
    return examModel.listSubjectPlan(examMasterId);
  },

  /** 実施科目の決定サマリ（変更件数・提出・確定・学年別） */
  async subjectDecisionSummary(examMasterId, master) {
    const decisions = await examModel.listSubjectDecisions(examMasterId);
    const plan = await examModel.listSubjectPlan(examMasterId);
    const grades = (master?.grades || []).map(Number);
    const shared = decisions.filter((d) => Number(d.grade) === 0);
    const perGrade = grades.map((g) => {
      const rows = decisions.filter((d) => Number(d.grade) === g).concat(shared);
      return {
        grade: g,
        subjects: rows.length,
        changed: rows.filter((d) => (d.changed || []).length > 0).length,
        submitted: rows.filter((d) => d.submit_status === 'SUBMITTED').length,
        requests: rows.filter((d) => d.request_note).length,
      };
    });
    return {
      total: decisions.length,
      plan_total: plan.length,
      changed: decisions.filter((d) => (d.changed || []).length > 0).length,
      submitted: decisions.filter((d) => d.submit_status === 'SUBMITTED').length,
      confirmed: decisions.filter((d) => d.decision_status === 'CONFIRMED').length,
      requests: decisions.filter((d) => d.request_note).length,
      per_grade: perGrade,
    };
  },

  /** 年度中の全考査名の調査入力状況（② 実施科目調査は考査名ごとに記入するため一覧化する） */
  async listExamSurveyStatus() {
    const res = await query(
      `SELECT m.id, m.title, m.start_date, m.end_date, m.academic_year, m.grades,
              COUNT(sp.id) AS plan_rows,
              COUNT(sp.id) FILTER (WHERE sp.submit_status = 'SUBMITTED') AS submitted,
              COUNT(sp.id) FILTER (WHERE sp.request_note IS NOT NULL AND sp.request_note <> '') AS requests,
              COUNT(d.id) AS decision_rows,
              COUNT(d.id) FILTER (WHERE d.decision_status = 'CONFIRMED') AS decided
       FROM exam_masters m
       LEFT JOIN exam_subject_plan sp ON sp.exam_master_id = m.id
       LEFT JOIN exam_subject_decisions d ON d.exam_master_id = m.id
       WHERE m.is_active = true
       GROUP BY m.id, m.title, m.start_date, m.end_date, m.academic_year, m.grades
       ORDER BY m.start_date DESC, m.title ASC`
    );
    return res.rows.map((r) => ({
      id: r.id,
      title: r.title,
      start_date: r.start_date,
      end_date: r.end_date,
      academic_year: r.academic_year,
      grades: safeJson(r.grades, []),
      plan_rows: Number(r.plan_rows) || 0,
      submitted: Number(r.submitted) || 0,
      requests: Number(r.requests) || 0,
      decision_rows: Number(r.decision_rows) || 0,
      decided: Number(r.decided) || 0,
    }));
  },


  /**
   * 科目マスタ (curriculum_subjects) から調査用の実施科目プランをシードする。
   * 開講クラス・コース（offerings）とクラス・コース別の標準教室・標準時間を引き継ぐ。
   */
  async seedSubjectPlanFromCatalog(examMasterId, master, updatedBy) {
    const grades = (master.grades || []).map(Number);
    const [catalog, rooms, classes] = await Promise.all([
      basicinfoModel.listSubjects(),
      basicinfoModel.listRooms(),
      basicinfoModel.listClasses(),
    ]);
    const roomById = new Map(rooms.map((r) => [r.id, r]));
    const classById = new Map(classes.map((c) => [String(c.id), c]));
    const rows = [];
    for (const g of grades) {
      const gradeClasses = classes.filter((c) => c.is_active && Number(c.grade) === g);
      for (const s of catalog) {
        if (!s.is_active) continue;
        if (s.grade !== 0 && Number(s.grade) !== g) continue;
        const raw = (s.offerings || []);
        const offersForGrade = raw.filter((o) => Number(o.grade) === g);
        // 開講設定は class_course_id（基本情報のクラス・コース）で参照する（旧 course_id も許容）
        const resolved = offersForGrade.filter((o) => classById.has(String(o?.class_course_id || o?.course_id)));
        let classIds = [];
        let roomId = s.default_room_id || null;
        if (resolved.length > 0) {
          classIds = resolved.map((o) => String(o.class_course_id || o.course_id));
          roomId = (resolved.find((o) => o.room_id) || {}).room_id || s.default_room_id || null;
        } else if (offersForGrade.length > 0 || raw.length === 0) {
          // 開講設定がクラス・コースに紐づかない（または未登録）の科目は基本情報デフォルト＝その学年の全クラス・コースで実施する
          classIds = gradeClasses.map((c) => String(c.id));
        } else {
          continue;
        }
        const room = roomId ? roomById.get(roomId) : null;
        const minutes = Number(s.default_duration) || 50;
        rows.push({
          subject_name: s.name,
          subject_short: s.short_name || s.name,
          subject_id: s.subject_id || null,
          grade: g,
          scope: s.grade === 0 ? 'ALL' : 'GRADE',
          stream: 'OTHER',
          setter_teacher_id: null,
          duration_slots: Math.max(1, Math.ceil(minutes / 50)),
          duration_minutes: minutes,
          courses: [],
          class_ids: classIds,
          room_id: room ? room.id : null,
          room_name: room ? room.name : null,
          submit_status: 'PENDING',
          decision_status: 'PENDING',
        });
      }
    }
    return examModel.bulkInsertSubjectPlan(examMasterId, rows, updatedBy);
  },

  /** 実施科目調査のサマリ（教員別の提出・要望件数） */
  async subjectSurveySummary(examMasterId) {
    const plan = await examModel.listSubjectPlan(examMasterId);
    const byTeacher = new Map();
    let submitted = 0;
    let requests = 0;
    for (const p of plan) {
      const key = p.setter_teacher_id || '__none__';
      if (!byTeacher.has(key)) {
        byTeacher.set(key, {
          teacher_id: p.setter_teacher_id || null,
          teacher_name: p.setter_teacher_name || null,
          total: 0,
          submitted: 0,
          confirmed: 0,
          requests: 0,
        });
      }
      const entry = byTeacher.get(key);
      entry.total += 1;
      if (p.submit_status === 'SUBMITTED') {
        entry.submitted += 1;
        submitted += 1;
      }
      if (p.decision_status === 'CONFIRMED') entry.confirmed += 1;
      if (p.request_note) {
        entry.requests += 1;
        requests += 1;
      }
    }
    return {
      total: plan.length,
      submitted,
      requests,
      by_teacher: [...byTeacher.values()].sort((a, b) =>
        String(a.teacher_name || '').localeCompare(String(b.teacher_name || ''))
      ),
    };
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
    // class_id は classes(id) への外部キー → クラスマスタの ID に正規化してから登録する
    const normalizedRows = await normalizeClassIds(rows);
    for (const r of normalizedRows) {
      const blocked = !!r.is_blocked;
      const res = await query(
        `INSERT INTO exam_slots (exam_master_id, unit_id, day_number, slot_number, class_id, grade, subject_id, subject_name, subject_teacher_id, setter_teacher_name, slot_span, duration_slots, room_type, is_blocked, notes, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (exam_master_id, day_number, slot_number, class_id, is_blocked) DO UPDATE SET
           unit_id = EXCLUDED.unit_id,
           grade = EXCLUDED.grade,
           subject_id = EXCLUDED.subject_id,
           subject_name = EXCLUDED.subject_name,
           subject_teacher_id = EXCLUDED.subject_teacher_id,
           setter_teacher_name = EXCLUDED.setter_teacher_name,
           slot_span = EXCLUDED.slot_span,
           duration_slots = EXCLUDED.duration_slots,
           room_type = EXCLUDED.room_type,
           notes = EXCLUDED.notes,
           updated_by = EXCLUDED.updated_by,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
        [
          examMasterId,
          blocked ? null : r.unit_id || null,
          Number(r.day_number),
          Number(r.slot_number),
          r.class_id,
          Number(r.grade) || 0,
          blocked ? null : r.subject_id || null,
          blocked ? null : r.subject_name || null,
          blocked ? null : r.subject_teacher_id || null,
          blocked ? null : r.setter_teacher_name || null,
          1,
          1,
          r.room_type || 'CLASS',
          blocked,
          blocked ? r.notes || '×（使用不能コマ）' : r.notes ?? null,
          updatedBy,
        ]
      );
      saved.push(res.rows[0]);
    }
    return saved;
  },

  /**
   * 試験実施日番号の集合外（暦日を × で全コマ除外した日）の exam_slots 行を削除する
   * @param {string} examMasterId
   * @param {Set<number>} keepDays 保持する実施日番号（1..N）
   * @returns {Promise<number>} 削除件数
   */
  async deleteSlotsOutsideDays(examMasterId, keepDays) {
    const list = [...keepDays].map(Number);
    if (!list.length) {
      const res = await query(`DELETE FROM exam_slots WHERE exam_master_id = ?`, [examMasterId]);
      return res.rowCount ?? 0;
    }
    const res = await query(
      `DELETE FROM exam_slots WHERE exam_master_id = ? AND day_number NOT IN (${list.map(() => '?').join(', ')})`,
      [examMasterId, ...list]
    );
    return res.rowCount ?? 0;
  },

  /**
   * day_number を新実施日番号へ再採番する（× で実施日が削減された後の追随）
   * 衝突を避けるため一旦マイナスへ逃がしてから書き換える。
   * @param {string} table 対象テーブル（exam_slots / exam_trips / exam_proctor_assignments / exam_room_assignments / exam_parttime_availability）
   * @param {string} examMasterId
   * @param {Map<number, number>} mapping 旧実施日番号 → 新実施日番号
   */
  async renumberExamDays(table, examMasterId, mapping) {
    const ALLOWED = [
      'exam_slots',
      'exam_trips',
      'exam_proctor_assignments',
      'exam_room_assignments',
      'exam_parttime_availability',
    ];
    if (!ALLOWED.includes(table)) throw new Error(`renumberExamDays: 不正なテーブル ${table}`);
    if (!mapping.size) return 0;
    await query(`UPDATE ${table} SET day_number = -day_number WHERE exam_master_id = ? AND day_number > 0`, [examMasterId]);
    let touched = 0;
    for (const [from, to] of mapping) {
      const res = await query(
        `UPDATE ${table} SET day_number = ? WHERE exam_master_id = ? AND day_number = ?`,
        [to, examMasterId, -Number(from)]
      );
      touched += res.rowCount ?? 0;
    }
    // 再採番対象外（旧実施日が全コマ×で実施日外になった行）は 0 に寄せて削除対象化する
    await query(`UPDATE ${table} SET day_number = 0 WHERE exam_master_id = ? AND day_number < 0`, [examMasterId]);
    return touched;
  },

  /**
   * 実施日番号が実施日外（暦日が全コマ × で実施日でなくなった）の行を削除する
   * @param {string} table 対象テーブル（再採番可能なテーブルに限定）
   * @param {string} examMasterId
   * @param {Set<number>} keepDays 保持する実施日番号
   */
  async deleteExamRowsOutsideDays(table, examMasterId, keepDays) {
    const ALLOWED = [
      'exam_slots',
      'exam_trips',
      'exam_proctor_assignments',
      'exam_room_assignments',
      'exam_parttime_availability',
    ];
    if (!ALLOWED.includes(table)) throw new Error(`deleteExamRowsOutsideDays: 不正なテーブル ${table}`);
    const list = [...keepDays].map(Number);
    if (!list.length) {
      const res = await query(`DELETE FROM ${table} WHERE exam_master_id = ?`, [examMasterId]);
      return res.rowCount ?? 0;
    }
    const res = await query(
      `DELETE FROM ${table} WHERE exam_master_id = ? AND day_number NOT IN (${list.map(() => '?').join(', ')})`,
      [examMasterId, ...list]
    );
    return res.rowCount ?? 0;
  },
  /**
   * 全学年共通 × の圧縮で実施日外へ出た学年固有 ×（exam_slots.is_blocked）行を削除する
   * @param {string} examMasterId
   * @param {Array} daySlots 現在の buildDaySlots 結果（実施日連番と使用可能コマ）
   * @returns {number} 削除した行数
   */
  async deleteBlockedCellsOutside(examMasterId, daySlots) {
    const usable = new Set((daySlots || []).flatMap((d) => (d.enabled_slots || []).map((s) => `${Number(d.day)}|${Number(s)}`)));
    const res = await query(
      `SELECT id, day_number, slot_number FROM exam_slots WHERE exam_master_id = ? AND is_blocked = true`,
      [examMasterId]
    );
    const stale = res.rows.filter((r) => !usable.has(`${Number(r.day_number)}|${Number(r.slot_number)}`));
    if (!stale.length) return 0;
    const deleted = await query(
      `DELETE FROM exam_slots WHERE id IN (${stale.map(() => '?').join(', ')})`,
      [examMasterId, ...stale.map((r) => r.id)]
    );
    return deleted.rowCount ?? 0;
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
      `SELECT ra.*, c.name AS class_name
       FROM exam_room_assignments ra
       LEFT JOIN classes c ON c.id = ra.class_id
       WHERE ra.exam_master_id = ?
       ORDER BY ra.day_number ASC, ra.slot_number ASC, ra.grade ASC, c.name ASC`,
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
          (id, exam_master_id, unit_id, subject_name, grade, class_id, day_number, slot_number, room_id, room_name, is_standard, notes, updated_by, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT (exam_master_id, class_id, day_number, slot_number) DO UPDATE SET
           unit_id = EXCLUDED.unit_id,
           subject_name = EXCLUDED.subject_name,
           grade = EXCLUDED.grade,
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
          r.class_id || null,
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
    // class_id は classes(id) への外部キー → クラスマスタの ID に正規化する
    const normalizedRows = await normalizeClassIds(rows);
    // (exam_master_id, day_number, slot_number, class_id) が重複する行は後ろの行を優先して insertion 前に正規化
    const dedupMap = new Map();
    for (const r of normalizedRows) {
      const dayNumber = Number(r.day_number);
      const slotNumber = Number(r.slot_number);
      const classId = r.class_id;
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
      `SELECT id, name, staff_code, grade, role, is_parttime, subjects FROM users ORDER BY name ASC`
    );
    return res.rows.map((r) => ({
      id: r.id,
      name: r.name,
      staff_code: r.staff_code,
      grade: Number(r.grade) || 0,
      role: r.role,
      is_parttime: !!r.is_parttime,
      subjects: parseSubjectList(r.subjects),
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