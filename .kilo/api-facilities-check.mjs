const base = 'http://localhost:3000';
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  body: new URLSearchParams({ staff_code: 'T2026001', password: 'password123' }),
}).then((r) => r.json());
const headers = { Authorization: `Bearer ${login.token}` };

const list = await fetch(`${base}/api/facilities`, { headers }).then((r) => r.json());
const arr = list.facilities || list.data?.facilities || list.data || list;
const names = arr.map((f) => f.name);
console.log(`facilities(${names.length}):`, names.join(','));

const bad = await fetch(`${base}/api/facilities`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '体育館', category: 'ROOM' }),
});
console.log('POST 体育館 =>', bad.status, JSON.stringify(await bad.json()));

const del = await fetch(`${base}/api/facilities/fac_1`, { method: 'DELETE', headers });
console.log('DELETE fac_1 =>', del.status, JSON.stringify(await del.json()));

const ok = await fetch(`${base}/api/facilities`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '２１２教室', category: 'SPECIAL' }),
});
console.log('POST ２１２教室 =>', ok.status, JSON.stringify(await ok.json()));
process.exit(0);
