const base = 'http://localhost:3000';
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  body: new URLSearchParams({ staff_code: 'T2026001', password: 'password123' }),
}).then((r) => r.json());
const tok = login.token;
const headers = { Authorization: `Bearer ${tok}` };

const list = await fetch(`${base}/api/subjects`, { headers }).then((r) => r.json());
console.log('subjects:', list.subjects.map((s) => s.name).join(','));

const create = await fetch(`${base}/api/subjects`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '英語' }),
});
console.log('POST 英語 =>', create.status, (await create.json()).message);

const kokugo = list.subjects.find((s) => s.name === '国語');
if (kokugo) {
  const del = await fetch(`${base}/api/subjects/${kokugo.id}`, { method: 'DELETE', headers });
  console.log(`DELETE 国語(${kokugo.id}) =>`, del.status, (await del.json()).message);
}
process.exit(0);


