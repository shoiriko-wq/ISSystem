/**
 * 職員一覧のユーザ情報編集（管理者 ADMIN のみ）の実ブラウザ回帰テスト（v3.2.0追加5 §5・§7・§14）
 *
 * 検証項目:
 *  1. ADMIN の職員一覧に 7列（氏名/ID・所属・種別・学年・担当教科・内線・操作）が並ぶ
 *  2. 種別セルは role バッジ (ADMIN/KYOMU/TEACHER) と 教務主任・非常勤 バッジを実描画する
 *  3. 学年セルは users.grade を表示する (NONE / 未設定は -)
 *  4. ADMIN の全行に「情報編集」ボタンがある。教務部 (KYOMU) には無い（担当教科編集だけ）
 *  5. 「情報編集」でカードが開き name / email / 学年 / 所属 / 内線 / role / 教務主任 / 非常勤 と
 *     担当教科ピッカー（教科マスタ 9件・正式名）が現在値で prefill される
 *  6. 保存は PUT /api/users/:id を 1回だけ送り、トースト「ユーザ情報を更新しました」が出てカードが閉じ、
 *     一覧が再取得され新値・非常勤・教務主任バッジが反映される（二重束縛なし）
 *  7. DB 実測: name / email / grade / department / extension_number / is_parttime / is_kyomu / role が変わり、
 *     staff_code と password_hash は変わらない（教職員番号とパスワードは編集対象外）
 *  8. 自分自身の行の role select は disabled（ADMIN を自分から外すと編集者が消えるため）
 *  9. 教務部 (KYOMU) では「情報編集」が出ず「担当教科編集」だけが出る
 * 10. 後片付け（DB を元へ戻し、一覧表示も元通り）
 * 実行: node scripts/test-user-info-ui.mjs  （ISSystem サーバーが必要）
 *  options: UI_BASE=https://127.0.0.1:3443  UI_ADMIN_USER=T2026000  UI_PASS=password123  CHROME_PATH=...
 */
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { query, pool } from '../config/database.js';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const ADMIN_USER = process.env.UI_ADMIN_USER || 'T2026000';
const KYOMU_USER = process.env.UI_KYOMU_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
let TARGET_CODE = process.env.UI_TARGET_CODE || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
let total = 0;
const check = (name, ok, detail = null) => {
  total++;
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

const findChrome = () => {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH 環境変数でパスを指定してください。');
};

/** 職員一覧の特定行 (教職員番号) の表示状態と操作ボタンを読む */
const rowState = (page, code) => page.evaluate((c) => {
  const tbody = document.getElementById('users-manage-tbody');
  const tr = Array.from(tbody.querySelectorAll('tr')).find((r) => r.textContent.includes(c));
  if (!tr) return { found: false };
  const tds = Array.from(tr.querySelectorAll('td'));
  return {
    found: true,
    cols: tds.length,
    userId: String(tr.querySelector('.subject-cell')?.getAttribute('data-user-id') || ''),
    nameText: tds[0]?.innerText.replace(/\s+/g, ' ').trim() || '',
    departmentText: tds[1]?.innerText.replace(/\s+/g, ' ').trim() || '',
    kindText: tds[2]?.innerText.replace(/\s+/g, ' ').trim() || '',
    gradeText: tds[3]?.innerText.replace(/\s+/g, ' ').trim() || '',
    chipsText: tds[4]?.querySelector('.subject-chips-area')?.innerText.replace(/\s+/g, ' ').trim() || '',
    extText: tds[5]?.innerText.replace(/\s+/g, ' ').trim() || '',
    hasInfoEdit: Boolean(tr.querySelector('.user-info-edit-btn')),
    hasSubjectEdit: Boolean(tr.querySelector('.subject-edit-btn')),
    hasDelete: Boolean(tr.querySelector('.delete-user-btn')),
    rowText: tr.innerText.replace(/\s+/g, ' ').trim(),
  };
}, code);

/** 編集カードの現在値（prefill されたフォーム値）を読む */
const cardState = (page) => page.evaluate(() => {
  const card = document.getElementById('user-info-edit-card');
  const boxes = Array.from(document.querySelectorAll('#uinfo-subjects input[type=checkbox]'));
  const roleSel = document.getElementById('uinfo-role');
  return {
    visible: !card.classList.contains('hidden'),
    label: document.getElementById('uinfo-target-label').textContent,
    code: document.getElementById('uinfo-target-code').textContent,
    name: document.getElementById('uinfo-name').value,
    email: document.getElementById('uinfo-email').value,
    grade: document.getElementById('uinfo-grade').value,
    department: document.getElementById('uinfo-department').value,
    ext: document.getElementById('uinfo-ext').value,
    role: roleSel.value,
    roleDisabled: roleSel.disabled,
    kyomu: document.getElementById('uinfo-kyomu').checked,
    parttime: document.getElementById('uinfo-parttime').checked,
    boxes: boxes.length,
    checkedValues: boxes.filter((b) => b.checked).map((b) => b.value),
    saveDisabled: document.getElementById('uinfo-save').disabled,
  };
});

/** 編集フォームへ値を入れ、担当教科のチェックを指定教科名へ揃える */
const fillCard = (page, fields, wantSubjects) => page.evaluate((f, want) => {
  document.getElementById('uinfo-name').value = f.name;
  document.getElementById('uinfo-email').value = f.email;
  document.getElementById('uinfo-grade').value = f.grade;
  document.getElementById('uinfo-department').value = f.department;
  document.getElementById('uinfo-ext').value = f.ext;
  document.getElementById('uinfo-role').value = f.role;
  document.getElementById('uinfo-kyomu').checked = f.kyomu;
  document.getElementById('uinfo-parttime').checked = f.parttime;
  const boxes = Array.from(document.querySelectorAll('#uinfo-subjects input[type=checkbox]'));
  boxes.forEach((b) => {
    const wantChecked = want.includes(b.value);
    if (b.checked !== wantChecked) b.click();
  });
  return boxes.filter((b) => b.checked).map((b) => b.value);
}, fields, wantSubjects);

/** 職員一覧モーダルを開いて tbody の描画を待つ */
const openUsersModal = async (page) => {
  await page.evaluate(() => {
    document.getElementById('user-menu-btn')?.click();
    document.getElementById('menu-users-manage-btn')?.click();
  });
  await page.waitForFunction(() => {
    const m = document.getElementById('users-manage-modal');
    return Boolean(m) && !m.classList.contains('hidden');
  }, { timeout: 20000 });
};

/** 実ブラウザでログインする（app が保存する JWT キーを使う） */
const loginAs = async (page, staffCode) => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#login-form', { visible: true, timeout: 15000 });
  await page.type('#login-userid', staffCode);
  await page.type('#login-password', PASS);
  await page.click('#login-form button[type="submit"]');
  await page.waitForFunction(() => {
    const app = document.getElementById('app-container');
    return Boolean(app) && !app.classList.contains('hidden');
  }, { timeout: 30000 });
  await sleep(1200);
};

