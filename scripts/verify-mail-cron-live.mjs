/**
 * ライブ検証（一時スクリプト）: サーバー側 cron 定期受信 -> WSS mail:new_messages -> 無再描画更新
 *  1. 127.0.0.1:1143 に IMAP モックを立てる（1通目のみ応答 -> 2通目を追加）
 *  2. 検証用アカウント行を DB へ直接挿入（imap_host=127.0.0.1:1143 / tls none）
 *  3. ブラウザでログイン -> メールタブ -> 一覧コンテナとタブ面へノードマーカー
 *  4. cron の毎分 poll（1回目=基準のみ、2回目=件数変化で通知）を最大150秒待ち、
 *     WSS 受信・一覧カード差し替え・ノード不変・件数表示・トーストを実測
 */
import fs from 'node:fs';
import net from 'node:net';
import puppeteer from 'puppeteer-core';
import { query } from '../config/database.js';
import mailModel from '../src/models/mail.model.js';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const USER_ID = 'kyomu01';
const ACCOUNT_ID = 'acct-live-cron';
const MOCK_PORT = 1143;
const FIRST_SUBJECT = 'Cron検証1号 件名ライブ';
const SECOND_SUBJECT = 'Cron検証2号 件名ライブ';

const results = [];
function check(name, ok, detail = null) {
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Application/msedge.exe',
  ];
  for (const p of candidates) if (p && fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH を指定してください。');
}

function rawMsg(n, subject) {
  return [
    'From: 山田 太郎 <cron-sender@issystem.example>',
    'To: cron-test@issystem.example',
    `Subject: ${subject}`,
    `Date: Mon, 13 Nov 2026 10:0${n}:00 +0900`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 7bit',
    '',
    `ISSystem 定期受信 cron のライブ検証メール ${n} 号です。`,
  ].join('\r\n') + '\r\n';
}

// ---- IMAP モック ----
const msgs = [{ uid: 1, raw: rawMsg(1, FIRST_SUBJECT), flags: '\\Seen' }];
let polls = 0;
let appended = false;

const server = net.createServer((sock) => {
  let buf = '';
  sock.write('* OK [CAPABILITY IMAP4rev1 LITERAL+] mock IMAP server\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString('latin1');
    let idx;
    while ((idx = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const sp = line.indexOf(' ');
      if (sp < 0) continue;
      const tag = line.slice(0, sp);
      const rest = line.slice(sp + 1);
      const upper = rest.toUpperCase();
      if (upper.startsWith('LOGIN')) {
        sock.write(`${tag} OK LOGIN completed\r\n`);
      } else if (upper.startsWith('SELECT')) {
        sock.write(`* ${msgs.length} EXISTS\r\n* ${msgs.length} RECENT\r\n`);
        sock.write(`* OK [UIDNEXT ${msgs.length + 1}] Predicted next UID\r\n* FLAGS (\\Seen)\r\n`);
        sock.write(`${tag} OK [READ-ONLY] SELECT completed\r\n`);
      } else if (upper.startsWith('UID SEARCH')) {
        polls += 1;
        if (polls === 2 && !appended) {
          appended = true;
          msgs.push({ uid: 2, raw: rawMsg(2, SECOND_SUBJECT), flags: '' });
        }
        sock.write(`* SEARCH ${msgs.map((m) => m.uid).join(' ')}\r\n${tag} OK SEARCH completed\r\n`);
      } else if (upper.startsWith('UID FETCH')) {
        const uid = Number(rest.split(' ')[2]);
        const m = msgs.find((x) => x.uid === uid);
        if (!m) { sock.write(`${tag} OK FETCH completed\r\n`); continue; }
        const bytes = Buffer.from(m.raw, 'latin1');
        sock.write(`* ${uid} FETCH (UID ${uid} FLAGS (${m.flags}) INTERNALDATE "13-Nov-2026 10:0${uid}:00 +0900" BODY[] {${bytes.length}}\r\n`);
        sock.write(bytes);
        sock.write(`${tag} OK FETCH completed\r\n`);
      } else if (upper === 'LOGOUT') {
        sock.write(`* BYE IMAP4rev1 Server logging out\r\n${tag} OK LOGOUT completed\r\n`);
        sock.end();
      } else {
        sock.write(`${tag} OK completed\r\n`);
      }
    }
  });
  sock.on('error', () => sock.destroy());
});

server.listen(MOCK_PORT, '127.0.0.1');

// ---- 検証用アカウントを DB へ挿入 (前回の残骸を掃除して再実行可能に) ----
await query('DELETE FROM mail_messages WHERE account_id = $1', [ACCOUNT_ID]);
await query('DELETE FROM mail_accounts WHERE id = $1', [ACCOUNT_ID]);
const enc = mailModel.encryptPassword('live-cron-secret');
await query(
  `INSERT INTO mail_accounts (id, user_id, email_address, password_enc, imap_host, imap_port, imap_tls, imap_folder, smtp_host, smtp_port, smtp_tls, status, updated_at)
   VALUES ($1,$2,$3,$4,'127.0.0.1',${MOCK_PORT},'none','INBOX','127.0.0.1',${MOCK_PORT},'none','VERIFIED', NOW())`,
  [ACCOUNT_ID, USER_ID, 'cron-live@issystem.example', enc],
);

