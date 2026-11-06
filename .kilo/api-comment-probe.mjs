import { readFileSync } from 'node:fs';
import https from 'node:https';

const base = 'https://127.0.0.1:3443/api';
const ca = readFileSync('certs/issystem-ca.crt');

function req(method, path, body, token) {
  return new Promise((resolve) => {
    const u = new URL(base + path);
    const data = body ? JSON.stringify(body) : '';
    const r = https.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        'Content-Length': Buffer.byteLength(data),
      },
      ca,
      checkServerIdentity: () => undefined,
    }, (res) => {
      let b = '';
      res.on('data', (c) => b += c);
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', (e) => resolve({ status: 0, body: String(e) }));
    r.end(data);
  });
}

const login = await req('POST', '/auth/login', { staff_code: 'T2026001', password: 'password123' });
console.log('LOGIN=', login.status, login.body.slice(0, 260));
const j = JSON.parse(login.body);
const token = j.token || j.access_token || j.accessToken || j.data?.token || j.data?.access_token;
const create = await req('POST', '/bulletins', { title: 'API確認掲示', content: 'API 確認', author_id: 'kyomu01' }, token);
console.log('CREATE=', create.status, create.body.slice(0, 300));
const cid = JSON.parse(create.body).data?.id;
const post = await req('POST', `/bulletins/${cid}/comments`, { comment: 'API 確認コメント', comment_text: 'API 確認コメント' }, token);
console.log('CREATE=', create.status, 'POST=', post.status, post.body.slice(0, 200));
const detail = await req('GET', `/bulletins/${cid}`, undefined, token);
const d = JSON.parse(detail.body);
console.log('DETAIL comments=', JSON.stringify((d.data?.comments || []).map((c) => [c.id, c.comment_text])));
