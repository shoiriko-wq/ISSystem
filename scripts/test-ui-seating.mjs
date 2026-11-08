/**
 * 座席表マトリクス UI 検証
 *
 * 検証項目:
 *  1. タイトルは「座席表」。検索ボックス・更新ボタン・ステータス凡例は存在しない
 *  2. 編集ロックモードでは行列セレクトが無効で、空席クリックでもモーダルは開かない
 *  3. 編集可能モードではセレクトが有効化 (1〜100 選択可)、行列変更でグリッドが再構成される
 *  4. 空席クリックはユーザセレクトのみのモーダルを開く（行・列・状態などの入力欄は無い）
 *  5. カードは オンラインバッヂ・出張/年休バッヂ・所属部局・担当教科・名前を表示し、枠線を持つ
 *  6. カードクリックはそのユーザが選択された状態でモーダルが開く。「設定なし」で席を空にできる
 *  7. 編集ロックへ戻すとセレクトは無効化され、カードクリックはモーダルを開かない
 * 実行: npm run test:ui:seating  （ISSystem サーバーが必要 UI_BASE / UI_USER / UI_PASS）
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const API_BASE = `${BASE}/api`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

/** 席セルのクリックを JS ディスパッチで発火（横スクロールによる座標ズレを排除） */
const clickSeat = (row, col) => page.evaluate((r, c) => {
  const el = document.querySelector(`#seating-matrix-container [data-seat-row="${r}"][data-seat-col="${c}"]`);
  if (!el) return false;
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  return true;
}, row, col);

const todayJST = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

/** Node 側 API 呼び出し（検証データの作成・掃除用） */
const nodeLogin = async () => {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ staff_code: USER, password: PASS }),
  });
  const json = await res.json().catch(() => ({}));
  return json.token || json.accessToken || json?.user?.token;
};

const nodeCall = async (token, method, path, body) => {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: token ? `Bearer ${token}` : '' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
};

const token = await nodeLogin();

// 検証開始前にマトリクスを確定状態化 (5×6・席なし)。編集モードのロックも解放
await nodeCall(token, 'POST', '/seating/matrix/lock', { resourceId: 'staff_room' });
await nodeCall(token, 'PUT', '/seating/matrix', { resourceId: 'staff_room', rows: 5, cols: 6, seats: [] });
await nodeCall(token, 'DELETE', '/seating/matrix/lock', null);

// 出張バッヂ検証用: 本日 t-sato の出張登録（テスト後に削除）
const trip = await nodeCall(token, 'POST', '/absences', {
  user_id: 't-sato',
  record_date: todayJST(),
  record_type: 'TRIP',
  reason: '座席表UI検証',
});
console.log('TRIP record', trip.status, trip.json?.record?.id || null);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[page js error] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log(`[console error] ${m.text()}`); });

await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1000);
await page.evaluate(() => document.querySelector('a[data-tab="seating"]').click());
await sleep(900);
// 1. ヘッダー（タイトル・検索/更新/凡例なし・トグル・行列セレクト）
const header = await page.evaluate(() => {
  const rowsSel = document.querySelector('#seat-grid-rows');
  const colsSel = document.querySelector('#seat-grid-cols');
  const h2 = document.querySelector('#seating-header-container h2');
  return {
    title: h2 ? h2.textContent.trim() : null,
    search: !!document.querySelector('#seating-search-input'),
    refresh: !!document.querySelector('#seating-btn-refresh'),
    legend: !!document.querySelector('.seating-legend'),
    toggle: !!document.querySelector('#seating-edit-toggle'),
    rowsDisabled: rowsSel ? rowsSel.disabled : null,
    colsDisabled: colsSel ? colsSel.disabled : null,
    rowsOptions: rowsSel ? rowsSel.options.length : 0,
    colsMax: colsSel ? Math.max(...Array.from(colsSel.options).map((o) => Number(o.value))) : 0,
  };
});
check('タイトルは「座席表」', header.title === '座席表', header.title);
check('検索ボックス・更新ボタン・凡例は無い', !header.search && !header.refresh && !header.legend, header);
check('編集ロック/編集可能トグルがある', header.toggle, header.toggle);
check('編集ロックモードでは行列セレクトが無効', header.rowsDisabled === true && header.colsDisabled === true, header);
check('行列セレクトは 1〜100 が選べる', header.rowsOptions === 100 && header.colsMax === 100, header);

