/**
 * 未読件数ルール検証 (v3.1) — 登録日・掲示期間の追加条件
 *  未読 = ackStatus ∈ {UNREAD, REJECTED}
 *     AND 投稿日 (JST) ≧ ユーザ登録日 (users.created_at)  ← 登録日より古い記事は未読数に含まれない
 *     AND 掲示期間が有効 (start 未設定/≦今日, end 未設定/≧今日)  ← 着任前・掲示終了記事を除く
 *     AND target_scope に自分が含まれる（現行は ALL/ALL → noop）
 *     AND 非削除（findAll が既に除外）
 * seed の created_at と posts を操作して SQL で検証する
 */
import { query } from '../config/database.js';
import { closePool } from './helpers.js';

/** JST 基準の今日キー (YYYY-MM-DD) から offset 日分のキー */
function dayKey(offset = 0) {
  const d = new Date(Date.now() + 9 * 3600000);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().split('T')[0];
}

/** PostgreSQL の TIMESTAMP/DATE 値 (Date オブジェクト / 'YYYY-MM-DD HH:MM:SS' 文字列) を JST 暦日 'YYYY-MM-DD' に正規化する */
function dayFrom(value) {
  if (!value) return '';
  const s = String(value);
  const naive = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T]\d{2}:\d{2}/);
  if (naive && !/[Zz]|[+-]\d{2}/.test(s)) return naive[1];
  const d = new Date(value);
  if (isNaN(d.getTime())) return '';
  return new Date(d.getTime() + 9 * 3600000).toISOString().split('T')[0];
}

/** フロント (bulletin.module.js isUnreadForMe) と同一条件を JS で再現した検証用ミラー */
function isUnreadForMeMirror(b, user) {
  const status = b.ackstatus || 'UNREAD';
  if (status !== 'UNREAD' && status !== 'REJECTED') return false;
  const postedDay = dayFrom(b.posted_at || b.created_at);
  const regDay = dayFrom(user.created_at);
  if (postedDay && regDay && postedDay < regDay) return false;
  const start = b.display_start_date ? dayFrom(b.display_start_date) : null;
  const end = b.display_end_date ? dayFrom(b.display_end_date) : null;
  const today = dayKey(0);
  if (start && start > today) return false;
  if (end && end < today) return false;
  const scope = typeof b.target_scope === 'string' ? JSON.parse(b.target_scope) : (b.target_scope || {});
  if (String(scope.grade ?? 'ALL') !== 'ALL' && user.grade && String(scope.grade) !== String(user.grade)) return false;
  if (String(scope.department ?? 'ALL') !== 'ALL' && user.department && String(scope.department) !== String(user.department)) return false;
  return true;
}

