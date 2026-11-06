const BASE = 'https://127.0.0.1:3443';

const login = await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ staff_code: 'kyomu01', password: 'issystem2026' }),
});
const j = await login.json();
console.log('login keys=', JSON.stringify(Object.keys(j)));
console.log('login user=', JSON.stringify(j.user));

const token = j.token;
const hdrs = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

const create = await fetch(BASE + '/api/bulletins', {
  method: 'POST',
  headers: hdrs,
  body: JSON.stringify({ title: 'API確認投稿', content: 'x', target_date: '2026-11-06' }),
});
const cj = await create.json();
const id = cj?.data?.id ?? cj?.id;
console.log('create status=', create.status, 'id=', id);

const detail = await (await fetch(BASE + `/api/bulletins/${id}`, { headers: hdrs })).json();
const d = detail.data || {};
console.log('detail keys=', JSON.stringify(Object.keys(d)));
console.log('detail author=', JSON.stringify({
  authorId: d.authorId, author_id: d.author_id, authorName: d.authorName,
  title: d.title, targetDate: d.targetDate, target_date: d.target_date,
  postedAt: d.postedAt, posted_at: d.posted_at, displayStart: d.displayStart,
}));

/* コメント追加 → 永続化 -> 再取得 */
const cmt = await fetch(BASE + `/api/bulletins/${id}/comments`, {
  method: 'POST',
  headers: hdrs,
  body: JSON.stringify({ comment: 'API確認コメント' }),
});
const cmtJson = await cmt.json();
console.log('comment status=', cmt.status, JSON.stringify(cmtJson).slice(0, 220));

const detail2 = await (await fetch(BASE + `/api/bulletins/${id}`, { headers: hdrs })).json();
console.log('detail comments=', JSON.stringify((detail2.data?.comments || []).map((c) => [c.id, c.comment_text, c.commenter, c.created_at])));

/* 後片付け：この確認投稿を削除 */
const del = await fetch(BASE + `/api/bulletins/${id}`, { method: 'DELETE', headers: hdrs });
console.log('delete status=', del.status);
