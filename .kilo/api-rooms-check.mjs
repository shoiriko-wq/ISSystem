const base = 'http://localhost:3000';
const login = await fetch(`${base}/api/auth/login`, {
  method: 'POST',
  body: new URLSearchParams({ staff_code: 'T2026001', password: 'password123' }),
}).then((r) => r.json());
const headers = { Authorization: `Bearer ${login.token}` };

const rooms = await fetch(`${base}/api/exam/exam_2026_1/rooms`, { headers }).then((r) => r.json());
const names = (rooms.rooms || rooms.data?.rooms || []).map((r) => r.name);
console.log('rooms:', names.join(','), `(count=${names.length})`);

const bad = await fetch(`${base}/api/exam/exam_2026_1/rooms`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '体育館', room_type: 'SPECIAL' }),
});
console.log('POST 体育館 =>', bad.status, (await bad.json()).message);

const ok = await fetch(`${base}/api/exam/exam_2026_1/rooms`, {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: '405', room_type: 'SPECIAL' }),
});
console.log('POST 405 =>', ok.status, (await ok.json()).message ?? (await ok.json()).data?.name);
process.exit(0);
