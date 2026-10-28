/**
 * ISSystem User & Authentication Data Access Model
 * 教職員ユーザー情報(staff_code基盤) PostgreSQL (pg) 準拠モデル
 */

import { query } from '../../config/database.js';
import { openDb, nowIso } from '../utils/db.js';

/** モデル層用 SQLite 互換アダプタ (共有プール借用 / close() は no-op) */
async function getDb() {
  return openDb();
}

// 自動マイグレーション: avatar_url カラムの存在確認と追加 (PostgreSQL)
async function ensureAvatarColumn() {
  try {
    const db = await getDb();
    const tableInfo = await db.query(
      `SELECT column_name AS name FROM information_schema.columns WHERE table_name = 'users'`
    );
    const hasAvatar = tableInfo.rows.some((col) => col.name === 'avatar_url');
    if (!hasAvatar) {
      await db.query("ALTER TABLE users ADD COLUMN avatar_url TEXT");
      console.log('[Database Migration] users テーブルに avatar_url カラムを追加しました。');
    }
  } catch (err) {
    // 42P01 = users テーブル未作成 (db:init 未実行)。警告ではなく案内として扱う
    if (err && err.code === '42P01') {
      console.log('[Database Migration] users テーブル未作成: npm run db:init を実行してください。');
    } else {
      console.warn('[Database Migration Warning] ensureAvatarColumn failed:', err.message);
    }
  }
}
ensureAvatarColumn();

const mockUsers = new Map();
const mockInvitationCodes = new Map();

