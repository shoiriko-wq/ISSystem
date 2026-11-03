/**
 * ISSystem Bulletin & Circular Data Access Model
 * PostgreSQL issystem DB (posts / post_acknowledgements) 準拠モデル
 */

import { query } from '../../config/database.js';
import { openDb, nowIso, parseJson } from '../utils/db.js';

/** モデル層用 SQLite 互換アダプタ (共有プール借用 / close() は no-op) */
async function getDb() {
  return openDb();
}

function mapPost(row) {
  if (!row) return null;
  const postedAt = row.postedAt || row.posted_at || row.createdAt;
  const updatedAt = row.updatedAt || row.updated_at || postedAt;
  const displayStart = normalizeDateOnly(row.displayStart || row.display_start_date);
  const displayEnd = normalizeDateOnly(row.displayEnd || row.display_end_date);
  return {
    ...row,
    postedAt,
    posted_at: postedAt,
    updatedAt,
    updated_at: updatedAt,
    // 掲示期間 (両方任意。開始日が未指定のレコードは投稿日へ補完、終了日 null は「期間限定の掲示ではない」)
    displayStart,
    displayEnd,
    display_start_date: displayStart,
    display_end_date: displayEnd,
    targetScope: parseJson(row.target_scope, { grade: 'ALL', department: 'ALL' }),
    attachments: parseJson(row.attachments, []),
  };
}

/**
 * 日付値 (PostgreSQL DATE 由来の Date / 'YYYY-MM-DD' 文字列) を 'YYYY-MM-DD' に正規化する
 * ※ PostgreSQL の DATE は UTC 基準の Date オブジェクトとして返るため JST の暦日へ変換する
 * 不正日付 (例: 2月30日) と空値は null を返す
 * @param {string|Date} value
 * @returns {string|null}
 */
function normalizeDateOnly(value) {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  const raw = String(value).trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;

  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);
  const dateObj = new Date(y, m - 1, d);
  const isValid =
    dateObj.getFullYear() === y &&
    dateObj.getMonth() === m - 1 &&
    dateObj.getDate() === d;

  return isValid ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

/**
 * 投稿日時文字列を 'YYYY-MM-DD HH:MM:SS' へ正規化する
 * 'YYYY-MM-DDTHH:MM' (datetime-local) にも対応し、不正日付 (例: 2月30日) は fallback を返す
 * @param {string} value
 * @param {string} fallback
 */
