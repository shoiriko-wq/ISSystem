/**
 * 施設・備品マスタ CRUD (教務部 KYOMU) の実ブラウザ検証
 *
 * 検証項目:
 *  1. 教務部 (KYOMU) にはヘッダーに「施設管理」ボタンがありマスタ管理モーダルが開く
 *  2. 教務部以外 (TEACHER) にはボタンが出ず、マスタ一覧も描画されない
 *  3. 新規追加 → マスタ行・タイムライン行・予約フォーム select へ即反映
 *  4. 改名 → マスタ行・タイムライン行・予約 select へ即反映
 *  5. 有効予約が残る施設は削除できない (エラートースト、行は残る)
 *  6. 予約をキャンセルすると削除でき、マスタ・タイムライン・select から消える
 *  7. socket 通知で他クライアント (TEACHER) のタイムラインと select が自動更新されトーストが出る
 * 実行: node scripts/test-facility-master.mjs   （ISSystem サーバーが必要）
 *  options: UI_BASE=http://host:port  UI_USER=T2026001  UI_PASS=password123  UI_TEACHER=T2026002  CHROME_PATH=...
 * 出力: scripts/output/facility-master.png
 *       NG が 1 件でもあれば exit code 1 (テスト後に追加施設は削除して元へ戻す)
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const TEACHER = process.env.UI_TEACHER || 'T2026002';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const OUT_DIR = `${import.meta.dirname}/output`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const log = (name, val) => console.log(`${name} = ${JSON.stringify(val)}`);
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

/** マスタ一覧・タイムライン・予約 select・トーストの状態スナップショット */
const snapshot = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#facility-master-list .facility-master-row')];
  const matrix = [...document.querySelectorAll('#facility-matrix-body [data-facility-row]')];
  const modal = document.getElementById('facility-master-modal');
  return {
    masterRows: rows.length,
    masterNames: rows.map((r) => r.querySelector('[data-field=name]').value.trim()),
    masterBadges: rows.map((r) => (r.querySelector('[data-badge]')?.textContent || '').replace(/\s+/g, ' ').trim()),
    masterPositions: rows.map((r) => Number(r.querySelector('[data-pos]')?.textContent)),
    upDisabled: rows.map((r) => r.querySelector('[data-action=up]')?.disabled === true),
    downDisabled: rows.map((r) => r.querySelector('[data-action=down]')?.disabled === true),
    matrixRows: matrix.length,
    matrixNames: matrix.map((r) => r.querySelector('span')?.textContent.trim()),
    matrixChips: document.querySelectorAll('#facility-matrix-body [data-res-id]').length,
    selectOptions: [...document.querySelectorAll('#facility-select option')].map((o) => o.textContent.trim()),
    modalHidden: modal ? modal.classList.contains('hidden') : null,
    hasManageBtn: !!document.getElementById('facility-btn-manage'),
    toastTexts: [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
  };
});

/** バッジ文字列から有効予約件数を取り出す */
const activeCount = (badge) => Number((badge.match(/有効予約 (\d+)/) || [])[1]);

