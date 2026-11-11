/**
 * 職員掲示板の添付ダウンロード検証（トークン付き取得で保存する）
 *
 * 直リンク（<a href="/api/bulletins/attachments/..">）はブラウザのナビゲーションなので
 * Authorization ヘッダーを送れず、API が 401 {"error":"Unauthorized"} を返す。
 * ダウンロードは apiDownload（トークン付き fetch）で取得し、blob をこの端末に保存する。
 *
 * 検証項目:
 *  1. サーバー: トークンなしの直接 GET は 401（＝直リンクが落ちる原因を実測で確定）
 *  2. サーバー: トークン付き GET は 200・Content-Disposition のファイル名・バイト数が元ファイルと一致
 *  3. UI: 新規投稿で .txt を添付して投稿できる（トースト・左列の行・右ペインの添付行）
 *  4. UI: ダウンロードはボタン（BUTTON + data-attachment-download）。掲示画面に API 直リンクの <a> は存在しない
 *     （ボタンは pointer と 1px 実線枠＝ボタン枠規則、ラベル「ダウンロード」）
 *  5. UI: 右ペインのボタンで保存動作が起こる（保存名・サイズ・中身が元ファイルと一致、API 200、成功トースト、ボタンは再利用可能）
 *  6. UI: 詳細モーダルのボタンでも同じ（モーダルは閉じない、2回目の保存動作）
 *  7. ルール27（UI では確認できない server 側の権限）: 投稿者・教務 (KYOMU)・管理者 (ADMIN) だけダウンロード可。
 *     投稿者でもアップローダでもない一般教員 (TEACHER) のトークンでの GET は 403（ファイル本体は返らない）。
 *     一般教員が UI でこの掲示を開くとダウンロードボタンが出ない（サーバー直叩きも 403 で防ぐ）
 *  8. 後片付け（投稿を削除し、添付レコードと実体ファイルを消して data/uploads に残さない。既読レコードも消す。
 *     検証用に作った TEACHER アカウントは ADMIN で削除する）
 * 実行: node scripts/test-bulletin-download.mjs  （ISSystem サーバーが必要・npm start）
 *  options: UI_BASE=https://127.0.0.1:3443  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 * 出力: スクリプト実行ログ + scripts/output/bulletin-download.png
 *       NG が 1 件でもあれば exit code 1
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'scripts', 'output');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ★ Node 側の通信は CA を明示する（素の fetch は自己署名チェーンを弾く。NODE_EXTRA_CA_CERTS は使わない）
const SECURE = BASE.startsWith('https:');
const CA = SECURE ? [fs.readFileSync(path.join(ROOT, 'certs', 'issystem-ca.crt'))] : null;

/** CA を渡す API 呼び出し（バイナリも扱う。status / headers / text / buffer を返す） */
function caReq(method, p, bodyText, tok) {
  return new Promise((resolve, reject) => {
    const u = new URL(`${BASE}/api${p}`);
    const headers = {};
    if (bodyText) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(bodyText));
    }
    if (tok) headers.Authorization = `Bearer ${tok}`;
    const opts = {
      hostname: u.hostname,
      port: u.port || (SECURE ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
    };
    if (SECURE) opts.ca = CA;
    const mod = SECURE ? https : http;
    const r = mod.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, text: buf.toString('utf8'), buffer: buf });
      });
    });
    r.on('error', reject);
    if (bodyText) r.write(bodyText);
    r.end();
  });
}

const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

// ★ 添付する元ファイル（実体はサーバーが data/uploads に作るため、後片付けで実体も消す）
fs.mkdirSync(OUT, { recursive: true });
const MARK = `${Date.now()}`;
const FILE_NAME = `dlcheck-${MARK}.txt`;
const FILE_TEXT = `ISSystem attachment download check ${MARK}\nline2\n`;
const TITLE = `添付ダウンロード検証 ${MARK}`;
const TMP_FILE = path.join(OUT, FILE_NAME);
fs.writeFileSync(TMP_FILE, FILE_TEXT, 'utf8');

const { query, pool } = await import('../config/database.js');

