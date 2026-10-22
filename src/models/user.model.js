/**
 * ISSystem User & Authentication Data Access Model
 * 教職員ユーザー情報(staff_code基盤) SQLite 実テーブル構造 完全準拠モデル
 */

import { openDb, nowIso } from '../utils/db.js';

async function getDb() {
  return openDb();
}

// 自動マイグレーション: avatar_url カラムの存在確認と追加
async function ensureAvatarColumn() {
  try {
    const db = await getDb();
    const tableInfo = await db.all("PRAGMA table_info(users);");
    const hasAvatar = tableInfo.some(col => col.name === 'avatar_url');
    if (!hasAvatar) {
      await db.run("ALTER TABLE users ADD COLUMN avatar_url TEXT;");
      console.log('[Database Migration] users テーブルに avatar_url カラムを追加しました。');
    }
    await db.close();
  } catch (err) {
    console.warn('[Database Migration Warning] ensureAvatarColumn failed:', err.message);
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
      const db = await getDb();
      const user = await db.get(
        `SELECT id, staff_code, email, name, role, grade, department, extension_number, password_hash FROM users WHERE id = ?`, 
        [id]
      );
      await db.close();
      return user || null;
    } catch (err) {
      console.warn('[UserModel SQLite Warning] findById failed:', err.message);
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
      const db = await getDb();
      // staff_code または id のいずれかで完全一致検索 (is_active 条件を除去)
      const user = await db.get(
        `SELECT id, staff_code, email, name, role, grade, department, extension_number, password_hash FROM users WHERE UPPER(staff_code) = UPPER(?) OR UPPER(id) = UPPER(?)`, 
        [staffCode, staffCode]
      );
      await db.close();
      return user || null;
    } catch (err) {
      console.warn('[UserModel SQLite Warning] findByStaffCode failed:', err.message);
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
      const db = await getDb();
      const user = await db.get(
        `SELECT id, staff_code, email, name, role, grade, department, extension_number, password_hash FROM users WHERE LOWER(email) = LOWER(?)`, 
        [email]
      );
      await db.close();
      return user || null;
    } catch (err) {
      console.warn('[UserModel SQLite Warning] findByEmail failed:', err.message);
      return null;
    }
  },

  /**
   * 全教職員ユーザー一覧の取得
   */
  async listAll() {
    try {
      const db = await getDb();
      const users = await db.all(`SELECT id, staff_code, email, name, role, grade, department, extension_number, avatar_url FROM users ORDER BY name ASC`);
      await db.close();
      return users;
    } catch (err) {
      return Array.from(mockUsers.values());
    }
  },

  /**
   * 新規教職員ユーザーの登録
   */
  async create(userData) {
    if (!userData.name) {
      throw new Error('氏名は必須です。');
    }
    const newUser = {
      id: userData.id || `usr_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      staff_code: userData.staff_code,
      email: userData.email || null,
      password_hash: userData.password_hash,
      name: userData.name,
      role: userData.role || 'TEACHER',
      department: userData.department || null,
      extension_number: userData.extension_number || null,
      avatar_url: userData.avatar_url || null
    };

    mockUsers.set(newUser.id, newUser);

    try {
      const db = await getDb();
      const ts = nowIso();
      newUser.created_at = ts;
      newUser.updated_at = ts;
      await db.run(
        `INSERT INTO users (id, staff_code, email, password_hash, name, role, department, extension_number, avatar_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [newUser.id, newUser.staff_code, newUser.email, newUser.password_hash, newUser.name, newUser.role, newUser.department, newUser.extension_number, newUser.avatar_url, ts, ts]
      );
      await db.close();
    } catch (err) {
      console.warn('[UserModel SQLite Warning] create user failed:', err.message);
    }

    return newUser;
  },

  /**
   * プロファイル更新
   */
  async updateProfile(userId, profile) {
    try {
      const db = await getDb();
      const user = await db.get(`SELECT * FROM users WHERE id = ?`, [userId]);
      if (!user) {
        await db.close();
        return null;
      }

      const name = profile.name !== undefined ? profile.name : user.name;
      const email = profile.email !== undefined ? profile.email : user.email;
      const department = profile.department !== undefined ? profile.department : user.department;
      const extension_number = profile.extension_number !== undefined ? profile.extension_number : user.extension_number;
      const avatar_url = profile.avatar_url !== undefined ? profile.avatar_url : (user.avatar_url || null);

      await db.run(
        `UPDATE users SET name = ?, email = ?, department = ?, extension_number = ?, avatar_url = ?, updated_at = ? WHERE id = ?`,
        [name, email, department, extension_number, avatar_url, nowIso(), userId]
      );
      await db.close();
      return { ...user, name, email, department, extension_number, avatar_url };
    } catch (err) {
      console.warn('[UserModel SQLite Warning] updateProfile failed:', err.message);
      return null;
    }
  },

  /**
   * ユーザーの削除
   */
  async delete(id) {
    try {
      const db = await getDb();
      await db.run(`DELETE FROM users WHERE id = ?`, [id]);
      await db.close();
      return true;
    } catch (err) {
      console.warn('[UserModel SQLite Warning] delete user failed:', err.message);
      return false;
    }
  },

  /**
   * パスワードハッシュの更新
   */
  async updatePasswordHash(userId, newPasswordHash) {
    try {
      const db = await getDb();
      await db.run(`UPDATE users SET password_hash = ? WHERE id = ?`, [newPasswordHash, userId]);
      await db.close();
    } catch (err) {
      console.warn('[UserModel SQLite Warning] updatePasswordHash failed:', err.message);
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
      const existing = await db.get(`SELECT * FROM seating_status WHERE user_id = ?`, [userId]);
      if (existing) {
        await db.run(
          `UPDATE seating_status SET current_status = ?, status_note = ?, updated_at = ? WHERE user_id = ?`,
          [normalized, statusNote || existing.status_note || '', ts, userId]
        );
      } else {
        await db.run(
          `INSERT INTO seating_status (id, user_id, desk_number, group_zone, current_status, status_note, updated_at)
           VALUES (?, ?, ?, 'staff', ?, ?, ?)`,
          [`seat_${userId}`, userId, '-', normalized, statusNote || '', ts]
        );
      }
      const user = await db.get(
        `SELECT id, staff_code, email, name, role, grade, department, extension_number FROM users WHERE id = ?`,
        [userId]
      );
      await db.close();
      return { ...user, status: normalized, current_status: normalized };
    } catch (err) {
      console.warn('[UserModel SQLite Warning] updateStatus failed:', err.message);
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
      const db = await getDb();
      await db.run(
        `INSERT INTO invitation_codes (id, code, created_by_user_id, is_used, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [invData.id, invData.code, invData.created_by_user_id, invData.is_used, invData.expires_at, invData.created_at]
      );
      await db.close();
    } catch (err) {
      mockInvitationCodes.set(code, invData);
    }
    return invData;
  },

  async findInvitationCode(code) {
    try {
      const db = await getDb();
      const inv = await db.get(`SELECT * FROM invitation_codes WHERE code = ? AND is_used = 0 AND expires_at > datetime('now')`, [code]);
      await db.close();
      return inv || mockInvitationCodes.get(code) || null;
    } catch (err) {
      return mockInvitationCodes.get(code) || null;
    }
  },

  async markInvitationCodeUsed(code, usedByUserId) {
    try {
      const db = await getDb();
      await db.run(`UPDATE invitation_codes SET is_used = 1, used_by_user_id = ? WHERE code = ?`, [usedByUserId, code]);
      await db.close();
    } catch (err) {
      if (mockInvitationCodes.has(code)) {
        const inv = mockInvitationCodes.get(code);
        inv.is_used = 1;
      }
    }
  }
};

export default userModel;