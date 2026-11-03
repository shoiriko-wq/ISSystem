import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
});

for (const user of (process.env.ONLY_USER ? [process.env.ONLY_USER] : ['T2026001', 'T2026002'])) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`  [js] ${e.message}`));
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.type('#login-userid', user);
  await page.type('#login-password', 'password123');
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(900);
  await page.evaluate(() => document.querySelector('a[data-tab="facility"]').click());
  await sleep(1500);
  const info = await page.evaluate(() => {
    const userRaw = localStorage.getItem('is_system_user_info_v251');
    const btn = document.getElementById('facility-btn-manage');
    return {
      lsUser: userRaw ? userRaw.slice(0, 120) : null,
      hasBtn: !!btn,
      btnContainer: btn ? (btn.closest('[id]')?.id || 'NO_ID') : 'NONE',
      viewFacilityCount: document.querySelectorAll('#view-facility').length,
      headerUser: document.getElementById('current-user-badge')?.textContent || 'NONE',
      loginError: document.getElementById('login-error')?.textContent || 'NONE',
      loginScreenHidden: document.getElementById('login-screen')?.classList.contains('hidden'),
      appVisible: !document.getElementById('app-container')?.classList.contains('hidden'),
    };
  });
  console.log(user, JSON.stringify(info, null, 1));
}

await browser.close();
process.exit(0);
