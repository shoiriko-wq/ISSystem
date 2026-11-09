import { spawn } from 'node:child_process';
import net from 'node:net';
import puppeteer from 'puppeteer-core';

const ROOT = 'C:\\Users\\入江田　承\\Documents\\プログラミング\\ISSystem';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tryConnect = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 1200);
  });

const server = spawn('node', ['src/server.js'], { cwd: ROOT, stdio: 'inherit' });
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  if (await tryConnect(3443)) { ready = true; break; }
}
console.log(`READY=${ready}`);

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH,
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
try {
  const res = await page.goto('https://127.0.0.1:3443/', { waitUntil: 'domcontentloaded', timeout: 20000 });
  console.log('STATUS=', res.status(), 'TITLE=', await page.title());
} catch (e) {
  console.log('GOTO_FAIL=', e.message);
}
await browser.close();
server.kill('SIGTERM');
process.exit(0);