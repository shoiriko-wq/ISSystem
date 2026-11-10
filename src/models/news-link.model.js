/**
 * ISSystem ピックアップ教育ニュース共有リンク モデル
 * ダッシュボード「記事を共有」で追加した記事URLとページタイトルを news_links に保持する。
 * ★ 共有はリンク追加だけ（チャット投稿はしない）。追加者の名前は表示用の控えとして持つ。
 */

import { query } from '../../config/database.js';
import { openDb, nowIso } from '../utils/db.js';

/** モデル層用 PostgreSQL アダプタ（共有プールの借用、冪等スキーマを初回アクセスで適用） */
async function getDb() {
  return openDb();
}

/**
 * PostgreSQL TIMESTAMP（壁時計・タイムゾーン無し）を JST 壁時計 'YYYY-MM-DD HH:MM:SS' に正規化する
 * @param {string|Date} value
 * @returns {string|null}
 */
function toJstWall(value) {
  if (!value) return null;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return value.toLocaleString('sv-SE', { timeZone: 'Asia/Tokyo' });
  }

  const raw = String(value).trim();
  if (!raw) return null;

  // 素朴な 'YYYY-MM-DD HH:MM:SS' / 'YYYY-MM-DDTHH:MM' は JST 壁時計として格納されている
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    return raw.replace('T', ' ');
  }

  return raw;
}

/** レコードを客户端が使う形へ整える（camel / snake 両形と JST 壁時計の追加日） */
function mapLink(row) {
  if (!row) return null;

  const addedAt = toJstWall(row.addedAt || row.added_at);
  const day = addedAt ? String(addedAt).substring(0, 10) : null;

  return {
    ...row,
    id: row.id,
    url: row.url,
    title: row.title,
    domain: row.domain,
    addedBy: row.addedBy || row.added_by,
    added_by: row.added_by || row.addedBy,
    addedByName: row.addedByName || row.added_by_name,
    added_by_name: row.added_by_name || row.addedByName,
    addedAt,
    added_at: addedAt,
    addedDay: day,
    added_day: day,
  };
}

export const newsLinkModel = {
  /**
   * 共有リンクの一覧（新しい順）
   * @param {number} limit
   * @returns {Promise<Array<object>>}
   */
  async listNewsLinks({ limit = 50 } = {}) {
    await getDb();
    const res = await query(
      `SELECT * FROM news_links WHERE is_deleted = 0 ORDER BY added_at DESC, id DESC LIMIT $1`,
      [Math.max(1, Math.min(parseInt(limit, 10) || 50, 200))]
    );
    return res.rows.map(mapLink);
  },

  /**
   * 同じURLの共有リンクを探す（小文字比較。見つからなければ null）
   * @param {string} url
   * @returns {Promise<object|null>}
   */
  async findNewsLinkByUrl(url) {
    await getDb();
    const res = await query(
      `SELECT * FROM news_links WHERE lower(url) = lower($1) AND is_deleted = 0 LIMIT 1`,
      [url]
    );
    return mapLink(res.rows[0]);
  },

  /**
   * 共有リンクを追加する（時刻は JST 壁時計で書く）
   * @param {object} link { url, title, domain, addedBy, addedByName }
   * @returns {Promise<object>}
   */
  async createNewsLink({ url, title, domain, addedBy, addedByName }) {
    await getDb();

    const id = `nl_${Date.now().toString(36)}${Math.random().toString(36).substring(2, 8)}`;
    const nowStr = nowIso();

    await query(
      `INSERT INTO news_links (id, url, title, domain, added_by, added_by_name, added_at, is_deleted)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 0)`,
      [id, url, title, domain, addedBy, addedByName, nowStr]
    );

    return mapLink({
      id,
      url,
      title,
      domain,
      added_by: addedBy,
      added_by_name: addedByName,
      added_at: nowStr,
    });
  },
};

export default newsLinkModel;