// 2. 初期グリッド（セル数 = 行×列）
const gridInfo = () => page.evaluate(() => {
  const grid = document.querySelector('#seating-matrix-container .seating-grid');
  const rows = Number(document.querySelector('#seat-grid-rows').value);
  const cols = Number(document.querySelector('#seat-grid-cols').value);
  return {
    cells: grid.querySelectorAll('[data-seat-row]').length,
    cards: grid.querySelectorAll('.seat-card:not(.seat-card--empty)').length,
    rows,
    cols,
  };
});
const init = await gridInfo();
check('グリッドセル数 = 行×列', init.cells === init.rows * init.cols, init);
check('初期マトリクスには誰のカードもない', init.cards === 0 && init.rows === 5 && init.cols === 6, init);

// 3. 編集ロックモードの空席クリックはモーダルを開かない
await clickSeat(1, 1);
await sleep(400);
const lockedModal = await page.evaluate(() => document.querySelector('#seating-modal').classList.contains('hidden'));
check('編集ロックモードでは空席クリックでモーダルを開かない', lockedModal === true, lockedModal);

// 4. 編集可能モードへ（セレクト有効化）
await page.click('#seating-edit-toggle');
await sleep(1100);
const edit = await page.evaluate(() => ({
  label: document.querySelector('#seating-edit-toggle span')?.textContent.trim(),
  rowsDisabled: document.querySelector('#seat-grid-rows').disabled,
  colsDisabled: document.querySelector('#seat-grid-cols').disabled,
}));
check('編集可能モードへ切り替わりセレクトが有効化', edit.label === '編集可能' && edit.rowsDisabled === false && edit.colsDisabled === false, edit);

// 5. 行列変更 7×9 → グリッド再構成
await page.select('#seat-grid-rows', '7');
await page.select('#seat-grid-cols', '9');
await sleep(900);
const resized = await gridInfo();
check('行列変更でグリッドが 7×9 (=63) セル', resized.cells === 63 && resized.rows === 7 && resized.cols === 9, resized);

// 6. 空席 (5,5) クリック → ユーザセレクトのみのモーダル
await clickSeat(5, 5);
await sleep(800);
const modal = await page.evaluate(() => {
  const sel = document.querySelector('#seat-input-user');
  return {
    hidden: document.querySelector('#seating-modal').classList.contains('hidden'),
    title: document.querySelector('#seat-modal-title-text')?.textContent.trim(),
    options: sel ? sel.options.length : 0,
    value: sel ? sel.value : null,
    extraFields: !!(document.querySelector('#seat-input-row') || document.querySelector('#seat-input-name') || document.querySelector('#seat-select-status')),
  };
});
check('空席クリックでユーザセレクトのみモーダルが開く', modal.hidden === false && modal.title === '座席設定 (5行 - 5列)' && modal.options > 1 && modal.value === '', modal);
check('行・列・状態などの入力欄はモーダルから削除済み', modal.extraFields === false, modal.extraFields);

