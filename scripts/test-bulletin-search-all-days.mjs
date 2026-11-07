/**
 * 職員掲示板の全日検索（左列の検索結果一覧・対象日グループ見出し・中心日の「全日」表示・投稿者名検索）の実ブラウザ検証
 *
 * 検証項目:
 *  1. 初期状態（本日）は件数「N 件」・中心日表示は日付・‹ ›・本日・日付クリックは enabled・検索ピルは無い
 *  2. 検索語入力前に C キーでミニカレンダーが開く（検索語を入力する前は ‹ ›・本日・C キーが効く）
 *  3. 検索語入力で左列が全日の検索結果一覧になる（過去日・未来日の 2 投稿が対象日見出し付きで並び、
 *     行に対象日チップ・タイトル該当語の <mark class="bulletin-hit">・件数「N 件」が出る）
 *  4. 中心日表示が「全日」になり、‹ ›・本日・日付クリック（カレンダー開閉）は disabled（data-day は入力前と同じ本日。
 *     固定幅なので › の位置は動かず「全日」も同じ枠に収まる）
 *  5. ミニカレンダーは検索該当日に .mini-cal-hit の枠と aria-label「検索該当 N 件」を出し、日付セルは全セル disabled
 *  6. 検索結果の行クリックは中心日を動かさず、その記事が選択されて右ペインに全文が出る（左列は全日の列表まま）
 *  7. 検索中は ←/→・T・C キーが中心日を動かさない（readout は「全日」、カレンダーは開いたまま）。
 *     全セル disabled のカレンダー日付セルも合成クリックで中心日が動かない（委譲側にもガード）
 *  8. 投稿者名（ログインユーザー名。タイトル・本文に含めない語）でも過去日・未来日の 2 件が全日の列表に出る
 *  9. 検索語を消すと通常表示（件数「N 件」・中心日表示は本日・‹ ›・本日・C が enabled・カレンダーの該当枠消え日付セル復帰）
 * 10. C キーでミニカレンダーを閉じる（検索語が無い状態では C が効く）
 * 11. 検証投稿を DELETE で掃除できる（後片付け）
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
let total = 0;
const check = (name, ok, detail = null) => {
  total++;
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

/** ミニカレンダーの中心日読取と同じ短縮ラベル (MM/DD (曜)) */
const shortLabel = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;

/** 左列の行チップ・対象日見出しと同じ MM/DD 部分（曜日は付きません） */
const mmdd = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;

/** ログイン（app が保存する JWT キー is_system_jwt_token_v251 を page.__token に保持。test-bulletin-split.mjs と同じ慣習） */
const login = async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(1200);
  const tok = await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251'));
  page.__token = tok;
  return Boolean(tok);
};

/** ページ内 fetch で API を叩く（ログイン後の JWT を使用） */
const apiFetch = (page, method, path, body) => page.evaluate(async (tok, m, p, b) => {
  const res = await fetch(`/api${p}`, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: tok ? `Bearer ${tok}` : '' },
    ...(b ? { body: JSON.stringify(b) } : {}),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}, page.__token, method, path, body || null);

