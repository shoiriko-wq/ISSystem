/**
 * 職員一覧の担当教科表示と行内編集（保存・閉じる）の実ブラウザ回帰テスト（v3.1.16 §5・§14）
 *
 * 検証項目:
 *  1. 教務部 (KYOMU) の職員一覧モーダルが開く（CSV 一括登録カードと職員一覧テーブル）
 *  2. 教科マスタは 9件・id コード (ko01..ko09) と正式名を持つ
 *  3. 担当教科を id コード (ko03 等) で保存済みの CSV 登録ユーザーのチップは正式名で描画される（チップに ko03 は出ない）
 *  4. チップ寸法（フォント 14.35px・枠 2px・角丸 4.375px）とクラスは教科マスタの color_key と一致する
 *  5. 「担当教科編集」のピッカーはマスタ 9件・id コード保存のユーザーも正式名でチェックが付く
 *  6. 「保存」を1クリックすると PUT は 1件だけ（二重束縛なし）・トースト「担当教科を保存しました」
 *  7. 保存後は行が正式名チップへ更新され、DB の users.subjects も正式名になる
 *  8. 「閉じる」はピッカーを消してチップへ戻す（職員一覧の再取得リクエストは増えない）
 *  9. 閉じた後に同じ行の編集ボタンが再び使える
 * 10. プロフィールの担当教科ピッカーは教科マスタ読み込み込みで描画される（チェックボックスはマスタ名）
 * 11. 後片付け（DB を元の id コードへ戻し、チップ表示も元通り）
 * 実行: node scripts/test-user-subjects-ui.mjs  （ISSystem サーバーが必要）
 *  options: UI_BASE=https://127.0.0.1:3443  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { query, pool } from '../config/database.js';

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

// public/js/modules/subjects.module.js の CHIP_PALETTE と同一（テスト側で複製して実測と突き合わせる）
const CHIP_PALETTE = {
  ACCENT: 'bg-accent-soft text-accent-strong border-accent-soft',
  PURPLE: 'bg-accent-alt-soft text-accent-alt border-accent-alt',
  SUCCESS: 'bg-success-soft text-success-strong border-success-soft',
  WARNING: 'bg-warning-soft text-warning-strong border-warning-soft',
  INFO: 'bg-info-soft text-info-strong border-info-soft',
  DANGER: 'bg-danger-soft text-danger-strong border-danger-soft',
  SLATE: 'bg-surface text-soft border-divider',
};

const findChrome = () => {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH 環境変数でパスを指定してください。');
};

/** ページ内で職員一覧の特定行（教職員番号）の担当教科セル状態を読む（寸法は px 実測） */
const rowState = (page, code) => page.evaluate((c) => {
  const tbody = document.getElementById('users-manage-tbody');
  const tr = Array.from(tbody.querySelectorAll('tr')).find((r) => r.textContent.includes(c));
  if (!tr) return { found: false };
  const cell = tr.querySelector('.subject-cell');
  if (!cell) return { found: false, reason: 'no subject-cell' };
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const style = (el) => {
    if (!el) return null;
    const c2 = getComputedStyle(el);
    return {
      fs: parseFloat(c2.fontSize), bw: parseFloat(c2.borderTopWidth),
      radius: parseFloat(c2.borderTopLeftRadius), cls: el.className,
    };
  };
  const chipsArea = cell.querySelector('.subject-chips-area');
  const chips = chipsArea ? Array.from(chipsArea.querySelectorAll('span')) : [];
  const picker = cell.querySelector('div[id^="subject-edit-"]');
  const boxes = picker ? Array.from(picker.querySelectorAll('input[type=checkbox]')) : [];
  return {
    found: true,
    userId: String(cell.getAttribute('data-user-id') || ''),
    cellText: cell.innerText.replace(/\s+/g, ' ').trim(),
    chipsAreaText: chipsArea ? chipsArea.innerText.replace(/\s+/g, ' ').trim() : null,
    chipTexts: chips.map((s) => s.textContent.trim()),
    chipStyle: chips.map((s) => style(s)),
    chipRects: chips.map((s) => rect(s)),
    pickerId: picker ? picker.id : null,
    boxes: boxes.length,
    checkedValues: boxes.filter((b) => b.checked).map((b) => b.value),
    hasSave: Boolean(cell.querySelector('.subject-save-btn')),
    hasCancel: Boolean(cell.querySelector('.subject-cancel-btn')),
    hasEdit: Boolean(cell.querySelector('.subject-edit-btn')),
    hasDelete: Boolean(tr.querySelector('.delete-user-btn')),
    rowText: tr.innerText.replace(/\s+/g, ' ').trim(),
  };
}, code);

