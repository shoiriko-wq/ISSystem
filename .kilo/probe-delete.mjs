/**
 * 掲示 DELETE のサーバー挙動probe（ルート有無・権限・ソフトデリートの効き方）
 */
import puppeteer from 'puppeteer-core';

const BASE = 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', 'T2026001');
await page.type('#login-password', 'password123');
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(800);

const tok = await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251'));

const call = async (method, path, body) => {
  const r = await page.evaluate(async (t, m, p, b) => {
    const res = await fetch(`/api${p}`, {
      method: m,
      headers: { 'Content-Type': 'application/json', Authorization: t ? `Bearer ${t}` : '' },
      body: b ? JSON.stringify(b) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text };
  }, tok, method, path, body);
  return r;
};

// 前回の検証で作ったまま残った投稿があれば撤去する（テストは自分の投稿を削除して元へ戻す）
const listJson = JSON.parse((await call('GET', '/bulletins')).text);
const leftovers = (listJson.bulletins || listJson.data || []).filter((i) => String(i.title || '').startsWith('UI検証削除用掲示'));
for (const l of leftovers) {
  console.log('CLEANUP', l.id, JSON.stringify(await call('DELETE', `/bulletins/${l.id}`)));
}

const created = await call('POST', '/bulletins', {
  title: 'probe削除用掲示',
  content: 'probe',
  author_id: 'kyomu01',
});
const id = JSON.parse(created.text)?.data?.id || JSON.parse(created.text)?.bulletin?.id;
console.log('CREATE', created.status, id);
console.log('GET-BEFORE', JSON.stringify(await call('GET', `/bulletins/${id}`)).slice(0, 160));
console.log('DELETE-OWN', JSON.stringify(await call('DELETE', `/bulletins/${id}`)));
console.log('GET-AFTER', (await call('GET', `/bulletins/${id}`)).status);
console.log('DELETE-OTHER(post_2)', JSON.stringify(await call('DELETE', '/bulletins/post_2')).slice(0, 200));
console.log('GET-POST2-AFTER', (await call('GET', '/bulletins/post_2')).status);

await browser.close();
