/**
 * EXAM-PLAN-TABLE-TEST ③ 考査期間の登録（考査名を行とした表・自動登録）
 * ルール (public/js/modules/exam/exam.plan.ui.js):
 *  R1. ③ は考査名を行とした9列の表（考査名・開始日・終了日・1日の時限数・試験日数(自動)・キャパ(自動)・② 実施コマ・状態・操作）。
 *      行は ① の考査名（exam_masters.title）と1対1で並ぶ。標準試験時間の入力欄 #plan-default_duration と「期間登録」ボタンは存在しない。
 *  R2. 行に「保存」ボタンは無い（操作列は「この考査を開く」だけ）。対象考査の行は行自体が bg-accent-soft で強調され、
 *      操作列は「（対象考査）」、状態は「作業中の考査」。
 *  R3. 自動登録は基本情報の登録と同一の作法: 書き終えて焦点が行の外へ移った瞬間にその行を POST する。
 *      行内の次の入力欄へ焦点が移るだけでは書かない。内容が変わっていない行も書かない（POST 通数が増えない）。
 *  R4. 試験日数（暦日）とキャパ（日数×1日の時限数）は行内の入力からその場で自動算出表示。年度は開始日の西暦（サーバーの academic_year）。
 *  R5. 日程不正（開始日 ≦ 終了日）と 1日の時限数 1〜8外は書き込まず警告トースト。書き込み成功後は reload してもサーバーの値が行に表示される。
 *  R6. ② の実施科目調査表（12列）と ① の科目テーブル（5列）、サブタブ8件、② 実施コマ表示（N コマ）は従来通り。
 * 実行: npm run test:ui:examplan （サーバー起動が必要。UI_BASE 既定 https://127.0.0.1:3443、T2026001/password123）
 * 副作用: STAMP 名で考査を2件作り、テスト終了で exam_masters から DELETE（子表は exam_master_id ON DELETE CASCADE）。
 *        対象考査（作業中の行）の期間・状態は変えない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { Client } from 'pg';
import config from '../config/default.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'scripts', 'output');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const STAMP = 'Z' + String(Date.now()).slice(-4);
const NAME_A = `計画表A${STAMP}`;
const NAME_B = `計画表B${STAMP}`;

function findChrome() {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH を指定してください。');
}

const failures = [];
const logLines = [];
const check = (name, ok, detail = '') => {
  const line = `  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`;
  logLines.push(line);
  console.log(line);
  if (!ok) failures.push(name);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--window-size=1920,1080'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });

  // 自動登録のリクエストを数えるためのログ（reload で消えるので増分で測る）
  page.on('request', (r) => {
    const m = r.method();
    if (m === 'POST' || m === 'PUT') {
      page.evaluate((u, mm) => { (window.__reqs = window.__reqs || []).push({ url: u, method: mm }); }, r.url(), m);
    }
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  /** ログイン（実ログインフォーム）して定期考査の年間考査計画タブへ */
  const goPlan = async () => {
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
    const needLogin = await page.evaluate(() => !!document.querySelector('#login-userid') && document.querySelector('#app-container')?.classList.contains('hidden'));
    if (needLogin) {
      await page.type('#login-userid', USER);
      await page.type('#login-password', PASS);
      await page.evaluate(() => window.handleLoginClick());
    }
    await page.waitForSelector('#app-container:not(.hidden)', { timeout: 15000 });
    await page.click('[data-tab="exam"]');
    await sleep(1200);
    await page.click('[data-subtab="plan"]');
    await sleep(1200);
  };

  /** ③ の表をスナップショット（行・入力値・自動表示・ボタン・強調） */
  const snap = () => page.evaluate(() => {
    const panel = document.querySelector('#exam-panel-plan');
    const card = document.querySelector('#plan-period-body')?.closest('table');
    const heads = [...card.querySelectorAll('thead th')].map((t) => t.textContent.trim());
    const rows = [...document.querySelectorAll('#plan-period-body tr')].map((r) => {
      const cells = [...r.querySelectorAll('td')].map((td) => td.textContent.trim());
      const inputs = {};
      [...r.querySelectorAll('[data-pf]')].forEach((i) => { inputs[i.dataset.pf] = i.value; });
      return {
        id: r.dataset.planRowId,
        cells,
        inputs,
        days: r.querySelector('[data-pdays]')?.textContent.trim(),
        cap: r.querySelector('[data-pcap]')?.textContent.trim(),
        slotsPlan: cells[6],
        badge: cells[7],
        rowBg: r.className.includes('bg-accent-soft'),
        actBtns: [...r.querySelectorAll('[data-plan-open]')].map((b) => b.dataset.planOpen),
        openTxt: r.querySelector('[data-plan-open]')?.textContent.trim() ?? null,
      };
    });
    return {
      heads,
      rows,
      hasDur: !!panel.querySelector('#plan-default_duration'),
      hasRegister: !!panel.querySelector('[data-plan-act="register"]'),
      hasTitle: panel.textContent.includes('③ 考査期間の登録（考査名ごとの表）'),
      hasNote: panel.textContent.includes('標準試験時間の入力はありません'),
      refresh: !!panel.querySelector('#plan-refresh'),
    };
  });

  /** ③ の考査期間 POST 通数（reload 後は 0 から数え直す） */
  const countPlanPost = () => page.evaluate(() => (window.__reqs || []).filter((r) => r.url.includes('/plan/register') && r.method === 'POST').length);

  /** 行への入力（日付欄は value 代入 + change ディスパッチ、数値欄は focus して実タイピング。click は number の spinner に触れるため focus を使う） */
  const fillField = async (sel, key, val) => {
    await page.focus(sel);
    await sleep(120);
    if (key === 'start_date' || key === 'end_date') {
      await page.evaluate((s, v) => {
        const el = document.querySelector(s);
        el.value = v;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, sel, String(val));
      await sleep(150);
    } else {
      await page.evaluate((s) => { const el = document.querySelector(s); el.select(); }, sel);
      await page.type(sel, String(val));
      await page.evaluate((s) => { const el = document.querySelector(s); el.dispatchEvent(new Event('change', { bubbles: true })); }, sel);
      await sleep(150);
    }
  };

  const typeRow = async (id, values) => {
    for (const [key, val] of Object.entries(values)) {
      await fillField(`#plan-period-body tr[data-plan-row-id="${id}"] [data-pf="${key}"]`, key, val);
    }
  };

  /** 行内の次の入力欄へ焦点を移す（行内の移動は自動登録の条件ではない） */
  const focusWithin = (id) => page.evaluate((rid) => {
    const row = document.querySelector(`#plan-period-body tr[data-plan-row-id="${rid}"]`);
    row.querySelector('[data-pf="start_date"]').focus();
    row.querySelector('[data-pf="end_date"]').focus();
    row.querySelector('[data-pf="daily_slots"]').focus();
  }, id);

  /** 焦点が行の外（カード見出しの更新ボタン）へ移る＝書き終えた瞬間 */
  const focusOutside = () => page.focus('#plan-refresh');

  /** トースト文言（5秒で消えるので直後に読む） */
  const toastText = () => page.evaluate(() => [...document.querySelectorAll('#toast-container > div')].map((d) => d.textContent.trim()));



  /** ① の考査名セクション（年間考査計画タブに統合済み）で行追加→登録し、その行の id を返す */
  const addExam = async (name) => {
    await page.click('#exam-names-add');
    await sleep(400);
    const sel = '#exam-names-body tr[data-exam-row-id=""] [data-exam-name]';
    await page.click(sel);
    await page.type(sel, name);
    const resP = page.waitForResponse((r) => r.url().endsWith('/api/exam') && r.request().method() === 'POST', { timeout: 8000 });
    await page.click('#exam-names-save');
    const res = await resP;
    await sleep(1500);
    const created = await res.json();
    return created.data?.id ?? created.id;
  };

  const db = new Client({ host: config.db.host, port: config.db.port, database: config.db.name, user: config.db.user, password: config.db.password });
  await db.connect();
  const SEED_TITLE = '2026年度 1学期中間考査';
  const pick = () => db.query('SELECT title, start_date, end_date, daily_slots, days_count, is_active FROM exam_masters WHERE title = $1', [SEED_TITLE]).then((r) => r.rows[0]);
  const orig = await pick();

  await goPlan();
  const s0 = await snap();


  check('③ の見出しと注記（標準試験時間の入力は無い）', s0.hasTitle && s0.hasNote && s0.refresh && !s0.hasDur && !s0.hasRegister,
    `title=${s0.hasTitle} note=${s0.hasNote} dur=${s0.hasDur} register=${s0.hasRegister}`);

  const HEADS = ['考査名', '開始日', '終了日', '1日の時限数', '試験日数（自動）', 'キャパ（自動）', '② 実施コマ', '状態', '操作'];
  check('③ の9列ヘッダ（列順）', JSON.stringify(s0.heads) === JSON.stringify(HEADS), s0.heads.join('|'));

  const masterTitles = await page.evaluate(() => [...document.querySelectorAll('#exam-names-body tr[data-exam-row-id]')].map((r) => r.querySelector('[data-exam-name]')?.value.trim()).filter(Boolean));
  check('行は ① の考査名と1対1で並ぶ', s0.rows.length === masterTitles.length && s0.rows.every((r, i) => r.cells[0] === masterTitles[i]),
    `rows=${s0.rows.length} masters=${masterTitles.length}`);

  const activeRow = s0.rows.find((r) => r.rowBg);
  check('対象考査の行が bg-accent-soft で強調（1行だけ）', activeRow && s0.rows.filter((r) => r.rowBg).length === 1,
    `highlight=${s0.rows.filter((r) => r.rowBg).length}`);
  check('強調行は 状態=作業中の考査・操作列に開くボタン無し', activeRow && activeRow.badge === '作業中の考査' && activeRow.openTxt === null && activeRow.cells[8] === '（対象考査）',
    `badge=${activeRow?.badge} act=${activeRow?.cells[8]}`);
  check('ロード直後はサーバーの値で行が並ぶ（対象考査 3日×3時限=9コマ・開始 2026-10-15）',
    activeRow.inputs.start_date === '2026-10-15' && activeRow.inputs.end_date === '2026-10-17' && activeRow.inputs.daily_slots === '3'
    && activeRow.days === '3 日' && activeRow.cap === '9 コマ' && orig.start_date.slice(0, 10) === '2026-10-15',
    `start=${activeRow?.inputs.start_date} days=${activeRow?.days} cap=${activeRow?.cap}`);

  const openCount = s0.rows.filter((r) => r.openTxt === 'この考査を開く').length;
  check('行に「保存」ボタンは無い（操作列は open/対象考査だけ）', openCount === s0.rows.filter((r) => !r.rowBg).length && !s0.rows.some((r) => r.cells[8].includes('保存')),
    `open=${openCount} rows=${s0.rows.length}`);
  check('② 実施コマ表示（N コマ）', s0.rows.every((r) => /^\d+ コマ$/.test(r.slotsPlan)), s0.rows.map((r) => r.slotsPlan).join(','));

  const activeTitle = activeRow.cells[0];

  // ① で考査を2件作る（STAMP 名。テスト終了で消す）
  const idA = await addExam(NAME_A);
  const idB = await addExam(NAME_B);
  const s1 = await snap();
  const rowA = s1.rows.find((r) => r.id === String(idA));
  const rowB = s1.rows.find((r) => r.id === String(idB));
  check('① で作った考査が ③ の行として並ぶ', !!rowA && !!rowB && s1.rows.length === masterTitles.length + 2,
    `rows=${s1.rows.length} A=${rowA?.cells[0]} B=${rowB?.cells[0]}`);
  check('新行は 開始日=空・試験日数/キャパ=- ・状態=期間未登録', rowA && rowA.inputs.start_date === '' && rowA.days === '− 日' && rowA.cap === '− コマ' && rowA.badge === '期間未登録',
    `start=${rowA?.inputs.start_date} days=${rowA?.days} cap=${rowA?.cap} badge=${rowA?.badge}`);

  // R4 実タイピングで入力 → 焦点を外へ移す前に試験日数/キャパが自動表示
  const beforeA = await countPlanPost();
  await typeRow(idA, { start_date: '2026-11-05', end_date: '2026-11-08', daily_slots: '4' });
  const t1 = await snap();
  const rowT1 = t1.rows.find((r) => r.id === String(idA));
  check('入力から試験日数(4)とキャパ(16)がその場で自動算出', rowT1.days === '4 日' && rowT1.cap === '16 コマ', `days=${rowT1.days} cap=${rowT1.cap}`);

  // R3 行内の次入力欄へ焦点が移るだけでは書かない
  await focusWithin(idA);
  await sleep(400);
  const cWithin = await countPlanPost();
  check('行内の次の入力欄へ焦点が移るだけでは POST しない', cWithin === beforeA, `count=${cWithin}`);

  // R3 焦点が行の外へ移った瞬間にその行を書く
  const resP = page.waitForResponse((r) => r.url().includes('/plan/register') && r.request().method() === 'POST', { timeout: 8000 });
  await focusOutside();
  const res = await resP;
  await sleep(1200);
  const afterA = await countPlanPost();
  const t2 = await snap();
  const rowT2 = t2.rows.find((r) => r.id === String(idA));
  check('焦点が行の外へ移った瞬間にその行を POST（200）', res.status() === 200 && afterA === beforeA + 1, `status=${res.status()} count=${afterA}`);
  check('書き込み後はサーバーの値が行に表示・状態=期間登録済', rowT2.inputs.start_date === '2026-11-05' && rowT2.inputs.end_date === '2026-11-08'
    && rowT2.inputs.daily_slots === '4' && rowT2.days === '4 日' && rowT2.cap === '16 コマ' && rowT2.badge === '期間登録済',
    `start=${rowT2.inputs.start_date} slots=${rowT2.inputs.daily_slots} days=${rowT2.days} cap=${rowT2.cap} badge=${rowT2.badge}`);

  // R3 内容が変わっていない行は焦点を外へ移しても書かない（行の先頭欄へ focus → 見出しの更新ボタンへ焦点を外す）
  const beforeNo = await countPlanPost();
  await page.focus(`#plan-period-body tr[data-plan-row-id="${idA}"] [data-pf="start_date"]`);
  await focusOutside();
  await sleep(600);
  const cNo = await countPlanPost();
  check('内容が変わっていない行は焦点を外へ移しても POST しない', cNo === beforeNo, `count=${cNo}`);



  // R5 日程不正（開始日 > 終了日）は書き込まず警告トースト
  await typeRow(idB, { start_date: '2026-12-10', end_date: '2026-12-05' });
  const t3 = await snap();
  const rowT3 = t3.rows.find((r) => r.id === String(idB));
  check('日程不正では試験日数が - 日・キャパが - コマ', rowT3.days === '− 日' && rowT3.cap === '− コマ', `days=${rowT3.days} cap=${rowT3.cap}`);
  const beforeInv = await countPlanPost();
  await focusOutside();
  await sleep(700);
  const toastInv = await toastText();
  check('日程不正は書き込まず警告トースト', (await countPlanPost()) === beforeInv && toastInv.some((t) => t.includes('日程が不正です')),
    `count=${await countPlanPost()} toast=${toastInv.join(' / ')}`);

  // R5 1日の時限数 9（8超）は書き込まず警告トースト（日数6・キャパ54は表示される）
  await typeRow(idB, { start_date: '2026-11-20', end_date: '2026-11-25', daily_slots: '9' });
  const t3b = await snap();
  const rowT3b = t3b.rows.find((r) => r.id === String(idB));
  check('日数6・キャパ54が自動表示（時限数9でも計算は動く）', rowT3b.days === '6 日' && rowT3b.cap === '54 コマ', `days=${rowT3b.days} cap=${rowT3b.cap}`);
  const beforeSlots = await countPlanPost();
  await focusOutside();
  await sleep(700);
  const toastSlots = await toastText();
  check('1日の時限数 9 は書き込まず警告トースト', (await countPlanPost()) === beforeSlots && toastSlots.some((t) => t.includes('1日の時限数は 1〜8')),
    `count=${await countPlanPost()} toast=${toastSlots.join(' / ')}`);

  // R3 時限数を 4 へ直して焦点を外へ移す → POST、キャパ 24
  const resB = page.waitForResponse((r) => r.url().includes('/plan/register') && r.request().method() === 'POST', { timeout: 8000 });
  await typeRow(idB, { daily_slots: '4' });
  await focusOutside();
  const resB2 = await resB;
  await sleep(1200);
  const t4 = await snap();
  const rowT4 = t4.rows.find((r) => r.id === String(idB));
  check('時限数4へ直すと POST・キャパ24・状態=期間登録済', resB2.status() === 200 && rowT4.cap === '24 コマ' && rowT4.badge === '期間登録済',
    `status=${resB2.status()} cap=${rowT4.cap} badge=${rowT4.badge}`);

  // R5 reload してもサーバーの値が行に表示され、対象考査の行だけが続け強調される
  await goPlan();
  const t5 = await snap();
  const rowA5 = t5.rows.find((r) => r.id === String(idA));
  const rowB5 = t5.rows.find((r) => r.id === String(idB));
  const active5 = t5.rows.filter((r) => r.rowBg);
  check('reload 後もサーバーの値が行に残る', rowA5.inputs.start_date === '2026-11-05' && rowA5.cap === '16 コマ'
    && rowB5.inputs.start_date === '2026-11-20' && rowB5.cap === '24 コマ',
    `A=${rowA5?.inputs.start_date}/${rowA5?.cap} B=${rowB5?.inputs.start_date}/${rowB5?.cap}`);
  check('reload 後も対象考査の行だけが bg-accent-soft（1行だけ・作業中の考査）', active5.length === 1 && active5[0].badge === '作業中の考査' && active5[0].cells[8] === '（対象考査）',
    `highlight=${active5.map((r) => r.cells[0]).join(',')}`);

  // R6 ② の実施科目調査表（12列）と ① の科目テーブル（5列）、サブタブ8件は従来通り
  const svHeads = await page.evaluate(() => {
    const tb = document.querySelector('#exam-sub-body');
    const ths = [...tb.closest('table').querySelectorAll('thead th')];
    return { n: ths.length, labels: ths.map((t) => t.textContent.replace(/\s+/g, ' ').trim()) };
  });
  check('② の実施科目調査表は12列（従来通り）', svHeads.n === 12 && svHeads.labels[0].startsWith('試験実施科目') && svHeads.labels[1].startsWith('学年'),
    `n=${svHeads.n} head=${svHeads.labels.slice(0, 2).join('|')}`);

  await page.click('[data-subtab="basic"]');
  await sleep(1000);
  const basic = await page.evaluate(() => {
    const panel = document.querySelector('#exam-panel-basic');
    const ths = [...(panel.querySelector('#basic-body-subject')?.closest('table').querySelectorAll('thead th') || [])].map((t) => t.textContent.trim());
    return { heads: ths, add: !!panel.querySelector('#basic-add-subject'), lock: !!panel.querySelector('#basic-lock-subject') };
  });
  check('① の科目テーブル（5列・行追加・編集ロック）は従来通り', basic.heads.length === 5 && basic.heads[0] === '教科' && basic.add && basic.lock,
    `heads=${basic.heads.join('|')} add=${basic.add} lock=${basic.lock}`);

  const subtabs = await page.evaluate(() => [...document.querySelectorAll('#exam-subtabs [data-subtab]')].map((b) => b.textContent.trim()));
  check('サブタブ8件（年間考査計画が2番目）は従来通り', subtabs.length === 8 && subtabs[1] === '年間考査計画', subtabs.join('|'));
  check('実行中に JS エラーが無い', pageErrors.length === 0, pageErrors.slice(0, 2).join(' / '));

  // R4 サーバー側: 試験日数=暦日・academic_year=開始日の西暦・標準試験時間50
  const saved = await db.query(
    'SELECT id, title, start_date, end_date, days_count, daily_slots, default_duration, academic_year FROM exam_masters WHERE title = ANY($1::text[]) ORDER BY id',
    [[NAME_A, NAME_B]]
  );
  const a = saved.rows.find((r) => r.title === NAME_A);
  const b = saved.rows.find((r) => r.title === NAME_B);
  check('サーバーの 試験日数=4と6(暦日)・時限数4・標準試験時間50・年度2026',
    a?.days_count === 4 && a?.daily_slots === 4 && a?.default_duration === 50 && a?.academic_year === 2026
    && b?.days_count === 6 && b?.daily_slots === 4,
    `A=${a?.days_count}日/${a?.daily_slots}コマ/${a?.default_duration}分/${a?.academic_year}年 B=${b?.days_count}日/${b?.daily_slots}コマ`);

  // スクリーンショット（1920x1080。行の強調・自動表示・状態バッジが写る）
  await page.click('[data-subtab="plan"]');
  await sleep(1000);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  await page.screenshot({ path: path.join(OUT_DIR, 'exam-plan-table.png'), fullPage: false });

  // 後片付け: 作った考査を消す（子表は exam_master_id ON DELETE CASCADE）。対象考査（作業中の行）の期間・状態は不変
  await db.query('DELETE FROM exam_masters WHERE title = ANY($1::text[])', [[NAME_A, NAME_B]]);
  const left = await db.query('SELECT count(*)::int AS n FROM exam_masters WHERE title = ANY($1::text[])', [[NAME_A, NAME_B]]);
  const now = await pick();
  check('後片付けで新行は消え・対象考査（作業中の行）の期間/状態は不変', left.rows[0].n === 0
    && now.start_date === orig.start_date && now.end_date === orig.end_date && now.daily_slots === orig.daily_slots && now.is_active === orig.is_active,
    `left=${left.rows[0].n} start=${now.start_date} slots=${now.daily_slots} active=${now.is_active}`);
  await db.end();

  await browser.close();
  const summary = `${logLines.join('\n')}\n[RESULT] ${failures.length ? 'FAIL ' + failures.length + '件: ' + failures.join(', ') : 'ALL PASS'}\n`;
  fs.writeFileSync(path.join(OUT_DIR, 'exam-plan-table.txt'), summary);
  console.log('\n=== EXAM-PLAN-TABLE-TEST ③ 考査期間の登録（考査名を行とした表・自動登録） ===');
  console.log(summary);
  process.exit(failures.length ? 1 : 0);
})();

