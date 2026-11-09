import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const ROOT = 'C:\\Users\\入江田　承\\Documents\\プログラミング\\ISSystem';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tryConnect = (port) =>
  new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1');
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    setTimeout(() => resolve(false), 1200);
  });

const runScript = (script, extraEnv = {}) =>
  new Promise((resolve) => {
    const child = spawn('cmd', ['/c', 'npm', 'run', script], {
      cwd: ROOT,
      env: { ...process.env, CHROME_PATH: CHROME, ...extraEnv },
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code));
  });

const spawnServer = () => {
  const outFd = fs.openSync(path.join(ROOT, 'data', 'srv_out2.log'), 'a');
  const errFd = fs.openSync(path.join(ROOT, 'data', 'srv_err2.log'), 'a');
  const s = spawn('node', ['src/server.js'], {
    cwd: ROOT,
    detached: true,
    stdio: ['ignore', outFd, errFd],
  });
  s.unref();
  return s;
};

const ensureServer = async () => {
  if (await tryConnect(3443)) return;
  console.log('SERVER_DOWN ->再起動');
  spawnServer();
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    if (await tryConnect(3443)) return;
  }
  console.log('SERVER_READY_TIMEOUT');
};

const server = spawnServer();
let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(1000);
  if (await tryConnect(3443)) { ready = true; break; }
}
console.log(`SERVER_READY=${ready}`);

if (ready) {
  console.log('=== api-smoke-test (server 稼働) ===');
  await runScript('api:check');
}

const specs = [
  'test:ui:https',
  'test:ui:modal',
  'test:ui:news-share',
  'test:ui:fx',
  'test:ui:frames',
  'test:ui:audit',
  'test:ui:chrome',
  'test:ui:contrast',
  'test:ui:contrast-plain',
  'test:ui:scan',
  'test:ui:header-frames',
  'test:ui:nav',
  'test:ui:sidebar',
  'test:ui:sidebar-push',
  'test:ui:facility-header-sticky',
  'test:ui:facility-order',
  'test:ui:bulletin',
  'test:ui:unread',
  'test:ui:bulletin-search',
  'test:ui:schedule',
  'test:ui:chat',
  'test:ui:facility',
  'test:ui:timeline',
  'test:ui:mail',
  'test:ui:exambasic',
  'test:ui:seating',
  'test:ui:block',
];

for (const s of specs) {
  console.log(`=== spec ${s} ===`);
  await ensureServer();
  const code = await runScript(s);
  console.log(`EXIT ${s} = ${code}`);
}

try {
  process.kill(server.pid, 'SIGTERM');
} catch {
  // 起動できていなければ何もしない
}
await sleep(1500);
console.log('=== docs gate ===');
const code = await runScript('verify:docs');
console.log(`EXIT docs = ${code}`);
console.log('ALL_DONE');
process.exit(0);