/** 担当教科セルの状態（ピッカー・チップ）を user id で読む */
const rowStateById = (page, userId) => page.evaluate((uid) => {
  const tbody = document.getElementById('users-manage-tbody');
  const cell = tbody.querySelector(`.subject-cell[data-user-id="${uid}"]`);
  const picker = cell ? cell.querySelector('div[id^="subject-edit-"]') : null;
  const boxes = picker ? Array.from(picker.querySelectorAll('input[type=checkbox]')) : [];
  return {
    pickerId: picker ? picker.id : null,
    boxes: boxes.length,
    checkedValues: boxes.filter((b) => b.checked).map((b) => b.value),
    chipsAreaText: cell?.querySelector('.subject-chips-area')?.innerText.replace(/\s+/g, ' ').trim() || null,
    hasEdit: Boolean(cell?.querySelector('.subject-edit-btn')),
  };
}, userId);

/** ピッカーのチェックを教科名で一致させる */
const setChecks = (page, pickerId, want) => page.evaluate((pid, names) => {
  const holder = document.getElementById(pid);
  if (!holder) return null;
  const boxes = Array.from(holder.querySelectorAll('input[type=checkbox]'));
  boxes.forEach((b) => {
    const wantChecked = names.includes(b.value);
    if (b.checked !== wantChecked) b.click();
  });
  return boxes.filter((b) => b.checked).map((b) => b.value);
}, pickerId, want);

