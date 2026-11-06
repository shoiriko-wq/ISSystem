const BASE = 'https://127.0.0.1:3443';

const login = await fetch(BASE + '/api/auth/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ staff_code: 'T2026001', password: 'password123' }),
});
const j = await login.json();
console.log('login status=', login.status, 'user=', JSON.stringify(j.user || j.data?.user || null));

const token = j.token || j.data?.token;
const hdrs = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };

const create = await fetch(BASE + '/api/bulletins', {
  method: 'POST',
  headers: hdrs,
  body: JSON.stringify({ title: 'API確認投稿', content: 'x', target_date: '2026-11-06' }),
});
const cj = await create.json();
const id = cj?.data?.id ?? cj?.id;
console.log('create status=', create.status, 'id=', id, 'author=', JSON.stringify({
  authorId: cj?.data?.authorId, author_id: cj?.data?.author_id, authorName: cj?.data?.authorName,
}));

const cmt = await fetch(BASE + `/api/bulletins/${id}/comments`, {
  method: 'POST',
  headers: hdrs,
  body: JSON.stringify({ comment: 'API確認コメント' }),
});
console.log('comment status=', cmt.status, JSON.stringify(await cmt.json()).slice(0, 200));

const detail = await (await fetch(BASE + `/api/bulletins/${id}`, { headers: hdrs })).json();
console.log('detail comments=', JSON.stringify((detail.data?.comments || []).map((c) => [c.id, c.comment_text, c.commenter || c.author_name, c.created_at])));

const del = await fetch(BASE + `/api/bulletins/${id}`, { method: 'DELETE', headers: hdrs });
console.log('delete status=', del.status, JSON.stringify(await del.json()).slice(0, 120));
