/**
 * ISSystem Bulletin & Circular Data Access Model
 * PostgreSQL (posts / post_acknowledgements / post_comments) 完全準拠版
 */

import { query } from '../../config/database.js';
import { nowIso, parseJson } from '../utils/db.js';

function mapPost(row) {
  if (!row) return null;

  const postType = row.post_type || row.postType || 'NOTICE';
  const targetScope = parseJson(row.target_scope, { grade: 'ALL', department: 'ALL' });
  const attachments = parseJson(row.attachments, []);
  const authorName = row.author_name || row.authorName || '教務 主任';

  return {
    ...row,
    postType,
    post_type: postType,
    priority: row.priority || 'NORMAL',
    authorId: row.author_id || row.authorId,
    author_id: row.author_id || row.authorId,
    authorName,
    author_name: authorName,
    targetScope,
    target_scope: targetScope,
    attachments,
    is_deleted: row.is_deleted === true,
    createdAt: row.created_at,
    created_at: row.created_at,
    ackStatus: row.ack_status || row.ackStatus || 'UNREAD',
    ack_status: row.ack_status || row.ackStatus || 'UNREAD',
  };
}

export const bulletinModel = {
  /**
   * 掲示・回覧板の一覧取得（閲覧者の既読/承認ステータス付与）
   * @param {Object} filters - { post_type, type, targetGrade, targetDepartment, searchKey, pinned, limit, currentUserId }
   */
  async findAll(filters = {}) {
    const params = [];
    const ph = () => `$${params.length}`;

    let sql = `
      SELECT p.*, u.name AS author_name,
             COALESCE(pa.status, 'UNREAD') AS ack_status
      FROM posts p
      LEFT JOIN users u ON p.author_id = u.id
    `;

    if (filters.currentUserId) {
      params.push(filters.currentUserId);
      sql += ` LEFT JOIN post_acknowledgements pa ON p.id = pa.post_id AND pa.user_id = ${ph()}`;
    } else {
      sql += ` LEFT JOIN post_acknowledgements pa ON p.id = pa.post_id`;
    }

    sql += ` WHERE p.is_deleted = false`;

    const postType = filters.post_type || filters.type;
    if (postType) {
      params.push(postType);
      sql += ` AND p.post_type = ${ph()}`;
    }

    if (filters.targetGrade && filters.targetGrade !== 'ALL') {
      params.push(JSON.stringify({ grade: filters.targetGrade }));
      sql += ` AND p.target_scope @> ${ph()}::jsonb`;
    }

    if (filters.targetDepartment && filters.targetDepartment !== 'ALL') {
      params.push(JSON.stringify({ department: filters.targetDepartment }));
      sql += ` AND p.target_scope @> ${ph()}::jsonb`;
    }

    if (filters.pinned === true || filters.pinned === 'true') {
      sql += ` AND p.priority = 'URGENT'`;
    }

    if (filters.searchKey) {
      params.push(`%${filters.searchKey.trim()}%`);
      sql += ` AND (p.title LIKE ${ph()} OR p.content LIKE ${ph()})`;
      params.push(`%${filters.searchKey.trim()}%`);
    }

    sql += ` ORDER BY CASE WHEN p.priority = 'URGENT' THEN 1 ELSE 2 END, p.created_at DESC`;

    if (filters.limit) {
      params.push(parseInt(filters.limit, 10));
      sql += ` LIMIT ${ph()}`;
    }

    const res = await query(sql, params);
    return (res.rows || []).map(mapPost);
  },

  /**
   * 個別投稿の詳細取得
   */
  async findById(id) {
    const res = await query(
      `SELECT p.*, u.name AS author_name
       FROM posts p
       LEFT JOIN users u ON p.author_id = u.id
       WHERE p.id = $1 AND p.is_deleted = false`,
      [id]
    );
    return mapPost(res.rows[0]);
  },

  /**
   * 新規掲示・回覧板の作成
   */
  async create(postData) {
    const id = postData.id || `post_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const postType = postData.post_type || postData.postType || postData.type || 'NOTICE';
    const priority = postData.priority || (postData.is_urgent || postData.isUrgent ? 'URGENT' : 'NORMAL');
    const authorId = postData.author_id || postData.authorId || 'kyomu01';
    const targetScope = postData.target_scope || postData.targetScope || { grade: 'ALL', department: 'ALL' };
    const attachments = postData.attachments || [];
    const nowStr = nowIso();

    const res = await query(
      `INSERT INTO posts (id, title, content, post_type, priority, author_id, target_scope, attachments, is_deleted, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false, $9, $10)
       RETURNING *`,
      [
        id,
        postData.title,
        postData.content,
        postType,
        priority,
        authorId,
        JSON.stringify(targetScope),
        JSON.stringify(attachments),
        nowStr,
        nowStr,
      ]
    );
    return mapPost(res.rows[0]);
  },

  /**
   * 投稿内容の更新（掲示・回覧板）
   */
  async update(postData) {
    const id = postData.id || postData.bulletinId;
    const nowStr = nowIso();
    const scope = postData.target_scope || postData.targetScope;
    const attachments = postData.attachments;

    const res = await query(
      `UPDATE posts
       SET title = COALESCE($1, title),
           content = COALESCE($2, content),
           post_type = COALESCE($3, post_type),
           priority = COALESCE($4, priority),
           target_scope = COALESCE($5, target_scope),
           attachments = COALESCE($6, attachments),
           updated_at = $7
       WHERE id = $8 AND is_deleted = false
       RETURNING *`,
      [
        postData.title || null,
        postData.content || null,
        postData.post_type || postData.postType || null,
        postData.priority || null,
        scope ? JSON.stringify(scope) : null,
        attachments ? JSON.stringify(attachments) : null,
        nowStr,
        id,
      ]
    );
    return mapPost(res.rows[0]);
  },

  /**
   * デジタルワンクリック承認・既読ログの登録/更新 (PostgreSQL ON CONFLICT)
   */
  async updateAcknowledgement(postId, userId, status = 'APPROVED', comment = null) {
    const id = `ack_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const acknowledgedAt = nowIso();

    const res = await query(
      `INSERT INTO post_acknowledgements (id, post_id, user_id, status, comment, acknowledged_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (post_id, user_id)
       DO UPDATE SET status = EXCLUDED.status, comment = EXCLUDED.comment, acknowledged_at = EXCLUDED.acknowledged_at
       RETURNING *`,
      [id, postId, userId, status, comment, acknowledgedAt]
    );

    return res.rows[0] || { id, post_id: postId, user_id: userId, status, comment, acknowledged_at: acknowledgedAt };
  },

  /**
   * 該当投稿の全承認・既読ログ取得
   */
  async getAcknowledgements(postId) {
    const res = await query(
      `SELECT pa.*, u.name AS user_name, u.grade, u.department
       FROM post_acknowledgements pa
       JOIN users u ON pa.user_id = u.id
       WHERE pa.post_id = $1
       ORDER BY pa.acknowledged_at DESC`,
      [postId]
    );
    return res.rows;
  },

  /**
   * 回覧板スレッドのコメント一覧
   */
  async getComments(postId) {
    const res = await query(
      `SELECT pc.*, u.name AS author_name
       FROM post_comments pc
       LEFT JOIN users u ON pc.user_id = u.id
       WHERE pc.post_id = $1
       ORDER BY pc.created_at ASC`,
      [postId]
    );
    return res.rows;
  },

  /**
   * 回覧板スレッドへのコメント登録
   */
  async addComment(commentData) {
    const id = commentData.id || `cmt_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const postId = commentData.post_id || commentData.bulletin_id;
    const userId = commentData.author_id || commentData.user_id || 'kyomu01';

    const res = await query(
      `INSERT INTO post_comments (id, post_id, user_id, user_name, comment_text, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        id,
        postId,
        userId,
        commentData.author_name || null,
        commentData.comment_text,
        commentData.created_at || nowIso(),
      ]
    );
    return res.rows[0];
  },

  /**
   * 投稿の削除（ソフトデリート）
   */
  async delete(id) {
    const res = await query(
      `UPDATE posts SET is_deleted = true, updated_at = $1 WHERE id = $2 RETURNING *`,
      [nowIso(), id]
    );
    return res.rows[0] || null;
  },

  // ===== 呼び出し側サービスとの命名互換エイリアス =====
  async findPosts(filters = {}) {
    return this.findAll(filters);
  },

  async listBulletins(filters = {}) {
    return this.findAll(filters);
  },

  async createPost(postData) {
    return this.create(postData);
  },

  async addAcknowledgement(postId, userId, status = 'APPROVED', comment = null) {
    return this.updateAcknowledgement(postId, userId, status, comment);
  },
};

export default bulletinModel;