/** JST 基準の YYYY-MM-DD (オフセット日数) */
const jstDate = (offset = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const todayJst = () => jstDate(0);
const tomorrowJst = () => jstDate(1);
const dayAfterJst = () => jstDate(2);

/** ページを開いてログインし、施設タブへ移動する */
async function setup(browser, user) {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  // 前ページのセッション (localStorage) を消して未ログイン状態から開始する (ページ間共有対策)
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await sleep(400);
  await page.type('#login-userid', user);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(1200);
  // ページ間で localStorage が共有されるため、このページのトークンを控え置く
  page.__token = await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251'));
  await page.evaluate(() => document.querySelector('a[data-tab="facility"]').click());
  await sleep(1600);
  return page;
}

/** マスタ追加フォームを送信する */
const addFacility = (page, name, category) => page.evaluate((n, c) => {
  document.getElementById('facility-master-add-name').value = n;
  document.getElementById('facility-master-add-category').value = c;
  document.getElementById('facility-master-add-form').requestSubmit();
}, name, category);

/** 名前を指定してマスタ行のボタンをクリックする (行が無ければ NOT_FOUND) */
const rowAction = (page, name, action) => page.evaluate((n, a) => {
  const row = [...document.querySelectorAll('#facility-master-list .facility-master-row')]
    .find((r) => r.querySelector('[data-field=name]').value.trim() === n);
  if (!row) return 'NOT_FOUND';
  row.querySelector(`[data-action=${a}]`).click();
  return row.dataset.facilityMasterId;
}, name, action);

/** マスタ行を改名・カテゴリ変更して保存する */
const renameRow = (page, oldName, newName, category) => page.evaluate((o, n, c) => {
  const row = [...document.querySelectorAll('#facility-master-list .facility-master-row')]
    .find((r) => r.querySelector('[data-field=name]').value.trim() === o);
  if (!row) return 'NOT_FOUND';
  row.querySelector('[data-field=name]').value = n;
  row.querySelector('[data-field=category]').value = c;
  row.querySelector('[data-action=save]').click();
  return row.dataset.facilityMasterId;
}, oldName, newName, category);

/** 予約作成フォームを埋めて送信する */
const createReservation = (page, { facilityName, date, start, end, purpose }) => page.evaluate((f, d, s, e, p) => {
  const sel = document.getElementById('facility-select');
  const opt = [...sel.options].find((o) => o.textContent.trim() === f);
  if (!opt) return 'OPTION_NOT_FOUND';
  sel.value = opt.value;
  document.getElementById('facility-date-input').value = d;
  document.getElementById('facility-start-time').value = s;
  document.getElementById('facility-end-time').value = e;
  document.getElementById('facility-purpose-input').value = p;
  document.getElementById('facility-form').requestSubmit();
  return 'OK';
}, facilityName, date, start, end, purpose);

/** 日付ピッカーの値を変えて再読込させる */
const setFacilityDate = (page, date) => page.evaluate((d) => {
  const picker = document.getElementById('facility-date-picker');
  picker.value = d;
  picker.dispatchEvent(new Event('change'));
}, date);


/** ページ内で API を叩く (予約作成・キャンセルの確認用)。そのページのログイントークンを渡す */
const apiFetch = (page, method, path, body) => page.evaluate(async (tok, m, p, b) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: tok ? `Bearer ${tok}` : '' },
    body: b ? JSON.stringify(b) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* flash レスポンス等 */ }
  return { status: res.status, json };
}, page.__token, method, path, body);

/** daily-overview 応答から (施設ID → 有効予約ID) を集める */
const collectReservations = (overviewJson, facilityId) => {
  const items = Array.isArray(overviewJson) ? overviewJson
    : (overviewJson?.facilitiesOverview || overviewJson?.overview || overviewJson?.facilities || overviewJson?.data || []);
  const ids = [];
  items.forEach((f) => {
    const fid = String(f.facility?.id || f.facility?.facility_id || f.facility_id || f.id || '');
    if (facilityId && fid !== facilityId) return;
    (f.reservations || []).forEach((r) => {
      if (r.id && Number(r.is_cancelled) !== 1) ids.push(String(r.id));
    });
  });
  return ids;
};

/** 過去の実行で作成した UI 検証用施設を API で撤去する (取り消し予約込み) */
const cleanUiLeftovers = async (page) => {
  const list = await apiFetch(page, 'GET', '/facilities');
  const facilities = list.json?.facilities || list.json?.data || [];
  const prefixes = ['UI検証室', 'UI同期室', 'UI権限確認部屋'];
  const leftovers = facilities.filter((f) => prefixes.some((p) => String(f.name || f.facility_name || '').startsWith(p)));
  const removed = [];
  for (const f of leftovers) {
    const fid = String(f.id || f.facility_id);
    for (const d of [todayJst(), tomorrowJst(), dayAfterJst()]) {
      const ov = await apiFetch(page, 'GET', `/facilities/daily-overview?date=${d}`);
      for (const rid of collectReservations(ov.json, fid)) {
        await apiFetch(page, 'DELETE', `/facilities/reservations/${rid}`);
      }
    }
    const del = await apiFetch(page, 'DELETE', `/facilities/${fid}`);
    removed.push(`${f.name}:${del.status}:${(del.json && (del.json.message || del.json.error)) || ''}`);
  }
  return removed;
};

