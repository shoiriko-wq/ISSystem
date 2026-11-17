/**
 * 考査基本情報 CSV 一括登録カードの UI スイート（正式検証・npm run test:ui:exambasic-csv）
 * カード描画 → テンプレート（BOM+CRLF・fileName・トースト）→ CSV 選択で preview（行表・要約）
 * → 確定で実データへ登録（実行表示へ追従・カード cleared）→ 部屋 preview → 取り消し（実データ不変）
 * → 後片付け（作ったクラス行を削除してベースラインへ戻す＝再実行可能）
 * 実行: npm run test:ui:exambasic-csv  （サーバー起動済み・db:seed 済み・CA信頼は端末に1度だけ登録）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { query } from '../src/utils/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const findChrome = () => {
  const c = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  throw new Error('Chrome がない');
};

const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` (${detail})` : ''}`);
};

const CSV_CLASS = 'grade,name,short_name,is_active\n1,CSVX9,CSVX9,TRUE\n';
const CSV_ROOM = 'name,seats,notes,is_active\nCSV9R,17,CSV検証,TRUE\n';
const DECISION_HEADERS = [
  'subject_name', 'subject_short', 'subject_id', 'grade', 'stream', 'scope',
  'setter_teacher_id', 'patrol_teacher_id', 'duration_slots', 'duration_minutes', 'room_name', 'notes',
];
const csvPath = (text) => {
  const p = `/tmp/csv-import-${text.length}.csv`;
  fs.writeFileSync(p, text, 'utf8');
  return p;
};

const toastText = () =>
  page.evaluate(() => [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ')).join(' | '));

const read = () =>
  page.evaluate(() => {
    const inner = document.querySelector('.ui-exam-import-inner');
    const rows = [...(inner?.querySelectorAll('.ui-exam-import-preview tbody tr') || [])].map((tr) => {
      const td = [...tr.querySelectorAll('td')].map((t) => t.textContent.trim());
      return { row: td[0], act: td[1], display: td[2], okMsg: td[3] };
    });
    return {
      staged: inner?.dataset.staged || '',
      summary: inner?.querySelector('.ui-exam-import-summary')?.textContent?.trim() || '',
      rows,
      commitDisabled: inner?.querySelector('.ui-exam-import-commit')?.disabled === true,
    };
  });

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: 'new',
  protocolTimeout: 90000,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  [page js error]', e.message));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console error]', m.text());
});

await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(900);
await page.click('[data-tab="exam"]');
await sleep(1600);

// 試験期間タブのカードに CSV 一括登録カードがあるか（plan を開いて確認し、basic へ戻る）
await page.click('[data-subtab="plan"]');
await sleep(900);
const planImport = await page.evaluate(() => !!document.querySelector('#plan-card .ui-exam-import-inner'));
await page.click('[data-subtab="basic"]');
await sleep(900);

const card = await page.evaluate(() => {
  const inner = document.querySelector('.ui-exam-import-inner');
  const cardEl = inner?.closest('.card') || inner?.parentElement;
  return {
    hasInner: !!inner,
    title: cardEl?.textContent?.includes('CSV 一括登録') === true,
    options: [...(document.querySelector('.ui-exam-import-section')?.options || [])].map((o) => o.value),
    modes: [...(document.querySelector('.ui-exam-import-mode')?.options || [])].map((o) => o.value),
    hasFile: !!document.querySelector('.ui-exam-import-file'),
    hasCommit: !!document.querySelector('.ui-exam-import-commit'),
    hasCancel: !!document.querySelector('.ui-exam-import-cancel'),
  };
});
check('CSV 一括登録カードが基本情報タブに出る（6セクション・モード選択・テンプレ・CSV選択・確定・取り消し、試験期間カードにも導入）',
  card.hasInner && card.title && card.options.join(',') === 'class,group,subject,room,decision,plan' &&
    card.modes.join(',') === 'template,current' && planImport && card.hasFile && card.hasCommit && card.hasCancel,
  JSON.stringify({ ...card, planImport }));

// テンプレート（API 応答の fileName と csvText、トースト）
const tmplRes = page.waitForResponse((r) => r.url().includes('/exam/import/template/class'), { timeout: 8000 }).catch(() => null);
await page.click('.ui-exam-import-template');
const tmpl = await tmplRes;
const tmplBody = tmpl ? await tmpl.json().catch(() => null) : null;
const tmplData = tmplBody?.data || tmplBody || {};
const tmplToast = await toastText();
check('テンプレートボタンで class テンプレート（BOM・4列・fileName）が来てトーストが出る',
  tmpl && tmpl.status() === 200 && tmplData.fileName === 'classes-import-template.csv' && tmplData.csvText.charCodeAt(0) === 0xfeff &&
    tmplData.csvText.split('\r\n')[0] === '\uFEFFgrade,name,short_name,is_active' && tmplToast.includes('テンプレート'),
  `status=${tmpl?.status()} fileName=${tmplData.fileName} toast=${tmplToast.slice(0, 40)}`);

// preview（クラス）→ 1行・新規・commit 有効
await (await page.$('.ui-exam-import-file')).uploadFile(csvPath(CSV_CLASS));
await sleep(1200);
const pv = await read();
check('CSV を選ぶと preview 表と要約が出る（1行=新規・commit 有効）',
  pv.staged === '1' && pv.rows.length === 1 && pv.rows[0].act === '新規' && pv.summary.includes('CSV') && pv.summary.includes('登録可能') && !pv.commitDisabled,
  JSON.stringify(pv));

// 確定 → クラス行が増える・カードが cleared
const rowsBefore = await page.evaluate(() => document.querySelectorAll('#basic-body-class tr').length);
await page.click('.ui-exam-import-commit');
await sleep(2200);
const rowsAfter = await page.evaluate(() => document.querySelectorAll('#basic-body-class tr').length);
const hasNew = await page.evaluate(() =>
  [...document.querySelectorAll('#basic-body-class tr')].some((r) => r.querySelector('input[data-f="name"]')?.value === 'CSVX9'));
const afterCommit = await read();
const commitToast = await toastText();
check('確定で検証済み行が登録され（クラス+1・実行表示）カードは cleared',
  rowsAfter === rowsBefore + 1 && hasNew && afterCommit.staged === '0' && afterCommit.rows.length === 0 && commitToast.includes('登録しました'),
  `before=${rowsBefore} after=${rowsAfter} hasNew=${hasNew} staged=${afterCommit.staged} toast=${commitToast.slice(0, 60)}`);

// 部屋 CSV → preview → 取り消し（実データへ書き込まれない）
await page.select('.ui-exam-import-section', 'room');
await (await page.$('.ui-exam-import-file')).uploadFile(csvPath(CSV_ROOM));
await sleep(1200);
const pvRoom = await read();
check('部屋 CSV の preview も staged（1行）', pvRoom.staged === '1' && pvRoom.rows.length === 1, JSON.stringify(pvRoom));
await page.click('.ui-exam-import-cancel');
await sleep(900);
const afterCancel = await read();
const roomHas = await page.evaluate(() =>
  [...document.querySelectorAll('#basic-body-room tr')].some((r) => r.querySelector('input[data-f="name"]')?.value === 'CSV9R'));
check('取り消しでカードが cleared され部屋行は増えない', afterCancel.staged === '0' && afterCancel.rows.length === 0 && !roomHas,
  JSON.stringify({ staged: afterCancel.staged, roomHas }));

// モード「登録済み」（current）: 登録済みデータ全件の書き出し → CSV を戻すと全行「更新」→ 編集 commit で実DBへ反映
const subjectCount = (await query('select count(*)::int as c from subjects')).rows[0].c;

const setMode = async (section, mode) => {
  await page.select('.ui-exam-import-section', section);
  await page.select('.ui-exam-import-mode', mode);
};

const tmplResGroup = page.waitForResponse((r) => r.url().includes('/exam/import/template/group?mode=current'), { timeout: 8000 }).catch(() => null);
await setMode('group', 'current');
await page.click('.ui-exam-import-template');
const tmplGroup = await tmplResGroup;
const groupData = (await tmplGroup?.json().catch(() => null))?.data || {};
const groupToast = await toastText();
check('モード「登録済み」+教科で current CSV（BOM・3列・全件・fileName）とトーストが出る',
  tmplGroup && tmplGroup.status() === 200 && groupData.mode === 'current' && groupData.fileName === 'subject_groups-current.csv' &&
    groupData.row_count === subjectCount && groupData.csvText.charCodeAt(0) === 0xfeff &&
    groupData.csvText.split('\r\n')[0] === '\uFEFFname,color_key,sort_order' && groupToast.includes('登録済み'),
  `status=${tmplGroup?.status()} row_count=${groupData.row_count} toast=${groupToast.slice(0, 40)}`);

// current CSV をそのまま CSV 選択へ戻すと全行「更新」（DB 変更なし・新規 0）
fs.writeFileSync('/tmp/csv-import-group-current.csv', groupData.csvText, 'utf8');
await (await page.$('.ui-exam-import-file')).uploadFile('/tmp/csv-import-group-current.csv');
await sleep(1200);
const pvGroup = await read();
check('登録済み CSV を選ぶと全行「更新」で要約に新規 0 / 更新 全件が出る',
  pvGroup.staged === '1' && pvGroup.rows.length === subjectCount && pvGroup.rows.every((r) => r.act === '更新') &&
    pvGroup.summary.includes('更新') && pvGroup.summary.includes('新規 0'),
  JSON.stringify({ staged: pvGroup.staged, rows: pvGroup.rows.length, summary: pvGroup.summary.slice(0, 60) }));

// 試験期間の current（active 考査全件・title 列）
const planCount = (await query('select count(*)::int as c from exam_masters where is_active = true')).rows[0].c;
const tmplResPlan = page.waitForResponse((r) => r.url().includes('/exam/import/template/plan?mode=current'), { timeout: 8000 }).catch(() => null);
await setMode('plan', 'current');
await page.click('.ui-exam-import-template');
const tmplPlan = await tmplResPlan;
const planData = (await tmplPlan?.json().catch(() => null))?.data || {};
check('試験期間の current CSV は active 考査全件を title,start_date,end_date,daily_slots で書き出す',
  tmplPlan && tmplPlan.status() === 200 && planData.fileName === 'exam_plan-current.csv' && planData.row_count === planCount &&
    planData.csvText.split('\r\n')[0] === '\uFEFFtitle,start_date,end_date,daily_slots',
  `row_count=${planData.row_count} planCount=${planCount}`);

// 実施科目の current（表示中の考査の決定行・名前で解決されている）
await page.click('[data-subtab="plan"]');
await sleep(900);
const examTitle = await page.evaluate(() => document.querySelector('#plan-title')?.textContent?.trim() || '');
await page.click('[data-subtab="basic"]');
await sleep(900);
const examRow = await query('select id from exam_masters where title = $1', [examTitle]);
const decCount = (await query('select count(*)::int as c from exam_subject_decisions where exam_master_id = $1', [String(examRow.rows[0].id)])).rows[0].c;
const tmplResDec = page.waitForResponse((r) => r.url().includes('/exam/import/template/decision?mode=current'), { timeout: 8000 }).catch(() => null);
await setMode('decision', 'current');
await page.click('.ui-exam-import-template');
const tmplDec = await tmplResDec;
const decData = (await tmplDec?.json().catch(() => null))?.data || {};
check('実施科目の current CSV は表示中の考査の決定行を名前解決付きで書き出す',
  tmplDec && tmplDec.status() === 200 && decData.fileName === 'exam_subject_decisions-current.csv' && decData.row_count === decCount &&
    decData.csvText.split('\r\n')[0] === '\uFEFF' + DECISION_HEADERS.join(','),
  `exam=${examTitle} row_count=${decData.row_count} decCount=${decCount}`);

// 教室の current CSV を編集（座席数 17）→ preview 全行「更新」→ commit → 実DB へ反映 → 元へ戻す（再実行可能）
// 基本情報タブのカードで実行する（スクープは #exam-panel-basic。計画タブのカードの存在は最初のチェックで検証済み）
const roomRes = page.waitForResponse((r) => r.url().includes('/exam/import/template/room?mode=current'), { timeout: 8000 }).catch(() => null);
await page.select('#exam-panel-basic .ui-exam-import-section', 'room');
await page.select('#exam-panel-basic .ui-exam-import-mode', 'current');
await page.click('#exam-panel-basic .ui-exam-import-template');
const roomResp = await roomRes;
const roomData = (roomResp ? await roomResp.json().catch(() => null) : null)?.data || {};
const roomLines = roomData.csvText.split('\r\n').filter((l) => l.trim() !== '');
const roomIdx = 1; // current CSV の最初の教室行（name,seats,notes,is_active）
const roomParts = roomLines[roomIdx].split(',');
const roomName = roomParts[0];
const origSeats = Number(roomParts[1]);
roomParts[1] = '17';
roomLines[roomIdx] = roomParts.join(',');
fs.writeFileSync('/tmp/csv-import-room-current.csv', roomLines.join('\r\n'), 'utf8');
await (await page.$('#exam-panel-basic .ui-exam-import-file')).uploadFile('/tmp/csv-import-room-current.csv');
await sleep(1200);
const pvRoom2 = await page.evaluate(() => ({
  staged: document.querySelector('#exam-panel-basic .ui-exam-import-staged')?.textContent,
  summary: document.querySelector('#exam-panel-basic .ui-exam-import-summary')?.textContent,
}));
check('教室 current CSV の座席数変更は全行「更新」として preview される',
  pvRoom2.staged === '1' && pvRoom2.summary.includes('更新 34'),
  JSON.stringify(pvRoom2));
await page.click('#exam-panel-basic .ui-exam-import-commit');
await sleep(2400);
const roomSeats = await query('select seats from basic_rooms where name = $1', [roomName]);
const roomToast2 = await toastText();
check('教室 current CSV commit で座席数が実DBへ update されトーストに出る',
  Number(roomSeats.rows[0]?.seats) === 17 && roomToast2.includes('教室') && roomToast2.includes('登録しました'),
  `name=${roomName} seats=${roomSeats.rows[0]?.seats} toast=${roomToast2.slice(0, 40)}`);
await query('update basic_rooms set seats = $1 where name = $2', [origSeats, roomName]);
await page.click('#exam-panel-basic .ui-exam-import-cancel');
await sleep(400);

// 後片付け：モードをテンプレートへ戻し、取得した編集ロックを掃除する（このスイートを再実行可能にする）
await setMode('class', 'template');
await query("delete from editing_locks where resource_type = 'exam_basic'");


// 後片付け：確定で作った検証クラス行をデータベースから削除してベースラインへ戻す（このスイートを再実行可能にする）。
// UI 側の delete ボタンは DELETE→reload の再描画で evaluate が長時間ブロックするため、SQL で掃除する（検証用成果物）。
const delRows = await query("delete from classes where name='CSVX9' returning id");
const baseline = await query("select count(*)::int as c from classes");
check('後片付けで検証クラスをデータベースから削除しベースライン21件へ戻る',
  delRows.rows.length >= 1 && baseline.rows[0].c === 21,
  JSON.stringify({ deleted: delRows.rows.length, c: baseline.rows[0].c }));

console.log(`=== ${failures.length} FAILURES ===`);
failures.forEach((f) => console.log(f));
await browser.close();
process.exitCode = failures.length ? 1 : 0;

