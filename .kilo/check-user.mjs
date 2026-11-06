import { query, closeDatabase } from '../config/database.js';

const r = await query("SELECT id, staff_code, name, role, password_hash FROM users WHERE staff_code = 'kyomu01'");
console.log('user=', JSON.stringify(r.rows.map((u) => ({ ...u, hashHead: String(u.password_hash).slice(0, 12) }))));

const n = await query("SELECT id, title, author_id, target_date, posted_at, created_at, is_deleted FROM posts ORDER BY created_at DESC LIMIT 5");
console.log('posts=', JSON.stringify(n.rows));

const c = await query('SELECT COUNT(*) AS n FROM bulletin_comments');
console.log('comments count=', JSON.stringify(c.rows));

await closeDatabase();
