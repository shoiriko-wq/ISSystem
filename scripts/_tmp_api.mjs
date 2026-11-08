const B = 'https://127.0.0.1:3443';
(async () => {
  const l = await fetch(B + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ staff_code: 'sys-admin', password: 'password123' }) });
  const j = await l.json();
  console.log('LOGIN', JSON.stringify(j).slice(0, 200));
  const me = await fetch(B + '/api/auth/me', { headers: { Authorization: 'Bearer ' + j.token } });
  const m = await me.json();
  console.log('ME', JSON.stringify(m).slice(0, 300));
})();