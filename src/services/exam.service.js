/**
 * ISSystem 定期考査サービス
 * 教務権限（kyomu）による考査登録・実施科目/出題者調査・時間割自動作成・
 * 教室割自動作成・出張等登録・監督割自動作成と、公表フェーズ管理を提供する。
 */

import { examModel } from '../models/exam.model.js';
import { query } from '../../config/database.js';
import { logAction } from '../models/audit.model.js';
import { solveTimetable, validateTimetable, DEFAULT_TIMETABLE_RULES } from '../utils/exam-timetable-solver.js';
import { solveRooms, DEFAULT_ROOM_RULES } from '../utils/exam-room-solver.js';
import { solveProctor, validateProctor, DEFAULT_PROCTOR_RULES } from '../utils/exam-proctor-solver.js';

const PHASE = { DRAFT: 'DRAFT', SURVEY: 'SURVEY', PUBLISHED: 'PUBLISHED', ENDED: 'ENDED' };

/** 監査ログ記録（auditModel.logAction の薄いラッパー） */
function audit(action, user, target, targetId, details) {
  return logAction({ userId: user.id, action, target, targetId, details });
}

function isKyomu(user) {
  if (!user) return false;
  return user.is_kyomu === true || String(user.role || '').toUpperCase() === 'KYOMU' || String(user.role || '').toUpperCase() === 'ADMIN';
}

function ensureKyomu(user) {
  if (!isKyomu(user)) {
    const err = new Error('この操作には教務権限が必要です。');
    err.status = 403;
    throw err;
  }
}

function ensureMaster(examMasterId) {
  return examModel.findExamMasterById(examMasterId).then((m) => {
    if (!m) {
      const err = new Error('考査が見つかりません。');
      err.status = 404;
      throw err;
    }
    return m;
  });
}

/** フェーズ変更履歴の記録（best-effort） */
function logPhase(examMasterId, phaseKey, fromValue, toValue, userId) {
  return examModel.logPhaseChange(examMasterId, phaseKey, fromValue, toValue, userId);
}