const NEW_NAME = 'UI検証室A';
const RENAMED_NAME = 'UI検証室B';
const SYNC_NAME = 'UI同期室A';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});

const kyomu = await setup(browser, USER);
const teacher = await setup(browser, TEACHER);

// 教務部でマスタ管理モーダルを開いて基準値を測る (TEACHER はボタンもマスタ一覧を持たない)
log('kyomu-auth', { role: kyomu.__token ? 'token-captured' : 'missing', len: (kyomu.__token || '').length });
const cleanup = await cleanUiLeftovers(kyomu);
log('cleanup-leftovers', cleanup);
await sleep(400);
const baseTeacher = await snapshot(teacher);
await kyomu.evaluate(() => document.getElementById('facility-btn-manage').click());
await sleep(600);
await setFacilityDate(kyomu, todayJst());
await sleep(900);
const base = await snapshot(kyomu);
log('baseline-kyomu', { masterRows: base.masterRows, matrixRows: base.matrixRows, selectCount: base.selectOptions.length });

check('教務部ヘッダーに施設管理ボタンが出る', base.hasManageBtn === true, { hasManageBtn: base.hasManageBtn });
check('施設管理モーダルが開く', base.modalHidden === false, { modalHidden: base.modalHidden });
check('教務部以外 (TEACHER) に施設管理ボタンは出ない', baseTeacher.hasManageBtn === false, { hasManageBtn: baseTeacher.hasManageBtn });
check('TEACHER はマスタ一覧を持たない (モーダルも閉じたまま)', baseTeacher.masterRows === 0 && baseTeacher.modalHidden === true, { masterRows: baseTeacher.masterRows, modalHidden: baseTeacher.modalHidden });

// ---- 新規追加 ----
await addFacility(kyomu, NEW_NAME, 'GYM');
await sleep(1600);
const afterAdd = await snapshot(kyomu);
check('追加でマスタ行・タイムライン行・select が増える',
  afterAdd.masterRows === base.masterRows + 1 && afterAdd.matrixRows === base.matrixRows + 1 && afterAdd.selectOptions.includes(NEW_NAME),
  { before: base.masterRows, after: afterAdd.masterRows, matrixRows: afterAdd.matrixRows });
check('追加成功トースト', afterAdd.toastTexts.some((t) => t.includes(NEW_NAME) && t.includes('追加')), { toastTexts: afterAdd.toastTexts.slice(0, 2) });
await kyomu.screenshot({ path: `${OUT_DIR}/facility-master.png` });

// ---- 改名 ----
const renameRes = await renameRow(kyomu, NEW_NAME, RENAMED_NAME, 'ROOM');
await sleep(1600);
const afterRename = await snapshot(kyomu);
check('改名がマスタ行へ反映', renameRes !== 'NOT_FOUND' && afterRename.masterNames.includes(RENAMED_NAME) && !afterRename.masterNames.includes(NEW_NAME), { masterNames: afterRename.masterNames });
check('改名がタイムライン行と予約 select へ反映', afterRename.matrixNames.includes(RENAMED_NAME) && afterRename.selectOptions.includes(RENAMED_NAME), { matrixNames: afterRename.matrixNames, selectOptions: afterRename.selectOptions });

// ---- socket 通知 (TEACHER 側へ自動反映) ----
const socketBefore = await snapshot(teacher);
await addFacility(kyomu, SYNC_NAME, 'ROOM');
await sleep(1800);
const socketAfter = await snapshot(teacher);
check('socket 通知で TEACHER のタイムライン行と select が増える',
  socketAfter.matrixRows === socketBefore.matrixRows + 1 && socketAfter.selectOptions.includes(SYNC_NAME),
  { before: socketBefore.matrixRows, after: socketAfter.matrixRows });
check('socket 通知トースト (TEACHER)', socketAfter.toastTexts.some((t) => t.includes('施設を新規追加')), { toastTexts: socketAfter.toastTexts.slice(0, 3) });

