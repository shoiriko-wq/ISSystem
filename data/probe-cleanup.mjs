// 一時スクリプト（削除予定）: 計測用試験（PROBE）の残りを消す
import pg from 'pg';
const c = new pg.Client({ user: 'postgres', password: 'otome601', host: 'localhost', port: 5432, database: 'issystem' });
await c.connect();
const ids = (await c.query("SELECT id FROM exam_masters WHERE title LIKE 'PROBE%'")).rows.map((r) => r.id);
for (const id of ids) {
  await c.query('DELETE FROM exam_slots WHERE exam_master_id = $1', [id]);
  await c.query('DELETE FROM exam_subject_plan WHERE exam_master_id = $1', [id]);
  await c.query('DELETE FROM exam_phases WHERE exam_master_id = $1', [id]);
  await c.query('DELETE FROM exam_masters WHERE id = $1', [id]);
}
console.log('probe exams deleted:', ids.length);

// 検索テスト（test-bulletin-search-all-days.mjs）の残存投稿（タイトルが ZK9 で始まる）を消す。
// 中断したUIテストが後片付けできず残した投稿は、ダッシュボード未読テストの期待を壊す。
const zids = (await c.query("SELECT id FROM posts WHERE title LIKE 'ZK9%'")).rows.map((r) => r.id);
for (const id of zids) {
  await c.query('DELETE FROM post_acknowledgements WHERE post_id = $1', [id]);
  await c.query('DELETE FROM bulletin_attachments WHERE post_id = $1', [id]);
  await c.query('DELETE FROM bulletin_comments WHERE post_id = $1', [id]);
  await c.query('DELETE FROM posts WHERE id = $1', [id]);
}
console.log('ZK9 posts deleted:', zids.length);
await c.end();
