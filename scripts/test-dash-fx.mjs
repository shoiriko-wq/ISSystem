/**
 * ダッシュボード労いカード（粒子アニメーション）と開発・QA 用プレビューパネルの回帰テスト
 *
 * 検証項目:
 *  1. ソース静的検証: 粒子の落下・上昇距離はカード高さを実測した --fx-drop に比例、計測 + ResizeObserver、
 *     「記入する」ボタン (dash-btn-absence) は撤廃済み、1分毎の再描画はプレビュー設定を引き継ぐ
 *  2. プレビューパネル #dash-fx-dev-panel は常時表示。開閉バーでコントロール部 #dash-fx-dev-body を折りたためる
 *  3. テーマセレクトと前/次ボタンで粒子レイヤーのテーマとモーションクラスが切り替わる
 *  4. 静的スウォッチ #fxp-swatches は全 13 テーマ分（prefers-reduced-motion でもテーマを確認できる）
 *  5. 疑似日付・疑似時刻・時刻帯・曜日・季節・特別な日・全メッセージの選択で労いメッセージとテーマが変わる
 *     (疑似日付 2026-12-24 → サンタテーマ + クリスマスイブ文、季節=夏 → 夏文、時刻帯 5・曜日 7・特別の日 10 がすべて出る)
 *  6. 復帰で疑似設定がクリアされ実日時に戻る
 *  7. --fx-drop は労いカードの高さ以上（粒子はカード底・上端まで届く）
 *  8. 幅 390px で横スクロールが出ず、パネルの全コントロールに label.for と枠線がある
 *  9. 「記入する」ボタンは画面に存在せず、区分別人数タイルのクリックと Enter で登録・確認モーダルが開く
 *     (bindAbsenceTile は件数非依存＝件数ゲート無し。0名表示のタイルでもクリックで開く)
 * 実行: npm run test:ui:fx  （ISSystem サーバーが必要 UI_BASE / UI_USER / UI_PASS）
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.NODE_EXTRA_CA_CERTS ||= path.join(ROOT, 'certs', 'issystem-ca.crt');
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

// ---- 1. ソース静的検証 ----
const dashSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modules', 'dashboard.module.js'), 'utf8');
const absSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'modules', 'absence.module.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'public', 'css', 'components.css'), 'utf8');

// bindAbsenceTile は件数ゲートを持たない（0名でもタイルクリックが効く）。バインド関数だけを切り出す
const bindBlock = absSrc.slice(
  absSrc.indexOf('const bindAbsenceTile'),
  absSrc.indexOf("bindAbsenceTile('dash-absence-leave-tile'")
);

check('落下・上昇距離はカード高さ実測の --fx-drop に比例（固定 150px は無い）',
  cssSrc.includes('var(--fx-drop, 160px)')
  && !cssSrc.includes('translate(26px, 150px)')
  && /100%\s*\{\s*transform:\s*translate\(26px,\s*var\(--fx-drop/.test(cssSrc)
  && /translate\(-22px,\s*calc\(var\(--fx-drop,\s*160px\)\s*\*\s*-1\)/.test(cssSrc), null);
check('レイヤー高さを計測して --fx-drop を設定し ResizeObserver で再計算する',
  dashSrc.includes('setDashFxDrop(layer)') && dashSrc.includes('new ResizeObserver('), null);
check('「記入する」ボタン (dash-btn-absence) はソースから撤廃済み',
  !dashSrc.includes('dash-btn-absence') && !absSrc.includes('dash-btn-absence') && !cssSrc.includes('#dash-btn-absence'), null);
check('人数タイルのクリックは件数に依存しない（bindAbsenceTile に件数ゲート・disabled が無く open を常時結ぶ）',
  bindBlock.length > 40 && bindBlock.includes("tile.addEventListener('click', open)")
  && !bindBlock.includes('disabled') && !/\bcount\b/i.test(bindBlock) && !/> 0/.test(bindBlock),
  { len: bindBlock.length });
check('1分毎の再描画はプレビュー設定を引き継ぐ (renderDashGreeting() は引数なし)',
  /setInterval\(\s*\(\)\s*=>\s*\{\s*renderDashGreeting\(\);/.test(dashSrc), null);

// ---- ブラウザ起動とログイン ----
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`  [page js error] ${e.message}`));

await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1500);
await page.evaluate(() => document.querySelector('.app-sidebar .nav-item[data-tab="dashboard"]').click());
await sleep(900);

// ---- 2. パネル常時表示と開閉 ----
const panelInfo = await page.evaluate(() => {
  const panel = document.getElementById('dash-fx-dev-panel');
  const toggle = document.getElementById('dash-fx-dev-toggle');
  const body = document.getElementById('dash-fx-dev-body');
  return {
    exists: !!panel,
    panelVisible: !!panel && panel.offsetParent !== null,
    barVisible: !!toggle && toggle.offsetParent !== null,
    bodyVisible: !!body && body.offsetParent !== null,
    expanded: toggle?.getAttribute('aria-expanded'),
    note: (document.querySelector('#dash-fx-dev-panel .fxp-note')?.textContent || '').trim(),
  };
});
check('プレビューパネルは常時表示され開閉バーを持つ',
  panelInfo.exists && panelInfo.panelVisible && panelInfo.barVisible
  && panelInfo.bodyVisible && panelInfo.expanded === 'true', panelInfo);
check('パネルは開発・QA 用である旨の注記を持つ', panelInfo.note.includes('開発') && panelInfo.note.includes('運用'), panelInfo.note);

await page.click('#dash-fx-dev-toggle');
await sleep(300);
const collapsed = await page.evaluate(() => ({
  bodyHidden: document.getElementById('dash-fx-dev-body').classList.contains('hidden'),
  bodyVisible: document.getElementById('dash-fx-dev-body').offsetParent !== null,
  barVisible: document.getElementById('dash-fx-dev-toggle').offsetParent !== null,
  expanded: document.getElementById('dash-fx-dev-toggle').getAttribute('aria-expanded'),
}));
check('折りたたまれるとコントロールバーだけが残る',
  collapsed.bodyHidden && !collapsed.bodyVisible && collapsed.barVisible && collapsed.expanded === 'false', collapsed);

await page.click('#dash-fx-dev-toggle');
await sleep(300);
const reopened = await page.evaluate(() => ({
  bodyVisible: document.getElementById('dash-fx-dev-body').offsetParent !== null,
  expanded: document.getElementById('dash-fx-dev-toggle').getAttribute('aria-expanded'),
}));
check('再度開くとコントロールが戻る', reopened.bodyVisible && reopened.expanded === 'true', reopened);

// ---- 3,4. テーマ切替 ----
const setTheme = (v) => page.evaluate((val) => {
  const sel = document.getElementById('fxp-theme');
  sel.value = val;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
}, v);

const fxState = () => page.evaluate(() => {
  const layer = document.getElementById('dash-fx-layer');
  return {
    theme: layer.dataset.fxTheme,
    cls: layer.className,
    particles: layer.querySelectorAll('.dash-fx').length,
    drop: parseFloat(getComputedStyle(layer).getPropertyValue('--fx-drop')),
    h: layer.offsetHeight,
    selectValue: document.getElementById('fxp-theme').value,
    swatches: document.querySelectorAll('#fxp-swatches span').length,
  };
});

const themeOrder = await page.evaluate(() => [...document.querySelectorAll('#fxp-theme option')].map((o) => o.value));
check('テーマセレクトは自動 + 全 13 テーマ', themeOrder.length === 14 && themeOrder[0] === 'auto', themeOrder);

await setTheme('santa');
await sleep(250);
const santaState = await fxState();
check('テーマセレクトで粒子テーマと上昇モーションが切り替わる',
  santaState.theme === 'santa' && santaState.cls.includes('fx-rise') && santaState.particles === 10, santaState);

await setTheme('leaves');
await sleep(250);
const leavesState = await fxState();
check('紅葉テーマは落下モーション', leavesState.theme === 'leaves' && leavesState.cls.includes('fx-fall'), leavesState);

check('静的スウォッチは全 13 テーマ分（prefers-reduced-motion でも確認できる）',
  santaState.swatches === 13, { swatches: santaState.swatches });

await setTheme('auto');
await sleep(200);
await page.click('#fxp-next');
await sleep(250);
const afterNext = await fxState();
check('次ボタンはセレクトの次のテーマへ進む',
  afterNext.selectValue === themeOrder[1] && afterNext.theme === themeOrder[1], afterNext.selectValue);
await page.click('#fxp-prev');
await sleep(250);
const afterPrev = await fxState();
check('前ボタンは自動 (日時) に戻る', afterPrev.selectValue === 'auto' && themeOrder.includes(afterPrev.theme), afterPrev.selectValue);

// ---- 5. 疑似日時とメッセージ次元 ----
const setField = (id, value) => page.evaluate((i, v) => {
  const el = document.getElementById(i);
  el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
}, id, value);

const msgOf = () => page.evaluate(() => document.getElementById('dash-warm-message').textContent.replace(/\s+/g, ' ').trim());

await setField('fxp-date', '2026-12-24');
await sleep(300);
const xmasMsg = await msgOf();
const xmasState = await fxState();
check('疑似日付 2026-12-24 はサンタテーマとクリスマスイブ文になる',
  xmasState.theme === 'santa' && xmasMsg.includes('クリスマスイブ'), { theme: xmasState.theme, msg: xmasMsg });

await setField('fxp-season', 'WINTER');
await sleep(250);
const winterMsg = await msgOf();
check('季節セレクト（冬）で労いメッセージの季節文が冬の文に変わる',
  winterMsg.includes('冬越えの体調管理'), winterMsg);

await setField('fxp-season', 'SUMMER');
await sleep(250);
const summerMsg = await msgOf();
check('季節セレクト（夏）へ即時切替（文もテーマも季節連動。7 月以外では夏テーマは出ない）',
  summerMsg.includes('まぶしい夏') && summerMsg !== winterMsg && xmasState.theme === 'santa', summerMsg);

const slotMsgs = [];
for (const v of ['MORNING', 'NOON', 'AFTERNOON', 'EVENING', 'NIGHT']) {
  await setField('fxp-slot', v);
  await sleep(150);
  slotMsgs.push((await msgOf()).slice(0, 12));
}
check('時刻帯セレクトで 5 つの労い文がすべて出る',
  new Set(slotMsgs).size === 5 && slotMsgs[0].includes('朝の光'), slotMsgs);

const weekMsgs = [];
for (const v of ['0', '1', '2', '3', '4', '5', '6']) {
  await setField('fxp-week', v);
  await sleep(150);
  weekMsgs.push(await msgOf());
}
check('曜日セレクトで 7 つの労い文がすべて出る',
  new Set(weekMsgs).size === 7 && weekMsgs[3].includes('折り返し'), weekMsgs);

const eventKeys = ['12-23', '12-24', '12-25', '12-26', '12-31', '01-01', '01-05', '04-01', '07-20', '09-01'];
const eventMsgs = [];
for (const k of eventKeys) {
  await setField('fxp-event', k);
  await sleep(150);
  eventMsgs.push((await msgOf()).slice(-24));
}
check('特別な日セレクトで 10 のイベント文がすべて出る',
  new Set(eventMsgs).size === 10 && eventMsgs[0].includes('クリスマスイブ'), eventMsgs.length);

// 特別な日を「なし (季節文)」にすると季節文へ戻る
await setField('fxp-date', '2026-07-20');
await sleep(250);
const confettiMsg = await msgOf();
const confettiState = await fxState();
check('疑似日付 2026-07-20 は紙吹雪テーマと終業式文',
  confettiState.theme === 'confetti' && confettiMsg.includes('終業式'), { theme: confettiState.theme, msg: confettiMsg });
await setField('fxp-event', 'none');
await sleep(250);
const noEventMsg = await msgOf();
check('特別な日を「なし」にすると季節文だけになる（季節は 7 月=初夏）',
  !noEventMsg.includes('終業式') && noEventMsg.includes('考査前の集中期'), noEventMsg);

// 全メッセージセレクト（時刻帯・曜日・季節・特別な日の全 28 文を選べる）
const msgSelInfo = await page.evaluate(() => {
  const sel = document.getElementById('fxp-message');
  return { options: sel.querySelectorAll('option').length, groups: sel.querySelectorAll('optgroup').length };
});
check('全メッセージセレクトは 4 組 28 文を並べる',
  msgSelInfo.groups === 4 && msgSelInfo.options === 29, msgSelInfo);
const pickedText = await page.evaluate(() => {
  const sel = document.getElementById('fxp-message');
  const target = [...sel.querySelectorAll('option')].find((o) => o.value.includes('深夜の校務'));
  sel.value = target.value;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return target.value;
});
await sleep(250);
check('全メッセージセレクトで選んだ文がそのまま労いカードに出る',
  (await msgOf()) === pickedText, pickedText);

// ---- 6. 復帰で実日時に戻る ----
await page.click('#fxp-reset');
await sleep(300);
const resetState = await page.evaluate(() => ({
  date: document.getElementById('fxp-date').value,
  time: document.getElementById('fxp-time').value,
  theme: document.getElementById('fxp-theme').value,
  slot: document.getElementById('fxp-slot').value,
  week: document.getElementById('fxp-week').value,
  season: document.getElementById('fxp-season').value,
  evt: document.getElementById('fxp-event').value,
  msg: document.getElementById('fxp-message').value,
  fxTheme: document.getElementById('dash-fx-layer').dataset.fxTheme,
  msgText: document.getElementById('dash-warm-message').textContent.replace(/\s+/g, ' ').trim(),
  toasts: [...document.querySelectorAll('#toast-container .toast')].map((t) => t.textContent.replace(/\s+/g, ' ').trim()),
}));
check('復帰で全セレクトが自動・疑似日付は空になり実日時のメッセージへ戻る',
  resetState.date === '' && resetState.time === '' && resetState.theme === 'auto'
  && resetState.slot === '' && resetState.week === '' && resetState.season === ''
  && resetState.evt === '' && resetState.msg === ''
  && !resetState.msgText.includes('終業式') && !resetState.msgText.includes('まぶしい夏')
  && themeOrder.includes(resetState.fxTheme), resetState);
check('復帰のトーストが出る', resetState.toasts.some((t) => t.includes('労いプレビュー')), resetState.toasts.slice(-1));

// ---- 7. 粒子の落下距離はカード高さ以上 ----
const dropState = await fxState();
check('粒子の落下・上昇距離 (--fx-drop) は労いカードの高さ以上（カード底まで届く）',
  dropState.h > 0 && dropState.drop >= dropState.h && dropState.drop <= dropState.h + 60,
  { h: dropState.h, drop: dropState.drop });

// ---- 8. モバイル 390px とフォーム規約 ----
await page.setViewport({ width: 390, height: 800 });
await sleep(700);
const mobile = await page.evaluate(() => {
  const panel = document.getElementById('dash-fx-dev-panel');
  const labels = [...panel.querySelectorAll('label[for]')];
  const missing = labels.filter((l) => !document.getElementById(l.htmlFor)).map((l) => l.htmlFor);
  const unbordered = [...panel.querySelectorAll('select, input')]
    .filter((el) => parseFloat(getComputedStyle(el).borderTopWidth) === 0).map((el) => el.id);
  const plainButtons = [...panel.querySelectorAll('button')]
    .filter((b) => parseFloat(getComputedStyle(b).borderTopWidth) === 0).map((b) => b.id);
  return {
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    panelVisible: panel.offsetParent !== null,
    barVisible: document.getElementById('dash-fx-dev-toggle').offsetParent !== null,
    labelCount: labels.length,
    missing, unbordered, plainButtons,
  };
});
check('幅 390px で横スクロールが出ずパネルも表示される',
  !mobile.overflowX && mobile.panelVisible && mobile.barVisible, mobile);
check('パネルの全コントロールに label.for があり入力欄・セレクト・ボタンは枠線を持つ',
  mobile.labelCount >= 7 && mobile.missing.length === 0 && mobile.unbordered.length === 0 && mobile.plainButtons.length === 0, mobile);

// ---- 9. 「記入する」ボタンは無く、人数タイルからモーダルを開ける ----
const absenceInfo = await page.evaluate(() => {
  const leave = document.getElementById('dash-absence-leave-tile');
  const trip = document.getElementById('dash-absence-trip-tile');
  return {
    absenceBtn: !!document.getElementById('dash-btn-absence'),
    leaveRole: leave?.getAttribute('role'),
    leaveTitle: leave?.getAttribute('title'),
    tripTitle: trip?.getAttribute('title'),
    tileText: (leave?.textContent || '').replace(/\s+/g, ' ').trim(),
    modalExists: !!document.getElementById('absence-modal'),
    formExists: !!document.getElementById('absence-form'),
  };
});
check('年休等・出張の「記入する」ボタンは画面に存在しない', !absenceInfo.absenceBtn, absenceInfo);
check('区分別人数タイルは role=button と「記入フォームを開く」旨の title を持ち件数ラベル（n名）を表示',
  absenceInfo.leaveRole === 'button' && !!absenceInfo.leaveTitle?.includes('記入フォーム')
  && !!absenceInfo.tripTitle?.includes('記入フォーム') && /\d+名/.test(absenceInfo.tileText), absenceInfo);

await page.evaluate(() => document.getElementById('dash-absence-leave-tile').dispatchEvent(new MouseEvent('click', { bubbles: true })));
await sleep(700);
const openedAbs = await page.evaluate(() => ({
  open: !document.getElementById('absence-modal').classList.contains('hidden'),
  activeFilter: [...document.querySelectorAll('.absence-filter-btn')]
    .filter((b) => b.classList.contains('text-accent-strong')).map((b) => b.dataset.absenceFilter),
  hasUserSelect: !!document.getElementById('absence-user-select'),
  hasTypeSelect: !!document.getElementById('absence-type-select'),
}));
check('年休等タイルのクリックで登録・確認モーダルが開き年休等フィルタが効く',
  openedAbs.open && openedAbs.activeFilter.length === 1 && openedAbs.activeFilter[0] === 'LEAVE'
  && openedAbs.hasUserSelect && openedAbs.hasTypeSelect, openedAbs);
await page.click('#absence-modal .modal-close-x');
await sleep(400);

// 0名表示のタイルでもクリックでモーダルが開く（bindAbsenceTile は件数を見ない）
// openAbsenceModal → loadAbsenceSummary が件数を再描画するため、0名へ戻す MutationObserver を仕掛ける
await page.evaluate(() => {
  const el = document.getElementById('dash-absence-leave');
  el.textContent = '0名';
  new MutationObserver(() => { if (el.textContent !== '0名') el.textContent = '0名'; })
    .observe(el, { childList: true, characterData: true, subtree: true });
});
await page.evaluate(() => document.getElementById('dash-absence-leave-tile').dispatchEvent(new MouseEvent('click', { bubbles: true })));
await sleep(700);
const zeroOpen = await page.evaluate(() => ({
  open: !document.getElementById('absence-modal').classList.contains('hidden'),
  tileText: (document.getElementById('dash-absence-leave-tile')?.textContent || '').replace(/\s+/g, ' ').trim(),
  activeFilter: [...document.querySelectorAll('.absence-filter-btn')]
    .filter((b) => b.classList.contains('text-accent-strong')).map((b) => b.dataset.absenceFilter),
  formVisible: !!document.getElementById('absence-form')
    && document.getElementById('absence-form').offsetParent !== null,
}));
check('0名表示の年休等タイルでもクリックで登録・確認モーダルが開き記入フォームが見える',
  zeroOpen.open && zeroOpen.tileText.includes('0名') && zeroOpen.activeFilter[0] === 'LEAVE'
  && zeroOpen.formVisible, zeroOpen);
await page.click('#absence-modal .modal-close-x');
await sleep(400);

// キーボード (Enter) でもモーダルが開く
await page.evaluate(() => document.getElementById('dash-absence-trip-tile').focus());
await page.keyboard.press('Enter');
await sleep(700);
const byKey = await page.evaluate(() => ({
  open: !document.getElementById('absence-modal').classList.contains('hidden'),
  activeFilter: [...document.querySelectorAll('.absence-filter-btn')]
    .filter((b) => b.classList.contains('text-accent-strong')).map((b) => b.dataset.absenceFilter),
}));
check('キーボード Enter でも出張タイルからモーダルが開く',
  byKey.open && byKey.activeFilter[0] === 'TRIP', byKey);

await browser.close();

console.log(failures.length ? `\nFAIL (${failures.length}): ${failures.join(', ')}` : '\nすべての検証 passed');
process.exit(failures.length ? 1 : 0);
