/**
 * CSV 一括登録 UI 回帰テスト (v3.1.15 §5) — 5項目
 *
 * 検証項目:
 *  1. 教務部の CSV 取り込みカード UI (テンプレート→ファイル選択→プレビュー→承認/取消→閉じても再出せる)
 *  2. 初回ログインの強制変更モーダル (閉じられない・アプリ系 API 403・変更後 WSS 接続)
 *  3. 新規登録フォームの初期パスワード欄 (招待コード新規登録 → must_change=true)
 *  4. ADMIN の変更 (自分の変更は自由・ADMIN 発行アカウントは変更強制しない・招待登録アカウントは初回変更強制)
 *  5. 監査ログ (USER_IMPORT の件数・発行者ロール)
 *
 * 実行: npm run test:ui:user-import
 *  前提: サーバー起動済み (UI_BASE=https://127.0.0.1:3443)。Chrome バイナリは CHROME_PATH または既定パス
 *  テスト用教職員番号は T9 で作り、最後に ADMIN が職員一覧 UI から削除して状態を戻す (§17)
 */
import fs from 'node:fs';
import path from 'node:path';
import { jest } from '@jest/globals';
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const KYOMU = { code: 'T2026001', pw: 'password123' };
const ADMIN = { code: 'T2026000', pw: 'password123' };
const TOKEN_KEY = 'is_system_jwt_token_v251';
const STAMP = String(Date.now()).slice(-6);
const CODE_A = `T9${STAMP}A`;
const CODE_B = `T9${STAMP}B`;
const CODE_ADMIN_ROW = `T9${STAMP}X`;
const CODE_REG = `T9${STAMP}R`;
const CODE_C = `T9${STAMP}C`;
const CODE_D = `T9${STAMP}D`;
const INIT_PW = 'Init2026!8';
const NEW_PW = 'Changed2026!8';
const FIXTURE = path.join(process.cwd(), 'data', 'ui-user-import-fixture.csv');

jest.setTimeout(90000);

const findChrome = () => {
  for (const p of [CHROME, '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    if (p && fs.existsSync(p)) return p;
  }
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH 環境変数でパスを指定してください。');
};

let browser = null;
let page = null;
const logs = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WSS 接続成功のコンソールログ (v3.1.15 §5: ゲート中は接続しない/解禁後接続する) */
const wssConnected = () => logs.some((l) => l.includes('リアルタイム通信レイヤーに接続成功'));

/** ページ内の localStorage トークンで API を叩く (ゲートの 403 と解禁を実測する) */
const apiInPage = (method, urlPath, body = null) =>
  page.evaluate(async (m, p, b) => {
    const token = localStorage.getItem('is_system_jwt_token_v251');
    const res = await fetch(`/api${p}`, {
      method: m,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: b ? JSON.stringify(b) : undefined,
    });
    const text = await res.text();
    return { status: res.status, text };
  }, method, urlPath, body);

const waitForUi = (fnBody, timeout = 25000, ...args) => page.waitForFunction(fnBody, { timeout }, ...args);

const loginUI = async (code, pw) => {
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('#login-form', { visible: true });
  await page.type('#login-userid', code);
  await page.type('#login-password', pw);
  await page.click('#login-form button[type="submit"]');
  try {
    await waitForUi(() => {
      const app = document.getElementById('app-container');
      return Boolean(app) && !app.classList.contains('hidden');
    }, 30000);
  } catch (e) {
    const err = await page.evaluate(() => document.getElementById('login-error')?.innerText || 'no #login-error');
    console.log(`loginUI failed (${code}): ${err}`);
    throw e;
  }
};

const logoutUI = async () => {
  await page.evaluate(() => document.getElementById('logout-btn')?.click());
  await waitForUi(() => {
    const ls = document.getElementById('login-screen');
    return Boolean(ls) && !ls.classList.contains('hidden');
  }, 25000);
};

/** ドロップダウンの項目を押す (ドロップダウンは閉じていても evaluate で押す) */
const clickMenu = async (menuBtnId) => {
  await page.evaluate((id) => {
    document.getElementById('user-menu-btn')?.click();
    document.getElementById(id)?.click();
  }, menuBtnId);
};

const usersModalOpen = () => waitForUi(() => {
  const m = document.getElementById('users-manage-modal');
  return Boolean(m) && !m.classList.contains('hidden');
}, 20000);

const usersModalClosed = () => waitForUi(() => {
  const m = document.getElementById('users-manage-modal');
  return Boolean(m) && m.classList.contains('hidden');
}, 10000);

const importCardVisible = async () => page.evaluate(() => {
  const c = document.getElementById('user-import-card');
  return Boolean(c) && !c.classList.contains('hidden');
});

/** 職員一覧 UI で教職員番号の行を削除する (confirm は自動承認)。§17 の状態戻し */
const deleteUserViaUI = async (staffCode) => {
  await clickMenu('menu-users-manage-btn');
  await usersModalOpen();
  await waitForUi((code) => {
    const tbody = document.getElementById('users-manage-tbody');
    return Boolean(tbody) && Array.from(tbody.querySelectorAll('tr')).some((tr) => tr.textContent.includes(code));
  }, 20000, staffCode);
  await page.evaluate((code) => {
    const tbody = document.getElementById('users-manage-tbody');
    const tr = Array.from(tbody.querySelectorAll('tr')).find((r) => r.textContent.includes(code));
    tr?.querySelector('.delete-user-btn')?.click();
  }, staffCode);
  await waitForUi((code) => {
    const tbody = document.getElementById('users-manage-tbody');
    return Boolean(tbody) && !Array.from(tbody.querySelectorAll('tr')).some((tr) => tr.textContent.includes(code));
  }, 20000, staffCode);
  await page.evaluate(() => document.querySelector('#users-manage-modal .modal-footer .modal-close')?.click());
  await usersModalClosed();
};

/** コンソールログの出現を待つ (WSS の接続成功ログ等) */
const expectConsoleLog = async (substr, timeout = 20000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (logs.some((l) => l.includes(substr))) return true;
    await sleep(250);
  }
  throw new Error(`コンソールログが見つかりません: ${substr}`);
};