// ---- 自前起動したサーバー (cron 込み。稼働中 nodemon を止めて 3443 を占有) ----
const serverModule = await import('../src/server.js'); // 自己起動（startServer は export されていない）
await new Promise((r) => setTimeout(r, 2500));

const browser = await puppeteer.launch({

  executablePath: findChrome(), headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });

try {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(1500);

  await page.click('.app-sidebar [data-tab="mail"]');
  await sleep(1500);

  const markers = await page.evaluate(async () => {
    window.__mailEvents = [];
    const mod = await import('/js/socket.js');
    const s = mod.socketClient.socket;
    if (!s) return { attached: false, connected: false, id: null };
    s.on('mail:new_messages', (p) => window.__mailEvents.push(p));
    const root = document.getElementById('view-mail');
    const listBox = root ? root.querySelector('#mail-inbox-list') : null;
    window.__listMarker = listBox;
    return {
      attached: true,
      connected: s.connected === true,
      id: s.id,
      hasList: !!listBox,
      accounts: root ? root.querySelectorAll('[data-mail-tab-unread]').length : 0,
      text: root ? root.innerText.slice(0, 120) : '',
    };
  });
  check('メールタブに受信一覧カードがある', markers.hasList === true, markers);
  check('ブラウザ側で WSS 接続とイベント捕捉', markers.attached === true && markers.connected === true, markers);

  let event = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 150000) {
    const evs = await page.evaluate(() => window.__mailEvents.slice());
    if (evs.length > 0) { event = evs[0]; break; }
    await sleep(2000);
  }
  check('cron が毎分 poll し WSS mail:new_messages を配信（150秒内）', event !== null, { polls, event });

  if (event) {
    check('payload は account_id / added=1 / total=2 / unread=1',
      event.account_id === ACCOUNT_ID && event.added === 1 && event.total === 2 && event.unread === 1,
      { account_id: event.account_id, added: event.added, total: event.total, unread: event.unread, newest_subject: event.newest_subject });

    const ui = await page.evaluate((aid) => {
      const root = document.getElementById('view-mail');
      const listBox = root ? root.querySelector('#mail-inbox-list') : null;
      return {
        listSameNode: listBox === window.__listMarker,
        text: root ? root.innerText : '',
        boxCount: (document.getElementById('mail-box-count') || {}).textContent || '',
        inboxCount: (document.getElementById('mail-inbox-count') || {}).textContent || '',
        tabUnread: (document.querySelector(`#view-mail [data-mail-tab-unread="${aid}"]`) || {}).textContent || '',
        badge: (document.getElementById('mail-unread-count') || {}).textContent || '',
        toast: document.body.innerText.includes('新着メール'),
      };
    }, ACCOUNT_ID);

    check('受信一覧カードに新件名が現れる', ui.text.includes('Cron') && ui.text.includes('10:02'), { text: ui.text.slice(0, 160) });
    check('一覧コンテナのノードは作り替えられない（Animation 再発火なし）', ui.listSameNode === true, ui.listSameNode);
    check('件数表示が 全2件 / 2件 へ更新', ui.boxCount.includes('全 2件') && ui.inboxCount === '2件', { boxCount: ui.boxCount, inboxCount: ui.inboxCount });
    check('未読バッジが 1（タブ未読 span またはヘッダーバッジ）', ui.tabUnread === '1' || ui.badge === '1', { tabUnread: ui.tabUnread, badge: ui.badge });
    check('新着トースト（📪 新着メール 1件）が出る', ui.toast === true, ui.toast);
  }

  const rows = await query('SELECT uid, subject, is_read FROM mail_messages WHERE account_id = $1 ORDER BY uid', [ACCOUNT_ID]);
  check('サーバー側 cron が IMAP から 2通を受信保存（DB 実測）', rows.rows.length === 2, rows.rows.map((r) => `${r.uid}:${r.subject}:${r.is_read ? 'read' : 'unread'}`));
  const acc = await query('SELECT last_checked_at FROM mail_accounts WHERE id = $1', [ACCOUNT_ID]);
  check('cron が last_checked_at を更新', !!acc.rows[0]?.last_checked_at, acc.rows[0]?.last_checked_at);
  check('IMAP モックの poll 回数は2回以上', polls >= 2, polls);
} catch (e) {
  check('ライブ検証が完了', false, e.message);
} finally {
  await page.close().catch(() => {});
  await browser.close().catch(() => {});
  server.close();
  await query('DELETE FROM mail_messages WHERE account_id = $1', [ACCOUNT_ID]);
  await query('DELETE FROM mail_accounts WHERE id = $1', [ACCOUNT_ID]);
  const fails = results.filter((r) => !r.ok);
  console.log('--- live cron result ---');
  console.log(fails.length === 0 ? 'ALL PASS' : `${fails.length} FAIL`);
  process.exit(fails.length === 0 ? 0 : 1);
}
