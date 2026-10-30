/**
 * ISSystem Subject Catalog Data Access Model (教科マスタ)
 * 教科マスタの追加・改名・削除は教務部 (KYOMU) のみ。
 * 教員の担当教科 (users.subjects) は JSON 文字列の複数選択。
 */

import { query } from '../../config/database.js';

/** JSON 文字列を文字列配列へ正規化 */
export function parseSubjectList(raw) {
  if (Array.isArray(raw)) return raw.map((s) => String(s).trim()).filter(Boolean);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((s) => String(s).trim()).filter(Boolean) : [];
  } catch (err) {
    return [];
  }
}

const mockSubjects = new Map();

export const subjectModel = {
  /**
   * 教科マスタ一覧 (使用件数: 考査計画行・担当教員数)
   */
  async listSubjects() {
    try {
      const subsRes = await query(
        `SELECT id, name, color_key, sort_order FROM subjects ORDER BY sort_order ASC, name ASC`
      );
      const planRes = await query(
        `SELECT lower(subject_name) AS name, count(*) AS c FROM exam_subject_plan GROUP BY 1`
      );
      const userRes = await query(`SELECT id, subjects FROM users`);

      const planCounts = new Map(planRes.rows.map((r) => [String(r.name), Number(r.c)]));
      const userCounts = new Map();
      for (const u of userRes.rows) {
        for (const name of parseSubjectList(u.subjects)) {
          const key = String(name).toLowerCase();
          userCounts.set(key, (userCounts.get(key) || 0) + 1);
        }
      }

      return subsRes.rows.map((s) => ({
        id: String(s.id),
        name: s.name,
        color_key: s.color_key || 'SLATE',
        sort_order: Number(s.sort_order) || 0,
        plan_count: planCounts.get(String(s.name).toLowerCase()) || 0,
        teacher_count: userCounts.get(String(s.name).toLowerCase()) || 0,
      }));
    } catch (err) {
      console.warn('[SubjectModel PG Warning] listSubjects failed:', err.message);
      return Array.from(mockSubjects.values());
    }
  },
  /**
   * 教科の追加 (教務部のみ)
   */
  async createSubject({ id, name, color_key = 'SLATE', sort_order = 0 }) {
    const subjectId = id || `ko${Date.now().toString(36)}`;
    try {
      const res = await query(
        `INSERT INTO subjects (id, name, color_key, sort_order)
         VALUES (?, ?, ?, ?)
         RETURNING id, name, color_key, sort_order`,
        [subjectId, name, color_key, parseInt(sort_order, 10) || 0]
      );
      const row = res.rows[0];
      const subject = {
        id: String(row.id),
        name: row.name,
        color_key: row.color_key,
        sort_order: Number(row.sort_order) || 0,
        plan_count: 0,
        teacher_count: 0,
      };
      mockSubjects.set(subject.id, { ...subject });
      return subject;
    } catch (err) {
      console.warn('[SubjectModel PG Warning] createSubject failed:', err.message);
      const subject = {
        id: subjectId,
        name,
        color_key,
        sort_order: parseInt(sort_order, 10) || 0,
        plan_count: 0,
        teacher_count: 0,
      };
      mockSubjects.set(subject.id, subject);
      return subject;
    }
  },

  /**
   * 教科の改名・色・表示順変更 (教務部のみ)
   * 改名時は考査計画・時間割・監督割当・教員の担当教科へCASCADE反映する
   */
  async updateSubject(id, { name, color_key, sort_order }) {
    const subjectId = String(id);
    const existing = await query(`SELECT id, name FROM subjects WHERE id = ?`, [subjectId]);
    const oldName = existing.rows[0] && existing.rows[0].name;
    if (!oldName) {
      return null;
    }

    try {
      const res = await query(
        `UPDATE subjects
         SET name = COALESCE(?, name), color_key = COALESCE(?, color_key),
             sort_order = COALESCE(?, sort_order)
         WHERE id = ?
         RETURNING id, name, color_key, sort_order`,
        [name || null, color_key || null, sort_order === undefined ? null : parseInt(sort_order, 10), subjectId]
      );

      const row = res.rows[0] || null;
      const updated = {
        id: subjectId,
        name: row ? row.name : (name || oldName),
        color_key: row ? row.color_key : color_key,
        sort_order: row ? Number(row.sort_order) : (Number(sort_order) || 0),
      };

      // 改名は考査計画の教科名と教員の担当教科へCASCADE反映 (exam_slots 等は subject_id 参照のため改名の影響なし)
      const cascaded = { users: 0, plan: 0 };
      if (updated.name && String(oldName) !== String(updated.name)) {
        const planRes = await query(
          `UPDATE exam_subject_plan SET subject_name = ? WHERE lower(subject_name) = lower(?) RETURNING id`,
          [updated.name, oldName]
        );
        cascaded.plan = planRes.rowCount ?? planRes.rows.length;

        const userRes = await query(`SELECT id, subjects FROM users`);
        for (const u of userRes.rows) {
          const list = parseSubjectList(u.subjects);
          const replaced = list.map((n) =>
            String(n).toLowerCase() === String(oldName).toLowerCase() ? updated.name : n
          );
          const changed = replaced.some((n, i) => n !== list[i]);
          if (changed) {
            await query(
              `UPDATE users SET subjects = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [JSON.stringify(replaced), u.id]
            );
            cascaded.users += 1;
          }
        }
      }

      mockSubjects.set(subjectId, { ...(mockSubjects.get(subjectId) || {}), ...updated });
      return { ...updated, cascaded };
    } catch (err) {
      console.warn('[SubjectModel PG Warning] updateSubject failed:', err.message);
      const base = mockSubjects.get(subjectId);
      if (!base) return null;
      const updated = {
        ...base,
        ...(name ? { name } : {}),
        ...(color_key ? { color_key } : {}),
        ...(sort_order !== undefined ? { sort_order: parseInt(sort_order, 10) } : {}),
      };
      mockSubjects.set(subjectId, updated);
      return { ...updated, cascaded: { users: 0, plan: 0 } };
    }
  },
  /**
   * 教科の削除 (教務部のみ)
   * 考査計画で使用中の場合は service 側で削除前に検証する
   * 教員の担当教科から該当名称を除去する
   */
  async deleteSubject(id) {
    const subjectId = String(id);
    const res = await query(`SELECT name FROM subjects WHERE id = ?`, [subjectId]);
    const name = res.rows[0] && res.rows[0].name;

    try {
      await query(`DELETE FROM subjects WHERE id = ?`, [subjectId]);
      let removedFromUsers = 0;
      if (name) {
        const userRes = await query(`SELECT id, subjects FROM users`);
        for (const u of userRes.rows) {
          const list = parseSubjectList(u.subjects);
          const kept = list.filter((n) => String(n).toLowerCase() !== String(name).toLowerCase());
          if (kept.length !== list.length) {
            await query(
              `UPDATE users SET subjects = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
              [JSON.stringify(kept), u.id]
            );
            removedFromUsers += 1;
          }
        }
      }
      mockSubjects.delete(subjectId);
      return { id: subjectId, name, removed_from_users: removedFromUsers };
    } catch (err) {
      console.warn('[SubjectModel PG Warning] deleteSubject failed:', err.message);
      mockSubjects.delete(subjectId);
      return { id: subjectId, name, removed_from_users: 0 };
    }
  },

  /**
   * 教員ごとの担当教科設定 (users.subjects)
   */
  async setUserSubjects(userId, subjects) {
    const list = parseSubjectList(subjects);
    try {
      const res = await query(
        `UPDATE users SET subjects = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, name, subjects`,
        [JSON.stringify(list), userId]
      );
      return res.rows[0] || { id: userId, subjects: list };
    } catch (err) {
      console.warn('[SubjectModel PG Warning] setUserSubjects failed:', err.message);
      return { id: userId, subjects: list };
    }
  },

  /**
   * 登録済みの教科名集合 (担当教科バリデーション用)
   */
  async subjectNames() {
    try {
      const res = await query(`SELECT name FROM subjects`);
      return new Set(res.rows.map((r) => String(r.name)));
    } catch (err) {
      console.warn('[SubjectModel PG Warning] subjectNames failed:', err.message);
      return new Set(Array.from(mockSubjects.values()).map((s) => s.name));
    }
  },
};

export default subjectModel;