const main = async () => {
  // 教科マスタと id コード保存のユーザーを DB から選ぶ（テスト対象の実データを固定する）
  const master = (await query('SELECT id, name, color_key, sort_order FROM subjects ORDER BY sort_order ASC, name ASC')).rows;
  const usersRaw = (await query("SELECT id, staff_code, name, subjects FROM users WHERE subjects IS NOT NULL AND subjects <> '[]' ORDER BY staff_code ASC")).rows;
  const masterById = new Map(master.map((s) => [String(s.id).toLowerCase(), s]));
  let target = null;
  for (const u of usersRaw) {
    let arr = [];
    try { arr = JSON.parse(u.subjects); } catch { arr = []; }
    const hits = arr.map((t) => masterById.get(String(t).toLowerCase())).filter(Boolean);
    if (hits.length > 0 && hits.length === arr.length) {
      target = { user: u, tokens: arr, names: hits.map((s) => s.name) };
      break;
    }
  }

  check('2. 教科マスタは 9件・id コードと正式名', master.length === 9 && master.every((s) => s.id && s.name),
    { count: master.length, ids: master.map((s) => s.id) });
  check('対象選定: id コードで担当教科が保存済みのユーザー', Boolean(target),
    target ? { staff_code: target.user.staff_code, tokens: target.tokens, names: target.names } : null);
  if (!target) { await pool.end(); process.exit(1); }

  const code = target.user.staff_code;
  const originalSubjects = target.user.subjects;

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // API リクエスト数を実測する（保存の二重束縛と閉じる時の余計な再取得を測る）
  const reqs = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/')) reqs.push(`${r.method()} ${u.replace(BASE, '')}`);
  });

  // ログイン（app が保存する JWT キーを使う）
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#login-form', { visible: true, timeout: 15000 });
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.click('#login-form button[type="submit"]');
  await page.waitForFunction(() => {
    const app = document.getElementById('app-container');
    return Boolean(app) && !app.classList.contains('hidden');
  }, { timeout: 30000 });
  await sleep(1200);
  const token = await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251'));

  // 1. 職員一覧モーダル（CSV 一括登録カードと職員一覧テーブル）
  await page.evaluate(() => {
    document.getElementById('user-menu-btn')?.click();
    document.getElementById('menu-users-manage-btn')?.click();
  });
  await page.waitForFunction(() => {
    const m = document.getElementById('users-manage-modal');
    return Boolean(m) && !m.classList.contains('hidden');
  }, { timeout: 20000 });
  const card = await page.evaluate(() => {
    const c = document.getElementById('user-import-card');
    const t = document.getElementById('users-manage-tbody');
    return { importCard: Boolean(c) && !c.classList.contains('hidden'), tbody: Boolean(t) };
  });
  check('1. 職員一覧モーダル（CSV 一括登録カードと一覧テーブル）', card.importCard && card.tbody, card);
  await page.waitForFunction((c) => {
    const tbody = document.getElementById('users-manage-tbody');
    return Boolean(tbody) && tbody.innerText.includes(c);
  }, { timeout: 25000 }, code);

  // 3. 担当教科チップは正式名（id コードはチップに出ない）
  const st0 = await rowState(page, code);
  const masterColorClass = CHIP_PALETTE[String(masterById.get(target.tokens[0].toLowerCase()).color_key || 'SLATE').toUpperCase()] || CHIP_PALETTE.SLATE;
  check('3. チップは正式名で描画（id コードはチップに出ない）',
    st0.found && target.names.every((n) => st0.chipsAreaText.includes(n)) && !st0.chipsAreaText.includes(target.tokens[0]),
    { chipsAreaText: st0.chipsAreaText, tokens: target.tokens, names: target.names });
  check('4. チップ寸法（フォント 14px・枠 2px・角丸 4px）と color_key クラス',
    st0.chipStyle.length > 0
      && st0.chipStyle.every((s) => Math.round(s.fs) === 14 && Math.round(s.bw) === 2 && Math.round(s.radius) === 4)
      && st0.chipStyle.every((s) => s.cls.includes(masterColorClass.split(' ')[0])),
    { chipStyle: st0.chipStyle.slice(0, 2), expected: masterColorClass });

  // 5. 編集ピッカーはマスタ 9件・id コード保存でも正式名にチェックが付く
  const userId = st0.userId;
  await page.evaluate((uid) => {
    const cell = document.querySelector(`.subject-cell[data-user-id="${uid}"]`);
    cell?.querySelector('.subject-edit-btn')?.click();
  }, userId);
  await page.waitForFunction((uid) => {
    const cell = document.querySelector(`.subject-cell[data-user-id="${uid}"]`);
    const holder = cell?.querySelector('div[id^="subject-edit-"]');
    return Boolean(holder) && holder.querySelectorAll('input[type=checkbox]').length > 0;
  }, { timeout: 20000 }, userId);
  const st1 = await rowStateById(page, userId);
  check('5. 編集ピッカーはマスタ 9件・id コード保存でも正式名にチェック',
    st1.boxes === master.length && st1.checkedValues.length === target.names.length
      && target.names.every((n) => st1.checkedValues.includes(n)),
    { boxes: st1.boxes, checkedValues: st1.checkedValues, names: target.names });

  // 6. 保存を1クリック（PUT は 1件だけ・トースト）
  const wantName = master.find((s) => String(s.name) !== target.names[0]).name;
  const afterChecks = await setChecks(page, st1.pickerId, [wantName]);
  const reqsBeforeSave = reqs.length;
  await page.evaluate((uid) => {
    const cell = document.querySelector(`.subject-cell[data-user-id="${uid}"]`);
    cell?.querySelector('.subject-save-btn')?.click();
  }, userId);
  await page.waitForFunction(() => document.body.innerText.includes('担当教科を保存しました'), { timeout: 25000 });
  const saveReqs = reqs.slice(reqsBeforeSave).filter((r) => r.startsWith('PUT') && r.includes(`/users/${userId}/subjects`));
  check('6. 保存1クリックで PUT は 1件だけ（二重束縛なし）・トースト',
    saveReqs.length === 1 && afterChecks.length === 1 && afterChecks[0] === wantName,
    { saveReqs, afterChecks });

  // 7. 保存後は行のチップと DB が正式名
  await page.waitForFunction((uid, n) => {
    const cell = document.querySelector(`.subject-cell[data-user-id="${uid}"]`);
    const area = cell?.querySelector('.subject-chips-area');
    return Boolean(area) && area.innerText.includes(n) && !area.innerText.includes('ko0');
  }, { timeout: 25000 }, userId, wantName);
  const st2 = await rowStateById(page, userId);
  const dbSubjects = JSON.parse((await query('SELECT subjects FROM users WHERE id = ?', [userId])).rows[0].subjects);
  check('7. 保存後はチップと DB が正式名',
    st2.chipsAreaText.includes(wantName) && dbSubjects.length === 1 && dbSubjects[0] === wantName,
    { chipsAreaText: st2.chipsAreaText, dbSubjects });

  // 8. 閉じる（ピッカーが消えてチップへ戻す。職員一覧の再取得リクエストは増えない）
  await page.evaluate((uid) => {
    const cell = document.querySelector(`.subject-cell[data-user-id="${uid}"]`);
    cell?.querySelector('.subject-edit-btn')?.click();
  }, userId);
  await page.waitForFunction((uid) => {
    const cell = document.querySelector(`.subject-cell[data-user-id="${uid}"]`);
    return Boolean(cell?.querySelector('div[id^="subject-edit-"]')?.querySelector('input[type=checkbox]'));
  }, { timeout: 20000 }, userId);
  const reqsBeforeClose = reqs.length;
  await page.evaluate((uid) => {
    const cell = document.querySelector(`.subject-cell[data-user-id="${uid}"]`);
    cell?.querySelector('.subject-cancel-btn')?.click();
  }, userId);
  await sleep(600);
  const st3 = await rowStateById(page, userId);
  const closeGets = reqs.slice(reqsBeforeClose).filter((r) => r.startsWith('GET') && r.includes('/api/users'));
  check('8. 閉じるでピッカー消失・チップ復帰・一覧再取得なし',
    st3.pickerId === null && st3.hasEdit && st3.chipsAreaText.includes(wantName) && closeGets.length === 0,
    { pickerId: st3.pickerId, hasEdit: st3.hasEdit, chipsAreaText: st3.chipsAreaText, closeGets });

  // 9. 閉じた後に同じ行の編集が再び使える
  await page.evaluate((uid) => {
    const cell = document.querySelector(`.subject-cell[data-user-id="${uid}"]`);
    cell?.querySelector('.subject-edit-btn')?.click();
  }, userId);
  await page.waitForFunction((uid) => {
    const cell = document.querySelector(`.subject-cell[data-user-id="${uid}"]`);
    const holder = cell?.querySelector('div[id^="subject-edit-"]');
    return Boolean(holder) && holder.querySelectorAll('input[type=checkbox]').length === 9;
  }, { timeout: 20000 }, userId);
  const st4 = await rowStateById(page, userId);
  check('9. 閉じた後に編集が再び使える（ピッカー 9件・現在の正式名がチェック済み）',
    st4.boxes === 9 && st4.checkedValues.length === 1 && st4.checkedValues[0] === wantName,
    { boxes: st4.boxes, checkedValues: st4.checkedValues });
  await page.evaluate((uid) => {
    const cell = document.querySelector(`.subject-cell[data-user-id="${uid}"]`);
    cell?.querySelector('.subject-cancel-btn')?.click();
  }, userId);
  await sleep(400);

  // 10. プロフィールの担当教科ピッカー（教科マスタ読み込み込みで描画される）
  await page.evaluate(() => document.querySelector('#users-manage-modal .modal-footer .modal-close')?.click());
  await page.waitForFunction(() => document.getElementById('users-manage-modal').classList.contains('hidden'), { timeout: 10000 });
  await page.evaluate(() => {
    document.getElementById('user-menu-btn')?.click();
    document.getElementById('menu-profile-btn')?.click();
  });
  await page.waitForFunction(() => !document.getElementById('profile-modal').classList.contains('hidden'), { timeout: 15000 });
  const prof = await page.evaluate(() => {
    const holder = document.getElementById('profile-subjects');
    const boxes = Array.from(holder.querySelectorAll('input[type=checkbox]'));
    return { boxes: boxes.length, values: boxes.map((b) => b.value), checked: boxes.filter((b) => b.checked).map((b) => b.value) };
  });
  const meTokens = JSON.parse((await query('SELECT subjects FROM users WHERE staff_code = ?', [USER])).rows[0].subjects);
  const meNames = meTokens.map((t) => { const s = masterById.get(String(t).toLowerCase()); return s ? s.name : t; });
  check('10. プロフィールのピッカーはマスタ 9件・マスタ名・自分の担当教科（正式名）がチェック済み',
    prof.boxes === 9 && prof.values.every((v) => master.some((s) => s.name === v))
      && prof.checked.length === meNames.length && meNames.every((n) => prof.checked.includes(n)),
    { boxes: prof.boxes, values: prof.values.slice(0, 10), checked: prof.checked, meTokens, meNames });
  await page.evaluate(() => document.querySelector('#profile-modal .modal-footer .modal-close')?.click());


  // 11. 後片付け（DB を元の id コードへ戻し、チップ表示も元通り）
  await query('UPDATE users SET subjects = ? WHERE id = ?', [originalSubjects, userId]);
  await page.evaluate(() => {
    document.getElementById('user-menu-btn')?.click();
    document.getElementById('menu-users-manage-btn')?.click();
  });
  await page.waitForFunction(() => !document.getElementById('users-manage-modal').classList.contains('hidden'), { timeout: 20000 });
  await page.waitForFunction((c) => {
    const tbody = document.getElementById('users-manage-tbody');
    return Boolean(tbody) && tbody.innerText.includes(c);
  }, { timeout: 25000 }, code);
  const st5 = await rowState(page, code);
  const dbBack = JSON.parse((await query('SELECT subjects FROM users WHERE id = ?', [userId])).rows[0].subjects);
  check('11. 後片付け（DB とチップ表示が元通り）',
    JSON.stringify(dbBack) === JSON.stringify(target.tokens)
      && target.names.every((n) => st5.chipsAreaText.includes(n)) && !st5.chipsAreaText.includes(target.tokens[0]),
    { dbBack, chipsAreaText: st5.chipsAreaText });

  await browser.close();
  await pool.end();
  console.log(`\n合計 ${total}項目、失敗 ${failures.length}項目`);
  if (failures.length > 0) {
    console.log('FAIL: ' + failures.join(' | '));
    process.exit(1);
  }
  console.log('ALL OK');
};

main().catch(async (e) => {
  console.error('ERROR:', e.message);
  await pool.end().catch(() => {});
  process.exit(1);
});