describe('未読件数ルール (登録日・掲示期間)', () => {
  const userId = `usr_unread_${String(Date.now()).slice(-6)}`;
  const staffCode = `T90${String(Date.now()).slice(-6)}`;
  const regDay = dayKey(-3);
  const stamp = Date.now();
  const ids = {
    beforeReg: `unread_before_${stamp}`,   // 登録日より古い → 除外
    regDayPost: `unread_sameday_${stamp}`, // 登録当日 → 含む (≧)
    valid: `unread_valid_${stamp}`,        // 掲示期間有効 → 含む
    expired: `unread_expired_${stamp}`,    // 掲示終了済 → 除外
    notStarted: `unread_future_${stamp}`,  // 掲示開始前 → 除外
    read: `unread_read_${stamp}`,          // 既読 → 除外
    rejected: `unread_rejected_${stamp}`,  // REJECTED → 含む
    deleted: `unread_deleted_${stamp}`,    // 削除済み → 除外
  };

  beforeAll(async () => {
    await query(
      `INSERT INTO users (id, staff_code, name, password_hash, role, created_at, updated_at)
       VALUES ($1, $2, '未読検証 太郎', 'x', 'TEACHER', $3, $3)`,
      [userId, staffCode, `${regDay} 09:00:00`]
    );

    const postRows = [
      [ids.beforeReg, '登録日より古い記事', `${dayKey(-5)} 10:00:00`, null, null, 0],
      [ids.regDayPost, '登録当日の記事', `${regDay} 12:00:00`, regDay, null, 0],
      [ids.valid, '掲示期間内の記事', `${dayKey(0)} 09:00:00`, dayKey(-1), dayKey(2), 0],
      [ids.expired, '掲示終了した記事', `${dayKey(0)} 09:10:00`, dayKey(-5), dayKey(-1), 0],
      [ids.notStarted, '掲示開始前の記事', `${dayKey(0)} 09:20:00`, dayKey(1), null, 0],
      [ids.read, '既読の記事', `${dayKey(0)} 09:30:00`, null, null, 0],
      [ids.rejected, '承認却下の記事', `${dayKey(0)} 09:40:00`, null, null, 0],
      [ids.deleted, '削除された記事', `${dayKey(0)} 09:50:00`, null, null, 1],
    ];

    for (const [id, title, created, start, end, deleted] of postRows) {
      await query(
        `INSERT INTO posts (id, title, content, author_id, target_scope, display_start_date, display_end_date,
                            is_deleted, posted_at, created_at, updated_at)
         VALUES ($1, $2, '未読判定検証本文', 'kyomu01', '{"grade":"ALL","department":"ALL"}', $3, $4, $5, $6, $6, $6)`,
        [id, title, start, end, deleted, created]
      );
    }

    await query(
      `INSERT INTO post_acknowledgements (id, post_id, user_id, status, acknowledged_at)
       VALUES ($1, $2, $3, 'READ', CURRENT_TIMESTAMP)`,
      [`ack_${ids.read}`, ids.read, userId]
    );
    await query(
      `INSERT INTO post_acknowledgements (id, post_id, user_id, status, acknowledged_at)
       VALUES ($1, $2, $3, 'REJECTED', CURRENT_TIMESTAMP)`,
      [`ack_${ids.rejected}`, ids.rejected, userId]
    );
  });

  afterAll(async () => {
    await query(`DELETE FROM post_acknowledgements WHERE user_id = $1`, [userId]);
    await query(`DELETE FROM posts WHERE id LIKE 'unread_%'`);
    await query(`DELETE FROM users WHERE id = $1`, [userId]);
    await closePool();
  });

  it('SQL 判定: 登録日より古い記事・掲示終了記事・掲示開始前記事・既読・削除記事は未読数に含まれないこと', async () => {
    const today = dayKey(0);
    const res = await query(
      `SELECT count(*)::int AS n
       FROM posts p
       JOIN users u ON u.id = $2
       LEFT JOIN post_acknowledgements pa ON pa.post_id = p.id AND pa.user_id = $1
       WHERE COALESCE(p.is_deleted, 0) = 0
         AND COALESCE(pa.status, 'UNREAD') IN ('UNREAD', 'REJECTED')
         AND to_char(COALESCE(p.posted_at, p.created_at), 'YYYY-MM-DD') >= to_char(u.created_at, 'YYYY-MM-DD')
         AND (p.display_start_date IS NULL OR p.display_start_date <= $3::date)
         AND (p.display_end_date IS NULL OR p.display_end_date >= $3::date)
         AND p.id LIKE 'unread_%'`,
      [userId, userId, today]
    );
    expect(Number(res.rows[0].n)).toBe(3);
  });

  it('フロント条件 (isUnreadForMe ミラー) でも同じ 3 件になること', async () => {
    const userRes = await query(`SELECT id, grade, department, created_at FROM users WHERE id = $1`, [userId]);
    const user = userRes.rows[0];
    const postsRes = await query(
      `SELECT p.id, p.target_scope, p.display_start_date, p.display_end_date, p.posted_at, p.created_at,
              COALESCE(pa.status, 'UNREAD') AS ackstatus
       FROM posts p
       LEFT JOIN post_acknowledgements pa ON pa.post_id = p.id AND pa.user_id = $1
       WHERE p.id LIKE 'unread_%' AND COALESCE(p.is_deleted, 0) = 0`,
      [userId]
    );
    const unread = postsRes.rows.filter((b) => isUnreadForMeMirror(b, user));
    const idsSet = new Set(unread.map((b) => b.id));
    expect(unread.length).toBe(3);
    expect(idsSet.has(ids.regDayPost)).toBe(true);
    expect(idsSet.has(ids.valid)).toBe(true);
    expect(idsSet.has(ids.rejected)).toBe(true);
    expect(idsSet.has(ids.beforeReg)).toBe(false);
    expect(idsSet.has(ids.expired)).toBe(false);
    expect(idsSet.has(ids.notStarted)).toBe(false);
    expect(idsSet.has(ids.read)).toBe(false);
  });

  it('登録当日の記事は ≧ で含む（登録日正規化 ' + "'YYYY-MM-DD' JST）こと", async () => {
    const res = await query(`SELECT to_char(created_at, 'YYYY-MM-DD') AS day FROM users WHERE id = $1`, [userId]);
    expect(res.rows[0].day).toBe(regDay);
  });
});