/** 考査期間の日付リスト */
function dateRange(start, end) {
  const out = [];
  const d1 = new Date(start);
  const d2 = new Date(end);
  for (let d = new Date(d1); d <= d2; d.setDate(d.getDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** 計画プランからソルバー用実施単位を生成 */
function planToUnits(plan) {
  return plan.map((p) => ({
    id: p.id,
    unit_id: p.id,
    subject_id: p.subject_id,
    subject_name: String(p.subject_name || '').trim(),
    grade: Number(p.grade) || 0,
    stream: p.stream || 'OTHER',
    scope: p.scope || 'GRADE',
    setter_teacher_id: p.setter_teacher_id || null,
    setter_teacher_name: p.setter_teacher_name || null,
    duration_slots: Number(p.duration_slots) || 1,
    fixed_slot: p.fixed_slot ? Number(p.fixed_slot) : null,
    shared_slot: !!p.shared_slot,
    broadcast_slot: !!p.broadcast_slot,
    solo_subject: !!p.solo_subject,
  }));
}

/** 時間割スロット → ソルバー入力 timetable [{unit_id, grade, day, slot, duration_slots}] */
function slotsToTimetable(slots) {
  const seen = new Set();
  const out = [];
  for (const s of slots) {
    const key = `${s.grade}:${s.day_number}:${s.slot_number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      unit_id: s.unit_id || s.subject_id,
      grade: Number(s.grade),
      day: Number(s.day_number),
      slot: Number(s.slot_number),
      duration_slots: Number(s.slot_span) || 1,
      subject_name: s.subject_name,
    });
  }
  return out;
}

/** 学年別在籍生徒数（クラス数 × 1クラス想定人数） */
function gradeStudentsFromClasses(classes, perClass = 40) {
  const out = {};
  for (const c of classes || []) {
    const g = Number(c.grade);
    out[g] = (out[g] || 0) + perClass;
  }
  return out;
}

/** 出欠記録 → 出張コマ（考査期間・全コマ）の集合 */
function absencesToTrips(absences, master, teachers) {
  const dates = dateRange(master.start_date, master.end_date);
  const byDate = new Map();
  for (const a of absences) {
    if (!byDate.has(a.record_date)) byDate.set(a.record_date, []);
    byDate.get(a.record_date).push(a);
  }
  const trips = [];
  for (const t of teachers) {
    for (let d = 1; d <= master.days_count; d++) {
      const date = dates[d - 1];
      const recs = (byDate.get(date) || []).filter((a) => a.user_id === t.id);
      if (recs.length === 0) continue;
      for (let s = 1; s <= master.daily_slots; s++) {
        trips.push({
          teacher_id: t.id,
          teacher_name: t.name,
          day_number: d,
          slot_number: s,
          reason: recs.map((r) => r.reason || r.record_type).join(' / '),
          record_type: recs[0].record_type,
          from_absence: true,
        });
      }
    }
  }
  return trips;
}

/** 学年別特別教室ルールの正規化（{"1":"SP1","3|化学":"SP2"} ⇄ {rules_by_grade, rules_by_subject}） */
function normalizeRoomRules(payload) {
  const rules_by_grade = {};
  const rules_by_subject = {};
  const entries = [];
  const src = payload || {};
  if (src.rules_by_grade || src.rules_by_subject) {
    for (const [k, v] of Object.entries(src.rules_by_grade || {})) entries.push([k, v]);
    for (const [k, v] of Object.entries(src.rules_by_subject || {})) entries.push([k, v]);
  } else {
    const flat = src.rules && typeof src.rules === 'object' ? src.rules : src;
    for (const [k, v] of Object.entries(flat || {})) {
      if (['rules', 'weights', 'rules_by_grade', 'rules_by_subject', 'updated_by', 'updated_at'].includes(k)) continue;
      entries.push([k, v]);
    }
  }
  for (const [k, v] of entries) {
    const type = String(v).toUpperCase();
    if (!type) continue;
    if (k.includes('|')) {
      const [g, s] = k.split('|');
      rules_by_subject[`${Number(g)}|${String(s).trim()}`] = type;
    } else {
      rules_by_grade[Number(k)] = type;
    }
  }
  return { rules_by_grade, rules_by_subject };
}

/** 保存用フラット形式へ変換（exam_room_rules.rules に格納） */
function flatRoomRules(normalized) {
  const out = {};
  for (const [g, t] of Object.entries(normalized.rules_by_grade || {})) out[String(g)] = t;
  for (const [k, t] of Object.entries(normalized.rules_by_subject || {})) out[k] = t;
  return out;
}

async function getRoomRulesNormalized(examMasterId) {
  const raw = await examModel.getRulesTable('exam_room_rules', examMasterId, {});
  return normalizeRoomRules(raw);
}

export const examService = {
  // ==========================================================
  // 考査登録・マスタ
  // ==========================================================
  async listMasters(user) {
    const masters = await examModel.listExamMasters();
    const out = [];
    for (const m of masters) {
      const phases = await examModel.getPhases(m.id);
      out.push({ ...m, phases, can_edit: isKyomu(user) });
    }
    return out;
  },

  async createMaster(payload, user) {
    ensureKyomu(user);
    if (!payload.title) {
      const err = new Error('考査名を入力してください。');
      err.status = 400;
      throw err;
    }
    const created = await examModel.createExamMaster({
      ...payload,
      days_count: payload.days_count || dateRange(payload.start_date, payload.end_date).length,
      grades: payload.grades && payload.grades.length ? payload.grades : [1, 2, 3],
      created_by: user.id,
    });
    await audit('CREATE_EXAM', user, 'exam_master', created.id, `定期考査「${created.title}」を登録`);
    return created;
  },

  async updateMaster(examMasterId, payload, user) {
    ensureKyomu(user);
    const updated = await examModel.updateExamMaster(examMasterId, payload);
    await audit('UPDATE_EXAM', user, 'exam_master', examMasterId, '定期考査情報を更新');
    return updated;
  },

  async deactivateMaster(examMasterId, user) {
    ensureKyomu(user);
    await examModel.deactivateExamMaster(examMasterId);
    await audit('DEACTIVATE_EXAM', user, 'exam_master', examMasterId, '定期考査を完了（非active化）');
    return { ok: true };
  },

  // ==========================================================
  // 考査ボード（全データ一括取得）
  // ==========================================================
  async getBoard(examMasterId, user) {
    const master = await ensureMaster(examMasterId);
    const phases = await examModel.getPhases(examMasterId);
    const kyomu = isKyomu(user);

    const [plan, slots, rooms, roomConfig, roomAssignments, trips, staff, availability, proctors, constraints, exemptions] =
      await Promise.all([
        examModel.listSubjectPlan(examMasterId),
        examModel.listSlots(examMasterId),
        examModel.listRooms(examMasterId),
        examModel.listRoomConfig(examMasterId),
        examModel.listRoomAssignments(examMasterId),
        examModel.listTrips(examMasterId),
        examModel.listParttimeStaff(examMasterId),
        examModel.listParttimeAvailability(examMasterId),
        examModel.listProctorAssignments(examMasterId),
        examModel.listTeacherConstraints(examMasterId),
        examModel.listExemptions(examMasterId),
      ]);

    const rulesTable = await examModel.getRulesTable('exam_timetable_rules', examMasterId, DEFAULT_TIMETABLE_RULES);
    const proctorRules = await examModel.getRulesTable('exam_proctor_rules', examMasterId, DEFAULT_PROCTOR_RULES);

    const editable = {
      subject: kyomu || phases.subject_phase === PHASE.SURVEY,
      subject_kyomu: kyomu,
      timetable: kyomu && phases.timetable_phase !== PHASE.ENDED,
      room: kyomu && phases.room_phase !== PHASE.ENDED,
      trip: kyomu || phases.trip_phase === PHASE.SURVEY,
      proctor: kyomu && phases.proctor_phase !== PHASE.ENDED,
    };

    return {
      master,
      phases,
      subject_plan: plan.map((p) => ({
        ...p,
        can_edit: kyomu || (phases.subject_phase === PHASE.SURVEY && p.setter_teacher_id === user.id),
      })),
      slots,
      rooms,
      room_config: roomConfig,
      room_assignments: roomAssignments,
      trips: trips.map((t) => ({ ...t, can_edit: kyomu || t.teacher_id === user.id })),
      parttime_staff: staff,
      parttime_availability: availability,
      proctor_assignments: proctors,
      teacher_constraints: constraints,
      exemptions,
      timetable_rules: rulesTable,
      proctor_rules: proctorRules,
      editable,
      is_kyomu: kyomu,
    };
  },

  // ==========================================================
  // 実施科目・出題者の登録／調査
  // ==========================================================
  async startSubjectSurvey(examMasterId, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    await examModel.setPhase(examMasterId, 'subject_phase', PHASE.SURVEY, user.id);

    const plan = await examModel.listSubjectPlan(examMasterId);
    if (plan.length === 0) {
      const subjects = (await query('SELECT id, name FROM subjects ORDER BY name ASC')).rows;
      const rows = [];
      for (const g of master.grades) {
        for (const s of subjects) {
          rows.push({ subject_name: s.name, subject_id: s.id, grade: g, scope: 'GRADE', stream: 'OTHER', setter_teacher_id: null });
        }
      }
      await examModel.bulkInsertSubjectPlan(examMasterId, rows, user.id);
    }
    await audit('EXAM_SURVEY_START', user, 'exam_master', examMasterId, `考査「${master.title}」の実施科目調査を開始`);
    return examModel.getPhases(examMasterId);
  },

  async saveSubjectRow(examMasterId, row, user) {
    const phases = await examModel.getPhases(examMasterId);
    const kyomu = isKyomu(user);
    if (!kyomu) {
      if (phases.subject_phase !== PHASE.SURVEY) {
        const err = new Error('調査期間中でない実施科目は編集できません。');
        err.status = 403;
        throw err;
      }
      if (row.setter_teacher_id !== user.id) {
        const err = new Error('自分の出題コマのみ編集できます。');
        err.status = 403;
        throw err;
      }
    }
    const saved = await examModel.upsertSubjectPlanRow({
      ...row,
      exam_master_id: examMasterId,
      grade: Number(row.grade) || 0,
      updated_by: user.id,
    });
    await audit('EXAM_SUBJECT_SAVE', user, 'exam_subject_plan', saved.id, `実施科目「${saved.subject_name}」(${saved.grade}年) を登録`);
    return saved;
  },


  async submitSubjectRow(examMasterId, id, user) {
    const row = (await examModel.listSubjectPlan(examMasterId)).find((r) => r.id === id);
    if (!row) {
      const err = new Error('プラン行が見つかりません。');
      err.status = 404;
      throw err;
    }
    if (!isKyomu(user) && row.setter_teacher_id !== user.id) {
      const err = new Error('自分の出題コマのみ提出できます。');
      err.status = 403;
      throw err;
    }
    return examModel.upsertSubjectPlanRow({ ...row, submit_status: 'SUBMITTED', updated_by: user.id });
  },

  async deleteSubjectRow(examMasterId, id, user) {
    ensureKyomu(user);
    await examModel.deleteSubjectPlan(id);
    return { ok: true };
  },

  async endSubjectSurvey(examMasterId, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    const phases = await examModel.setPhase(examMasterId, 'subject_phase', PHASE.ENDED, user.id);
    await audit('EXAM_SURVEY_END', user, 'exam_master', examMasterId, `考査「${master.title}」の実施科目調査を終了`);
    return phases;
  },

  // ==========================================================
  // 試験時間割（自動作成・公表）
  // ==========================================================
  async saveTimetableRules(examMasterId, rules, user) {
    ensureKyomu(user);
    return examModel.saveRulesTable('exam_timetable_rules', examMasterId, rules, user.id);
  },

  async solveTimetable(examMasterId, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    if (master.timetable_phase === PHASE.ENDED) {
      const err = new Error('時間割フェーズは終了済みです。');
      err.status = 403;
      throw err;
    }

    const plan = await examModel.listSubjectPlan(examMasterId);
    if (plan.length === 0) {
      const err = new Error('実施科目が登録されていません。');
      err.status = 400;
      throw err;
    }

    const rules = await examModel.getRulesTable('exam_timetable_rules', examMasterId, DEFAULT_TIMETABLE_RULES);
    const historyRows = await examModel.fetchSlotHistory(200);

    const units = planToUnits(plan);
    const grades = master.grades.map((g) => Number(g));

    const result = solveTimetable({
      units,
      days: master.days_count,
      slots: master.daily_slots,
      rules,
      grades,
      history: historyRows,
    });

    if (!result.feasible && result.assignments.length === 0) {
      return { ...result, saved: 0 };
    }

    const unitsById = new Map(units.map((u) => [u.id, u]));
    const rows = result.assignments.map((a) => {
      const u = unitsById.get(a.unit_id) || {};
      return {
        class_id: `G${a.grade}`,
        grade: a.grade,
        subject_id: a.unit_id,
        subject_name: a.subject_name || u.subject_name || null,
        subject_teacher_id: u.setter_teacher_id || null,
        setter_teacher_name: u.setter_teacher_name || null,
        day_number: a.day,
        slot_number: a.slot,
        slot_span: a.duration_slots,
        room_type: 'CLASS',
      };
    });

    await examModel.saveSlots(examMasterId, rows, user.id);
    await examModel.setPhase(examMasterId, 'timetable_phase', PHASE.DRAFT, user.id);
    await audit('EXAM_TIMETABLE_SOLVE', user, 'exam_master', examMasterId, `試験時間割を自動作成（ペナルティ ${result.penalty} / 未配置 ${result.stats.unplacedUnits}）`);

    return { ...result, saved: rows.length };
  },

  async saveTimetableSlots(examMasterId, rows, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    if (master.timetable_phase === PHASE.ENDED) {
      const err = new Error('時間割フェーズは終了済みです。');
      err.status = 403;
      throw err;
    }

    const plan = await examModel.listSubjectPlan(examMasterId);
    const units = planToUnits(plan);
    const normalized = rows.map((r) => ({
      unit_id: r.subject_id,
      grade: Number(r.grade),
      day: Number(r.day_number),
      slot: Number(r.slot_number),
      duration_slots: Number(r.slot_span) || 1,
    }));

    const rules = await examModel.getRulesTable('exam_timetable_rules', examMasterId, DEFAULT_TIMETABLE_RULES);
    const diagnostics = validateTimetable({
      days: master.days_count,
      slots: master.daily_slots,
      grades: master.grades.map((g) => Number(g)),
      units,
      rules,
      history: await examModel.fetchSlotHistory(200),
      assignments: normalized,
    });

    const setterNames = new Map(plan.map((p) => [p.id, p.setter_teacher_name]));

    const slotRows = rows.map((r) => ({
      class_id: r.class_id || `G${Number(r.grade)}`,
      grade: Number(r.grade),
      subject_id: r.subject_id,
      subject_name: r.subject_name,
      subject_teacher_id: r.subject_teacher_id,
      setter_teacher_name: r.setter_teacher_name || setterNames.get(r.subject_id) || null,
      day_number: Number(r.day_number),
      slot_number: Number(r.slot_number),
      slot_span: Number(r.slot_span) || 1,
      room_type: r.room_type || 'CLASS',
    }));

    await examModel.saveSlots(examMasterId, slotRows, user.id);
    await audit('EXAM_TIMETABLE_SAVE', user, 'exam_master', examMasterId, `試験時間割を手動編集（${rows.length}コマ）`);

    return { saved: slotRows.length, diagnostics, violations: diagnostics.hard };
  },

  async publishTimetable(examMasterId, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    const slots = await examModel.listSlots(examMasterId);
    if (slots.length === 0) {
      const err = new Error('時間割が作成されていません。先に自動作成または手動編集を行ってください。');
      err.status = 400;
      throw err;
    }
    const phases = await examModel.setPhase(examMasterId, 'timetable_phase', PHASE.PUBLISHED, user.id);
    await audit('EXAM_TIMETABLE_PUBLISH', user, 'exam_master', examMasterId, `試験時間割を公表（${slots.length}コマ）`);
    return phases;
  },

  async endTimetable(examMasterId, user) {
    ensureKyomu(user);
    return examModel.setPhase(examMasterId, 'timetable_phase', PHASE.ENDED, user.id);
  },


  // ==========================================================
  // 試験教室（マスタ・設定・自動割当・公表）
  // ==========================================================
  async saveRooms(examMasterId, rooms, user) {
    ensureKyomu(user);
    const list = Array.isArray(rooms) ? rooms : [rooms];
    const saved = [];
    for (const room of list) {
      if (!room.name) {
        const err = new Error('教室名を入力してください。');
        err.status = 400;
        throw err;
      }
      saved.push(
        await examModel.upsertRoom({
          ...room,
          exam_master_id: examMasterId,
          name: room.name,
          room_type: room.room_type || 'CLASS',
          capacity: Number(room.capacity) || null,
          grades: room.grades && room.grades.length ? room.grades.map(Number) : [],
          updated_by: user.id,
        })
      );
    }
    await audit('EXAM_ROOM_SAVE', user, 'exam_master', examMasterId, `試験教室マスターを ${saved.length}室 保存`);
    return saved;
  },

  async deleteRoom(examMasterId, roomId, user) {
    ensureKyomu(user);
    await examModel.deleteRoom(roomId);
    return { ok: true };
  },

  async getRooms(examMasterId, user) {
    const rooms = await examModel.listRooms(examMasterId);
    const rules = await getRoomRulesNormalized(examMasterId);
    const isTeacher = !isKyomu(user);
    const grade = Number(user.grade) || 0;
    return {
      rooms: isTeacher ? rooms.filter((r) => grade === 0 || r.grades.includes(grade)) : rooms,
      rules_by_grade: rules.rules_by_grade,
      rules_by_subject: rules.rules_by_subject,
    };
  },

  async getRoomRules(examMasterId, user) {
    const rules = await getRoomRulesNormalized(examMasterId);
    return { ...rules, is_kyomu: isKyomu(user) };
  },

  async saveRoomRules(examMasterId, payload, user) {
    ensureKyomu(user);
    const normalized = normalizeRoomRules(payload);
    await examModel.saveRulesTable('exam_room_rules', examMasterId, flatRoomRules(normalized), user.id);
    await audit('EXAM_ROOM_RULES', user, 'exam_master', examMasterId, `学年別特別教室ルールを保存（${Object.keys(normalized.rules_by_subject).length}件）`);
    return normalized;
  },

  async getRoomConfig(examMasterId, user) {
    const config = await examModel.listRoomConfig(examMasterId);
    return { config, is_kyomu: isKyomu(user) };
  },

  async saveRoomConfig(examMasterId, config, user) {
    ensureKyomu(user);
    return examModel.upsertRoomConfigRow({
      ...config,
      exam_master_id: examMasterId,
      grade: Number(config.grade) || 0,
      alt_rooms: config.alt_rooms || [],
      updated_by: user.id,
    });
  },

  async solveRoomAssignments(examMasterId, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    if (master.room_phase === PHASE.ENDED) {
      const err = new Error('教室割当フェーズは終了済みです。');
      err.status = 403;
      throw err;
    }

    const slots = await examModel.listSlots(examMasterId);
    if (slots.length === 0) {
      const err = new Error('試験時間割が作成されていません。先に時間割を作成してください。');
      err.status = 400;
      throw err;
    }

    const rooms = await examModel.listRooms(examMasterId);
    if (rooms.length === 0) {
      const err = new Error('教室マスタが登録されていません。');
      err.status = 400;
      throw err;
    }

    const roomConfig = await examModel.listRoomConfig(examMasterId);
    const roomRulesRaw = await examModel.getRulesTable('exam_room_rules', examMasterId, {});
    const normalizedRoomRules = normalizeRoomRules(roomRulesRaw);
    const rules = {
      ...DEFAULT_ROOM_RULES,
      rules_by_grade: normalizedRoomRules.rules_by_grade,
      rules_by_subject: normalizedRoomRules.rules_by_subject,
      weights: { ...DEFAULT_ROOM_RULES.weights, ...(roomRulesRaw.weights || {}) },
      reserved_rooms: roomRulesRaw.reserved_rooms || DEFAULT_ROOM_RULES.reserved_rooms,
      reserve_prep_before_broadcast:
        roomRulesRaw.reserve_prep_before_broadcast !== false,
    };

    const plan = await examModel.listSubjectPlan(examMasterId);
    const unitsById = new Map(planToUnits(plan).map((u) => [u.id, u]));

    const gradeStudents = await examModel.getGradeStudents(master.grades.map((g) => Number(g)));

    const assignments = slotsToTimetable(slots).map((t) => {
      const u = unitsById.get(t.unit_id) || {};
      return {
        unit_id: t.unit_id,
        grade: t.grade,
        subject_name: t.subject_name,
        day: t.day,
        slot: t.slot,
        duration_slots: u.duration_slots ?? t.duration_slots,
      };
    });

    const roomRows = rooms.map((r) => ({
      id: r.id,
      name: r.name,
      room_type: r.room_type || 'CLASS',
      capacity: Number(r.capacity) || null,
      grades: Array.isArray(r.grades) ? r.grades.map(Number) : [],
    }));

    const result = solveRooms({
      days: master.days_count,
      slots: master.daily_slots,
      grades: master.grades.map((g) => Number(g)),
      rooms: roomRows,
      room_config: roomConfig,
      assignments,
      broadcast_subjects: plan.filter((p) => p.broadcast_slot).map((p) => p.subject_name),
      students: gradeStudents,
      rules,
    });

    const roomIdByName = new Map(roomRows.map((r) => [r.name, r.id]));

    // 1つのスパン占有を各コマに展開して保存行を作る
    const rows = [];
    for (const a of result.assignments) {
      if (!a.room_name) continue;
      for (let s = a.slot; s < a.slot + a.duration_slots; s++) {
        if (s > master.daily_slots) break;
        rows.push({
          grade: a.grade,
          day_number: a.day,
          slot_number: s,
          unit_id: a.unit_id,
          room_id: roomIdByName.get(a.room_name) ?? null,
          room_name: a.room_name,
          subject_name: a.subject_name,
          is_standard: a.is_standard && s === a.slot,
        });
      }
    }

    await examModel.saveRoomAssignments(examMasterId, rows, user.id);
    await examModel.setPhase(examMasterId, 'room_phase', PHASE.DRAFT, user.id);
    await audit('EXAM_ROOM_SOLVE', user, 'exam_master', examMasterId, `試験教室割当を自動作成（${rows.length}件 / 未割当 ${result.stats.unassignedUnits}）`);

    return result;
  },

  async saveRoomAssignments(examMasterId, rows, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    if (master.room_phase === PHASE.ENDED) {
      const err = new Error('教室割当フェーズは終了済みです。');
      err.status = 403;
      throw err;
    }
    const normalized = rows.map((r) => ({
      grade: Number(r.grade),
      day_number: Number(r.day_number),
      slot_number: Number(r.slot_number),
      unit_id: r.unit_id || r.subject_id || null,
      room_id: r.room_id,
      room_name: r.room_name,
      subject_name: r.subject_name,
      is_standard: !!r.is_standard,
    }));
    await examModel.saveRoomAssignments(examMasterId, normalized, user.id);
    await audit('EXAM_ROOM_SAVE', user, 'exam_master', examMasterId, `試験教室割当を手動編集（${normalized.length}件）`);
    return { saved: normalized.length };
  },

  async publishRoomAssignments(examMasterId, user) {
    ensureKyomu(user);
    const assignments = await examModel.listRoomAssignments(examMasterId);
    if (assignments.length === 0) {
      const err = new Error('教室割当が存在しません。');
      err.status = 400;
      throw err;
    }
    const phases = await examModel.setPhase(examMasterId, 'room_phase', PHASE.PUBLISHED, user.id);
    await audit('EXAM_ROOM_PUBLISH', user, 'exam_master', examMasterId, `試験教室割当を公表（${assignments.length}件）`);
    return phases;
  },

  async endRoomPhase(examMasterId, user) {
    ensureKyomu(user);
    return examModel.setPhase(examMasterId, 'room_phase', PHASE.ENDED, user.id);
  },


  // ==========================================================
  // 試験期間の出張・外出・私用・欠席登録
  // ==========================================================
  async startTripSurvey(examMasterId, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);

    const teachers = await examModel.fetchStaffPool();
    const absences = await examModel.listAbsencesByDateRange(master.start_date, master.end_date);
    const derived = absencesToTrips(absences, master, teachers);

    const phases = await examModel.setPhase(examMasterId, 'trip_phase', PHASE.SURVEY, user.id);
    for (const t of derived) {
      await examModel.upsertTrip({
        exam_master_id: examMasterId,
        teacher_id: t.teacher_id,
        day_number: t.day_number,
        slot_number: t.slot_number,
        reason: t.reason,
        recorded_by: user.id,
        recorded_by_name: user.name,
      });
    }
    await audit('EXAM_TRIP_START', user, 'exam_master', examMasterId, `考査「${master.title}」の出張等登録を開始（出欠から ${derived.length}件 抽出）`);
    return { phases, derived_count: derived.length };
  },

  /** 出張等登録を公表（教務のみ・登録開始済みであること） */
  async publishTrips(examMasterId, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    const phases = await examModel.getPhases(examMasterId);
    if (phases.trip_phase === PHASE.DRAFT) {
      const err = new Error('出張等登録が開始されていません。「出張等の登録を開始」後に公表できます。');
      err.status = 400;
      throw err;
    }
    const trips = await examModel.listTrips(examMasterId);
    const updated = await examModel.setPhase(examMasterId, 'trip_phase', PHASE.PUBLISHED, user.id);
    await audit('EXAM_TRIP_PUBLISH', user, 'exam_master', examMasterId, `考査「${master.title}」の出張等を公表（${trips.length}件）`);
    return { phases: updated, published: trips.length };
  },

  async addTripRow(examMasterId, row, user) {
    const phases = await examModel.getPhases(examMasterId);
    const kyomu = isKyomu(user);
    if (!kyomu && phases.trip_phase !== PHASE.SURVEY) {
      const err = new Error('登録期間中でない出張項目は編集できません。');
      err.status = 403;
      throw err;
    }
    if (!kyomu && row.teacher_id !== user.id) {
      const err = new Error('自分の出張・外出・私用・欠席のみ登録できます。');
      err.status = 403;
      throw err;
    }
    const saved = await examModel.upsertTrip({
      ...row,
      exam_master_id: examMasterId,
      day_number: Number(row.day_number),
      slot_number: Number(row.slot_number),
      teacher_id: row.teacher_id || user.id,
      updated_by: user.id,
    });
    await audit('EXAM_TRIP_SAVE', user, 'exam_master', examMasterId, `出張等「${saved.reason}」を登録`);
    return saved;
  },

  /** 出張等登録のプレビュー（出欠記録からの抽出件数表示用） */
  async previewTrips(examMasterId, user) {
    const master = await ensureMaster(examMasterId);
    const teachers = await examModel.fetchStaffPool();
    const absences = await examModel.listAbsencesByDateRange(master.start_date, master.end_date);
    const derived = absencesToTrips(absences, master, teachers);
    const saved = await examModel.listTrips(examMasterId);
    return {
      derived,
      derived_count: derived.length,
      saved_count: saved.length,
      is_kyomu: isKyomu(user),
    };
  },

  /** 出張等行の一括保存（教師は自分の分のみ、教務は全体） */
  async saveTrips(examMasterId, rows, user) {
    const phases = await examModel.getPhases(examMasterId);
    const kyomu = isKyomu(user);
    if (!kyomu && phases.trip_phase !== PHASE.SURVEY) {
      const err = new Error('登録期間中でない出張項目は編集できません。');
      err.status = 403;
      throw err;
    }
    const list = Array.isArray(rows) ? rows : [rows];
    const saved = [];
    for (const row of list) {
      if (!kyomu && String(row.teacher_id) !== String(user.id)) {
        const err = new Error('自分の出張・外出・私用・欠席のみ登録できます。');
        err.status = 403;
        throw err;
      }
      saved.push(
        await examModel.upsertTrip({
          ...row,
          exam_master_id: examMasterId,
          day_number: Number(row.day_number),
          slot_number: Number(row.slot_number),
          teacher_id: row.teacher_id || user.id,
          updated_by: user.id,
        })
      );
    }
    await audit('EXAM_TRIP_SAVE', user, 'exam_master', examMasterId, `出張等を ${saved.length}件 登録`);
    return { saved: saved.length };
  },

  /** 出張等行の削除（教務は全件、教員は自分の行のみ） */
  async deleteTrip(examMasterId, id, user) {
    const phases = await examModel.getPhases(examMasterId);
    const kyomu = isKyomu(user);
    if (!kyomu && phases.trip_phase !== PHASE.SURVEY) {
      const err = new Error('登録期間中でない出張項目は削除できません。');
      err.status = 403;
      throw err;
    }
    const rows = await examModel.listTrips(examMasterId);
    const target = rows.find((r) => r.id === id);
    if (!target) {
      const err = new Error('対象レコードが見つかりません。');
      err.status = 404;
      throw err;
    }
    if (!kyomu && String(target.teacher_id) !== String(user.id)) {
      const err = new Error('自分の出張・外出・私用・欠席のみ削除できます。');
      err.status = 403;
      throw err;
    }
    await examModel.deleteTrip(examMasterId, target.teacher_id, target.day_number, target.slot_number);
    await audit('EXAM_TRIP_DELETE', user, 'exam_master', examMasterId, `出張等「${target.reason}」を削除`);
    return { ok: true };
  },

  async deleteTripRow(examMasterId, id, user) {
    const phases = await examModel.getPhases(examMasterId);
    const kyomu = isKyomu(user);
    if (!kyomu && phases.trip_phase !== PHASE.SURVEY) {
      const err = new Error('登録期間中でない出張項目は削除できません。');
      err.status = 403;
      throw err;
    }
    if (!kyomu) {
      const rows = await examModel.listTrips(examMasterId);
      const target = rows.find((r) => r.id === id);
      if (!target) {
        const err = new Error('対象レコードが見つかりません。');
        err.status = 404;
        throw err;
      }
      if (target.teacher_id !== user.id) {
        const err = new Error('自分の出張項目のみ削除できます。');
        err.status = 403;
        throw err;
      }
      await examModel.deleteTrip(examMasterId, target.teacher_id, target.day_number, target.slot_number);
      return { ok: true };
    }

    const rows = await examModel.listTrips(examMasterId);
    const target = rows.find((r) => r.id === id);
    if (!target) {
      const err = new Error('対象レコードが見つかりません。');
      err.status = 404;
      throw err;
    }
    await examModel.deleteTrip(examMasterId, target.teacher_id, target.day_number, target.slot_number);
    return { ok: true };
  },

  async endTripSurvey(examMasterId, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    const phases = await examModel.setPhase(examMasterId, 'trip_phase', PHASE.ENDED, user.id);
    const count = await examModel.listTrips(examMasterId);
    await audit('EXAM_TRIP_END', user, 'exam_master', examMasterId, `考査「${master.title}」の出張等登録を終了（${count.length}件）`);
    return phases;
  },

  /** 出張等リストの公表（PUBLISHED） */
  async publishTripList(examMasterId, user) {
    ensureKyomu(user);
    const trips = await examModel.listTrips(examMasterId);
    const phases = await examModel.setPhase(examMasterId, 'trip_phase', PHASE.PUBLISHED, user.id);
    await audit('EXAM_TRIP_PUBLISH', user, 'exam_master', examMasterId, `出張等を公表（${trips.length}件）`);
    return phases;
  },

  /** 出張等フェーズの終了（ENDED） */
  async endTripPhase(examMasterId, user) {
    ensureKyomu(user);
    return examModel.setPhase(examMasterId, 'trip_phase', PHASE.ENDED, user.id);
  },

  // ==========================================================
  // 試験監督割当（非常勤条件・特別教室・配慮）
  // ==========================================================
  async saveProctorRules(examMasterId, rules, user) {
    ensureKyomu(user);
    return examModel.saveRulesTable('exam_proctor_rules', examMasterId, rules, user.id);
  },

  async saveParttimeStaff(examMasterId, staff, user) {
    ensureKyomu(user);
    const condition = {
      max_slots_per_day: Number(staff.max_slots_per_day) || 1,
      max_consecutive_slots: Number(staff.max_consecutive_slots) || 1,
      allow_consecutive: !!staff.allow_consecutive,
      consecutive_rule: staff.consecutive_rule || 'MAX1',
    };
    return examModel.upsertParttimeStaff({
      exam_master_id: examMasterId,
      staff_id: staff.staff_id || staff.teacher_id,
      slot_condition: condition,
      notes: staff.notes || null,
      updated_by: user.id,
    });
  },

  async deleteParttimeStaff(examMasterId, teacherId, user) {
    ensureKyomu(user);
    await examModel.deleteParttimeStaff(examMasterId, teacherId);
    await audit('EXAM_PARTTIME_DEL', user, 'exam_master', examMasterId, `非常勤教員条件 (教員ID ${teacherId}) を削除`);
    return { ok: true };
  },

  async setParttimeAvailability(examMasterId, rows, user) {
    ensureKyomu(user);
    for (const r of rows) {
      await examModel.setParttimeAvailability(
        examMasterId,
        r.staff_id || r.teacher_id,
        Number(r.day_number),
        Number(r.slot_number),
        r.available !== false && r.can_work !== false,
        user.id
      );
    }
    await audit('EXAM_PARTTIME_SET', user, 'exam_master', examMasterId, `非常勤出勤可能コマを ${rows.length}件 設定`);
    return { saved: rows.length };
  },

  async saveTeacherConstraint(examMasterId, row, user) {
    ensureKyomu(user);
    return examModel.upsertTeacherConstraint({
      exam_master_id: examMasterId,
      teacher_id: row.teacher_id,
      constraint_type: {
        max_slots_per_day: Number(row.max_slots_per_day) || null,
        max_consecutive_slots: Number(row.max_consecutive_slots) || null,
        notes: row.notes || null,
      },
      notes: row.notes || null,
      updated_by: user.id,
    });
  },

  async addExemption(examMasterId, row, user) {
    ensureKyomu(user);
    return examModel.addExemption({
      exam_master_id: examMasterId,
      teacher_id: row.teacher_id,
      reason: row.reason || '教務による監督免除',
      exempted_by: user.id,
    });
  },

  async removeExemption(examMasterId, teacherId, user) {
    ensureKyomu(user);
    return examModel.removeExemption(examMasterId, teacherId);
  },

  /** 監督割当ソルバー入力の構築（時間割・教室割当・出欠・非常勤・免除・ルール） */
  async buildProctorInput(examMasterId, user) {
    const master = await ensureMaster(examMasterId);
    const slots = await examModel.listSlots(examMasterId);
    const plan = await examModel.listSubjectPlan(examMasterId);
    const units = planToUnits(plan);
    const unitsById = new Map(units.map((u) => [u.id, u]));

    const rooms = await examModel.listRooms(examMasterId);
    const roomConfig = {
      special_rooms: rooms
        .filter((r) => ['SP1', 'SP2', 'PREP1'].includes(String(r.room_type || '').toUpperCase()))
        .map((r) => ({ type: String(r.room_type).toUpperCase(), room_name: r.name })),
    };
    const roomTypeByName = new Map(rooms.map((r) => [r.name, String(r.room_type || 'CLASS').toUpperCase()]));

    const staffPool = await examModel.fetchStaffPool();
    const constraints = await examModel.listTeacherConstraints(examMasterId, 'PROCTOR');
    const constraintMap = new Map(constraints.map((c) => [c.teacher_id, c.constraint_type || {}]));

    const teachers = staffPool.map((t) => {
      const c = constraintMap.get(t.id) || {};
      return {
        id: t.id,
        name: t.name,
        is_parttime: !!t.is_parttime,
        is_kyomu: !!t.is_kyomu,
        daily_limit: c.max_slots_per_day ? Number(c.max_slots_per_day) : null,
        max_consecutive: c.max_consecutive_slots ? Number(c.max_consecutive_slots) : null,
      };
    });

    const parttimeStaff = (await examModel.listParttimeStaff(examMasterId)).map((p) => ({
      id: p.id,
      staff_id: p.staff_id ?? p.teacher_id,
      teacher_id: p.staff_id ?? p.teacher_id,
      staff_name: p.staff_name ?? p.name ?? null,
      daily_limit: p.slot_condition?.max_slots_per_day ?? null,
      max_consecutive: p.slot_condition?.max_consecutive_slots ?? null,
      consecutive_rule: p.consecutive_rule ?? 'MAX1',
      notes: p.notes ?? null,
    }));

    const availability = (await examModel.listParttimeAvailability(examMasterId)).map((a) => ({
      staff_id: a.staff_id ?? a.teacher_id,
      teacher_id: a.staff_id ?? a.teacher_id,
      staff_name: a.staff_name ?? null,
      day_number: Number(a.day_number),
      slot_number: Number(a.slot_number),
      available: a.available !== false,
      can_work: a.available !== false,
    }));

    const trips = (await examModel.listTrips(examMasterId)).map((t) => ({
      teacher_id: t.teacher_id,
      day_number: Number(t.day_number),
      slot_number: Number(t.slot_number),
      reason: t.reason,
    }));

    const exemptions = await examModel.listExemptions(examMasterId, 'PROCTOR');
    const rules = await examModel.getRulesTable('exam_proctor_rules', examMasterId, DEFAULT_PROCTOR_RULES);

    const roomAssignRows = await examModel.listRoomAssignments(examMasterId);
    const roomAssignMap = new Map(roomAssignRows.map((r) => [`${r.grade}|${r.day_number}|${r.slot_number}`, r.room_name]));
    const roomCells = roomAssignRows.map((r) => ({
      grade: Number(r.grade),
      day: Number(r.day_number),
      slot: Number(r.slot_number),
      room_name: r.room_name,
      unit_id: r.unit_id ?? null,
    }));

    const timetable = slotsToTimetable(slots).map((t) => ({
      unit_id: t.unit_id,
      grade: t.grade,
      day: t.day,
      slot: t.slot,
      duration_slots: unitsById.get(t.unit_id)?.duration_slots ?? t.duration_slots,
      subject_name: t.subject_name,
    }));

    const proctorRows = await examModel.listProctorAssignments(examMasterId);

    return {
      master,
      unitsById,
      roomAssignMap,
      roomTypeByName,
      roomConfig,
      proctorRows,
      teachers,
      staffPool,
      parttimeStaff,
      availability,
      trips,
      exemptions,
      constraints: constraints.map((c) => ({
        teacher_id: c.teacher_id,
        teacher_name: c.teacher_name ?? null,
        max_slots_per_day: c.constraint_type?.max_slots_per_day ?? null,
        max_consecutive_slots: c.constraint_type?.max_consecutive_slots ?? null,
        notes: c.notes ?? null,
      })),
      rules,
      timetable,
      input: {
        days: master.days_count,
        slots: master.daily_slots,
        units,
        timetable,
        teachers,
        parttime_staff: parttimeStaff,
        parttime_availability: availability,
        trips,
        room_cells: roomCells,
        room_config: roomConfig,
        exempted_ids: exemptions.map((e) => e.teacher_id),
        rules,
      },
    };
  },

  async solveProctorBoard(examMasterId, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    if (master.proctor_phase === PHASE.ENDED) {
      const err = new Error('監督割当フェーズは終了済みです。');
      err.status = 403;
      throw err;
    }

    const built = await this.buildProctorInput(examMasterId, user);
    if (built.timetable.length === 0) {
      const err = new Error('試験時間割が作成されていません。先に時間割を作成してください。');
      err.status = 400;
      throw err;
    }

    const unitsById = built.unitsById;
    const roomAssignMap = built.roomAssignMap;
    const roomConfig = built.roomConfig;
    const roomNameByType = new Map(roomConfig.special_rooms.map((s) => [s.type, s.room_name]));

    const result = solveProctor(built.input);

    const rows = result.assignments.map((a) => {
      const unit = unitsById.get(a.unit_id) || {};
      const isSpecial = a.kind === 'SPECIAL';
      return {
        grade: a.grade,
        class_id: isSpecial ? roomNameByType.get(a.room_type) || a.room_type : `G${a.grade}`,
        day_number: a.day,
        slot_number: a.slot,
        subject_name: a.subject_name,
        proctor_teacher_id: a.proctor_teacher_id,
        setter_teacher_id: unit.setter_teacher_id || null,
        setter_teacher_name: unit.setter_teacher_name || null,
        room_name: isSpecial ? roomNameByType.get(a.room_type) || a.room_type : roomAssignMap.get(`${a.grade}|${a.day}|${a.slot}`) || null,
        notes: a.proctor_teacher_id ? null : '未割当',
      };
    });

    await examModel.saveProctorAssignments(examMasterId, rows, user.id);
    await examModel.setPhase(examMasterId, 'proctor_phase', PHASE.DRAFT, user.id);
    await audit('EXAM_PROCTOR_SOLVE', user, 'exam_master', examMasterId, `試験監督割当を自動作成（${rows.length}件 / 未割当 ${result.unassigned}）`);

    return result;
  },

  /** 監督割当ボード取得（教務は全件、教員は担当コマ中心） */
  async getProctorBoard(examMasterId, user) {
    const built = await this.buildProctorInput(examMasterId, user);
    const phases = await examModel.getPhases(examMasterId);
    const rows = built.proctorRows.map((r) => ({
      id: r.id,
      grade: Number(r.grade),
      day_number: Number(r.day_number),
      slot_number: Number(r.slot_number),
      subject_name: r.subject_name,
      room_name: r.room_name,
      room_type: built.roomTypeByName.get(r.room_name) ?? null,
      proctor_teacher_id: r.proctor_teacher_id,
      proctor_name: r.proctor_name,
      setter_teacher_id: r.setter_teacher_id,
      setter_teacher_name: r.setter_teacher_name,
      is_mine: String(r.proctor_teacher_id) === String(user.id),
      notes: r.notes,
    }));

    const diagnostics = validateProctor(built.input, rows);
    const hard = diagnostics.filter((d) => d.level === 'HARD');

    const loads = new Map();
    for (const r of rows) {
      if (!r.proctor_teacher_id) continue;
      loads.set(r.proctor_teacher_id, (loads.get(r.proctor_teacher_id) || 0) + 1);
    }

    return {
      master: built.master,
      phases,
      cells: rows,
      staff: built.teachers,
      parttime_staff: built.parttimeStaff,
      availability: built.availability,
      trips: built.trips,
      exemptions: built.exemptions,
      constraints: built.constraints,
      rules: built.rules,
      special_rooms: built.roomConfig.special_rooms,
      diagnostics,
      hard_count: hard.length,
      ok: hard.length === 0,
      loads: [...loads.entries()].map(([id, load]) => ({ id, load })),
      is_kyomu: isKyomu(user),
    };
  },

  /** 手動編集済み監督割当の検証（出張・非常勤出勤・日上限・特別教室ローテーション） */
  async validateProctorRows(examMasterId, rows, user) {
    const built = await this.buildProctorInput(examMasterId, user);
    const normalized = (rows || []).map((r) => ({
      ...r,
      room_type: r.room_type ?? built.roomTypeByName.get(r.room_name) ?? null,
    }));
    const diagnostics = validateProctor(built.input, normalized);
    const hard = diagnostics.filter((d) => d.level === 'HARD');
    return { diagnostics, hard_count: hard.length, ok: hard.length === 0 };
  },

  /** 試験監督スタッフプール（教務:全教員 / 教員:同僚+自分） */
  async getStaffPool(user) {
    const staff = await examModel.fetchStaffPool();
    const isTeacher = !isKyomu(user);
    const grade = Number(user.grade) || 0;
    return {
      staff: isTeacher
        ? staff.filter((s) => s.id === user.id || grade === 0 || (s.grade && s.grade === grade))
        : staff,
      is_kyomu: isKyomu(user),
    };
  },

  /** 実施科目調査リスト（教員は担当学年のみ） */
  async getSubjects(examMasterId, user) {
    const plan = await examModel.listSubjectPlan(examMasterId);
    const isTeacher = !isKyomu(user);
    const grade = Number(user.grade) || 0;
    const filtered = isTeacher
      ? plan.filter((p) => (grade === 0 || Number(p.grade) === grade) && String(p.setter_teacher_id) === String(user.id))
      : plan;
    return { subjects: filtered, is_kyomu: isKyomu(user) };
  },

  /** 試験時間割スロット（教員は担当学年のみ） */
  async getSlots(examMasterId, user) {
    const slots = await examModel.listSlots(examMasterId);
    const isTeacher = !isKyomu(user);
    const grade = Number(user.grade) || 0;
    return {
      slots: isTeacher ? slots.filter((s) => grade === 0 || Number(s.grade) === grade) : slots,
      is_kyomu: isKyomu(user),
    };
  },

  /** 出張等リスト（教員は自分の行中心） */
  async getTrips(examMasterId, user) {
    const trips = await examModel.listTrips(examMasterId);
    const isTeacher = !isKyomu(user);
    return {
      trips: isTeacher ? trips.filter((t) => Number(t.teacher_id) === Number(user.id)) : trips,
      is_kyomu: isKyomu(user),
    };
  },

  /** 公表済み試験時間割 */
  async getPublishedTimetable(examMasterId, user) {
    const slots = await examModel.listSlots(examMasterId);
    const isTeacher = !isKyomu(user);
    const grade = Number(user.grade) || 0;
    return { slots: isTeacher ? slots.filter((s) => grade === 0 || Number(s.grade) === grade) : slots };
  },

  /** 公表済み試験教室割当 */
  async getPublishedRooms(examMasterId, user) {
    const rooms = await examModel.listRoomAssignments(examMasterId);
    const isTeacher = !isKyomu(user);
    const grade = Number(user.grade) || 0;
    return { rooms: isTeacher ? rooms.filter((r) => grade === 0 || Number(r.grade) === grade) : rooms };
  },

  /** 公表済み試験監督割当 */
  async getPublishedProctors(examMasterId, user) {
    const proctors = await examModel.listProctorAssignments(examMasterId);
    const isTeacher = !isKyomu(user);
    return {
      proctors: isTeacher
        ? proctors.filter((p) => Number(p.proctor_teacher_id) === Number(user.id) || Number(p.setter_teacher_id) === Number(user.id))
        : proctors,
    };
  },

  /** 公表済み出張等 */
  async getPublishedTrips(examMasterId, user) {
    const trips = await examModel.listTrips(examMasterId);
    const isTeacher = !isKyomu(user);
    return { trips: isTeacher ? trips.filter((t) => Number(t.teacher_id) === Number(user.id)) : trips };
  },

  /** 監督免除教員登録（教務のみ） */
  async saveProctorExemption(examMasterId, row, user) {
    ensureKyomu(user);
    return this.addExemption(examMasterId, { ...row, type: 'PROCTOR' }, user);
  },

  /** 監督免除教員の解除（教務のみ） */
  async deleteProctorExemption(examMasterId, teacherId, user) {
    ensureKyomu(user);
    return this.removeExemption(examMasterId, teacherId, user);
  },

  async saveProctorAssignments(examMasterId, rows, user) {
    ensureKyomu(user);
    const master = await ensureMaster(examMasterId);
    if (master.proctor_phase === PHASE.ENDED) {
      const err = new Error('監督割当フェーズは終了済みです。');
      err.status = 403;
      throw err;
    }

    const normalized = rows.map((r) => ({
      grade: Number(r.grade),
      class_id: r.class_id || `G${Number(r.grade)}`,
      day_number: Number(r.day_number),
      slot_number: Number(r.slot_number),
      subject_name: r.subject_name || null,
      proctor_teacher_id: r.proctor_teacher_id || null,
      setter_teacher_id: r.setter_teacher_id || null,
      setter_teacher_name: r.setter_teacher_name || null,
      room_name: r.room_name || null,
      notes: r.notes || null,
    }));

    await examModel.saveProctorAssignments(examMasterId, normalized, user.id);
    await audit('EXAM_PROCTOR_SAVE', user, 'exam_master', examMasterId, `試験監督割当を手動編集（${normalized.length}件）`);
    return { saved: normalized.length };
  },

  async publishProctor(examMasterId, user) {
    ensureKyomu(user);
    const list = await examModel.listProctorAssignments(examMasterId);
    if (list.length === 0) {
      const err = new Error('監督割当が存在しません。先に自動作成を行ってください。');
      err.status = 400;
      throw err;
    }
    const unassigned = list.filter((p) => !p.proctor_teacher_id).length;
    if (unassigned > 0) {
      const err = new Error(`未割当のコマが ${unassigned} 件あります。監督教員を割り当ててから公表してください。`);
      err.status = 400;
      throw err;
    }
    const phases = await examModel.setPhase(examMasterId, 'proctor_phase', PHASE.PUBLISHED, user.id);
    await audit('EXAM_PROCTOR_PUBLISH', user, 'exam_master', examMasterId, `試験監督割当を公表（${list.length}件）`);
    return phases;
  },

  async endProctor(examMasterId, user) {
    ensureKyomu(user);
    return examModel.setPhase(examMasterId, 'proctor_phase', PHASE.ENDED, user.id);
  },


  // ==========================================================
  // 公表ビュー（全ユーザー向け）
  // ==========================================================
  async findActiveMaster() {
    const masters = await examModel.listExamMasters();
    return masters[0] || null;
  },

  // ==========================================================
  // フェーズ制御
  // ==========================================================
  async setPhase(examMasterId, phaseKey, phaseValue, user) {
    ensureKyomu(user);
    const keys = ['subject_phase', 'timetable_phase', 'room_phase', 'proctor_phase', 'trip_phase'];
    if (!keys.includes(phaseKey)) {
      const err = new Error('不明なフェーズです。');
      err.status = 400;
      throw err;
    }
    const values = [PHASE.DRAFT, PHASE.SURVEY, PHASE.PUBLISHED, PHASE.ENDED];
    if (!values.includes(phaseValue)) {
      const err = new Error('不明なフェーズ状態です。');
      err.status = 400;
      throw err;
    }
    const phases = await examModel.getPhases(examMasterId);
    if (phaseKey === 'proctor_phase' && phaseValue === PHASE.PUBLISHED && phases.timetable_phase !== PHASE.PUBLISHED && phases.timetable_phase !== PHASE.ENDED) {
      const err = new Error('時間割が作成されていないため、監督割当を公表できません。');
      err.status = 400;
      throw err;
    }
    await logPhase(examMasterId, phaseKey, phases[phaseKey], phaseValue, user.id);
    await audit('EXAM_PHASE', user, 'exam_master', examMasterId, `${phaseKey} → ${phaseValue}`);
    return examModel.getPhases(examMasterId);
  },

  async getPublishedView(examMasterId, user) {
    const master = await ensureMaster(examMasterId);
    const phases = await examModel.getPhases(examMasterId);

    const slots = await examModel.listSlots(examMasterId);
    const roomAssignments = await examModel.listRoomAssignments(examMasterId);
    const proctors = await examModel.listProctorAssignments(examMasterId);
    const trips = await examModel.listTrips(examMasterId);

    const grade = Number(user.grade) || 0;

    const timetableGrid = [];
    if (phases.timetable_phase === PHASE.PUBLISHED || phases.timetable_phase === PHASE.ENDED) {
      for (const g of master.grades) {
        // 教員は自分の学年のみ、教務/管理職（grade 0）は全学年を表示
        if (grade > 0 && Number(g) !== grade) continue;
        for (let d = 1; d <= master.days_count; d++) {
          for (let s = 1; s <= master.daily_slots; s++) {
            const cell = slots.find((x) => Number(x.grade) === Number(g) && Number(x.day_number) === d && Number(x.slot_number) === s);
            if (cell) {
              timetableGrid.push({ grade: g, day: d, slot: s, subject_name: cell.subject_name, setter: cell.setter_teacher_name, span: cell.slot_span });
            }
          }
        }
      }
    }

    const roomGrid = (phases.room_phase === PHASE.PUBLISHED || phases.room_phase === PHASE.ENDED)
      ? roomAssignments
          .filter((r) => grade === 0 || Number(r.grade) === grade)
          .map((r) => ({ grade: r.grade, day: r.day_number, slot: r.slot_number, room_name: r.room_name, subject_name: r.subject_name }))
      : [];

    const myProctor = (phases.proctor_phase === PHASE.PUBLISHED || phases.proctor_phase === PHASE.ENDED)
      ? proctors
          .filter((p) => p.proctor_teacher_id === user.id)
          .map((p) => ({ grade: p.grade, day: p.day_number, slot: p.slot_number, subject_name: p.subject_name, room_name: p.room_name }))
      : [];

    const myTrips = trips.filter((t) => t.teacher_id === user.id);

    return {
      master,
      phases,
      timetable: timetableGrid,
      rooms: roomGrid,
      my_proctor: myProctor,
      my_trips: myTrips,
      is_kyomu: isKyomu(user),
    };
  },
};

export default examService;