function normalizeDateTime(value, fallback = nowIso()) {
  const raw = String(value || '').trim();
  if (!raw) return fallback;

  const normalized = raw.replace('T', ' ');
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!match) return fallback;

  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10);
  const d = parseInt(match[3], 10);
  const hh = match[4] || '00';
  const mm = match[5] || '00';
  const ss = match[6] || '00';

  const dateObj = new Date(y, m - 1, d, Number(hh), Number(mm), Number(ss));
  const isValid =
    dateObj.getFullYear() === y &&
    dateObj.getMonth() === m - 1 &&
    dateObj.getDate() === d;

  if (!isValid) return fallback;
  return `${match[1]}-${match[2]}-${match[3]} ${hh}:${mm}:${ss}`;
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
          p.display_start_date,
          p.display_end_date,
          p.is_deleted,
          u.name as authorName,
          u.avatar_url as author_avatar,
          p.created_at as createdAt,
          p.posted_at as postedAt,
          p.posted_at,
          p.updated_at as updatedAt,
          p.updated_at
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
   * @param {Object} filters - { searchKey, currentUserId, limit, targetGrade, targetDepartment, postedDay, displayStart, displayEnd }
   */
  async findAll(filters = {}) {
    const params = [];
    const ph = () => `$${params.length}`;

      let sql = `
        SELECT 
          p.id,
          p.title,
          p.content,
          p.author_id as authorId,
          p.author_id,
          p.target_scope,
          p.attachments,
          p.display_start_date,
          p.display_end_date,
          u.name as authorName,
          u.avatar_url as author_avatar,
          p.created_at as createdAt,
          p.created_at,
          p.posted_at as postedAt,
          p.posted_at,
          p.updated_at as updatedAt,
          p.updated_at,
          COALESCE(pa.status, 'UNREAD') as ackStatus
        FROM posts p
        LEFT JOIN users u ON p.author_id = u.id
      `;

    if (filters.currentUserId) {
      params.push(filters.currentUserId);
      sql += ` LEFT JOIN post_acknowledgements pa ON p.id = pa.post_id AND pa.user_id = ${ph()}`;
    } else {
      sql += ` LEFT JOIN post_acknowledgements pa ON p.id = pa.post_id`;
    }

    sql += ` WHERE COALESCE(p.is_deleted, 0) = 0`;

    if (filters.targetGrade && filters.targetGrade !== 'ALL') {
      params.push(JSON.stringify({ grade: filters.targetGrade }));
      sql += ` AND p.target_scope @> ${ph()}::jsonb`;
    }

    if (filters.targetDepartment && filters.targetDepartment !== 'ALL') {
      params.push(JSON.stringify({ department: filters.targetDepartment }));
      sql += ` AND p.target_scope @> ${ph()}::jsonb`;
    }

    if (filters.searchKey) {
      params.push(`%${filters.searchKey.trim()}%`);
      sql += ` AND (p.title LIKE ${ph()} OR p.content LIKE ${ph()})`;
      params.push(`%${filters.searchKey.trim()}%`);
    }

      // 投稿日 (日ごと表示) による絞り込み
      const postedDay = filters.postedDay || filters.day || filters.posted_date;
      if (postedDay) {
        params.push(String(postedDay).substring(0, 10));
        sql += ` AND to_char(COALESCE(p.posted_at, p.created_at), 'YYYY-MM-DD') = ?`;
      }

      // 期間 ( startDate 〜 endDate ) による絞り込み (週間表示モードなど)
      if (filters.startDate) {
        params.push(String(filters.startDate).substring(0, 10));
        sql += ` AND to_char(COALESCE(p.posted_at, p.created_at), 'YYYY-MM-DD') >= ?`;
      }
      if (filters.endDate) {
        params.push(String(filters.endDate).substring(0, 10));
        sql += ` AND to_char(COALESCE(p.posted_at, p.created_at), 'YYYY-MM-DD') <= ?`;
      }

      // 掲示期間による絞り込み (掲示期間が [displayStart 〜 displayEnd] と重なる投稿)
      if (filters.displayStart) {
        params.push(String(filters.displayStart).substring(0, 10));
        sql += ` AND (p.display_end_date IS NULL OR p.display_end_date >= ${ph()})`;
      }
      if (filters.displayEnd) {
        params.push(String(filters.displayEnd).substring(0, 10));
        sql += ` AND (p.display_start_date IS NULL OR p.display_start_date <= ${ph()})`;
      }

      // 掲示期間にその日が含まれる (表示当日ベースの絞り込み)
      const displayOnDate = filters.displayOnDate;
      if (displayOnDate) {
        const displayDay = String(displayOnDate).substring(0, 10);
        params.push(displayDay);
        sql += ` AND (p.display_start_date IS NULL OR p.display_start_date <= ${ph()})`;
        params.push(displayDay);
        sql += ` AND (p.display_end_date IS NULL OR p.display_end_date >= ${ph()})`;
      }

      sql += ` ORDER BY COALESCE(p.posted_at, p.created_at) DESC`;

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
      `SELECT p.*, u.name AS author_name, u.avatar_url AS author_avatar
       FROM posts p
       LEFT JOIN users u ON p.author_id = u.id
       WHERE p.id = $1 AND COALESCE(p.is_deleted, 0) = 0`,
      [id]
    );
    return mapPost(res.rows[0]);
  },

  /**
   * 新規掲示・回覧板の作成
   */
  async create(postData) {
    const id = postData.id || `post_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const authorId = postData.author_id || postData.authorId || 'kyomu01';
    const targetScope = postData.target_scope || postData.targetScope || { grade: 'ALL', department: 'ALL' };
    const attachments = postData.attachments || [];
    const createdAt = nowIso();
    const postedAt = normalizeDateTime(postData.postedAt || postData.posted_at || postData.postedAtInput, createdAt);
    // 掲示期間 (両方任意。掲示開始日が未指定なら投稿日、掲示終了日が未指定なら「期間限定の掲示ではない」)
    const displayStart =
      normalizeDateOnly(postData.displayStart || postData.display_start || postData.display_start_date) || postedAt.substring(0, 10);
    const displayEnd = normalizeDateOnly(postData.displayEnd || postData.display_end || postData.display_end_date);

    try {
      const db = await getDb();
      await db.run(
        `INSERT INTO posts (id, title, content, author_id, target_scope, attachments, display_start_date, display_end_date, is_deleted, posted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [id, postData.title, postData.content, authorId, JSON.stringify(targetScope), JSON.stringify(attachments), displayStart, displayEnd, postedAt, createdAt, createdAt]
      );

      // 投稿作成時に添付ファイル (未紐付け) をこの投稿へ紐付ける
      const attachmentIds = (attachments || [])
        .map((a) => (typeof a === 'string' ? a : a && a.id))
        .filter(Boolean);
      if (attachmentIds.length > 0) {
        const setSql = attachmentIds.map(() => '?').join(', ');
        await db.run(
          `UPDATE bulletin_attachments SET post_id = ? WHERE id IN (${setSql}) AND post_id IS NULL`,
          [id, ...attachmentIds]
        );
      }
      await db.close();
    } catch (err) {
      console.warn('[BulletinModel SQLite Warning] create failed:', err.message);
    }

    return {
      id,
      title: postData.title,
      content: postData.content,
      authorId,
      createdAt,
      postedAt,
      posted_at: postedAt,
      displayStart,
      displayEnd,
      display_start_date: displayStart,
      display_end_date: displayEnd,
      targetScope,
      attachments
    };
  },

  /**
   * デジタルワンクリック承認・既読ログの登録/更新 (PostgreSQL ON CONFLICT)
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
   * 添付ファイルレコードの作成
   * @param {Object} row - { id, post_id, original_name, stored_name, mime_type, extension, size_bytes, uploaded_by }
   */
  async createAttachment(row) {
    const db = await getDb();
    await db.run(
      `INSERT INTO bulletin_attachments (id, post_id, original_name, stored_name, mime_type, extension, size_bytes, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.post_id || null,
        row.original_name,
        row.stored_name,
        row.mime_type || 'application/octet-stream',
        row.extension || '',
        Number(row.size_bytes || 0),
        row.uploaded_by || null,
        nowIso(),
      ]
    );
    await db.close();
    return this.findAttachment(row.id);
  },

  /**
   * 添付ファイルレコードの取得
   * @param {string} id
   */
  async findAttachment(id) {
    try {
      const db = await getDb();
      const row = await db.get(`SELECT * FROM bulletin_attachments WHERE id = ?`, [String(id)]);
      await db.close();
      return row || null;
    } catch (err) {
      console.warn('[BulletinModel] findAttachment failed:', err.message);
      return null;
    }
  },

  /**
   * 投稿に紐づく添付ファイル一覧
   * @param {string} postId
   */
  async listAttachments(postId) {
    try {
      const db = await getDb();
      const rows = await db.all(
        `SELECT * FROM bulletin_attachments WHERE post_id = ? ORDER BY created_at ASC`,
        [String(postId)]
      );
      await db.close();
      return rows || [];
    } catch (err) {
      console.warn('[BulletinModel] listAttachments failed:', err.message);
      return [];
    }
  },

  /**
   * 複数投稿に紐づく添付ファイル一覧 (一括取得)
   * @param {Array<string>} postIds
   */
  async listAttachmentsForPosts(postIds) {
    const ids = (postIds || []).map((id) => String(id)).filter(Boolean);
    if (ids.length === 0) return [];
    try {
      const db = await getDb();
      const placeholders = ids.map(() => '?').join(', ');
      const rows = await db.all(
        `SELECT * FROM bulletin_attachments WHERE post_id IN (${placeholders}) ORDER BY created_at ASC`,
        ids
      );
      await db.close();
      return rows || [];
    } catch (err) {
      console.warn('[BulletinModel] listAttachmentsForPosts failed:', err.message);
      return [];
    }
  },

  /**
   * 添付ファイルレコードの削除
   * @param {string} id
   */
  async deleteAttachment(id) {
    const db = await getDb();
    await db.run(`DELETE FROM bulletin_attachments WHERE id = ?`, [String(id)]);
    await db.close();
    return true;
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

