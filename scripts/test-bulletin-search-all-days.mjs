/**
 * 職員掲示板の全対象日検索（左列の検索結果一覧・対象日グループ見出し・検索ピル・対象日ジャンプ）の実ブラウザ検証
 *
 * 検証項目:
 *  1. 検索語入力で左列が全対象日の検索結果一覧になる（過去日・未来日の 2 投稿が並び、対象日見出し・対象日チップ・
 *     該当ハイライト <mark class="bulletin-hit">・件数「検索結果 N 件（全対象日）」が出る）
 *  2. 検索結果の行をクリックすると ‹ › の中心日がその対象日へジャンプし、その記事が選択されて右ペインに全文が出る
 *     （左列はその日の該当 1 件になり、ピルは「全対象日の検索結果 N 件」へ）
 *  3. ピルクリックで全対象日の検索結果一覧へ戻れる（中心日は動かさない）
 *  4. ピルで当日表示へ切り替えると検索語を保ったままその日の該当だけ（本日は該当 0 件）
 *  5. ミニカレンダー（C キー）は検索該当日に .mini-cal-hit の枠と aria-label「検索該当 N 件」を出す
 *  6. 検索語を消すと通常表示（ピル非表示・件数「N 件」）へ戻る
 *  7. 検証投稿を DELETE で掃除できる（後片付け）
 * 実行: node scripts/test-bulletin-search-all-days.mjs  （ISSystem サーバーが必要）
 *  options: UI_BASE=https://127.0.0.1:3443  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail = null) => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

const log = (name, val) => console.log(`${name} = ${JSON.stringify(val)}`);

/** JST の本日 (YYYY-MM-DD) */
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().split('T')[0];

/** YYYY-MM-DD に ±n 日 */
const shiftDate = (iso, days) => {
  const p = iso.split('-').map(Number);
  const t = Date.UTC(p[0], p[1] - 1, p[2]) + days * 86400000;
  return new Date(t).toISOString().split('T')[0];
};

const shortLabel = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;

const login = async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(900);
  page.__token = await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251'));
};

/** ページのログイントークンで API を叩く（検証投稿の作成・削除） */
const apiFetch = (page, method, path, body) => page.evaluate(async (tok, m, p, b) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: tok ? `Bearer ${tok}` : '' },
    body: b ? JSON.stringify(b) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON 応答 */ }
  return { status: res.status, json };
}, page.__token, method, path, body);

/** 左列・ピル・中心日・右ペインの状態スナップショット */
const snapshot = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const active = document.querySelector('#bulletin-list-container .bulletin-title-row.active');
  const pane = document.getElementById('bulletin-detail-pane');
  const pill = document.getElementById('bulletin-search-pill');
  const readout = document.getElementById('bulletin-day-current');
  const marks = [...document.querySelectorAll('#bulletin-list-container mark.bulletin-hit')];
  return {
    rows: rows.length,
    rowIds: rows.map((r) => String(r.getAttribute('data-bulletin-toggle'))),
    rowDays: rows.map((r) => r.querySelector('.bulletin-row-day')?.textContent.trim() || null),
    seps: [...document.querySelectorAll('#bulletin-list-container .bulletin-day-sep')].map((s) => s.textContent.trim()),
    countText: document.getElementById('bulletin-title-count')?.textContent.trim(),
    pillVisible: pill ? !pill.classList.contains('hidden') : null,
    pillText: pill ? pill.textContent.trim() : null,
    marks: marks.map((m) => m.textContent),
    activeTitle: active ? active.querySelector('.bulletin-row-title')?.textContent.trim() : null,
    centerDate: readout ? readout.dataset.day : null,
    paneTitle: pane.querySelector('h3') ? pane.querySelector('h3').textContent.trim() : null,
  };
});