/** 左列ヘッダーの検索ボックスへ入力（input イベントを起こす） */
const typeSearch = async (page, text) => {
  await page.evaluate((t) => {
    const el = document.getElementById('bulletin-search-input');
    el.value = t;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, text);
  await sleep(420);
};

/** 左列・中心日表示・ナビボタン・右ペインの状態スナップショット */
const snapshot = (page) => page.evaluate(() => {
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  const active = document.querySelector('#bulletin-list-container .bulletin-title-row.active');
  const pane = document.getElementById('bulletin-detail-pane');
  const readout = document.getElementById('bulletin-day-current');
  const marks = [...document.querySelectorAll('#bulletin-list-container mark.bulletin-hit')];
  const navIds = ['bulletin-day-prev', 'bulletin-day-next', 'bulletin-btn-today', 'bulletin-day-current'];
  const cal = document.getElementById('bulletin-mini-cal');
  return {
    rows: rows.length,
    rowIds: rows.map((r) => String(r.getAttribute('data-bulletin-toggle'))),
    rowDays: rows.map((r) => r.querySelector('.bulletin-row-day')?.textContent.trim() || null),
    seps: [...document.querySelectorAll('#bulletin-list-container .bulletin-day-sep')].map((s) => s.textContent.trim()),
    countText: document.getElementById('bulletin-title-count')?.textContent.trim(),
    pillExists: Boolean(document.getElementById('bulletin-search-pill')),
    readoutText: readout ? readout.textContent.trim() : null,
    centerDate: readout ? readout.dataset.day : null,
    readoutW: readout ? Math.round(readout.getBoundingClientRect().width) : null,
    nextX: document.getElementById('bulletin-day-next') ? Math.round(document.getElementById('bulletin-day-next').getBoundingClientRect().x) : null,
    navDisabled: navIds.map((id) => Boolean(document.getElementById(id)?.disabled)),
    calOpen: Boolean(cal && !cal.classList.contains('hidden')),
    marks: marks.map((m) => m.textContent),
    activeTitle: active ? active.querySelector('.bulletin-row-title')?.textContent.trim() : null,
    paneTitle: pane.querySelector('h3') ? pane.querySelector('h3').textContent.trim() : null,
  };
});

/** ミニカレンダー（検索該当日の枠・日付セルの enabled/disabled） */
const calState = (page) => page.evaluate(() => {
  const calEl = document.getElementById('bulletin-mini-cal');
  const hit = [...calEl.querySelectorAll('.mini-cal-hit')];
  const days = [...calEl.querySelectorAll('button.mini-cal-day')];
  return {
    open: !calEl.classList.contains('hidden'),
    hits: hit.length,
    hitDays: hit.map((d) => d.dataset.calDate),
    hitLabels: hit.map((d) => d.getAttribute('aria-label')),
    dayCells: days.length,
    disabledDays: days.filter((d) => d.disabled).length,
  };
});

const main = async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new', ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--allow-insecure-localhost', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e).slice(0, 300)));
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('CONSOLE-ERR:', String(m.text()).slice(0, 200));
  });

  const today = todayJst();
  const pastDay = shiftDate(today, -4);    // 対象日グループの過去日
  const futureDay = shiftDate(today, 3);   // 対象日グループの未来日
  const q = 'zk9全日検索';                 // 検索語（過去日のタイトルと未来日の本文にのみ存在）

  await login(page);

  const postA = await apiFetch(page, 'POST', '/bulletins', {
    title: `ZK9全日検索 過去日の記事`, content: `検索語 ${q} を本文にも持つ（過去日）`, target_date: pastDay,
  });
  const postB = await apiFetch(page, 'POST', '/bulletins', {
    title: `ZK9全日検索 未来日の記事`, content: `本文の語 ${q} だけ匹配（未来日）`, target_date: futureDay,
  });
  const idA = postA.json?.data?.id;
  const idB = postB.json?.data?.id;
  log('create', { pastDay, futureDay, idA, idB, statusA: postA.status, statusB: postB.status });
  check('検証投稿を 201 で作成できる（過去日・未来日の対象日）',
    postA.status === 201 && postB.status === 201 && idA && idB, { statusA: postA.status, statusB: postB.status });

  // 投稿者名（ログインユーザーの表示名。タイトル・本文に含めない語なので、この検索語は投稿者名一致で当たる）
  const authorName = (postA.json?.data?.author_name || postA.json?.data?.authorName)
    || await page.evaluate(async (tok, id) => {
        const res = await fetch('/api/bulletins', { headers: { Authorization: tok ? `Bearer ${tok}` : '' } });
        const j = await res.json();
        const list = j.bulletins || (Array.isArray(j) ? j : []);
        const b = list.find((x) => String(x.id) === String(id));
        return b ? (b.author_name || b.authorName || '') : '';
      }, page.__token, idA);
  log('authorName', authorName);

  // 掲示タブを開く（全件キャッシュ取得）
  await page.evaluate(() => document.querySelector('a[data-tab="bulletin"]').click());
  await sleep(900);

  const start = await snapshot(page);
  log('start', { centerDate: start.centerDate, countText: start.countText, rows: start.rows, readoutText: start.readoutText, navDisabled: start.navDisabled, pillExists: start.pillExists });
  check('初期状態（本日）は件数「N 件」・中心日表示は日付・‹ ›・本日・日付クリックは enabled・検索ピルは無い',
    start.centerDate === today && /^\d+ 件$/.test(start.countText || '') && String(start.readoutText).startsWith(shortLabel(today))
    && start.navDisabled.every((d) => d === false) && start.pillExists === false,
    { centerDate: start.centerDate, countText: start.countText, readoutText: start.readoutText, navDisabled: start.navDisabled, pillExists: start.pillExists });

  // 検索語入力前に C キーでミニカレンダーを開く（検索中は C が止まるため、開くのはここだけ）
  await page.keyboard.press('c');
  await sleep(350);
  const cal0 = await calState(page);
  log('calendar-before-search', cal0);
  check('検索語入力前に C キーでミニカレンダーが開く', cal0.open && !cal0.hits, cal0);

  // 全日の検索結果一覧・中心日「全日」・ナビ disabled・件数「N 件」
  await typeSearch(page, q);
  const s1 = await snapshot(page);
  log('search-results', s1);
  check('検索語入力で左列が全日の検索結果一覧になる（過去日・未来日の 2 件が並ぶ）',
    s1.rows >= 2 && s1.rowIds.includes(String(idA)) && s1.rowIds.includes(String(idB)), { rows: s1.rows, rowIds: s1.rowIds });
  check('左列ヘッダーの件数表示は「N 件」（全日の該当数。ピル用の「全対象日の検索結果 N 件」表記は無い）',
    /^\d+ 件$/.test(s1.countText || '') && Number(String(s1.countText).replace(/\D+/g, '')) >= 2, s1.countText);
  check('対象日見出しグループが 2 日分出る（過去日・未来日）',
    s1.seps.length === 2 && s1.seps.some((s) => s.includes(shortLabel(pastDay))) && s1.seps.some((s) => s.includes(shortLabel(futureDay))),
    s1.seps);
  check('検索結果の行に対象日チップが出る',
    s1.rowDays.filter(Boolean).length >= 2 && s1.rowDays.some((d) => d.startsWith(mmdd(pastDay))) && s1.rowDays.some((d) => d.startsWith(mmdd(futureDay))),
    s1.rowDays);
  check('タイトル内の該当語が <mark class="bulletin-hit"> でハイライトされる',
    s1.marks.length >= 1 && s1.marks.some((t) => t.toLowerCase() === q), s1.marks);
  check('中心日表示が「全日」になり、‹ ›・本日・日付クリック（カレンダー開閉）は disabled（data-day は本日まま）',
    s1.readoutText === '全日' && s1.centerDate === today && s1.navDisabled.every((d) => d === true),
    { readoutText: s1.readoutText, centerDate: s1.centerDate, navDisabled: s1.navDisabled });
  check('中心日表示は固定幅（5.4rem 相当）で「全日」も日付と同じ枠に収まり、› の位置は動かず、検索ピルは存在しない',
    s1.readoutW === start.readoutW && s1.nextX === start.nextX && s1.pillExists === false,
    { readoutW: s1.readoutW, startW: start.readoutW, nextX: s1.nextX, startX: start.nextX, pillExists: s1.pillExists });

  // ミニカレンダーの検索該当日（検索語入力後に再描画されて枠が出る）
  const cal1 = await calState(page);
  log('calendar-hits', cal1);
  check('ミニカレンダーは検索該当日に .mini-cal-hit の枠と aria-label「検索該当 N 件」を出す（過去日・未来日の 2 日）',
    cal1.open && cal1.hits === 2 && cal1.hitDays.includes(pastDay) && cal1.hitDays.includes(futureDay)
    && cal1.hitLabels.every((l) => l.includes('検索該当')), cal1);
  check('検索中はミニカレンダーの日付セルが選択できない（全日セル disabled・中心日ジャンプなし）',
    cal1.dayCells > 0 && cal1.disabledDays === cal1.dayCells,
    { dayCells: cal1.dayCells, disabledDays: cal1.disabledDays });

  // 検索結果の行クリック（中心日を動かさず、その記事の全文を右ペインに出す）
  await page.evaluate((id) => document.querySelector(`#bulletin-list-container [data-bulletin-toggle="${id}"]`).click(), idB);
  await sleep(500);
  const s2 = await snapshot(page);
  log('click-without-jump', { centerDate: s2.centerDate, readoutText: s2.readoutText, activeTitle: s2.activeTitle, paneTitle: s2.paneTitle, rows: s2.rows, countText: s2.countText });
  check('検索結果の行クリックは中心日を動かさない（readout は「全日」・data-day は本日まま）',
    s2.readoutText === '全日' && s2.centerDate === today, { readoutText: s2.readoutText, centerDate: s2.centerDate });
  check('クリックした記事が選択され、右ペインに全文が出る',
    s2.activeTitle === 'ZK9全日検索 未来日の記事' && s2.paneTitle === 'ZK9全日検索 未来日の記事',
    { activeTitle: s2.activeTitle, paneTitle: s2.paneTitle });
  check('左列は全日の検索結果列表のまま（当日表示へ絞らない・ジャンプしない）',
    s2.rows >= 2 && s2.rowIds.includes(String(idA)) && s2.rowIds.includes(String(idB)) && s2.seps.length === 2,
    { rows: s2.rows, rowIds: s2.rowIds, seps: s2.seps });

  // 検索中は ←/→・T・C キーが中心日を動かさない（readout は「全日」、開いているカレンダーも閉じない）
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('t');
  await page.keyboard.press('c');
  await sleep(350);
  const s3 = await snapshot(page);
  log('keys-while-searching', { centerDate: s3.centerDate, readoutText: s3.readoutText, calOpen: s3.calOpen, navDisabled: s3.navDisabled });
  check('検索中は ←/→・T・C キーが中心日を動かさない（readout は「全日」、カレンダーは開いたまま）',
    s3.centerDate === today && s3.readoutText === '全日' && s3.calOpen === true && s3.navDisabled.every((d) => d === true),
    { centerDate: s3.centerDate, readoutText: s3.readoutText, calOpen: s3.calOpen, navDisabled: s3.navDisabled });

  // 検索中のカレンダー日付セルは合成クリックでも中心日を動かさない（disabled セル＋委譲ガード）
  const s3b = await page.evaluate(() => {
    const cell = document.querySelector('#bulletin-mini-cal button[data-cal-date]');
    cell.click();
    const readout = document.getElementById('bulletin-day-current');
    return {
      centerDate: readout.dataset.day,
      readoutText: readout.textContent.trim(),
      cellDisabled: cell.disabled,
      clicked: cell.dataset.calDate,
    };
  });
  log('cal-cell-synthetic-click-while-searching', s3b);
  check('検索中のカレンダー日付セルは合成クリックでも中心日を動かさない（全日表示のまま）',
    s3b.cellDisabled === true && s3b.centerDate === today && s3b.readoutText === '全日', s3b);

  // 投稿者名検索（タイトル・本文に含めないログインユーザー名で検索し、2 件が全日の列表に出る）
  const aq = String(authorName || '').toLowerCase().trim();
  await typeSearch(page, aq);
  const s4 = await snapshot(page);
  log('author-search', { aq, rows: s4.rows, rowIds: s4.rowIds, countText: s4.countText, readoutText: s4.readoutText, seps: s4.seps });
  check('投稿者名（ログインユーザー名）でも検索できる（過去日・未来日の 2 件が全日の列表に出る）',
    Boolean(aq) && s4.rowIds.includes(String(idA)) && s4.rowIds.includes(String(idB)) && s4.readoutText === '全日'
    && /^\d+ 件$/.test(s4.countText || '') && Number(String(s4.countText).replace(/\D+/g, '')) >= 2
    && s4.seps.some((s) => s.includes(mmdd(pastDay))) && s4.seps.some((s) => s.includes(mmdd(futureDay))),
    { aq, rows: s4.rows, hasA: s4.rowIds.includes(String(idA)), hasB: s4.rowIds.includes(String(idB)), countText: s4.countText, readoutText: s4.readoutText });

  // 検索語を消すと通常表示（件数「N 件」・中心日は元の日付・ナビ enabled・カレンダーの該当日枠も消える）
  await typeSearch(page, '');
  const s5 = await snapshot(page);
  const cal2 = await calState(page);
  const todayCount = await apiFetch(page, 'GET', '/bulletins', null);
  const mineToday = (todayCount.json?.bulletins || []).filter((b) => String(b.target_date || '').slice(0, 10) === today).length;
  log('cleared', { centerDate: s5.centerDate, countText: s5.countText, rows: s5.rows, readoutText: s5.readoutText, navDisabled: s5.navDisabled, calHits: cal2.hits });
  check('検索語を消すと通常表示（件数「N 件」・中心日表示は本日の日付・‹ ›・本日・日付クリックが enabled・カレンダー閉じない）',
    s5.centerDate === today && /^\d+ 件$/.test(s5.countText || '') && s5.rows === mineToday
    && String(s5.readoutText).startsWith(shortLabel(today)) && s5.navDisabled.every((d) => d === false) && s5.calOpen === true,
    { centerDate: s5.centerDate, countText: s5.countText, rows: s5.rows, mineToday, readoutText: s5.readoutText, navDisabled: s5.navDisabled, calOpen: s5.calOpen });
  check('検索語を消すとカレンダーの検索該当枠も消える（.mini-cal-hit は 0）', cal2.hits === 0, cal2);
  check('検索語を消すとミニカレンダーの日付セルが選べるようになる（disabled 解除）',
    cal2.dayCells > 0 && cal2.disabledDays === 0, { dayCells: cal2.dayCells, disabledDays: cal2.disabledDays });

  // C キーでカレンダーを閉じる（検索語が無いので C は効く）
  await page.keyboard.press('c');
  await sleep(350);
  const cal3 = await calState(page);
  check('C キーでミニカレンダーを閉じる（検索語が無い状態では C が効く）', cal3.open === false, cal3);

  // 後片付け（検証投稿を削除）
  const delA = await apiFetch(page, 'DELETE', `/bulletins/${idA}`, null);
  const delB = await apiFetch(page, 'DELETE', `/bulletins/${idB}`, null);
  log('cleanup', { delA: delA.status, delB: delB.status });
  check('検証投稿を DELETE で掃除できる（後片付け）', delA.status === 200 && delB.status === 200, { delA: delA.status, delB: delB.status });

  console.log('');
  console.log('================ 全日検索（中心日「全日」表示・投稿者名検索）検証 =================');
  console.log(`  検証項目: ${total} 項目中 ${total - failures.length} 項目 PASS${failures.length ? ` / 失敗: ${failures.join(' | ')}` : ''}`);
  await browser.close();
  if (failures.length) process.exit(1);   // NG が 1 件でもあれば exit code 1（README の UI 検証運用）
};

main();