// 7. 佐藤先生（本日出張）を (5,5) に配置 → バッヂ・所属部局・担当教科・名前
const assigned = await page.evaluate(() => {
  const sel = document.querySelector('#seat-input-user');
  const opt = Array.from(sel.options).find((o) => o.value && o.textContent.includes('佐藤'));
  sel.value = opt.value;
  document.querySelector('#seating-edit-form').requestSubmit();
  return opt.value;
});
await sleep(1000);
const card = await page.evaluate(() => {
  const el = document.querySelector('#seating-matrix-container [data-seat-row="5"][data-seat-col="5"]');
  const cs = getComputedStyle(el);
  return {
    empty: el.classList.contains('seat-card--empty'),
    text: el.textContent.replace(/\s+/g, ' ').trim(),
    borderW: parseFloat(cs.borderTopWidth),
    modalHidden: document.querySelector('#seating-modal').classList.contains('hidden'),
  };
});
check('選択ユーザのカードが表示される', assigned === 't-sato' && !card.empty && card.text.includes('佐藤'), { assigned, text: card.text });
check('出張バッヂ・所属部局・担当教科が表示される', card.text.includes('出張') && card.text.includes('キャリアガイダンス部') && card.text.includes('数学'), card.text);
check('カードは枠線を持つ', card.borderW >= 1, card.borderW);

// 8. カードクリック → そのユーザが選択された状態でモーダル
await clickSeat(5, 5);
await sleep(700);
const reopen = await page.evaluate(() => ({
  hidden: document.querySelector('#seating-modal').classList.contains('hidden'),
  value: document.querySelector('#seat-input-user').value,
}));
check('カードクリックでそのユーザが選択されモーダルが開く', reopen.hidden === false && reopen.value === 't-sato', reopen);

// 9. 「設定なし」で席を空にする
await page.evaluate(() => {
  document.querySelector('#seat-input-user').value = '';
  document.querySelector('#seating-edit-form').requestSubmit();
});
await sleep(900);
const cleared = await page.evaluate(() =>
  document.querySelector('#seating-matrix-container [data-seat-row="5"][data-seat-col="5"]').classList.contains('seat-card--empty')
);
check('設定なしで席を空にできる', cleared === true, cleared);

// 10. 自分のカードはオンラインバッヂを表示
await clickSeat(6, 1);
await sleep(700);
await page.evaluate(() => {
  const sel = document.querySelector('#seat-input-user');
  const opt = Array.from(sel.options).find((o) => o.value === 'kyomu01');
  sel.value = opt ? opt.value : '';
  document.querySelector('#seating-edit-form').requestSubmit();
});
await sleep(900);
const selfCard = await page.evaluate(() =>
  document.querySelector('#seating-matrix-container [data-seat-row="6"][data-seat-col="1"]').textContent.replace(/\s+/g, ' ').trim()
);
check('オンラインバッヂと名前が表示される', selfCard.includes('オンライン') && selfCard.includes('教務'), selfCard);

// 11. 編集ロックへ戻す（セレクト無効化・カードクリックはモーダルを開かない）
await page.click('#seating-edit-toggle');
await sleep(1100);
const rellocked = await page.evaluate(() => ({
  label: document.querySelector('#seating-edit-toggle span')?.textContent.trim(),
  rowsDisabled: document.querySelector('#seat-grid-rows').disabled,
}));
await clickSeat(6, 1);
await sleep(500);
const lockModal = await page.evaluate(() => document.querySelector('#seating-modal').classList.contains('hidden'));
check('編集ロックへ戻りセレクト無効化・カードクリックはモーダルを開かない',
  rellocked.label === '編集ロック' && rellocked.rowsDisabled === true && lockModal === true,
  { label: rellocked.label, rowsDisabled: rellocked.rowsDisabled, lockModal });

// 掃除: 出張登録の削除とマトリクス初期化 (5×6・席なし)
if (trip.json?.record?.id) {
  await nodeCall(token, 'DELETE', `/absences/${trip.json.record.id}`);
}
await nodeCall(token, 'POST', '/seating/matrix/lock', { resourceId: 'staff_room' });
await nodeCall(token, 'PUT', '/seating/matrix', { resourceId: 'staff_room', rows: 5, cols: 6, seats: [] });
await nodeCall(token, 'DELETE', '/seating/matrix/lock', null);

await browser.close();
console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILURES`}`);
process.exit(failures.length === 0 ? 0 : 1);

