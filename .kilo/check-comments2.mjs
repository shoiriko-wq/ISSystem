import { query, closeDatabase } from '../config/database.js';

const c = await query('SELECT id, post_id, author_id, comment_text, created_at FROM bulletin_comments ORDER BY created_at DESC LIMIT 8');
console.log('comments=', JSON.stringify(c.rows));

const p = await query("SELECT id, title, author_id, created_at FROM posts WHERE title LIKE 'UI検証%' ORDER BY created_at DESC LIMIT 4");
console.log('ui posts=', JSON.stringify(p.rows));

await closeDatabase();