/** 左列ヘッダーの検索ボックスへ入力（input イベントを起こす） */
const typeSearch = async (page, text) => {
  await page.evaluate((t) => {
    const el = document.getElementById('bulletin-search-input');
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(350);
};


const main = async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new', ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log(`[page js error] ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') console.log(`[console error] ${m.text()}`); });

  const today = todayJst();
  const pastDay = shiftDate(today, -4);
  const futureDay = shiftDate(today, 3);
  const q = 'zk9全対象日検索';

  await login(page);

  // 検証投稿（過去日と未来日の対象日に 1 件ずつ）。検索語はタイトルと本文の両方に含む
  const postA = await apiFetch(page, 'POST', '/bulletins', {
    title: `ZK9全対象日検索 過去日の記事`, content: `検索語 ${q} を本文にも持つ（過去日）`, target_date: pastDay,
  });
  const postB = await apiFetch(page, 'POST', '/bulletins', {
    title: `ZK9全対象日検索 未来日の記事`, content: `本文の語 ${q} だけ匹配（未来日）`, target_date: futureDay,
  });
  const idA = postA.json?.data?.id;
  const idB = postB.json?.data?.id;
  log('create', { statusA: postA.status, statusB: postB.status, idA, idB, pastDay, futureDay });
  check('検証投稿を 201 で作成できる（過去日・未来日の対象日）',
    postA.status === 201 && postB.status === 201 && Boolean(idA) && Boolean(idB), { postA: postA.status, postB: postB.status });

  // 掲示タブを開く（全件キャッシュ取得）
  await page.evaluate(() => document.querySelector('a[data-tab="bulletin"]').click());
  await sleep(900);

  const start = await snapshot(page);
  log('start', { centerDate: start.centerDate, countText: start.countText, rows: start.rows });

  // 1. 全対象日の検索結果一覧
  await typeSearch(page, q);
  const s1 = await snapshot(page);
  log('search-results', s1);
  check('検索語で左列が全対象日の検索結果一覧になる（過去日・未来日の 2 件が並ぶ）',
    s1.rows >= 2 && s1.rowIds.includes(String(idA)) && s1.rowIds.includes(String(idB)),
    { rows: s1.rows, rowIds: s1.rowIds });
  check('件数表示が「検索結果 N 件（全対象日）」', /検索結果 \d+ 件（全対象日）/.test(s1.countText || ''), s1.countText);
  check('対象日見出しグループが 2 日分出る（過去日・未来日）',
    s1.seps.length === 2 && s1.seps.some((t) => t.includes(shortLabel(pastDay))) && s1.seps.some((t) => t.includes(shortLabel(futureDay))),
    s1.seps);
  check('検索結果の行に対象日チップが出る', s1.rowDays.filter(Boolean).length >= 2, s1.rowDays);
  check('タイトル内の該当語が <mark class="bulletin-hit"> でハイライトされる',
    s1.marks.length >= 1 && s1.marks.some((t) => t.toLowerCase() === q), s1.marks);
  check('ピルが「この日のみ表示」で表示される', s1.pillVisible === true && s1.pillText === 'この日のみ表示',
    { pillVisible: s1.pillVisible, pillText: s1.pillText });


  // 2. 検索結果クリックで中心日がその対象日へジャンプ、右ペインに全文
  await page.evaluate((id) => document.querySelector(`#bulletin-list-container [data-bulletin-toggle="${id}"]`).click(), idB);
  await sleep(500);
  const s2 = await snapshot(page);
  log('jump-to-future-day', s2);
  check('クリックで中心日（‹ › の間）がその記事の対象日へジャンプ', s2.centerDate === futureDay, { centerDate: s2.centerDate, futureDay });
  check('その記事が選択され、右ペインに全文が出る',
    s2.activeTitle === 'ZK9全対象日検索 未来日の記事' && s2.paneTitle === 'ZK9全対象日検索 未来日の記事',
    { activeTitle: s2.activeTitle, paneTitle: s2.paneTitle });
  check('左列はその日の該当 1 件（検索語は維持）', s2.rows === 1 && s2.countText === '1 件', { rows: s2.rows, countText: s2.countText });
  check('ピルは「全対象日の検索結果 2 件」へ切替表示', /全対象日の検索結果 2 件/.test(s2.pillText || '') && s2.pillVisible,
    { pillText: s2.pillText, pillVisible: s2.pillVisible });

  // 3. ピルで全対象日の検索結果一覧へ戻る（中心日は動かさない）
  await page.evaluate(() => document.getElementById('bulletin-search-pill').click());
  await sleep(400);
  const s3 = await snapshot(page);
  log('back-to-results', s3);
  check('ピルで検索結果一覧へ戻れる（中心日はジャンプ後のまま・2 件以上・見出し 2 日分）',
    s3.centerDate === futureDay && s3.rowIds.includes(String(idA)) && s3.seps.length === 2,
    { centerDate: s3.centerDate, rowIds: s3.rowIds, seps: s3.seps });

  // 4. ピルで当日表示へ（検索語はそのまま・本日は該当 0 件）
  await page.evaluate(() => document.getElementById('bulletin-btn-today').click());
  await sleep(400);
  const s4 = await snapshot(page);
  log('day-view-with-query', { centerDate: s4.centerDate, countText: s4.countText, rows: s4.rows, pillText: s4.pillText });
  check('本日へ移動して検索語はそのまま・当日の該当 0 件表示',
    s4.centerDate === today && s4.rows === 0 && s4.countText === '0 件' && /全対象日の検索結果/.test(s4.pillText || ''),
    { centerDate: s4.centerDate, countText: s4.countText, pillText: s4.pillText });

  // 5. ミニカレンダーの検索該当枠（C キーで開く）
  await page.keyboard.press('c');
  await sleep(350);
  const cal = await page.evaluate(() => {
    const calEl = document.getElementById('bulletin-mini-cal');
    const hit = [...calEl.querySelectorAll('.mini-cal-hit')];
    return {
      open: !calEl.classList.contains('hidden'),
      hits: hit.length,
      hitDays: hit.map((d) => d.dataset.calDate),
      hitLabels: hit.map((d) => d.getAttribute('aria-label')),
    };
  });
  log('mini-cal-hits', cal);
  check('ミニカレンダーに検索該当日の枠が出る（過去日・未来日の 2 日、aria-label に検索該当）',
    cal.open && cal.hits === 2 && cal.hitDays.includes(pastDay) && cal.hitDays.includes(futureDay) &&
    cal.hitLabels.every((l) => l.includes('検索該当')),
    { hits: cal.hits, hitDays: cal.hitDays });
  await page.keyboard.press('c');
  await sleep(250);

  // 6. 検索語を消すと通常表示へ戻る
  await typeSearch(page, '');
  const s6 = await snapshot(page);
  log('cleared', { centerDate: s6.centerDate, countText: s6.countText, rows: s6.rows, pillVisible: s6.pillVisible });
  check('検索語を消すと通常表示（ピル非表示・件数「N 件」・本日の列表）',
    s6.pillVisible === false && /^\d+ 件$/.test(s6.countText || '') && s6.centerDate === today,
    { pillVisible: s6.pillVisible, countText: s6.countText });

  // 7. 後片付け（検証投稿を削除）
  const delA = await apiFetch(page, 'DELETE', `/bulletins/${idA}`);
  const delB = await apiFetch(page, 'DELETE', `/bulletins/${idB}`);
  log('cleanup', { delA: delA.status, delB: delB.status });
  check('検証投稿を DELETE で掃除できる', delA.status === 200 && delB.status === 200, { delA: delA.status, delB: delB.status });

  await browser.close();
};

main().then(() => {
  console.log(`\n${failures.length === 0 ? 'ALL PASSED' : `${failures.length} FAILURES`}`);
  process.exit(failures.length === 0 ? 0 : 1);
}).catch((err) => {
  console.error('ERROR:', err);
  process.exit(1);
});