describe('CSV 一括登録 UI (v3.1.15 §5)', () => {
  beforeAll(async () => {
    const header = 'staff_code,name,role,grade,department,email,password,extension_number,desk_number,group_zone,status_note,subjects';
    const rows = [
      header,
      `${CODE_A},UI確認 一郎,TEACHER,3,３学年,,${INIT_PW},221,A-12,1,テスト,`,
      `${CODE_B},UI確認 二郎,TEACHER,1,１学年,,${INIT_PW},222,A-13,1,テスト,`,
      `T2026001,UI確認 三郎,ADMIN,3,教務部,,${INIT_PW},223,A-14,1,テスト,`,
      `,UI確認 四郎,TEACHER,1,１学年,,${INIT_PW},224,A-15,1,テスト,`,
    ];
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, `\uFEFF${rows.join('\n')}\n`, 'utf-8');

    browser = await puppeteer.launch({
      executablePath: findChrome(),
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--ignore-certificate-errors', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    page.on('console', (m) => logs.push(m.text()));
    page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message}`));
    page.on('dialog', async (d) => { await d.accept(); });
    await page.goto(BASE, { waitUntil: 'networkidle2' });
  });

  afterAll(async () => {
    if (!browser) return;
    try {
      // 状態を戻す: 作った教職員番号を ADMIN が職員一覧 UI から削除 (§17)
      await loginUI(ADMIN.code, ADMIN.pw);
      for (const code of [CODE_A, CODE_B, CODE_REG, CODE_ADMIN_ROW, CODE_C, CODE_D]) {
        try { await deleteUserViaUI(code); } catch (e) { console.warn(`cleanup ${code}: ${e.message}`); }
      }
    } catch (e) {
      console.warn(`cleanup skipped: ${e.message}`);
    }
    console.log('--- browser console/pageerror (末尾60件) ---\n' + logs.slice(-60).join('\n'));
    await browser.close();
  });

  it('1. 教務部の CSV 取り込みカード UI (テンプレート→プレビュー→承認行の確定→閉じても再出せる)', async () => {
    await loginUI(KYOMU.code, KYOMU.pw);
    await clickMenu('menu-users-manage-btn');
    await usersModalOpen();

    // カードは教務部 (KYOMU) に表示される (§5)
    expect(await importCardVisible()).toBe(true);

    // テンプレートダウンロード (UTF-8 BOM・12列・サンプル1行)
    await page.click('#user-import-template-btn');
    await waitForUi(() => document.body.innerText.includes('テンプレートをダウンロードしました'), 15000);

    // CSV を選ぶ → プレビュー 全 4行 / 登録可 2 / 登録不可 2 (role ADMIN と教職員番号缺失が行エラー)
    const csv = fs.readFileSync(FIXTURE, 'utf-8');
    await page.evaluate((csvText) => {
      const file = new File([csvText], 'ui-import-fixture.csv', { type: 'text/csv' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('user-import-file');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, csv);
    await waitForUi(() => {
      const s = document.getElementById('user-import-summary');
      return s && s.innerText.includes('全 4行') && s.innerText.includes('登録可 2') && s.innerText.includes('登録不可 2');
    }, 25000);

    const rowState = await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll('#user-import-tbody input[data-row]'));
      return {
        rows: document.querySelectorAll('#user-import-tbody tr').length,
        checked: boxes.filter((b) => b.checked && !b.disabled).length,
        disabled: boxes.filter((b) => b.disabled).length,
      };
    });
    expect(rowState).toEqual({ rows: 4, checked: 2, disabled: 2 });

    // 承認行を確定 → 1トランザクション INSERT (2件) → 登録結果の表示
    await page.click('#user-import-commit-btn');
    await waitForUi(() => {
      const r = document.getElementById('user-import-result');
      return r && r.innerText.includes('2件');
    }, 25000);

    // カードを閉じても再度出せる (§5)
    await page.evaluate(() => document.querySelector('#users-manage-modal .modal-footer .modal-close')?.click());
    await usersModalClosed();
    await clickMenu('menu-users-manage-btn');
    await usersModalOpen();
    expect(await importCardVisible()).toBe(true);
    await page.evaluate(() => document.querySelector('#users-manage-modal .modal-footer .modal-close')?.click());
    await usersModalClosed();
  });

  it('2. 初回ログインの強制変更モーダル (閉じられない・アプリ系 API 403・変更後 WSS)', async () => {
    logs.length = 0; // WSS 接続ログはこのセッションだけに見る (§5)
    await logoutUI();
    await loginUI(CODE_A, INIT_PW);

    await waitForUi(() => !document.getElementById('password-change-modal').classList.contains('hidden'), 25000);

    // ESC と背景クリックでも閉じられない (§5)
    await page.keyboard.press('Escape');
    await page.mouse.click(8, 8);
    await sleep(600);
    expect(await page.evaluate(() => !document.getElementById('password-change-modal').classList.contains('hidden'))).toBe(true);

    // アプリ系 API は 403 で遮断される (§5)。WSS はまだ接続しない
    const blocked = await apiInPage('GET', '/subjects');
    expect(blocked.status).toBe(403);
    expect(wssConnected()).toBe(false);

    // 変更完了でモーダルが閉じ、アプリ系 API が解禁され WSS が接続する (§5)
    await page.type('#forced-current-password', INIT_PW);
    await page.type('#forced-new-password', NEW_PW);
    await page.type('#forced-new-password-confirm', NEW_PW);
    await page.click('#forced-password-form button[type="submit"]');
    await waitForUi(() => document.getElementById('password-change-modal').classList.contains('hidden'), 25000);

    const unblocked = await apiInPage('GET', '/subjects');
    expect(unblocked.status).toBe(200);
    const t0 = Date.now();
    while (!wssConnected() && Date.now() - t0 < 20000) {
      await sleep(250);
    }
    expect(wssConnected()).toBe(true);

    // ヘッダーのユーザー名バッヂ表示 (アプリが動く)
    await waitForUi(() => {
      const el = document.getElementById('current-user-badge');
      return el && el.innerText.trim().includes('UI確認 一郎');
    }, 30000);
  });


  it('3. 新規登録フォームの初期パスワード欄 (招待コード新規登録 → 初回ログインで must_change=true)', async () => {
    // 教務部が招待コードを発行する
    await logoutUI();
    await loginUI(KYOMU.code, KYOMU.pw);
    await clickMenu('menu-users-manage-btn');
    await usersModalOpen();
    await page.click('#generate-invitation-btn');
    await waitForUi(() => {
      const d = document.getElementById('invitation-code-display');
      return d && !d.classList.contains('hidden') && d.innerText.trim().length > 0;
    }, 20000);
    const invitationCode = await page.evaluate(() => document.getElementById('invitation-code-display').innerText.trim());
    await page.evaluate(() => document.querySelector('#users-manage-modal .modal-footer .modal-close')?.click());
    await usersModalClosed();

    // ログイン画面の「新規登録」タブで初期パスワードを自分で決める (§5)
    await logoutUI();
    await page.click('#tab-register-btn');
    await page.type('#reg-invitation-code', invitationCode);
    await page.type('#reg-staffcode', CODE_REG);
    await page.type('#reg-name', 'UI確認 五郎');
    await page.type('#reg-password', INIT_PW);
    await page.click('#register-form button[type="submit"]');

    // 登録直後は初期パスワード未変更 → 強制変更モーダルが出る (§5)
    await waitForUi(() => !document.getElementById('password-change-modal').classList.contains('hidden'), 25000);

    await page.type('#forced-current-password', INIT_PW);
    await page.type('#forced-new-password', NEW_PW);
    await page.type('#forced-new-password-confirm', NEW_PW);
    await page.click('#forced-password-form button[type="submit"]');
    await waitForUi(() => document.getElementById('password-change-modal').classList.contains('hidden'), 25000);

    // 変更済みのアカウントで再ログインするとモーダルは出ない
    await logoutUI();
    await loginUI(CODE_REG, NEW_PW);
    await sleep(900);
    expect(await page.evaluate(() => document.getElementById('password-change-modal').classList.contains('hidden'))).toBe(true);
    await waitForUi(() => {
      const el = document.getElementById('current-user-badge');
      return el && el.innerText.trim().includes('UI確認 五郎');
    }, 30000);
  });

  it('4. ADMIN の変更 (自分の変更は自由・ADMIN 発行アカウントは初回変更強制しない)', async () => {
    await logoutUI();
    await loginUI(ADMIN.code, ADMIN.pw);
    // ADMIN も CSV 取り込みカードを出せる (閉じても再出せる §5)
    await clickMenu('menu-users-manage-btn');
    await usersModalOpen();
    expect(await importCardVisible()).toBe(true);

    // ADMIN が教職員を発行 (初期パスワード設定)。作成されたアカウントは初回ログインで変更必須 (§5)
    await page.type('#new-user-staffcode', CODE_ADMIN_ROW);
    await page.type('#new-user-name', 'UI確認 六郎');
    await page.type('#new-user-password', INIT_PW);
    await page.evaluate(() => { document.getElementById('new-user-dept').value = '3学年'; });
    await page.click('#add-user-form button[type="submit"]');
    await sleep(1500);
    await waitForUi((code) => {
      const tbody = document.getElementById('users-manage-tbody');
      return Boolean(tbody) && tbody.innerText.includes(code);
    }, 25000, CODE_ADMIN_ROW);

    await page.evaluate(() => document.querySelector('#users-manage-modal .modal-footer .modal-close')?.click());
    await usersModalClosed();

    await logoutUI();
    await loginUI(CODE_ADMIN_ROW, INIT_PW);
    await sleep(600);
    // ADMIN 発行アカウントは初回ログインで変更を強制しない。アプリがそのまま使える (§5)
    expect(await page.evaluate(() => document.getElementById('password-change-modal').classList.contains('hidden'))).toBe(true);
    await waitForUi(() => {
      const el = document.getElementById('current-user-badge');
      return el && el.innerText.trim().includes('UI確認 六郎');
    }, 30000);

    // ADMIN は自分の変更を自由に行える (§5)。変更成功でトークンは新トークンへ差し替わる
    await logoutUI();
    await loginUI(ADMIN.code, ADMIN.pw);
    await clickMenu('menu-profile-btn');
    await waitForUi(() => !document.getElementById('profile-modal').classList.contains('hidden'), 15000);
    const tokenBefore = await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251'));
    // ★ JWT の iat は秒精度。ログインからパスワード変更が同じ秒内で終わると新トークンの
    //   文字列が旧と同一になり得る（payload 一致）。秒を跨いでから変更して実値を比較する
    await sleep(1100);
    await page.type('#profile-current-password', ADMIN.pw);
    await page.type('#profile-new-password', NEW_PW);
    await page.type('#profile-new-password-confirm', NEW_PW);
    await page.click('#profile-password-change-btn');
    await waitForUi(() => document.body.innerText.includes('パスワードを変更しました'), 25000);
    const tokenAfter = await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251'));

    // 他の UI スイートが使えるよう ADMIN のパスワードを seed 値へ戻す (§17)。
    // ★ 戻す操作は検査より先に実行する（検査が落ちても ADMIN のパスワードが NEW_PW のまま
    //   残ると exam / invitation / schedules のスイートがログインできず连锁して落ちる）
    await page.type('#profile-current-password', NEW_PW);
    await page.type('#profile-new-password', ADMIN.pw);
    await page.type('#profile-new-password-confirm', ADMIN.pw);
    await page.click('#profile-password-change-btn');
    await waitForUi(() => document.body.innerText.includes('パスワードを変更しました'), 25000);
    await page.evaluate(() => document.querySelector('#profile-modal .modal-footer .modal-close')?.click());

    expect(tokenAfter).not.toBe(tokenBefore);
  });

  it('5. 監査ログ (USER_IMPORT の件数・発行者ロール)', async () => {
    await logoutUI();
    await loginUI(ADMIN.code, ADMIN.pw);

    // ADMIN 発行者で CSV 取り込みを1回行い、監査ログの USER_IMPORT に発行者ロールと件数が
    // 実値で残ることを測る (§5)。ファイル名は ADMIN 用の 2行 fixture (CODE_C/CODE_D)
    const csvAdmin = [
      'staff_code,name,role,grade,department,email,password,extension_number,desk_number,group_zone,status_note,subjects',
      `${CODE_C},UI確認 七郎,TEACHER,2,２学年,,${INIT_PW},225,A-16,1,テスト,`,
      `${CODE_D},UI確認 八郎,TEACHER,2,２学年,,${INIT_PW},226,A-17,1,テスト,`,
    ].join('\n');

    await clickMenu('menu-users-manage-btn');
    await usersModalOpen();
    expect(await importCardVisible()).toBe(true);

    await page.evaluate((csvText) => {
      const file = new File([csvText], 'ui-user-import-admin.csv', { type: 'text/csv' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.getElementById('user-import-file');
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, csvAdmin);
    await waitForUi(() => {
      const s = document.getElementById('user-import-summary');
      return s && s.innerText.includes('全 2行') && s.innerText.includes('登録可 2行');
    }, 25000);

    await page.click('#user-import-commit-btn');
    await waitForUi(() => {
      const r = document.getElementById('user-import-result');
      return r && r.innerText.includes('2件');
    }, 25000);

    const res = await apiInPage('GET', '/audit/logs?limit=200');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    const logs_ = body.logs || [];
    const actions = new Set(logs_.map((l) => l.action));

    // 取り込み成功はトーストと監査ログに出す (WSS イベントは使わない §5・§15)
    expect(actions.has('USER_IMPORT')).toBe(true);

    // 監査ログは created_at DESC。最新の USER_IMPORT は ADMIN 発行者の 2件取り込み (§5)
    const importRow = logs_.find((l) => l.action === 'USER_IMPORT');
    const changes = JSON.parse(importRow.new_value || importRow.changes_json || '{}');
    expect(changes.created_count).toBe(2);
    expect(changes.issuer_role).toBe('ADMIN');
    expect(String(changes.fileName)).toContain('ui-user-import-admin');
    // 教務部 (KYOMU) 発行者の取り込みもログに残る (テスト1の fixture)。発行者ロールは発行した役職
    const kyomuRow = logs_.find(
      (l) => l.action === 'USER_IMPORT' && JSON.parse(l.new_value || l.changes_json || '{}').issuer_role === 'KYOMU'
    );
    expect(kyomuRow).toBeTruthy();
    expect(JSON.parse(kyomuRow.new_value || kyomuRow.changes_json || '{}').created_count).toBe(2);
  });
});

