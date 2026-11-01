/**
 * ISSystem 定期考査 基本情報マスタ Data Access Model
 * クラス・コース（自由文字列名）・教科・科目・教室の登録（教務部 KYOMU のみ）と、
 * 改名の CASCADE（考査計画・時間割・教室割・監督割）および使用中削除ガードを行う。
 */

import { query } from '../../config/database.js';
import { parseJson } from '../utils/db.js';

function safeJson(value, fallback) {
  return parseJson(value, fallback);
}

function genId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).substring(2, 8)}`;
}

/** JSON 文字列の配列から要素を除く */
function removeFromJson(raw, needle) {
  const arr = Array.isArray(raw) ? raw : safeJson(raw, []);
  return JSON.stringify(arr.filter((v) => String(v) !== String(needle)));
}

const GROUP_ROW = (g) => ({
  id: String(g.id),
  name: g.name,
  color_key: g.color_key || 'SLATE',
  sort_order: Number(g.sort_order) || 0,
});

const CLASS_ROW = (c) => ({
  id: String(c.id),
  grade: Number(c.grade) || 0,
  class_num: Number(c.class_num) || 0,
  name: c.name,
  short_name: c.short_name || c.name,
  course_ids: safeJson(c.course_ids, []).map(String),
  is_active: c.is_active !== false,
});

const SUBJECT_ROW = (s) => ({
  id: String(s.id),
  name: s.name,
  short_name: s.short_name || s.name,
  subject_id: s.subject_id || null,
  subject_group_name: s.group_name || null,
  grade: Number(s.grade) || 0,
  offerings: safeJson(s.offerings, []).map((o) => ({
    grade: Number(o?.grade) || 0,
    class_course_id: o?.class_course_id ? String(o.class_course_id) : null,
    room_id: o?.room_id ? String(o.room_id) : null,
  })),
  default_room_id: s.default_room_id ? String(s.default_room_id) : null,
  default_duration: Number(s.default_duration) || 50,
  is_active: s.is_active !== false,
  sort_order: Number(s.sort_order) || 0,
  notes: s.notes || null,
});

const ROOM_ROW = (r) => ({
  id: String(r.id),
  name: r.name,
  room_type: r.room_type || 'CLASS',
  seats: Number(r.seats) || 0,
  grades: safeJson(r.grades, []).map(Number),
  is_active: r.is_active !== false,
  notes: r.notes || null,
});

export const basicinfoModel = {
  // ==========================================================
  // 基本情報一括読み込み（grade>0 はその学年＋全学年の科目に限定）
  // ==========================================================
  async getBasicInfo(grade = null) {
    const gradeFilter = Number(grade) > 0 ? Number(grade) : null;
    const [groupsRes, classesRes, subjectsRes, roomsRes] = await Promise.all([
      query(`SELECT id, name, color_key, sort_order FROM subjects ORDER BY sort_order ASC, name ASC`),
      query(`SELECT * FROM classes ORDER BY grade ASC, class_num ASC, id ASC`),
      query(
        `SELECT cs.*, sg.name AS group_name, sg.sort_order AS group_sort
         FROM curriculum_subjects cs
         LEFT JOIN subjects sg ON sg.id = cs.subject_id
         ORDER BY COALESCE(sg.sort_order, 999) ASC, COALESCE(sg.name, 'zzzz') ASC, cs.name ASC`
      ),
      query(`SELECT * FROM basic_rooms ORDER BY name ASC`),
    ]);

    const classGradeById = new Map(classesRes.rows.map((c) => [String(c.id), Number(c.grade)]));

    return {
      subject_groups: groupsRes.rows.map(GROUP_ROW),
      classes: classesRes.rows
        .filter((c) => !gradeFilter || Number(c.grade) === gradeFilter)
        .map(CLASS_ROW),
      subjects: subjectsRes.rows
        .filter((s) => {
          if (!gradeFilter) return true;
          if (Number(s.grade) === gradeFilter) return true;
          const offers = safeJson(s.offerings, []);
          return offers.some((o) => classGradeById.get(String(o?.class_course_id)) === gradeFilter);
        })
        .map(SUBJECT_ROW),
      rooms: roomsRes.rows.map(ROOM_ROW),
    };
  },

  // ==========================================================
  // 使用件数（削除ガード・削除時のカスケード対象）
  // ==========================================================
  async subjectUsage(name) {
    const target = String(name).toLowerCase();
    const res = await query(
      `SELECT
        (SELECT count(*) FROM exam_subject_plan WHERE lower(subject_name) = ?) AS plan_rows,
        (SELECT count(*) FROM exam_slots WHERE lower(subject_name) = ?) AS slot_rows,
        (SELECT count(*) FROM exam_room_config WHERE lower(subject_name) = ?) AS room_config_rows,
        (SELECT count(*) FROM exam_room_assignments WHERE lower(subject_name) = ?) AS room_assign_rows,
        (SELECT count(*) FROM exam_proctor_assignments WHERE lower(subject_name) = ?) AS proctor_rows`,
      [target, target, target, target, target]
    );
    const r = res.rows[0] || {};
    const counts = {
      plan: Number(r.plan_rows) || 0,
      slots: Number(r.slot_rows) || 0,
      room_config: Number(r.room_config_rows) || 0,
      room_assignments: Number(r.room_assign_rows) || 0,
      proctors: Number(r.proctor_rows) || 0,
    };
    counts.total = Object.values(counts).reduce((a, b) => a + b, 0);
    return counts;
  },

  async roomUsage(roomId, name) {
    const id = String(roomId);
    const lower = String(name || '').toLowerCase();
    const res = await query(
      `SELECT
        (SELECT count(*) FROM curriculum_subjects WHERE default_room_id = ?) AS subject_defaults,
        (SELECT count(*) FROM curriculum_subjects WHERE offerings::jsonb @> ?::jsonb) AS offering_rows,
        (SELECT count(*) FROM exam_rooms WHERE room_id = ?) AS exam_room_rows,
        (SELECT count(*) FROM exam_room_config WHERE room_id = ?) AS room_config_rows,
        (SELECT count(*) FROM exam_room_assignments WHERE room_id = ?) AS room_assign_rows,
        (SELECT count(*) FROM exam_subject_plan WHERE room_id = ?) AS plan_rows,
        (SELECT count(*) FROM exam_room_assignments WHERE lower(room_name) = ?) AS room_assign_name_rows`,
      [id, JSON.stringify([{ room_id: id }]), id, id, id, id, lower]
    );
    const r = res.rows[0] || {};
    const counts = {
      subject_defaults: Number(r.subject_defaults) || 0,
      offerings: Number(r.offering_rows) || 0,
      exam_rooms: Number(r.exam_room_rows) || 0,
      room_config: Number(r.room_config_rows) || 0,
      room_assignments: Number(r.room_assign_rows) || 0,
      plan_rows: Number(r.plan_rows) || 0,
      room_assign_names: Number(r.room_assign_name_rows) || 0,
    };
    counts.total =
      counts.subject_defaults + counts.offerings + counts.room_assignments + counts.plan_rows + counts.room_assign_names;
    return counts;
  },

  async classUsage(classId) {
    const id = String(classId);
    const res = await query(
      `SELECT
        (SELECT count(*) FROM exam_slots WHERE class_id = ?) AS slot_rows,
        (SELECT count(*) FROM exam_proctor_assignments WHERE class_id = ?) AS proctor_rows,
        (SELECT count(*) FROM exam_subject_plan WHERE class_ids::jsonb @> ?::jsonb) AS plan_rows,
        (SELECT count(*) FROM curriculum_subjects WHERE offerings::jsonb @> ?::jsonb) AS offering_rows`,
      [id, id, JSON.stringify([id]), JSON.stringify([{ class_course_id: id }])]
    );
    const r = res.rows[0] || {};
    const counts = {
      slots: Number(r.slot_rows) || 0,
      proctors: Number(r.proctor_rows) || 0,
      plans: Number(r.plan_rows) || 0,
      offerings: Number(r.offering_rows) || 0,
    };
    counts.total = counts.slots + counts.proctors + counts.plans + counts.offerings;
    return counts;
  },

  // ==========================================================
  // 教科マスタ (subjects テーブルの参照・登録)
  // ==========================================================
  async listSubjectGroups() {
    const res = await query(`SELECT id, name, color_key, sort_order FROM subjects ORDER BY sort_order ASC, name ASC`);
    return res.rows.map(GROUP_ROW);
  },

  // ==========================================================
  // クラス (classes)
  // ==========================================================
  async listClasses(grade = null) {
    const gradeFilter = Number(grade) > 0 ? Number(grade) : null;
    const res = await query(`SELECT * FROM classes ORDER BY grade ASC, class_num ASC, id ASC`);
    return res.rows.filter((c) => !gradeFilter || Number(c.grade) === gradeFilter).map(CLASS_ROW);
  },

  async createClass(data) {
    const grade = Number(data.grade) || 0;
    let classNum = parseInt(data.class_num, 10) || 0;
    if (classNum < 1) {
      // クラス・コース名は自由文字列なので、内部ID用の採番は学年内の連続番号で自動発行する
      const maxRes = await query(`SELECT max(class_num) AS m FROM classes WHERE grade = ?`, [grade]);
      classNum = (Number(maxRes.rows[0]?.m) || 0) + 1;
    }
    const id = data.id || `${grade}-${classNum}`;
    const res = await query(
      `INSERT INTO classes (id, grade, class_num, name, short_name, course_ids, is_active, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (id) DO UPDATE SET
         grade = EXCLUDED.grade,
         class_num = EXCLUDED.class_num,
         name = EXCLUDED.name,
         short_name = EXCLUDED.short_name,
         course_ids = EXCLUDED.course_ids,
         is_active = EXCLUDED.is_active,
         updated_by = EXCLUDED.updated_by,
         updated_at = CURRENT_TIMESTAMP
       RETURNING *`,
      [
        id,
        grade,
        classNum,
        data.name,
        data.short_name || data.name,
        '[]',
        data.is_active !== false,
        data.updated_by ?? null,
      ]
    );
    return CLASS_ROW(res.rows[0]);
  },

  async updateClass(id, payload, updatedBy) {
    const sets = [];
    const params = [];
    const map = { grade: 'grade', class_num: 'class_num', name: 'name', short_name: 'short_name', is_active: 'is_active' };
    for (const [key, col] of Object.entries(map)) {
      if (payload[key] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(key === 'grade' || key === 'class_num' ? parseInt(payload[key], 10) || 0 : payload[key]);
      }
    }
    if (payload.course_ids !== undefined) {
      sets.push('course_ids = ?');
      params.push(JSON.stringify((payload.course_ids || []).map(String)));
    }
    if (sets.length === 0) return (await this.listClasses()).find((c) => String(c.id) === String(id)) || null;
    params.push(updatedBy ?? null, String(id));
    const res = await query(
      `UPDATE classes SET ${sets.join(', ')}, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *`,
      params
    );
    return res.rows[0] ? CLASS_ROW(res.rows[0]) : null;
  },

  /** クラスの削除（考査コマ・監督割を除去しプランの参照から CASCADE） */
  async deleteClass(id) {
    const target = String(id);
    const cascaded = { slots: 0, proctors: 0, plans: 0, offerings: 0 };
    const slotRows = (await query(`SELECT id FROM exam_slots WHERE class_id = ?`, [target])).rows;
    if (slotRows.length) {
      await query(`DELETE FROM exam_slots WHERE class_id = ?`, [target]);
      cascaded.slots = slotRows.length;
    }
    const proctorRows = (await query(`SELECT id FROM exam_proctor_assignments WHERE class_id = ?`, [target])).rows;
    if (proctorRows.length) {
      await query(`DELETE FROM exam_proctor_assignments WHERE class_id = ?`, [target]);
      cascaded.proctors = proctorRows.length;
    }
    const planRows = (await query(`SELECT id, class_ids FROM exam_subject_plan WHERE class_ids::jsonb @> ?::jsonb`, [JSON.stringify([target])])).rows;
    for (const p of planRows) {
      await query(`UPDATE exam_subject_plan SET class_ids = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [removeFromJson(p.class_ids, target), p.id]);
      cascaded.plans += 1;
    }
    // 科目マスタの開講・標準教室設定から当該クラス・コースの参照を除去
    const subRows = (
      await query(`SELECT id, offerings FROM curriculum_subjects WHERE offerings::jsonb @> ?::jsonb`, [JSON.stringify([{ class_course_id: target }])])
    ).rows;
    for (const s of subRows) {
      const kept = safeJson(s.offerings, []).filter((o) => String(o?.class_course_id) !== target);
      await query(`UPDATE curriculum_subjects SET offerings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(kept), s.id]);
      cascaded.offerings += 1;
    }
    await query(`DELETE FROM classes WHERE id = ?`, [target]);
    return cascaded;
  },

  // ==========================================================
  // 科目 (curriculum_subjects)
  // ==========================================================
  async listSubjects(grade = null) {
    const gradeFilter = Number(grade) > 0 ? Number(grade) : null;
    const res = await query(
      `SELECT cs.*, sg.name AS group_name, sg.sort_order AS group_sort
       FROM curriculum_subjects cs
       LEFT JOIN subjects sg ON sg.id = cs.subject_id
       ORDER BY COALESCE(sg.sort_order, 999) ASC, COALESCE(sg.name, 'zzzz') ASC, cs.name ASC`
    );
    const classGradeById = new Map(
      (await query(`SELECT id, grade FROM classes`)).rows.map((c) => [String(c.id), Number(c.grade)])
    );
    return res.rows
      .filter((s) => {
        if (!gradeFilter) return true;
        if (Number(s.grade) === gradeFilter) return true;
        return safeJson(s.offerings, []).some((o) => classGradeById.get(String(o?.class_course_id)) === gradeFilter);
      })
      .map(SUBJECT_ROW);
  },

  async createSubject(data) {
    const id = data.id || `csub${Date.now().toString(36)}`;
    const res = await query(
      `INSERT INTO curriculum_subjects
        (id, name, short_name, subject_id, grade, offerings, default_room_id, default_duration, is_active, sort_order, notes, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING *`,
      [
        id,
        data.name,
        data.short_name || data.name,
        data.subject_id ?? null,
        Number(data.grade) || 0,
        JSON.stringify(data.offerings || []),
        data.default_room_id ?? null,
        parseInt(data.default_duration, 10) || 50,
        data.is_active !== false,
        parseInt(data.sort_order, 10) || 0,
        data.notes ?? null,
        data.updated_by ?? null,
      ]
    );
    return SUBJECT_ROW(res.rows[0]);
  },

  /** 科目改名は考査計画・時間割・教室割・監督割の科目名へ CASCADE 反映 */
  async cascadeSubjectName(oldName, newName, updatedBy) {
    const old = String(oldName).toLowerCase();
    const cascaded = { plan: 0, slots: 0, room_config: 0, room_assignments: 0, proctors: 0 };
    const p = await query(`UPDATE exam_subject_plan SET subject_name = ?, subject_short = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE lower(subject_name) = ? RETURNING id`, [newName, newName, updatedBy, old]);
    cascaded.plan = p.rows.length;
    const s = await query(`UPDATE exam_slots SET subject_name = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE lower(subject_name) = ? RETURNING id`, [newName, updatedBy, old]);
    cascaded.slots = s.rows.length;
    const rc = await query(`UPDATE exam_room_config SET subject_name = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE lower(subject_name) = ? RETURNING id`, [newName, updatedBy, old]);
    cascaded.room_config = rc.rows.length;
    const ra = await query(`UPDATE exam_room_assignments SET subject_name = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE lower(subject_name) = ? RETURNING id`, [newName, updatedBy, old]);
    cascaded.room_assignments = ra.rows.length;
    const pr = await query(`UPDATE exam_proctor_assignments SET subject_name = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE lower(subject_name) = ? RETURNING id`, [newName, updatedBy, old]);
    cascaded.proctors = pr.rows.length;
    return cascaded;
  },

  async updateSubject(id, payload, updatedBy) {
    const sets = [];
    const params = [];
    const map = {
      name: 'name',
      short_name: 'short_name',
      subject_id: 'subject_id',
      grade: 'grade',
      default_room_id: 'default_room_id',
      default_duration: 'default_duration',
      is_active: 'is_active',
      sort_order: 'sort_order',
      notes: 'notes',
    };
    for (const [key, col] of Object.entries(map)) {
      if (payload[key] !== undefined) {
        sets.push(`${col} = ?`);
        const numeric = key === 'grade' || key === 'default_duration' || key === 'sort_order';
        params.push(numeric ? parseInt(payload[key], 10) || 0 : payload[key] ?? null);
      }
    }
    if (payload.offerings !== undefined) {
      sets.push('offerings = ?');
      params.push(
        JSON.stringify(
          (payload.offerings || []).map((o) => ({
            grade: Number(o?.grade) || 0,
            class_course_id: o?.class_course_id ? String(o.class_course_id) : null,
            room_id: o?.room_id ? String(o.room_id) : null,
          }))
        )
      );
    }
    if (sets.length === 0) return (await this.listSubjects()).find((s) => String(s.id) === String(id)) || null;

    const before = (await query(`SELECT name FROM curriculum_subjects WHERE id = ?`, [String(id)])).rows[0];
    params.push(updatedBy ?? null, String(id));
    const res = await query(
      `UPDATE curriculum_subjects SET ${sets.join(', ')}, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *`,
      params
    );
    const row = res.rows[0];
    if (!row) return null;
    let cascaded = null;
    if (payload.name && before && String(before.name) !== String(payload.name)) {
      cascaded = await this.cascadeSubjectName(before.name, payload.name, updatedBy ?? null);
    }
    return { ...SUBJECT_ROW(row), cascaded };
  },

  async deleteSubject(id) {
    await query(`DELETE FROM curriculum_subjects WHERE id = ?`, [String(id)]);
    return true;
  },

  // ==========================================================
  // 教室 (basic_rooms)
  // ==========================================================
  async listRooms() {
    const res = await query(`SELECT * FROM basic_rooms ORDER BY room_type ASC, name ASC`);
    return res.rows.map(ROOM_ROW);
  },

  async createRoom(data) {
    const id = data.id || `room${Date.now().toString(36)}`;
    const res = await query(
      `INSERT INTO basic_rooms (id, name, room_type, seats, grades, is_active, notes, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP) RETURNING *`,
      [
        id,
        data.name,
        'CLASS',
        parseInt(data.seats, 10) || 40,
        '[]',
        data.is_active !== false,
        data.notes ?? null,
        data.updated_by ?? null,
      ]
    );
    return ROOM_ROW(res.rows[0]);
  },

  /** 教室改名は考査教室・科目別標準教室・教室割当・実施科目プランへ CASCADE 反映 */
  async cascadeRoomName(roomId, oldName, newName, updatedBy) {
    const id = String(roomId);
    const old = String(oldName).toLowerCase();
    const cascaded = { exam_rooms: 0, room_config: 0, room_assignments: 0, plan_rows: 0 };

    const er = await query(
      `UPDATE exam_rooms SET name = ?, room_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE room_id = ? OR lower(name) = ? RETURNING id`,
      [newName, id, updatedBy, id, old]
    );
    cascaded.exam_rooms = er.rows.length;

    const configs = (await query(
      `SELECT id, standard_room, alt_rooms FROM exam_room_config WHERE room_id = ? OR standard_room = ? OR alt_rooms::jsonb @> ?::jsonb`,
      [id, oldName, JSON.stringify([oldName])]
    )).rows;
    for (const c of configs) {
      const alt = (safeJson(c.alt_rooms, []) || []).map((n) => (String(n).toLowerCase() === old ? newName : n));
      const standard = String(c.standard_room || '').toLowerCase() === old ? newName : c.standard_room;
      await query(
        `UPDATE exam_room_config SET standard_room = ?, alt_rooms = ?, room_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [standard, JSON.stringify(alt), id, updatedBy, c.id]
      );
      cascaded.room_config += 1;
    }

    const ra = await query(
      `UPDATE exam_room_assignments SET room_name = ?, base_room_id = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE room_id = ? OR lower(room_name) = ? RETURNING id`,
      [newName, id, updatedBy, id, old]
    );
    cascaded.room_assignments = ra.rows.length;

    const pl = await query(
      `UPDATE exam_subject_plan SET room_name = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
       WHERE room_id = ? OR lower(room_name) = ? RETURNING id`,
      [newName, updatedBy, id, old]
    );
    cascaded.plan_rows = pl.rows.length;

    return cascaded;
  },

  async updateRoom(id, payload, updatedBy) {
    const sets = [];
    const params = [];
    const map = { name: 'name', room_type: 'room_type', seats: 'seats', is_active: 'is_active', notes: 'notes' };
    for (const [key, col] of Object.entries(map)) {
      if (payload[key] !== undefined) {
        sets.push(`${col} = ?`);
        params.push(key === 'seats' ? parseInt(payload[key], 10) || 0 : payload[key] ?? null);
      }
    }
    if (payload.grades !== undefined) {
      sets.push('grades = ?');
      params.push(JSON.stringify((payload.grades || []).map(Number)));
    }
    if (sets.length === 0) return (await this.listRooms()).find((r) => String(r.id) === String(id)) || null;

    const before = (await query(`SELECT name FROM basic_rooms WHERE id = ?`, [String(id)])).rows[0];
    params.push(updatedBy ?? null, String(id));
    const res = await query(
      `UPDATE basic_rooms SET ${sets.join(', ')}, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *`,
      params
    );
    const row = res.rows[0];
    if (!row) return null;
    let cascaded = null;
    if (payload.name && before && String(before.name) !== String(payload.name)) {
      cascaded = await this.cascadeRoomName(String(id), before.name, payload.name, updatedBy ?? null);
    }
    return { ...ROOM_ROW(row), cascaded };
  },

  async deleteRoom(id) {
    const target = String(id);
    await query(`UPDATE curriculum_subjects SET default_room_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE default_room_id = ?`, [target]);
    // クラス・コース別の標準教室 (offerings) から参照を除去
    const subRows = (
      await query(`SELECT id, offerings FROM curriculum_subjects WHERE offerings::jsonb @> ?::jsonb`, [JSON.stringify([{ room_id: target }])])
    ).rows;
    for (const s of subRows) {
      const kept = safeJson(s.offerings, []).map((o) => (String(o?.room_id) === target ? { ...o, room_id: null } : o));
      await query(`UPDATE curriculum_subjects SET offerings = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [JSON.stringify(kept), s.id]);
    }
    await query(`UPDATE exam_subject_plan SET room_id = NULL, room_name = NULL, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?`, [target]);
    await query(`DELETE FROM exam_rooms WHERE room_id = ?`, [target]);
    await query(`UPDATE exam_room_config SET room_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE room_id = ?`, [target]);
    await query(`UPDATE exam_room_assignments SET base_room_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE base_room_id = ?`, [target]);
    await query(`DELETE FROM basic_rooms WHERE id = ?`, [target]);
    return true;
  },
};

export default basicinfoModel;

