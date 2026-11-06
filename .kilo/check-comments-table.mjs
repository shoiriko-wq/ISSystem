import { query, closeDatabase } from '../config/database.js';

const r = await query("SELECT table_name FROM information_schema.tables WHERE table_name IN ('bulletin_comments','posts') ORDER BY table_name");
console.log('tables=', JSON.stringify(r.rows.map((x) => Object.values(x)[0])));

const cols = await query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'bulletin_comments' ORDER BY ordinal_position");
console.log('cols=', JSON.stringify(cols.rows.map((c) => Object.values(c).join(':'))));

const cnt = await query('SELECT COUNT(*) AS n FROM bulletin_comments');
console.log('comment rows=', JSON.stringify(cnt.rows));

const posts = await query("SELECT id, title, author_id FROM posts ORDER BY created_at DESC LIMIT 3");
console.log('latest posts=', JSON.stringify(posts.rows.map((p) => Object.values(p).join('|'))));

const postsCols = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'posts' ORDER BY ordinal_position");
console.log('posts cols=', JSON.stringify(postsCols.rows.map((c) => Object.values(c)[0])));

const ackCols = await query("SELECT column_name FROM information_schema.columns WHERE table_name = 'post_acknowledgements' ORDER BY ordinal_position");
console.log('ack cols=', JSON.stringify(ackCols.rows.map((c) => Object.values(c)[0])));

await closeDatabase();