export const userModel = {
  /**
   * ユーザーIDによる教職員アカウントの検索
   */
  async findById(id) {
    if (!id) return null;
    if (mockUsers.has(id)) return mockUsers.get(id);

    try {
      const res = await query(
        `SELECT id, staff_code, email, name, role, grade, department, extension_number, password_hash FROM users WHERE id = $1`,
        [id]
      );
      return res.rows[0] || null;
    } catch (err) {
      console.warn('[UserModel PG Warning] findById failed:', err.message);
      return null;
    }
  },

  /**
   * 教職員番号 (staff_code) によるアカウント検索 (仕様 v2.1.0 必須)
   */
  async findByStaffCode(staffCode) {
    if (!staffCode) return null;

    for (const u of mockUsers.values()) {
      if (u.staff_code && u.staff_code.toUpperCase() === String(staffCode).toUpperCase()) {
        return u;
      }
    }

    try {
      const res = await query(
        `SELECT id, staff_code, email, name, role, grade, department, extension_number, password_hash
         FROM users WHERE UPPER(staff_code) = UPPER($1) OR UPPER(id) = UPPER($2)`,
        [staffCode, staffCode]
      );
      return res.rows[0] || null;
    } catch (err) {
      console.warn('[UserModel PG Warning] findByStaffCode failed:', err.message);
      return null;
    }
  },

  /**
   * メールアドレスによるアカウントの検索 (フォールバック用)
   */
  async findByEmail(email) {
    if (!email) return null;

    for (const u of mockUsers.values()) {
      if (u.email && u.email.toLowerCase() === String(email).toLowerCase()) return u;
    }

    try {
      const res = await query(
        `SELECT id, staff_code, email, name, role, grade, department, extension_number, password_hash FROM users WHERE LOWER(email) = LOWER($1)`,
        [email]
      );
      return res.rows[0] || null;
    } catch (err) {
      console.warn('[UserModel PG Warning] findByEmail failed:', err.message);
      return null;
    }
  },

  /**
   * 全教職員ユーザー一覧の取得
   */
  async listAll() {
    try {
      const res = await query(`SELECT id, staff_code, email, name, role, grade, department, extension_number, avatar_url FROM users ORDER BY name ASC`);
      return res.rows;
    } catch (err) {
      return Array.from(mockUsers.values());
    }
  },

  /**
   * 新規教職員ユーザーの登録
   */
  async create(userData) {
    // 教職員番号とパスワードハッシュを必須とする (name は初回未設定の空文字を許容)
    if (!userData.staff_code) {
      const staffErr = new Error('教職員番号 (staff_code) は必須です。');
      staffErr.statusCode = 400;
      throw staffErr;
    }
    if (!userData.password_hash) {
      const passErr = new Error('パスワードハッシュは必須です。');
      passErr.statusCode = 400;
      throw passErr;
    }
    const newUser = {
      id: userData.id || `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      staff_code: userData.staff_code,
      email: userData.email || null,
      password_hash: userData.password_hash,
      name: userData.name || '',
      role: userData.role || 'TEACHER',
      department: userData.department || null,
      extension_number: userData.extension_number || null,
      avatar_url: userData.avatar_url || null
    };

    mockUsers.set(newUser.id, newUser);

    try {
      const ts = nowIso();
      newUser.created_at = ts;
      newUser.updated_at = ts;
      await query(
        `INSERT INTO users (id, staff_code, email, password_hash, name, role, department, extension_number, avatar_url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [newUser.id, newUser.staff_code, newUser.email, newUser.password_hash, newUser.name, newUser.role, newUser.department, newUser.extension_number, newUser.avatar_url, ts, ts]
      );
    } catch (err) {
      console.warn('[UserModel PG Warning] create user failed:', err.message);
    }

    return newUser;
  },

  /**
   * プロファイル更新
   */
  async updateProfile(userId, profile) {
    try {
      const res = await query(`SELECT * FROM users WHERE id = $1`, [userId]);
      const user = res.rows[0];
      if (!user) return null;

      const name = profile.name !== undefined ? profile.name : user.name;
      const email = profile.email !== undefined ? profile.email : user.email;
      const department = profile.department !== undefined ? profile.department : user.department;
      const extension_number = profile.extension_number !== undefined ? profile.extension_number : user.extension_number;
      const avatar_url = profile.avatar_url !== undefined ? profile.avatar_url : (user.avatar_url || null);

      await query(
        `UPDATE users SET name = $1, email = $2, department = $3, extension_number = $4, avatar_url = $5, updated_at = $6 WHERE id = $7`,
        [name, email, department, extension_number, avatar_url, nowIso(), userId]
      );
      return { ...user, name, email, department, extension_number, avatar_url };
    } catch (err) {
      console.warn('[UserModel PG Warning] updateProfile failed:', err.message);
      return null;
    }
  },

  /**
   * ユーザーの削除
   */
  async delete(id) {
    try {
      await query(`DELETE FROM users WHERE id = $1`, [id]);
      return true;
    } catch (err) {
      console.warn('[UserModel PG Warning] delete user failed:', err.message);
      return false;
    }
  },

  /**
   * パスワードハッシュの更新
   */
  async updatePasswordHash(userId, newPasswordHash) {
    // モックキャッシュ (mockUsers) にも同一ハッシュを反映して、
    // findByStaffCode / findById がキャッシュ経由で旧ハッシュを返すのを防ぐ
    const cached = mockUsers.get(userId);
    if (cached) {
      cached.password_hash = newPasswordHash;
    }
    for (const u of mockUsers.values()) {
      if (u && u.staff_code === (cached && cached.staff_code)) {
        u.password_hash = newPasswordHash;
      }
    }

    try {
      await query(`UPDATE users SET password_hash = $1 WHERE id = $2 OR staff_code = $3`, [newPasswordHash, userId, userId]);
    } catch (err) {
      console.warn('[UserModel PG Warning] updatePasswordHash failed:', err.message);
    }
  },

  /**
   * 在席ステータスを seating_status へ反映 (仕様: PRESENT / CLASS / TRIP / LEAVE)
   */
  async updateStatus(userId, status, statusNote = '') {
    const normalized = status === 'IN' ? 'PRESENT' : status === 'OUT' ? 'LEAVE' : status;
    const ts = nowIso();
    try {
      const db = await getDb();
      const existingRes = await db.query(`SELECT * FROM seating_status WHERE user_id = $1`, [userId]);
      const existing = existingRes.rows[0];
      if (existing) {
        await db.query(
          `UPDATE seating_status SET current_status = $1, status_note = $2, updated_at = $3 WHERE user_id = $4`,
          [normalized, statusNote || existing.status_note || '', ts, userId]
        );
      } else {
        await db.query(
          `INSERT INTO seating_status (id, user_id, desk_number, group_zone, current_status, status_note, updated_at)
           VALUES ($1, $2, $3, 'staff', $4, $5, $6)`,
          [`seat_${userId}`, userId, '-', normalized, statusNote || '', ts]
        );
      }
      const userRes = await db.query(
        `SELECT id, staff_code, email, name, role, grade, department, extension_number FROM users WHERE id = $1`,
        [userId]
      );
      const user = userRes.rows[0];
      return { ...user, status: normalized, current_status: normalized };
    } catch (err) {
      console.warn('[UserModel PG Warning] updateStatus failed:', err.message);
      return { id: userId, status: normalized, current_status: normalized };
    }
  },

  /**
   * 招待コード関連
   */
  async createInvitationCode(code, createdByUserId, expiresAt) {
    const invData = {
      id: `inv_${Date.now()}`,
      code,
      created_by_user_id: createdByUserId,
      is_used: 0,
      expires_at: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
      created_at: new Date().toISOString()
    };

    try {
      await query(
        `INSERT INTO invitation_codes (id, code, created_by_user_id, is_used, expires_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)`,
        [invData.id, invData.code, invData.created_by_user_id, invData.is_used, invData.expires_at, invData.created_at]
      );
    } catch (err) {
      console.warn('[UserModel PG Warning] createInvitationCode insert failed:', err.message);
      mockInvitationCodes.set(code, invData);
    }
    return invData;
  },

  async findInvitationCode(code) {
    try {
      const db = await getDb();
      const inv = await db.get(`SELECT * FROM invitation_codes WHERE code = ? AND is_used = 0 AND expires_at > CURRENT_TIMESTAMP`, [code]);
      await db.close();
      return inv || mockInvitationCodes.get(code) || null;
    } catch (err) {
      return mockInvitationCodes.get(code) || null;
    }
  },

  async markInvitationCodeUsed(code, usedByUserId) {
    try {
      await query(`UPDATE invitation_codes SET is_used = 1, used_by_user_id = $1 WHERE code = $2`, [usedByUserId, code]);
    } catch (err) {
      if (mockInvitationCodes.has(code)) {
        const inv = mockInvitationCodes.get(code);
        inv.is_used = 1;
      }
    }
  }
};

export default userModel;