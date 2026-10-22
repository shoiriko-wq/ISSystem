/**
 * ISSystem Bulletin & Circular Data Access Model
 * SQLite database.sqlite (posts / post_acknowledgements) 完全準拠モデル
 */

import { openDb, nowIso, parseJson } from '../utils/db.js';

async function getDb() {
  return openDb();
}

function mapPost(row) {
  if (!row) return null;
  return {
    ...row,
    targetScope: parseJson(row.target_scope, { grade: 'ALL', department: 'ALL' }),
    attachments: parseJson(row.attachments, []),
  };
}

export const bulletinModel = {
  /**
   * 掲示・回覧投稿の取得 (ID指定)
   * @param {string} id
   */
  async findById(id) {
    try {
      const db = await getDb();
      const bulletin = await db.get(
        `SELECT 
          p.id,
          p.title,
          p.content,
          p.post_type as postType,
          p.post_type,
          p.priority,
          p.author_id as authorId,
          p.author_id,
          p.target_scope,
          p.attachments,
          p.is_deleted,
          u.name as authorName,
          p.created_at as createdAt,
          p.created_at
        FROM posts p 
        LEFT JOIN users u ON p.author_id = u.id 
        WHERE p.id = ? AND p.is_deleted = 0`,
        [id]
      );
      await db.close();
      return mapPost(bulletin);
    } catch (err) {
      console.warn('[BulletinModel SQLite Warning] findById failed:', err.message);
      return null;
    }
  },

  /**
   * 掲示板・回覧板の一覧取得（作成者名・承認ステータス結合）
   * @param {Object} filters - { searchKey, currentUserId, limit, pinned, post_type }
   */
  async findAll(filters = {}) {
    try {
      const db = await getDb();
      const params = [];

      let sql = `
        SELECT 
          p.id,
          p.title,
          p.content,
          p.post_type as postType,
          p.post_type,
          p.priority,
          p.author_id as authorId,
          p.author_id,
          p.target_scope,
          p.attachments,
          u.name as authorName,
          p.created_at as createdAt,
          p.created_at,
          COALESCE(pa.status, 'UNREAD') as ackStatus
        FROM posts p
        LEFT JOIN users u ON p.author_id = u.id
      `;

      if (filters.currentUserId) {
        params.push(filters.currentUserId);
        sql += ` LEFT JOIN post_acknowledgements pa ON p.id = pa.post_id AND pa.user_id = ?`;
      } else {
        sql += ` LEFT JOIN post_acknowledgements pa ON p.id = pa.post_id`;
      }

      sql += ` WHERE p.is_deleted = 0`;

      if (filters.post_type || filters.type) {
        params.push(filters.post_type || filters.type);
        sql += ` AND p.post_type = ?`;
      }

      if (filters.targetGrade && filters.targetGrade !== 'ALL') {
        params.push(`%"grade":"${filters.targetGrade}"%`);
        sql += ` AND (p.target_scope LIKE ? OR p.target_scope LIKE '%"grade":"ALL"%')`;
      }

      if (filters.targetDepartment && filters.targetDepartment !== 'ALL') {
        params.push(`%"department":"${filters.targetDepartment}"%`);
        sql += ` AND (p.target_scope LIKE ? OR p.target_scope LIKE '%"department":"ALL"%')`;
      }

      if (filters.pinned === 'true' || filters.pinned === true) {
        sql += ` AND p.priority = 'URGENT'`;
      }

      if (filters.searchKey) {
        params.push(`%${filters.searchKey.trim()}%`);
        sql += ` AND (p.title LIKE ? OR p.content LIKE ?)`;
        params.push(`%${filters.searchKey.trim()}%`);
      }

      sql += ` ORDER BY CASE WHEN p.priority = 'URGENT' THEN 1 ELSE 2 END, p.created_at DESC`;

      if (filters.limit) {
        params.push(parseInt(filters.limit, 10));
        sql += ` LIMIT ?`;
      }

      const rows = await db.all(sql, params);
      await db.close();

      return (rows || []).map(mapPost);
    } catch (err) {
      console.warn('[BulletinModel SQLite Warning] findAll failed:', err.message);
      return [];
    }
  },

  /**
   * 新規掲示・回覧の作成
   * @param {Object} postData
   */
  async create(postData) {
    const id = postData.id || `post_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const postType = postData.postType || postData.post_type || postData.type || 'NOTICE';
    const priority = postData.priority || (postData.is_urgent ? 'URGENT' : 'NORMAL');
    const authorId = postData.authorId || postData.author_id || 'kyomu01';
    const createdAt = nowIso();
    const targetScope = postData.targetScope || postData.target_scope || { grade: 'ALL', department: 'ALL' };
    const attachments = postData.attachments || [];

    try {
      const db = await getDb();
      await db.run(
        `INSERT INTO posts (id, title, content, post_type, priority, author_id, target_scope, attachments, is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        [id, postData.title, postData.content, postType, priority, authorId, JSON.stringify(targetScope), JSON.stringify(attachments), createdAt, createdAt]
      );
      await db.close();
    } catch (err) {
      console.warn('[BulletinModel SQLite Warning] create failed:', err.message);
    }

    return {
      id,
      title: postData.title,
      content: postData.content,
      postType,
      post_type: postType,
      priority,
      authorId,
      createdAt,
      targetScope,
      attachments
    };
  },

  /**
   * デジタルワンクリック承認・既読ログの登録・更新
   * @param {string} postId
   * @param {string} userId
   * @param {string} status 'READ' | 'APPROVED' | 'REJECTED'
   * @param {string} comment
   */
  async updateAcknowledgement(postId, userId, status = 'APPROVED', comment = null) {
    const id = `ack_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const acknowledgedAt = new Date().toISOString().replace('T', ' ').substring(0, 19);

    try {
      const db = await getDb();
      await db.run(
        `INSERT INTO post_acknowledgements (id, post_id, user_id, status, comment, acknowledged_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(post_id, user_id) DO UPDATE SET
           status = excluded.status,
           comment = excluded.comment,
           acknowledged_at = excluded.acknowledged_at`,
        [id, postId, userId, status, comment, acknowledgedAt]
      );
      await db.close();
    } catch (err) {
      console.warn('[BulletinModel SQLite Warning] updateAcknowledgement failed:', err.message);
    }

    return { id, post_id: postId, user_id: userId, status, comment, acknowledged_at: acknowledgedAt };
  },

  /**
   * 該当投稿の全承認ログ取得
   * @param {string} postId
   */
  async getAcknowledgements(postId) {
    try {
      const db = await getDb();
      const rows = await db.all(
        `SELECT pa.*, u.name as user_name, u.grade, u.department 
         FROM post_acknowledgements pa
         JOIN users u ON pa.user_id = u.id
         WHERE pa.post_id = ?`,
        [postId]
      );
      await db.close();
      return rows || [];
    } catch (err) {
      console.warn('[BulletinModel SQLite Warning] getAcknowledgements failed:', err.message);
      return [];
    }
  },

  /**
   * 投稿の削除
   * @param {string} id
   */
  async delete(id) {
    try {
      const db = await getDb();
      await db.run(`UPDATE posts SET is_deleted = 1, updated_at = ? WHERE id = ?`, [nowIso(), id]);
      await db.close();
    } catch (err) {
      console.warn('[BulletinModel SQLite Warning] delete failed:', err.message);
    }
  }
};

export default bulletinModel;