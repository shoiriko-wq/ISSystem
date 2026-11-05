const base = 'http://localhost:3000';
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  body: new URLSearchParams({ staff_code: 'T2026001', password: 'password123' }),
}).then((r) => r.json());
const tok = login.token;
const headers = { Authorization: `Bearer ${tok}` };

const info = await fetch(`${base}/api/basic-info`, { headers }).then((r) => r.json());
const classes = (info.classes || info.data?.classes || []).map((c) => c.name);
console.log('classes:', classes.join(','));

const create = await fetch(`${base}/api/basic-info/class`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ grade: 1, name: '1-3理' }),
});
console.log('POST 1-3理 =>', create.status, (await create.json()).message);

const del = await fetch(`${base}/api/basic-info/class/1-1`, { method: 'DELETE', headers });
console.log('DELETE 1-1 =>', del.status, (await del.json()).message);
process.exit(0);