// ---- 予約作成 → 有効予約バッジとタイムラインバンド ----
const date = tomorrowJst();
await setFacilityDate(kyomu, date);
await sleep(1200);
const bookRes = await createReservation(kyomu, { facilityName: RENAMED_NAME, date, start: '09:00', end: '10:00', purpose: 'UI検証予約' });
await sleep(1700);
const withRes = await snapshot(kyomu);
const badge = withRes.masterBadges[withRes.masterNames.indexOf(RENAMED_NAME)] || '';
check('予約作成でタイムラインにバンドと有効予約 1 件',
  bookRes === 'OK' && activeCount(badge) === 1 && withRes.matrixChips > 0,
  { bookRes, badge, matrixChips: withRes.matrixChips });

// ---- 削除ガード (有効予約が残る) ----
const blockedId = await rowAction(kyomu, RENAMED_NAME, 'delete');
await sleep(1000);
const blocked = await snapshot(kyomu);
check('有効予約が残る施設は削除できない (行は残る)',
  blockedId !== 'NOT_FOUND' && blocked.masterRows === withRes.masterRows && blocked.modalHidden === false,
  { masterRows: blocked.masterRows });
check('削除ガードのエラートースト', blocked.toastTexts.some((t) => t.includes('削除できません') && t.includes('有効な予約')), { toastTexts: blocked.toastTexts.slice(0, 3) });

// ---- 予約をキャンセル → 削除可能になる ----
const overview = await apiFetch(kyomu, 'GET', `/facilities/daily-overview?date=${date}`);
const resIds = renameRes === 'NOT_FOUND' ? [] : collectReservations(overview.json, renameRes);
const cancels = [];
for (const rid of resIds) {
  const r = await apiFetch(kyomu, 'DELETE', `/facilities/reservations/${rid}`);
  cancels.push(r.status);
}
await sleep(1300);
const afterCancel = await snapshot(kyomu);
const cancelBadge = afterCancel.masterBadges[afterCancel.masterNames.indexOf(RENAMED_NAME)] || '';
check('予約キャンセルで有効予約 0 件に戻る',
  resIds.length > 0 && cancels.every((s) => s < 400) && activeCount(cancelBadge) === 0,
  { resIds, cancels, cancelBadge });

const deleted = await rowAction(kyomu, RENAMED_NAME, 'delete');
await sleep(1600);
const afterDelete = await snapshot(kyomu);
check('予約無し施設は削除できる (マスタ・タイムライン・select から消える)',
  deleted !== 'NOT_FOUND' && afterDelete.masterRows === base.masterRows + 1
  && afterDelete.matrixRows === base.matrixRows + 1 && !afterDelete.selectOptions.includes(RENAMED_NAME),
  { masterRows: afterDelete.masterRows, matrixRows: afterDelete.matrixRows });

// ---- socket 削除通知 ----
const socketDelBefore = await snapshot(teacher);
await rowAction(kyomu, SYNC_NAME, 'delete');
await sleep(1800);
const socketDelAfter = await snapshot(teacher);
check('socket 削除通知で TEACHER の行と select が戻る',
  socketDelAfter.matrixRows === socketDelBefore.matrixRows - 1 && !socketDelAfter.selectOptions.includes(SYNC_NAME),
  { before: socketDelBefore.matrixRows, after: socketDelAfter.matrixRows });

// ---- TEACHER は API を叩けない (403) ----
const teacherStatus = await teacher.evaluate(async (tok) => {
  const res = await fetch('/api/facilities', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: tok ? `Bearer ${tok}` : '' },
    body: JSON.stringify({ name: 'UI権限確認部屋', category: 'ROOM' }),
  });
  return res.status;
}, teacher.__token);
log('teacher-POST-facilities', teacherStatus);
check('TEACHER の POST /api/facilities は 403', teacherStatus === 403, { status: teacherStatus });

await teacher.screenshot({ path: `${OUT_DIR}/facility-master-teacher.png` });

const finalBase = await snapshot(kyomu);
check('テスト後にマスタ・タイムラインは基準数へ戻る',
  finalBase.masterRows === base.masterRows && finalBase.matrixRows === base.matrixRows,
  { masterRows: finalBase.masterRows, matrixRows: finalBase.matrixRows });

await browser.close();
console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILURES`}`);
process.exit(failures.length === 0 ? 0 : 1);