const main = async () => {
  // 対象は role TEACHER のユーザー。担当教科が教科マスタの正式名へ解決できる行を選ぶ
  // （id コード保存の行だとピッカーのチェック数が現在値と一致しないため）
  const master = (await query('SELECT id, name, sort_order FROM subjects ORDER BY sort_order ASC, name ASC')).rows;
  const masterById = new Map(master.map((s) => [String(s.id).toLowerCase(), s]));
  const teachers = (await query("SELECT id, staff_code, subjects FROM users WHERE role = 'TEACHER' ORDER BY staff_code ASC")).rows;
  let chosen = null;
  for (const t of teachers) {
    const tokens = JSON.parse(t.subjects || '[]');
    if (tokens.length === 0) continue;
    const names = tokens.map((tk) => (masterById.get(String(tk).toLowerCase()) || {}).name);
    if (names.every((n) => n)) { chosen = t; break; }
  }
  const targetRow = (await query(
    'SELECT id, staff_code, name, email, role, grade, department, extension_number, is_kyomu, is_parttime, subjects, password_hash FROM users WHERE staff_code = ?',
    [TARGET_CODE || chosen?.staff_code || teachers[0]?.staff_code]
  )).rows[0];
  const adminRow = (await query("SELECT id, staff_code, role FROM users WHERE role = 'ADMIN' ORDER BY staff_code ASC LIMIT 1")).rows[0];
  if (!targetRow || !adminRow) {
    check('対象データ (role TEACHER と ADMIN)', false, { targetRow: targetRow?.staff_code, adminRow: adminRow?.staff_code });
    await pool.end();
    process.exit(1);
  }
  TARGET_CODE = targetRow.staff_code;
  const original = {
    name: targetRow.name,
    email: targetRow.email,
    grade: targetRow.grade,
    department: targetRow.department,
    extension_number: targetRow.extension_number,
    role: targetRow.role,
    is_kyomu: targetRow.is_kyomu,
    is_parttime: targetRow.is_parttime,
    subjects: targetRow.subjects,
    password_hash: targetRow.password_hash,
  };
  const targetTokens = JSON.parse(targetRow.subjects || '[]');
  const targetNames = targetTokens.map((t) => (masterById.get(String(t).toLowerCase()) || {}).name || t);

  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // API リクエスト数を実測する（保存の二重束縛と一覧再取得の有無を測る）
  const reqs = [];
  const resp = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes('/api/')) reqs.push(`${r.method()} ${u.replace(BASE, '')}`);
  });
  page.on('response', (r) => {
    const u = r.url();
    if (u.includes('/api/')) resp.push(`${r.status()} ${r.request().method()} ${u.replace(BASE, '')}`);
  });

  await loginAs(page, ADMIN_USER);

  // 1. ADMIN の職員一覧モーダル（7列ヘッダ・編集カード・一覧テーブル）
  await openUsersModal(page);
  const header = await page.evaluate(() => {
    const thead = document.getElementById('users-manage-tbody').closest('table').querySelector('thead');
    const card = document.getElementById('user-info-edit-card');
    const gradeSel = document.getElementById('uinfo-grade');
    return {
      headers: Array.from(thead.querySelectorAll('th')).map((th) => th.textContent.trim()),
      cardVisible: !card.classList.contains('hidden'),
      gradeOptions: Array.from(gradeSel.options).map((o) => o.value),
    };
  });
  check('1. ADMIN の職員一覧は 7列 (氏名/ID・所属・種別・学年・担当教科・内線・操作) と編集カード',
    header.headers.length === 7 && header.headers[2] === '種別' && header.headers[3] === '学年'
      && header.cardVisible === false && header.gradeOptions.length === 5,
    header);
  await page.waitForFunction((c) => {
    const tbody = document.getElementById('users-manage-tbody');
    return Boolean(tbody) && tbody.innerText.includes(c);
  }, { timeout: 25000 }, TARGET_CODE);

  // 2・3. 種別セル (role バッジ) と学年セル (users.grade) を実描画、4. ADMIN は全行に「情報編集」
  const st0 = await rowState(page, TARGET_CODE);
  const self0 = await rowState(page, adminRow.staff_code);
  check('2. 種別セルは role バッジ (TEACHER=教員 / ADMIN=管理者) を実描画',
    st0.found && st0.cols === 7 && st0.kindText.includes('教員') && self0.kindText.includes('管理者'),
    { targetKind: st0.kindText, selfKind: self0.kindText });
  check('3. 学年セルは users.grade を表示 (対象 TEACHER の学年と ADMIN の -)',
    st0.gradeText === String(targetRow.grade) && self0.gradeText === '-',
    { targetGrade: st0.gradeText, dbGrade: targetRow.grade, selfGrade: self0.gradeText });
  check('4. ADMIN の全行に「情報編集」・「担当教科編集」・「削除」が出る',
    st0.hasInfoEdit && st0.hasSubjectEdit && st0.hasDelete && self0.hasInfoEdit,
    { target: st0, self: self0 });

  // 5. 「情報編集」でカードが開き、現在値と担当教科ピッカー (マスタ 9件・正式名) が prefill される
  const targetUserId = st0.userId;
  await page.evaluate((uid) => {
    const tr = document.querySelector(`.subject-cell[data-user-id="${uid}"]`)?.closest('tr');
    tr?.querySelector('.user-info-edit-btn')?.click();
  }, targetUserId);
  await page.waitForFunction(() => !document.getElementById('user-info-edit-card').classList.contains('hidden'), { timeout: 20000 });
  const st1 = await cardState(page);
  const masterNames = new Set(master.map((s) => s.name));
  // users.subjects は教科マスタ id コードでも正式名でも入る。チェック期待値は「正式名へ解決した token」
  const targetChecked = targetNames.filter((n) => masterNames.has(n));
  const prefillOk =
    st1.visible && st1.code === TARGET_CODE && st1.label === original.name &&
    st1.name === original.name && (st1.email || '') === (original.email || '') &&
    st1.grade === String(original.grade) && st1.department === (original.department || '') &&
    st1.ext === (original.extension_number || '') && st1.role === original.role &&
    st1.kyomu === Boolean(Number(original.is_kyomu)) && st1.parttime === Boolean(original.is_parttime) &&
    st1.boxes === master.length && st1.checkedValues.length === targetChecked.length &&
    targetChecked.every((n) => st1.checkedValues.includes(n));
  check('5. 情報編集カードは現在値 (name/email/学年/所属/内線/role/教務主任/非常勤) とピッカー 9件を prefill（教科マスタ名でチェック済み）',
    prefillOk, { st1, db: original, targetChecked });

  // 8. 自分自身の行の role select は disabled（ADMIN を自分から外さない）
  const adminUserId = String(adminRow.id);
  await page.evaluate((uid) => {
    const tbody = document.getElementById('users-manage-tbody');
    const tr = Array.from(tbody.querySelectorAll('tr')).find((r) => r.querySelector('.user-info-edit-btn')?.getAttribute('data-user-id') === uid);
    tr?.querySelector('.user-info-edit-btn')?.click();
  }, adminUserId);
  await sleep(600);
  const stSelf = await cardState(page);
  check('8. 自分自身の role select は disabled（他行の role は編集可能）',
    stSelf.visible && stSelf.code === adminRow.staff_code && stSelf.roleDisabled === true,
    { code: stSelf.code, roleDisabled: stSelf.roleDisabled });
  await page.evaluate(() => document.getElementById('uinfo-cancel')?.click());
  await sleep(400);
  const stClosed = await cardState(page);
  check('8b. 「中止する」でカードが閉じピッカーが空になる', stClosed.visible === false && stClosed.boxes === 0, stClosed);

  // 6. 保存: PUT は 1件だけ、トースト、カードが閉じ、一覧が再取得され新値・非常勤・学年が反映される
  const newEmail = `ui${String(Date.now()).slice(-6)}@school.ed.jp`;
  const wantSubject = master.find((s) => s.name !== targetNames[0]).name;
  const fields = {
    name: '情報編集 UI 改名',
    email: newEmail,
    grade: '3',
    department: 'UI検証部',
    ext: '118',
    role: 'TEACHER',
    kyomu: true,
    parttime: true,
  };
  const afterChecks = await (async () => {
    // 8b で閉じた後、対象行のカードをもう一度開いてから値を入れる（中止後カードは閉じている）
    await page.evaluate((uid) => {
      const tr = document.querySelector(`.subject-cell[data-user-id="${uid}"]`)?.closest('tr');
      tr?.querySelector('.user-info-edit-btn')?.click();
    }, targetUserId);
    await sleep(600);
    return fillCard(page, fields, [wantSubject]);
  })();
  const reqsBeforeSave = reqs.length;
  const respBeforeSave = resp.length;
  await page.evaluate(() => document.getElementById('uinfo-save').click());
  await sleep(5000);
  const toastNow = await page.evaluate(() => document.body.innerText.split('\n').filter((l) => l.includes('ユーザ情報')).join(' | '));
  const saveReqs = reqs.slice(reqsBeforeSave).filter((r) => r.startsWith('PUT') && r.includes(`/api/users/${targetUserId}`));
  const saveResp = resp.slice(respBeforeSave);
  const listGets = reqs.slice(reqsBeforeSave).filter((r) => r.startsWith('GET') && r.includes('/api/users'));
  check('6. 保存1クリックで PUT は 1件だけ（二重束縛なし）・トースト・カードが閉じる',
    saveReqs.length === 1 && afterChecks.length === 1 && afterChecks[0] === wantSubject && listGets.length >= 1
      && toastNow.includes('ユーザ情報を更新しました'),
    { saveReqs, saveResp, listGets, afterChecks, toastNow });
  await page.waitForFunction((uid) => {
    const tbody = document.getElementById('users-manage-tbody');
    const tr = Array.from(tbody.querySelectorAll('tr')).find((r) => r.textContent.includes(uid));
    return Boolean(tr) && tr.innerText.includes('情報編集 UI 改名') && tr.innerText.includes('非常勤');
  }, { timeout: 25000 }, TARGET_CODE);
  const st2 = await rowState(page, TARGET_CODE);
  check('6b. 一覧再取得後は新氏名・学年 3・所属・内線 118・非常勤と教務主任バッジが反映される',
    st2.rowText.includes('情報編集 UI 改名') && st2.gradeText === '3' && st2.departmentText === 'UI検証部'
      && st2.extText === '118' && st2.kindText.includes('非常勤') && st2.kindText.includes('教務主任')
      && st2.chipsText.includes(wantSubject) && !st2.chipsText.includes(targetNames[0]),
    { kindText: st2.kindText, gradeText: st2.gradeText, extText: st2.extText, chipsText: st2.chipsText });

  // 7. DB 実測: 各項目が変わり、教職員番号と password_hash は変わらない（編集対象外）。監査ログに差分が残る
  const after = (await query('SELECT * FROM users WHERE id = ?', [targetUserId])).rows[0];
  const audit = (await query("SELECT * FROM audit_logs WHERE action = 'UPDATE_USER_INFO' AND resource_id = ? ORDER BY id DESC LIMIT 1", [targetUserId])).rows[0];
  const auditChanges = audit ? JSON.parse(audit.new_value) : {};
  check('7. DB 実測: name/email/grade/department/extension_number/is_parttime/is_kyomu/subjects が変わり、staff_code と password_hash は変わらない',
    after.name === '情報編集 UI 改名' && after.email === newEmail && after.grade === '3' &&
      after.department === 'UI検証部' && after.extension_number === '118' &&
      Boolean(after.is_parttime) === true && Number(after.is_kyomu) === 1 &&
      after.role === 'TEACHER' && JSON.parse(after.subjects).length === 1 && JSON.parse(after.subjects)[0] === wantSubject &&
      after.staff_code === TARGET_CODE && after.password_hash === original.password_hash,
    { after: { name: after.name, email: after.email, grade: after.grade, department: after.department, ext: after.extension_number, role: after.role, parttime: after.is_parttime, kyomu: after.is_kyomu }, pwSame: after.password_hash === original.password_hash });
  check('7b. 監査ログ UPDATE_USER_INFO に差分 (from→to) と ADMIN 操作者が残る (password_hash は監査に載らない)',
    Boolean(audit) && auditChanges.name?.from === original.name && auditChanges.name?.to === '情報編集 UI 改名' &&
      auditChanges.grade?.from === String(original.grade) && auditChanges.grade?.to === '3' &&
      auditChanges.is_parttime?.to === 'true' && String(audit.new_value).includes('password_hash') === false,
    { auditChanges, user_name: audit?.user_name, action: audit?.action });

  // 9. 教務部 (KYOMU) には「情報編集」が出ない（担当教科編集のみ・編集カードは開かない）
  await page.evaluate(() => document.querySelector('#users-manage-modal .modal-footer .modal-close')?.click());
  await loginAs(page, KYOMU_USER);
  await openUsersModal(page);
  await page.waitForFunction((c) => {
    const tbody = document.getElementById('users-manage-tbody');
    return Boolean(tbody) && tbody.innerText.includes(c);
  }, { timeout: 25000 }, TARGET_CODE);
  const kyomuView = await page.evaluate((c) => {
    const tbody = document.getElementById('users-manage-tbody');
    const tr = Array.from(tbody.querySelectorAll('tr')).find((r) => r.textContent.includes(c));
    const card = document.getElementById('user-info-edit-card');
    return {
      infoEditButtons: tbody.querySelectorAll('.user-info-edit-btn').length,
      subjectEditButtons: tbody.querySelectorAll('.subject-edit-btn').length,
      trHasInfoEdit: Boolean(tr?.querySelector('.user-info-edit-btn')),
      trHasSubjectEdit: Boolean(tr?.querySelector('.subject-edit-btn')),
      cardVisible: !card.classList.contains('hidden'),
      kindText: tr?.querySelectorAll('td')[2]?.innerText.replace(/\s+/g, ' ').trim() || '',
      gradeText: tr?.querySelectorAll('td')[3]?.innerText.replace(/\s+/g, ' ').trim() || '',
      cols: tr?.querySelectorAll('td').length,
    };
  }, TARGET_CODE);
  check('9. 教務部 (KYOMU) には「情報編集」が出ない（担当教科編集のみ・カードは閉じたまま）。種別と学年は見る',
    kyomuView.infoEditButtons === 0 && kyomuView.trHasInfoEdit === false && kyomuView.trHasSubjectEdit === true &&
      kyomuView.cardVisible === false && kyomuView.cols === 7 && kyomuView.kindText.includes('非常勤'),
    kyomuView);

  // 10. 後片付け（DB を元へ戻し、監査ログの UPDATE_USER_INFO を消し、一覧表示も元通り）
  await page.evaluate(() => document.querySelector('#users-manage-modal .modal-footer .modal-close')?.click());
  await query('DELETE FROM audit_logs WHERE action = \'UPDATE_USER_INFO\' AND resource_id = ?', [targetUserId]);
  await query(
    'UPDATE users SET name = ?, email = ?, role = ?, grade = ?, department = ?, extension_number = ?, is_kyomu = ?, is_parttime = ?, subjects = ?, updated_at = NOW() WHERE id = ?',
    [original.name, original.email, original.role, original.grade, original.department, original.extension_number,
      Number(original.is_kyomu), Boolean(original.is_parttime), original.subjects, targetUserId]
  );
  await loginAs(page, ADMIN_USER);
  await openUsersModal(page);
  await page.waitForFunction((c, n) => {
    const tbody = document.getElementById('users-manage-tbody');
    return Boolean(tbody) && tbody.innerText.includes(c) && tbody.innerText.includes(n);
  }, { timeout: 25000 }, TARGET_CODE, original.name);
  const st3 = await rowState(page, TARGET_CODE);
  const dbBack = (await query('SELECT name, email, grade, department, extension_number, role, is_kyomu, is_parttime, subjects FROM users WHERE id = ?', [targetUserId])).rows[0];
  const auditLeft = (await query("SELECT count(*)::int c FROM audit_logs WHERE action = 'UPDATE_USER_INFO' AND resource_id = ?", [targetUserId])).rows[0].c;
  check('10. 後片付け（DB と一覧表示が元通り・監査ログは消して残さない）',
    dbBack.name === original.name && dbBack.email === original.email && dbBack.grade === original.grade &&
      dbBack.department === original.department && dbBack.extension_number === original.extension_number &&
      dbBack.role === original.role && Number(dbBack.is_kyomu) === Number(original.is_kyomu) &&
      Boolean(dbBack.is_parttime) === Boolean(original.is_parttime) &&
      JSON.stringify(JSON.parse(dbBack.subjects)) === JSON.stringify(targetNames) &&
      st3.nameText.includes(original.name) && st3.gradeText === String(original.grade) &&
      !st3.kindText.includes('非常勤') && auditLeft === 0,
    { dbBack: { name: dbBack.name, grade: dbBack.grade }, st3: { nameText: st3.nameText, kindText: st3.kindText }, auditLeft });

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