// --- 1. Node 側でログイン（トークン付き取得の基準） ---
const login = await caReq('POST', '/auth/login', JSON.stringify({ staff_code: USER, password: PASS }), '');
const loginJson = JSON.parse(login.text || '{}');
const token = loginJson.token || loginJson.accessToken || loginJson?.data?.token || '';
console.log(`node-login = ${JSON.stringify({ status: login.status, hasToken: !!token })}`);
check('テスト教職員番号でログインできる', login.status === 200 && !!token, { status: login.status, hasToken: !!token });

// --- 2. ブラウザでログインして添付付き投稿を作る ---
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
const apiStatuses = [];
page.on('response', (res) => {
  if (res.url().includes('/api/bulletins/attachments/')) apiStatuses.push(res.status());
});
page.on('pageerror', (e) => console.log(`[page js error] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log(`[console error] ${m.text()}`); });

await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1000);
await page.evaluate(() => document.querySelector('a[data-tab="bulletin"]').click());
await sleep(900);

// ★ 保存動作を記録する（ヘッドレスで実際にディスクへ書き出さない。href は object URL なので中身は __blobs にある）
await page.evaluate(() => {
  window.__dl = [];
  window.__blobs = new Map();
  const origCreate = URL.createObjectURL.bind(URL);
  URL.createObjectURL = function (b) {
    const u = origCreate(b);
    window.__blobs.set(u, b);
    return u;
  };
  const origClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (this.download) {
      const b = window.__blobs.get(this.href);
      window.__dl.push({ download: this.download, size: b ? b.size : -1 });
      return;
    }
    return origClick.apply(this);
  };
});

const toastTexts = (pg) => pg.evaluate(() =>
  [...document.querySelectorAll('#toast-container .toast')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()));

/** 左列のタイトルテキストで投稿行を選択する（クリック＝即既読化して右ペインが全文になる） */
const selectRowByTitle = async (pg, title) => {
  await pg.evaluate((t) => {
    const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
    const row = rows.find((r) => (r.querySelector('.bulletin-row-title')?.textContent || '').includes(t));
    if (row) row.click();
  }, title);
  await sleep(1200);
};

// ★ 新規投稿（ファイル添付付き）
await page.click('#bulletin-btn-create');
await sleep(400);
await page.type('#bulletin-title', TITLE);
await page.type('#bulletin-content', 'ダウンロード検証の本文です。');
// ★ puppeteer-core 25 では page.setInputFiles が無い → FileChooser でファイルを選ぶ（input[type=file] をクリックして accept）
const [fileChooser] = await Promise.all([page.waitForFileChooser(), page.click('#bulletin-files')]);
await fileChooser.accept([TMP_FILE]);
await sleep(300);
await page.click('#bulletin-form button[type="submit"]');
await sleep(1800);

const postState = await page.evaluate((t) => {
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const row = rows.find((r) => (r.querySelector('.bulletin-row-title')?.textContent || '').includes(t));
  return {
    rowFound: !!row,
    rowTitle: row ? row.querySelector('.bulletin-row-title').textContent.trim() : null,
    modalOpen: !document.getElementById('bulletin-modal')?.classList.contains('hidden'),
  };
}, TITLE);
const toastsAfterPost = await toastTexts(page);
check('添付付き投稿が成功した（トーストに「投稿しました（添付 1 件）」）',
  toastsAfterPost.some((t) => t.includes('投稿しました') && t.includes('添付 1 件')), toastsAfterPost.slice(-2));
check('左列に新しい投稿行が出た', postState.rowFound && postState.rowTitle.includes(MARK), postState.rowTitle);
check('投稿モーダルは閉じた', postState.modalOpen === false, postState.modalOpen);


// --- 3. 右ペインの添付行とダウンロードボタン（直リンクでないこと・枠・ラベル） ---
await selectRowByTitle(page, TITLE);

const attInfo = await page.evaluate(() => {
  const pane = document.getElementById('bulletin-detail-pane');
  const btn = pane.querySelector('[data-attachment-download]');
  const cs = btn ? getComputedStyle(btn) : null;
  return {
    attRows: pane.querySelectorAll('.attachment-item').length,
    tag: btn ? btn.tagName : null,
    attId: btn ? btn.getAttribute('data-attachment-download') : null,
    attName: btn ? btn.getAttribute('data-attachment-name') : null,
    label: btn ? btn.textContent.replace(/\s+/g, ' ').trim() : null,
    cursor: cs ? cs.cursor : null,
    borderW: cs ? cs.borderTopWidth : null,
    borderStyle: cs ? cs.borderTopStyle : null,
    anchors: document.querySelectorAll('#view-bulletin a[href*="/api/bulletins/attachments"]').length,
    disabled: btn ? btn.disabled : null,
  };
});
console.log(`pane-attachment = ${JSON.stringify(attInfo)}`);
check('右ペインに添付行が1件出た', attInfo.attRows === 1, attInfo.attRows);
check('ダウンロードはボタンで行う（BUTTON + data-attachment-download + ラベル「ダウンロード」）',
  attInfo.tag === 'BUTTON' && !!attInfo.attId && (attInfo.label || '').includes('ダウンロード'), attInfo);
check('ボタンは pointer と 1px 実線枠（ボタン枠規則）',
  attInfo.cursor === 'pointer' && attInfo.borderW === '1px' && attInfo.borderStyle === 'solid',
  { cursor: attInfo.cursor, borderW: attInfo.borderW, borderStyle: attInfo.borderStyle });
check('掲示画面に API 直リンクの <a> は存在しない（401 の原因となった形を残さない）', attInfo.anchors === 0, attInfo.anchors);

// ★ DB でこの投稿の添付レコード（実体ファイル名）を突き止める
const postRow = await query('SELECT id FROM posts WHERE title = ? AND COALESCE(is_deleted,0) = 0', [TITLE]);
const postId = postRow.rows[0] ? postRow.rows[0].id : null;
const attRows = await query('SELECT id, original_name, stored_name, size_bytes FROM bulletin_attachments WHERE post_id = ?', [postId]);
const attCount = attRows.rows.length;
const attId = attRows.rows[0] ? attRows.rows[0].id : '';
const storedName = attRows.rows[0] ? attRows.rows[0].stored_name : '';
console.log(`db-post = ${JSON.stringify({ postId, atts: attRows.rows })}`);
check('サーバーが添付レコードを作った（1件・元ファイル名・サイズ一致）',
  attCount === 1 && attRows.rows[0].original_name === FILE_NAME && Number(attRows.rows[0].size_bytes) === Buffer.byteLength(FILE_TEXT),
  attRows.rows);
check('右ペインのボタンがその添付IDを指している',
  attCount === 1 && attInfo.attId === attRows.rows[0].id, { attId: attInfo.attId, dbId: attRows.rows[0] ? attRows.rows[0].id : null });

// --- 4. サーバー: トークンなしの直接 GET（旧実装の直リンクが落ちる原因）は 401 ---
const noTok = await caReq('GET', `/bulletins/attachments/${attId}`, '', '');
check('トークンなしの直接 GET は 401 Unauthorized（直リンクが落ちる原因を再現）',
  noTok.status === 401 && (noTok.text.includes('Unauthorized') || noTok.text.includes('アクセストークン')),
  { status: noTok.status, body: noTok.text.slice(0, 120) });

// --- 5. サーバー: トークン付き GET は 200・ファイル名・バイト数一致 ---
const withTok = await caReq('GET', `/bulletins/attachments/${attId}`, '', token);
const disp = String(withTok.headers['content-disposition'] || '');
check('トークン付き GET は 200 でファイル本体が返る（バイト数が元ファイルと一致）',
  withTok.status === 200 && withTok.buffer.length === Buffer.byteLength(FILE_TEXT),
  { status: withTok.status, bytes: withTok.buffer.length });
check('Content-Disposition に元ファイル名がある（UTF-8 の filename*）',
  decodeURIComponent(disp).includes(FILE_NAME) && disp.includes('attachment'), disp.slice(0, 160));

// --- 5b. ルール27の権限（UI では確認できない server 側の判定をここで実測する） ---
//  投稿者・アップローダ・教務 (KYOMU)・管理者 (ADMIN) だけダウンロードできる。
//  投稿者でもアップローダでもない一般教員 (TEACHER) は 403（ファイル本体は返らない）。
const TEACHER_CODE = `T91${MARK.slice(-5)}`;
const TEACHER_PASS = PASS;
const ADMIN_CODE = 'T2026000';

const createTeacher = await caReq('POST', '/users',
  JSON.stringify({ staff_code: TEACHER_CODE, name: '添付検証 教員', password: TEACHER_PASS, role: 'TEACHER' }), token);
const teacherJson = JSON.parse(createTeacher.text || '{}');
const teacherId = teacherJson.user?.id || teacherJson.id || null;
check('ルール27の下準備: 検証用 TEACHER を作成できる（教務が作成する role は TEACHER に固定＝201）',
  createTeacher.status === 201 && !!teacherId, { status: createTeacher.status, body: createTeacher.text.slice(0, 120) });

const teacherLogin = await caReq('POST', '/auth/login', JSON.stringify({ staff_code: TEACHER_CODE, password: TEACHER_PASS }), '');
const teacherToken = JSON.parse(teacherLogin.text || '{}').token || '';
check('ルール27の下準備: 検証用 TEACHER でログインできる', teacherLogin.status === 200 && !!teacherToken,
  { status: teacherLogin.status, hasToken: !!teacherToken });

const teacherGet = await caReq('GET', `/bulletins/attachments/${attId}`, '', teacherToken);
check('ルール27: 投稿者でもアップローダでもない一般教員の GET は 403（ファイル本体は返らず、権限メッセージだけ）',
  teacherGet.status === 403 && !teacherGet.text.includes(FILE_TEXT) && teacherGet.text.includes('投稿者'),
  { status: teacherGet.status, bytes: teacherGet.buffer.length, body: teacherGet.text.slice(0, 120) });

const adminLogin = await caReq('POST', '/auth/login', JSON.stringify({ staff_code: ADMIN_CODE, password: PASS }), '');
const adminToken = JSON.parse(adminLogin.text || '{}').token || '';
const adminGet = await caReq('GET', `/bulletins/attachments/${attId}`, '', adminToken);
check('ルール27: ADMIN は投稿者でなくてもダウンロードできる（200・バイト数一致）',
  adminGet.status === 200 && adminGet.buffer.length === Buffer.byteLength(FILE_TEXT),
  { status: adminGet.status, bytes: adminGet.buffer.length });

// 掲示レコードの実体ファイル名は DB から取ったので、Content-Length も実測で合わせる
check('Content-Length が元ファイルのバイト数と一致（レスポンス実体長）',
  Number(String(withTok.headers['content-length'] || '-1')) === Buffer.byteLength(FILE_TEXT),
  { header: withTok.headers['content-length'], bytes: Buffer.byteLength(FILE_TEXT) });

// --- 6. UI: 右ペインのボタンで保存動作（ファイル名・中身・API 200・トースト・ボタン再利用） ---
apiStatuses.length = 0;
await page.evaluate(() => { window.__dl.length = 0; });

// ★ 実クリック前にボタンの中央に他の要素（オーバーレイ）が載っていないか実測する（UI の枠・重なり規則）
const paneOverlay = await page.evaluate(() => {
  const btn = document.querySelector('#bulletin-detail-pane [data-attachment-download]');
  if (!btn) return { found: false };
  const r = btn.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const top = document.elementFromPoint(cx, cy);
  return {
    found: true,
    topIsBtn: top === btn || btn.contains(top),
    topTag: top ? top.tagName + '.' + (top.className || '').toString().split(' ').slice(0, 2).join('.') : null,
    topAttr: top ? (top.getAttribute('data-attachment-download') || top.getAttribute('data-bulletin-detail') || null) : null,
  };
});
console.log(`pane-overlay = ${JSON.stringify(paneOverlay)}`);
check('右ペインのダウンロードボタンは中心まで実クリックできる（オーバーレイに覆われていない）',
  paneOverlay.found && paneOverlay.topIsBtn, paneOverlay);

// 中心クリック（puppeteer の実クリック）→ 覆われていれば evaluate の .click() でフォールバックして保存動作を見る
const paneClicked = await page.evaluate(() => {
  const btn = document.querySelector('#bulletin-detail-pane [data-attachment-download]');
  const r = btn.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  const overlayFree = top === btn || btn.contains(top);
  if (!overlayFree) btn.click();  // オーバーレイ対策（evaluate で直接発火）
  return overlayFree;
});
await sleep(1600);

const dl1 = await page.evaluate(async () => {
  const rec = window.__dl[window.__dl.length - 1] || null;
  let content = null;
  if (rec) {
    for (const b of window.__blobs.values()) {
      if (b.size === rec.size) { content = await b.text(); break; }
    }
  }
  const btn = document.querySelector('#bulletin-detail-pane [data-attachment-download]');
  return {
    rec,
    content,
    btnDisabled: btn ? btn.disabled : null,
    toasts: [...document.querySelectorAll('#toast-container .toast')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
  };
});
console.log(`pane-download = ${JSON.stringify({ rec: dl1.rec, contentMatch: dl1.content === FILE_TEXT, btnDisabled: dl1.btnDisabled, lastToast: dl1.toasts.slice(-1) })}`);
check('右ペインのボタンで保存動作が起こる（保存名は元ファイル名）', dl1.rec && dl1.rec.download === FILE_NAME, dl1.rec);
check('右ペインのボタンで保存される中身とサイズが元ファイルと一致',
  dl1.rec && dl1.rec.size === Buffer.byteLength(FILE_TEXT) && dl1.content === FILE_TEXT,
  { size: dl1.rec ? dl1.rec.size : null, contentMatch: dl1.content === FILE_TEXT });
check('右ペインからの取得は API 200（トークン付き。401 ではない）', apiStatuses.length === 1 && apiStatuses[0] === 200, apiStatuses);
check('右ペインの成功トースト（「保存しました」）', dl1.toasts.some((t) => t.includes('保存しました')), dl1.toasts.slice(-1));
check('取得後にボタンは再度押せる（disabled=false）', dl1.btnDisabled === false, dl1.btnDisabled);


// --- 7. UI: 詳細モーダルのボタンでも同じ（モーダルは閉じない） ---
// 「詳細」ボタンもオーバーレイ実測 → 覆われていれば evaluate で発火（フォールバック）
const detailOverlay = await page.evaluate(() => {
  const btn = document.querySelector('#bulletin-detail-pane [data-bulletin-detail]');
  if (!btn) return { found: false };
  const r = btn.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { found: true, topIsBtn: top === btn || btn.contains(top), topTag: top ? top.tagName : null };
});
console.log(`detail-overlay = ${JSON.stringify(detailOverlay)}`);
check('右ペインの「詳細」ボタンも中心まで実クリックできる（オーバーレイに覆われていない）',
  detailOverlay.found && detailOverlay.topIsBtn, detailOverlay);
if (detailOverlay.found && detailOverlay.topIsBtn) {
  await page.click('#bulletin-detail-pane [data-bulletin-detail]');
} else {
  await page.evaluate(() => document.querySelector('#bulletin-detail-pane [data-bulletin-detail]').click());
}
await sleep(900);
const modalOpen = await page.evaluate(() => !document.getElementById('bulletin-detail-modal').classList.contains('hidden'));
check('詳細モーダルが開いた', modalOpen, modalOpen);

const modalBtn = await page.evaluate(() => {
  const box = document.getElementById('detail-bulletin-attachments');
  const btn = box.querySelector('[data-attachment-download]');
  return {
    rows: box.querySelectorAll('.attachment-item').length,
    tag: btn ? btn.tagName : null,
    attId: btn ? btn.getAttribute('data-attachment-download') : null,
    anchors: box.querySelectorAll('a[href*="/api/bulletins/attachments"]').length,
  };
});
check('詳細モーダルにも添付行とボタンがある（直リンク <a> はなし）',
  modalBtn.rows === 1 && modalBtn.tag === 'BUTTON' && modalBtn.attId === attId && modalBtn.anchors === 0, modalBtn);

apiStatuses.length = 0;
await page.evaluate(() => { window.__dl.length = 0; });
const modalOverlay = await page.evaluate(() => {
  const btn = document.querySelector('#detail-bulletin-attachments [data-attachment-download]');
  if (!btn) return { found: false };
  const r = btn.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { found: true, topIsBtn: top === btn || btn.contains(top), topTag: top ? top.tagName : null };
});
console.log(`modal-overlay = ${JSON.stringify(modalOverlay)}`);
if (modalOverlay.found && modalOverlay.topIsBtn) {
  await page.click('#detail-bulletin-attachments [data-attachment-download]');
} else {
  await page.evaluate(() => document.querySelector('#detail-bulletin-attachments [data-attachment-download]').click());
}
await sleep(1600);
const dl2 = await page.evaluate(async () => {
  const rec = window.__dl[window.__dl.length - 1] || null;
  let content = null;
  if (rec) {
    for (const b of window.__blobs.values()) {
      if (b.size === rec.size) { content = await b.text(); break; }
    }
  }
  return {
    rec,
    content,
    modalOpen: !document.getElementById('bulletin-detail-modal').classList.contains('hidden'),
    toasts: [...document.querySelectorAll('#toast-container .toast')].map((el) => el.textContent.replace(/\s+/g, ' ').trim()),
  };
});
check('詳細モーダルのボタンでも保存動作が起こる（保存名・中身一致、モーダルは閉じない）',
  dl2.rec && dl2.rec.download === FILE_NAME && dl2.content === FILE_TEXT && dl2.modalOpen === true,
  { rec: dl2.rec, contentMatch: dl2.content === FILE_TEXT, modalOpen: dl2.modalOpen });
check('詳細モーダルからの取得は API 200', apiStatuses.length === 1 && apiStatuses[0] === 200, apiStatuses);
check('詳細モーダルの成功トースト（「保存しました」）', dl2.toasts.some((t) => t.includes('保存しました')), dl2.toasts.slice(-1));

// ★ ホバーで影（リング＋浮き）が付き、ボタンが上がる（UI十条5）。frame-rules は fx パネルの実測なのでここでは見るだけ
await page.hover('#detail-bulletin-attachments [data-attachment-download]');
await sleep(420);
const hover = await page.evaluate(() => {
  const btn = document.querySelector('#detail-bulletin-attachments [data-attachment-download]');
  const cs = getComputedStyle(btn);
  const parts = cs.boxShadow.split(/,(?![^(]*\))/).map((s) => s.trim()).filter((s) => s && s !== 'none');
  const tr = cs.transform.match(/matrix\(([^)]*)\)/);
  return { ring: parts.length, lift: tr ? -Number(tr[1].split(',')[5]) : 0, transform: cs.transform, shadow: cs.boxShadow.slice(0, 60) };
});
check('ホバーで影（リング）と浮きが出る（UI十条5）', hover.ring >= 1 && hover.lift >= 1, hover);

await page.screenshot({ path: path.join(OUT, 'bulletin-download.png'), fullPage: false });

// --- 7b. UI: 一般教員（投稿者ではない）にはダウンロードボタンが出ない（ルール27） ---
const page2 = await browser.newPage();
page2.on('pageerror', (e) => console.log(`[teacher page js error] ${e.message}`));
await page2.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page2.type('#login-userid', TEACHER_CODE);
await page2.type('#login-password', TEACHER_PASS);
await page2.evaluate(() => window.handleLoginClick());
await page2.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1000);
await page2.evaluate(() => document.querySelector('a[data-tab="bulletin"]').click());
await sleep(900);

// 掲示期間内の投稿なので TEACHER の一覧にも出る（スコープ ALL）。行を選んで右ペインを見る
await selectRowByTitle(page2, TITLE);

// ★ ルール27 判定ロジックの実測（UI 側の判定関数と、その入力を読む）
const listForTeacher = JSON.parse(await caReq('GET', '/bulletins', '', teacherToken));
const bT = (listForTeacher.bulletins || []).find((x) => (x.title || '').includes(MARK));
const aT = (bT?.attachments || [])[0];
const perm = await page2.evaluate((bb, aa) => window.__canDownloadDebug(bb, aa), bT, aT);
console.log(`teacher-perms = ${JSON.stringify(perm)}`);
check('ルール27の判定ロジック: 一般教員は canDownloadAttachment=false（author/uploader=教務, role=TEACHER）',
  perm.can === false, perm);

const teacherPane = await page2.evaluate(() => {
  const pane = document.getElementById('bulletin-detail-pane');
  const items = pane.querySelectorAll('.attachment-item');
  return {
    attRows: items.length,
    buttons: pane.querySelectorAll('[data-attachment-download]').length,
    hint: (pane.textContent || '').includes('ダウンロードは投稿者のみ'),
  };
});
check('ルール27: 一般教員の右ペインに添付行はあるがダウンロードボタンは出ない',
  teacherPane.attRows === 1 && teacherPane.buttons === 0 && teacherPane.hint === true, teacherPane);

// 詳細モーダルでもボタンは出ない（モーダルの添付欄を見る）
await page2.click('#bulletin-detail-pane [data-bulletin-detail]');
await sleep(900);
const teacherModal = await page2.evaluate(() => {
  const box = document.getElementById('detail-bulletin-attachments');
  return {
    rows: box.querySelectorAll('.attachment-item').length,
    buttons: box.querySelectorAll('[data-attachment-download]').length,
    anchors: box.querySelectorAll('a[href*="/api/bulletins/attachments"]').length,
  };
});
check('ルール27: 一般教員の詳細モーダルにもダウンロードボタンは出ない（直リンク <a> もなし）',
  teacherModal.rows === 1 && teacherModal.buttons === 0 && teacherModal.anchors === 0, teacherModal);

// 一般教員がダウンロード画面を開いたまま投稿者本人（KYOMU）のトークンで取得すると 200（権限者は取れる）
const kyomuGetAgain = await caReq('GET', `/bulletins/attachments/${attId}`, '', token);
check('ルール27: 投稿者本人 (KYOMU) のトークンは 403 にならず 200（権限者は取得できる）',
  kyomuGetAgain.status === 200, { status: kyomuGetAgain.status });

// --- 8. 存在しない添付とトークンなしの取得は 404 / 401（サーバー契約のまま） ---
const notFound = await caReq('GET', '/bulletins/attachments/att_not_here', '', token);
check('存在しない添付は 404（トークン付き）', notFound.status === 404 && !!notFound.text, { status: notFound.status, body: notFound.text.slice(0, 120) });

// --- 9. 後片付け（投稿削除・添付レコードと実体ファイル・既読レコード・検証用 TEACHER。data/uploads に検証ファイルを残さない） ---
const del = await caReq('DELETE', `/bulletins/${postId}`, '', token);
check('後片付け: 投稿者本人の DELETE は 200', del.status === 200, { status: del.status, body: del.text.slice(0, 120) });

// 検証用 TEACHER は ADMIN のみ削除できる（DELETE /api/users/:id = requireAdminRole）
const delTeacher = teacherId ? await caReq('DELETE', `/users/${teacherId}`, '', adminToken) : { status: 0, text: '' };
check('後片付け: 検証用 TEACHER を ADMIN で削除した（200）', delTeacher.status === 200,
  { status: delTeacher.status, body: delTeacher.text.slice(0, 120) });

await query('DELETE FROM bulletin_attachments WHERE post_id = ?', [postId]);
await query('DELETE FROM post_acknowledgements WHERE post_id = ?', [postId]);
const storedPath = path.join(ROOT, 'data', 'uploads', storedName);
if (storedName && fs.existsSync(storedPath)) fs.unlinkSync(storedPath);
const leftAtts = await query('SELECT COUNT(*) AS c FROM bulletin_attachments WHERE post_id = ?', [postId]);
const leftC = Number(leftAtts.rows[0].c);
console.log(`cleanup = ${JSON.stringify({ leftAtts: leftC, storedRemoved: !fs.existsSync(storedPath) })}`);
check('後片付け: 添付レコードと実体ファイルが消えた（data/uploads に検証ファイルを残さない）',
  leftC === 0 && !fs.existsSync(storedPath), { leftAtts: leftC, storedRemoved: !fs.existsSync(storedPath) });

fs.unlinkSync(TMP_FILE);
const afterList = await caReq('GET', '/bulletins', '', token);
check('後片付け: 検証投稿は API 一覧に残らない', !(afterList.text || '').includes(MARK), { status: afterList.status });

await pool.end();
await browser.close();
console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILURES`}`);
process.exit(failures.length === 0 ? 0 : 1);

