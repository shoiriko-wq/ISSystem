/**
 * 職員掲示板の全日未読ボタン（検索ボックスの右）とミニカレンダー年月部（スケジュールと同じ形）の実ブラウザ寸法検証
 *
 * 目的: 見出し右の未読バッヂは撤廃済み。全日未読は検索ボックス右のボタン（ラベル「未読 N」）で押す。
 *       ツールバーの「本日」ボタンも撤廃済み（本日へは年月選択メニューの「本日へ」と T キー）。
 *       ミニカレンダーの年月部（‹ [年月] ›）はスケジュールのカレンダーと同じ形。
 *       寸法・位置・枠はすべて px で実測する（AGENTS.md 第12条・禁则12）。
 *
 * 検証項目:
 *  1. 検証投稿（過去日・未来日の 2 件）を作れる
 *  2. 未読ボタンはツールバーの検索ボックスの真右（同じ行。ボタン左端は検索ボックス右端より右、縦中心は同じ、日付グループより左）
 *  3. 未読ボタンは検索ボックスと同一の高さ・角丸・フォント・枠（2px 実線 1枚、border-main の同一色）
 *  4. 通常時は影なし。ホバーでリング（outline＋影）＋浮きがツールバー内で見切れない
 *  5. ラベル「未読 N」はサイドバーの数字と同一。aria-label・title・aria-pressed は押されていない
 *  6. 見出しは「職員掲示板」ラベルのみ（見出し右の未読バッヂは存在しない）
 *  7. ツールバーに「本日」ボタン・カレンダーに「今日」ボタンは存在しない（年月選択メニューに「本日へ」はある）
 *  8. ミニカレンダーの年月ラベルはスケジュールの年月ラベルと同一設計（クラス・枠 2px・角丸・背景・下向き chevron・aria-haspopup）。
 *     ‹ › は同一寸法ボタンでラベルを挟み、ラベルは中央（ラベル高さは ‹ › 以下）
 *  9. ラベルクリックで年月選択メニューがラベル直下中央に開く（年 ‹ › + 12ヶ月 + 「本日へ」。中心日は動かさない）。
 *     矢印キーで月焦点が動き、Esc で閉じて焦点はラベルへ、外クリックで閉じる、› で 1ヶ月送り、「本日へ」で本日へ
 * 10. クリックで全日の未読一覧（過去日・未来日の 2 件・対象日見出し付き・中心日表示「未読」）。
 *     未読表示中は ‹ ›・中心日クリック・年月選択・カレンダー日付セルが止まり、検索語は空のまま
 * 11. もう一度押すと日付表示へ戻る。T キーも未読表示を閉じて本日へ戻る
 * 12. 後片付け（DELETE → 未読数 2 減・ラベル・サイドバー・ボタン hidden 追従）
 * 実行: node scripts/test-bulletin-unread-btn-pos.mjs  （ISSystem サーバーが必要）
 *  options: UI_BASE=https://127.0.0.1:3443  UI_USER=T2026001  UI_PASS=password123  CHROME_PATH=...
 */
import puppeteer from 'puppeteer-core';
import { query, pool } from '../config/database.js';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const log = (name, val) => console.log(`${name} = ${JSON.stringify(val)}`);
let total = 0;
const check = (name, ok, detail = null) => {
  total++;
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail !== null ? ` -> ${JSON.stringify(detail)}` : ''}`);
};

/** JST の本日 (YYYY-MM-DD) */
const todayJst = () => new Date(Date.now() + 9 * 3600000).toISOString().split('T')[0];
/** YYYY-MM-DD に ±n 日 */
const shiftDate = (iso, days) => {
  const p = iso.split('-').map(Number);
  const t = Date.UTC(p[0], p[1] - 1, p[2]) + days * 86400000;
  return new Date(t).toISOString().split('T')[0];
};
/** 対象日見出しと同じ MM/DD 部分 */
const mmdd = (iso) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}`;

/** ログイン（app が保存する JWT キー is_system_jwt_token_v251 を page.__token に保持。test-bulletin-search-all-days.mjs と同じ慣習） */
const login = async (page) => {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(1200);
  page.__token = await page.evaluate(() => localStorage.getItem('is_system_jwt_token_v251'));
  return Boolean(page.__token);
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

/** 掲示タブを開く（サイドバーのナビ項目） */
const openBulletin = async (page, ms = 1300) => {
  await page.evaluate(() => { const a = document.querySelector('a[data-tab="bulletin"]'); if (a) a.click(); });
  await sleep(ms);
};

/** ツールバー・列表・中心日表示・サイドバー・年月選択の状態スナップショット（寸法と描画を px で読む） */
const snapshot = (page) => page.evaluate(() => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      right: Math.round(r.right), bottom: Math.round(r.bottom),
      cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  };
  const style = (el) => {
    if (!el) return null;
    const c = getComputedStyle(el);
    return {
      bw: [c.borderTopWidth, c.borderRightWidth, c.borderBottomWidth, c.borderLeftWidth],
      bs: c.borderTopStyle, bc: c.borderTopColor, radius: c.borderTopLeftRadius,
      fs: c.fontSize, fw: c.fontWeight, bg: c.backgroundColor, color: c.color,
      shadow: c.boxShadow, outline: c.outlineWidth, outlineStyle: c.outlineStyle,
      outlineColor: c.outlineColor, outlineOffset: c.outlineOffset, cls: el.className,
    };
  };
  const input = document.getElementById('bulletin-search-input');
  const btn = document.getElementById('bulletin-btn-unread');
  const dayGroup = document.getElementById('bulletin-day-group');
  const readout = document.getElementById('bulletin-day-current');
  const side = document.getElementById('bulletin-unread-count');
  const h2 = document.querySelector('#view-bulletin h2');
  const row = btn ? btn.parentElement : null;
  const card = row ? row.closest('.p-3') : null;
  const cal = document.getElementById('bulletin-mini-cal');
  const menu = document.getElementById('bulletin-month-menu');
  const label = document.getElementById('bulletin-month-menu-btn');
  const rows = [...document.querySelectorAll('#bulletin-list-container [data-bulletin-toggle]')];
  return {
    inputRect: rect(input), inputStyle: style(input), placeholder: input ? input.placeholder : null,
    btnRect: rect(btn), btnStyle: style(btn), btnText: btn ? btn.textContent.trim() : null,
    btnHidden: btn ? btn.classList.contains('hidden') : null,
    btnPressed: btn ? btn.getAttribute('aria-pressed') : null,
    btnDisabled: btn ? btn.disabled === true : null,
    btnLabel: btn ? btn.getAttribute('aria-label') : null,
    btnTitle: btn ? btn.getAttribute('title') : null,
    btnTag: btn ? btn.tagName : null, btnType: btn ? btn.getAttribute('type') : null,
    rowRect: rect(row), cardRect: rect(card),
    cardPad: card ? (() => { const c = getComputedStyle(card); return { t: parseFloat(c.paddingTop), r: parseFloat(c.paddingRight), b: parseFloat(c.paddingBottom), l: parseFloat(c.paddingLeft), bw: parseFloat(c.borderTopWidth) }; })() : null,
    dayGroupRect: rect(dayGroup),
    readoutStyle: style(readout),
    readoutText: readout ? readout.textContent.trim() : null,
    centerDate: readout ? (readout.dataset.day || '') : '',
    navDisabled: ['bulletin-day-prev', 'bulletin-day-next', 'bulletin-day-current'].map((id) => Boolean(document.getElementById(id)?.disabled)),
    labelDisabled: label ? label.disabled === true : null,
    monthLabel: label ? label.textContent.trim().replace(/\s+/g, ' ') : null,
    menuOpen: menu ? !menu.classList.contains('hidden') : false,
    calOpen: cal ? !cal.classList.contains('hidden') : false,
    calDayCells: cal ? cal.querySelectorAll('button.mini-cal-day').length : 0,
    calDisabledDays: cal ? [...cal.querySelectorAll('button.mini-cal-day')].filter((d) => d.disabled).length : 0,
    sideText: side ? side.textContent.trim() : null,
    sideHidden: side ? side.classList.contains('hidden') : null,
    h2Text: h2 ? h2.textContent.replace(/\s+/g, ' ').trim() : null,
    titleBadgeExists: Boolean(document.getElementById('bulletin-title-unread')),
    h2Span: h2 ? Boolean(h2.querySelector('span')) : null,
    h2Button: h2 ? Boolean(h2.querySelector('button')) : null,
    todayBtnExists: Boolean(document.getElementById('bulletin-btn-today')),
    calTodayExists: Boolean(document.getElementById('bulletin-cal-today')),
    searchValue: input ? input.value : null,
    rows: rows.length,
    rowIds: rows.map((r) => String(r.getAttribute('data-bulletin-toggle'))),
    rowDays: rows.map((r) => r.querySelector('.bulletin-row-day')?.textContent.trim() || null),
    rowTitles: rows.map((r) => r.querySelector('.bulletin-row-title')?.textContent.trim() || null),
    seps: [...document.querySelectorAll('#bulletin-list-container .bulletin-day-sep')].map((s) => s.textContent.trim()),
    activeId: document.activeElement ? (document.activeElement.id || document.activeElement.tagName) : null,
    menuMonths: menu ? menu.querySelectorAll('[data-menu-month]').length : 0,
    menuYearBtns: menu ? menu.querySelectorAll('[data-menu-year]').length : 0,
    menuToday: Boolean(menu && menu.querySelector('[data-menu-today]')),
    menuExpanded: label ? label.getAttribute('aria-expanded') : null,
    labelFocused: document.activeElement === label,
    focusMonth: (() => {
      const f = document.activeElement;
      if (f && f.closest && f.closest('#bulletin-month-menu') && f.getAttribute('data-menu-month'))
        return Number(f.getAttribute('data-menu-month')) + 1;
      return null;
    })(),
    state: window.__bulletinSnap ? window.__bulletinSnap() : null,
  };
});

/** 年月ラベル（‹ [年月] ›）の寸法・描画・aria（bulletin と schedule を同じ関数で測る） */
const labelGeom = (page, labelId, prevSel, nextSel) => page.evaluate((lid, ps, ns) => {
  const rect = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      cx: Math.round(r.x + r.width / 2), cy: Math.round(r.y + r.height / 2) };
  };
  const c = (el) => {
    if (!el) return null;
    const s = getComputedStyle(el);
    return { bw: s.borderTopWidth, bs: s.borderTopStyle, bc: s.borderTopColor, radius: s.borderTopLeftRadius,
      fs: s.fontSize, fw: s.fontWeight, bg: s.backgroundColor };
  };
  const label = document.getElementById(lid);
  const group = label ? label.closest('div.flex.items-center') : null;
  const prev = group ? group.querySelector(ps) : null;
  const next = group ? group.querySelector(ns) : null;
  return {
    text: label ? label.textContent.trim().replace(/\s+/g, ' ') : null,
    rect: rect(label), st: c(label),
    prevRect: rect(prev), nextRect: rect(next),
    groupCx: group ? Math.round(group.getBoundingClientRect().x + group.getBoundingClientRect().width / 2) : null,
    chevrons: label ? label.querySelectorAll('svg').length : 0,
    haspopup: label ? label.getAttribute('aria-haspopup') : null,
    controls: label ? label.getAttribute('aria-controls') : null,
    aLabel: label ? label.getAttribute('aria-label') : null,
    expanded: label ? label.getAttribute('aria-expanded') : null,
    disabled: label ? label.disabled === true : null,
    classes: label ? label.className.split(/\s+/) : [],
    prevClasses: prev ? prev.className.split(/\s+/) : [],
    nextClasses: next ? next.className.split(/\s+/) : [],
  };
}, labelId, prevSel, nextSel);

/** ホバー時のリング（outline と影 spread）と上昇、ツールバー card 内の余白を測る */
const hoverRing = async (page, sel) => {
  await page.hover(sel);
  await sleep(400);
  const out = await page.evaluate((s) => {
    const btn = document.querySelector(s);
    if (!btn) return { missing: s };
    const cs = getComputedStyle(btn);
    const spreads = cs.boxShadow.split(/,(?![^(]*\))/).map((p) => p.trim()).filter((p) => p !== 'none')
      .map((p) => { const n = (p.match(/-?\d+(?:\.\d+)?px/g) || []).map((v) => parseFloat(v.replace('px', ''))); return n[3] || 0; });
    const spread = Math.max(0, ...spreads);
    const outlinePx = parseFloat(cs.outlineWidth) || 0;
    const offsetPx = parseFloat(cs.outlineOffset) || 0;
    const mt = cs.transform.match(/matrix\(([^)]*)\)/);
    const lift = mt ? -(parseFloat(mt[1].split(',')[5]) || 0) : 0;
    const card = btn.parentElement.closest('.p-3');
    const cr = card.getBoundingClientRect();
    const cc = getComputedStyle(card);
    const padBox = {
      top: cr.top + parseFloat(cc.borderTopWidth), right: cr.right - parseFloat(cc.borderRightWidth),
      bottom: cr.bottom - parseFloat(cc.borderBottomWidth), left: cr.left + parseFloat(cc.borderLeftWidth),
    };
    const b = btn.getBoundingClientRect();
    const ring = Math.max(spread, outlinePx + offsetPx);
    return {
      spread, outline: cs.outlineStyle + ' ' + cs.outlineWidth, ring, lift,
      shadow: cs.boxShadow.slice(0, 60),
      room: {
        top: Math.round(b.top - padBox.top - lift), right: Math.round(padBox.right - b.right),
        left: Math.round(b.left - padBox.left), bottom: Math.round(padBox.bottom - b.bottom + lift),
      },
    };
  }, sel);
  await page.mouse.move(2, 2);   // ホバーを外す（後続の計測に影響させない）
  await sleep(150);
  return out;
};

/** 年月選択メニューの寸法・位置・焦点月（ラベル直下中央、年 ‹ › + 12ヶ月 + 「本日へ」） */
const menuGeom = (page) => page.evaluate(() => {
  const label = document.getElementById('bulletin-month-menu-btn');
  const menu = document.getElementById('bulletin-month-menu');
  const r = (el) => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height),
      top: Math.round(b.top), bottom: Math.round(b.bottom), cx: Math.round(b.x + b.width / 2) };
  };
  const f = document.activeElement;
  return {
    labelRect: r(label), menuRect: r(menu),
    menuOpen: menu ? !menu.classList.contains('hidden') : false,
    menuMonths: menu ? menu.querySelectorAll('[data-menu-month]').length : 0,
    menuYearBtns: menu ? menu.querySelectorAll('[data-menu-year]').length : 0,
    menuToday: Boolean(menu && menu.querySelector('[data-menu-today]')),
    expanded: label ? label.getAttribute('aria-expanded') : null,
    labelFocused: document.activeElement === label,
    focusMonth: (f && f.closest && f.closest('#bulletin-month-menu') && f.getAttribute('data-menu-month'))
      ? Number(f.getAttribute('data-menu-month')) + 1 : null,
  };
});

/** 列表に焦点を戻してキーを押す（ミニカレンダー・未読表示のキー運用と同じ入口） */
const pressKey = async (p, key) => {
  await p.evaluate(() => {
    const r = document.querySelector('#bulletin-list-container [data-bulletin-toggle]');
    if (r) r.focus();
  });
  await p.keyboard.press(key);
  await sleep(320);
};

/** 検索ボックス右の未読ボタンを押す */
const clickUnread = (p) => p.evaluate(() => document.getElementById('bulletin-btn-unread').click());

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--window-size=1280,900'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log(`[page js error] ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') console.log(`[console error] ${m.text()}`); });
await page.setViewport({ width: 1280, height: 900 });

// 既読リセット（post_acknowledgements を全消し）：この検証は「未読 2 件」を作ってラベル数と
// サイドバーの数字の一致を測るので、直前のテスト（test-bulletin-unread-all-days.mjs）が既読を
// 消費した状態でも同じ期待値で通す（ログイン前に消す＝クライアントの既読読み込みはログイン後）。
await query('DELETE FROM post_acknowledgements');
const ackLeftQ = (await query('SELECT COUNT(*) AS c FROM post_acknowledgements')).rows[0].c;
log('db-reset', { ackLeft: Number(ackLeftQ) });
check('既読リセットで post_acknowledgements が 0 件（全掲示が未読に戻る）', Number(ackLeftQ) === 0, { ackLeft: Number(ackLeftQ) });

console.log('=== 1. ログイン（教員）と検証投稿（過去日・未来日）作成 ===');
const okLogin = await login(page);
check('教員でログインできる', okLogin);
await openBulletin(page);

const base = await snapshot(page);
const baseCount = Number(base.sideText);
check('未読ボタンが存在する（検索ボックスの右。ツールバーの「本日」ボタンは撤廃済み＝本日へは年月選択メニューの「本日へ」と T キー）',
  Boolean(base.btnRect) && base.todayBtnExists === false, { btnRect: base.btnRect, todayBtnExists: base.todayBtnExists });
check('ツールバーの「本日」ボタンは撤廃済み（本日へは年月選択メニューの「本日へ」と T キー）',
  base.todayBtnExists === false, { todayBtnExists: base.todayBtnExists });
check('ミニカレンダーの「今日」ボタンは撤廃済み', base.calTodayExists === false, { calTodayExists: base.calTodayExists });
check('見出しは「職員掲示板」ラベルのみ（見出し右の未読バッヂは撤廃済み。button と span を置かない）',
  base.h2Text === '職員掲示板' && base.titleBadgeExists === false && base.h2Span === false && base.h2Button === false,
  { h2Text: base.h2Text, titleBadgeExists: base.titleBadgeExists, h2Span: base.h2Span, h2Button: base.h2Button });
check('サイドバーに全日未読数が出ている（未読 0 でない。ボタンは hidden でない）',
  base.sideText !== null && base.sideText !== '0' && base.sideHidden === false && base.btnHidden === false,
  { sideText: base.sideText, sideHidden: base.sideHidden, btnHidden: base.btnHidden });

// 未読 2 件の検証投稿（過去日・未来日。未来日だけ検索しても全日未読一覧は出ない）
const today = todayJst();
const pastDay = shiftDate(today, -6);
const futureDay = shiftDate(today, 3);
const created = [];
for (const d of [pastDay, futureDay]) {
  const res = await apiFetch(page, 'POST', '/bulletins', {
    title: `全日未読位置検証 ${mmdd(d)}`,
    content: '全日の未読一覧が検索ボックス右の未読ボタンで出ることの検証投稿です。',
    target_date: d,
    visibility: 'all_staff',
  });
  if (res.status === 201) created.push(res.json.data?.id || res.json.bulletin?.id);
}
check('未読 2 件（過去日・未来日）を作成できる', created.length === 2, { created });

const s0 = await snapshot(page);
const countNow = Number(s0.sideText);
check('ラベル「未読 N」はサイドバーの数字と同一（作成で増える）。aria-label・title は検索説明文、押されていない',
  s0.btnText === `未読 ${countNow}` && countNow > baseCount &&
  s0.btnLabel === `全日の未読検索（未読 ${countNow} 件）` &&
  s0.btnTitle === '全日の未読を検索（クリックで全日の未読一覧を表示）' && s0.btnPressed === 'false',
  { btnText: s0.btnText, btnLabel: s0.btnLabel, btnTitle: s0.btnTitle, sideText: s0.sideText, baseCount, btnPressed: s0.btnPressed });

console.log('ツールバー 検索ボックス =', JSON.stringify(s0.inputRect), '未読ボタン =', JSON.stringify(s0.btnRect),
  '日付グループ =', JSON.stringify(s0.dayGroupRect), '行 =', JSON.stringify(s0.rowRect));
check('未読ボタンは `<button type="button">`（押せる・hidden でない）',
  s0.btnTag === 'BUTTON' && s0.btnType === 'button' && s0.btnHidden === false && s0.btnPressed === 'false',
  { btnTag: s0.btnTag, btnType: s0.btnType, btnHidden: s0.btnHidden });
check('未読ボタンはツールバーの検索ボックスの真右（同じ行・同じ行の高さ、同じフォント、右隙間 0〜40px、縦中心は同じ、日付グループより左）',
  s0.btnRect && s0.inputRect && s0.dayGroupRect &&
  s0.inputRect.y === s0.btnRect.y && s0.inputRect.h === s0.btnRect.h &&
  s0.btnRect.x >= s0.inputRect.right && (s0.btnRect.x - s0.inputRect.right) <= 40 &&
  s0.btnRect.cy === s0.inputRect.cy && s0.btnRect.cx < s0.dayGroupRect.cx,
  { input: s0.inputRect, btn: s0.btnRect, dayGroup: s0.dayGroupRect });
check('未読ボタンは検索ボックスと同一設計（高さ・角丸・フォント・枠 2px 実線 1枚・border-main の同一色・ラベル 700・通常時は影なし）',
  s0.btnRect.h === s0.inputRect.h && s0.btnStyle.radius === s0.inputStyle.radius &&
  s0.btnStyle.fs === s0.inputStyle.fs &&
  s0.btnStyle.bw[0] === '2px' && s0.btnStyle.bw[1] === '2px' && s0.btnStyle.bw[2] === '2px' && s0.btnStyle.bw[3] === '2px' &&
  s0.btnStyle.bs === 'solid' && s0.inputStyle.bs === 'solid' &&
  s0.btnStyle.bc === s0.inputStyle.bc && s0.btnStyle.cls.split(/\s+/).includes('border-main') &&
  s0.btnStyle.fw === '700' && s0.btnStyle.shadow === 'none',
  { btn: { bw: s0.btnStyle.bw, bs: s0.btnStyle.bs, bc: s0.btnStyle.bc, radius: s0.btnStyle.radius, fs: s0.btnStyle.fs, fw: s0.btnStyle.fw, shadow: s0.btnStyle.shadow },
    input: { bw: s0.inputStyle.bw, bs: s0.inputStyle.bs, bc: s0.inputStyle.bc, radius: s0.inputStyle.radius, fs: s0.inputStyle.fs } });

const ring = await hoverRing(page, '#bulletin-btn-unread');
console.log('未読ボタンホバー =', JSON.stringify(ring));
check('未読ボタンホバーでリング（outline 3px + offset 2px = 5px の輪）と 3px の浮きがあり、ツールバー内でリングが見切れない（余白はリング幅以上）。影は出さない',
  ring.ring >= 3 && ring.outline === 'solid 3px' && ring.lift >= 2 && ring.shadow === 'none' &&
  ring.room.top >= ring.ring && ring.room.right >= ring.ring && ring.room.left >= ring.ring && ring.room.bottom >= ring.ring,
  ring);

// ===== 8. ミニカレンダーの年月部（‹ [年月] ›）はスケジュールのカレンダーと同じ形 =====
// 年月ラベルはミニカレンダーを開いたときに出る（検索語が無いので C キーが効く）
await pressKey(page, 'c');
const calOpen1 = await snapshot(page);
check('C キーでミニカレンダーが開く（年月ラベルと ‹ › が並び、ラベルは enabled）',
  calOpen1.calOpen === true && /^\d{4}年\d{1,2}月$/.test(String(calOpen1.monthLabel)) && calOpen1.labelDisabled === false,
  { calOpen: calOpen1.calOpen, monthLabel: calOpen1.monthLabel, labelDisabled: calOpen1.labelDisabled });

// スケジュールタブでも同じラベルを測る（寸法は表示中のタブでのみ出る）
const bl = await labelGeom(page, 'bulletin-month-menu-btn', '[data-cal-month="-1"]', '[data-cal-month="1"]');
await page.evaluate(() => { const a = document.querySelector('a[data-tab="schedule"]'); if (a) a.click(); });
await sleep(1100);
const sl = await labelGeom(page, 'sched-month-menu-btn', '#sched-prev-month', '#sched-next-month');
await openBulletin(page);
log('label-bulletin', bl);
log('label-schedule', sl);
check('年月ラベルはスケジュールの年月ラベルと同一設計（sched-month-label-btn・border-main・枠 2px 実線 1枚・角丸・背景・色は同じ、下向き chevron 1個、aria-haspopup=dialog）',
  bl.classes.includes('sched-month-label-btn') && bl.classes.includes('border-main') &&
  sl.classes.includes('sched-month-label-btn') && sl.classes.includes('border-main') &&
  bl.st.bw === '2px' && sl.st.bw === '2px' && bl.st.bs === 'solid' && sl.st.bs === 'solid' &&
  bl.st.bc === sl.st.bc && bl.st.radius === sl.st.radius && bl.st.bg === sl.st.bg &&
  bl.chevrons === 1 && sl.chevrons === 1 && bl.haspopup === 'dialog' && sl.haspopup === 'dialog',
  { bulletin: bl.st, schedule: sl.st, blCls: bl.classes, slCls: sl.classes, blChevrons: bl.chevrons, slChevrons: sl.chevrons });
check('‹ › は同一寸法ボタンでラベルを挟み、ラベルはグループの中央（ラベル高さは ‹ › 以下）',
  bl.prevRect && bl.nextRect && bl.prevRect.w === bl.nextRect.w && bl.prevRect.h === bl.nextRect.h &&
  Math.abs(bl.rect.cx - bl.groupCx) <= 3 && bl.rect.h <= bl.prevRect.h,
  { prev: bl.prevRect, label: bl.rect, next: bl.nextRect, groupCx: bl.groupCx });

// ===== 9. ラベルクリックで年月選択メニューがラベル直下中央に開く（中心日は動かさない） =====
const year = today.slice(0, 4);
const g1 = await menuGeom(page);
check('開く前はメニューが閉じて aria-expanded=false（ラベルは enabled）',
  g1.menuOpen === false && g1.expanded === 'false' && calOpen1.labelDisabled === false,
  { menuOpen: g1.menuOpen, expanded: g1.expanded, labelDisabled: calOpen1.labelDisabled });
await page.evaluate(() => document.getElementById('bulletin-month-menu-btn').click());
await sleep(320);
const g2 = await menuGeom(page);
const g2s = await snapshot(page);
log('menu-open', g2);
check('ラベルクリックで年月選択メニューがラベル直下中央に開く（年 ‹ › + 12ヶ月 + 「本日へ」、aria-expanded=true、焦点月は月ボタン、中心日は本日まま、列表は本日列表）',
  g2.menuOpen === true && g2.menuMonths === 12 && g2.menuYearBtns === 2 && g2.menuToday === true &&
  g2.expanded === 'true' && g2.labelRect && g2.menuRect && g2.menuRect.top > g2.labelRect.bottom &&
  Math.abs(g2.menuRect.cx - g2.labelRect.cx) <= 3 && g2.focusMonth !== null &&
  g2s.centerDate === today && String(g2s.readoutText).startsWith(mmdd(today)) && g2s.rows === s0.rows,
  { menuOpen: g2.menuOpen, menuMonths: g2.menuMonths, menuYearBtns: g2.menuYearBtns, menuToday: g2.menuToday,
    expanded: g2.expanded, labelRect: g2.labelRect, menuRect: g2.menuRect, focusMonth: g2.focusMonth,
    centerDate: g2s.centerDate, readoutText: g2s.readoutText, rows: g2s.rows });

// 矢印キーで月焦点が右へ 1 ヶ月動く
await page.keyboard.press('ArrowRight');
await sleep(220);
const g3 = await menuGeom(page);
check('メニューで → キーは月焦点が右へ 1 ヶ月動く（12ヶ月目は動かさない）',
  g3.focusMonth === (g2.focusMonth < 12 ? g2.focusMonth + 1 : g2.focusMonth),
  { focusMonth: g3.focusMonth, prevFocus: g2.focusMonth });

// Esc で閉じて焦点はラベルへ
await page.keyboard.press('Escape');
await sleep(260);
const g4 = await menuGeom(page);
check('Esc で年月選択メニューが閉じ、焦点は年月ラベルへ戻る',
  g4.menuOpen === false && g4.labelFocused === true, { menuOpen: g4.menuOpen, labelFocused: g4.labelFocused });

// 外クリックで閉じる
await page.evaluate(() => document.querySelector('#bulletin-list-container').click());
await sleep(260);
const g5 = await menuGeom(page);
check('メニュー外クリックで年月選択メニューは閉じる', g5.menuOpen === false, { menuOpen: g5.menuOpen });

// › ボタンで 1 ヶ月送り（中心日は動かさない）
await page.evaluate(() => document.querySelector('#bulletin-mini-cal [data-cal-month="1"]').click());
await sleep(320);
const g6 = await snapshot(page);
check('年月の › ボタンで 1 ヶ月送り（ラベルは翌月、中心日は本日まま）',
  g6.monthLabel === `${year}年12月` && g6.centerDate === today, { monthLabel: g6.monthLabel, centerDate: g6.centerDate });

// 「本日へ」で本日へ移動してメニューとカレンダーが閉じる（‹ › は enabled へ復帰）
await page.evaluate(() => document.getElementById('bulletin-month-menu-btn').click());
await sleep(260);
await page.evaluate(() => document.querySelector('#bulletin-month-menu [data-menu-today]').click());
await sleep(420);
const g7 = await snapshot(page);
check('年月選択メニューの「本日へ」で本日へ移動しメニューとカレンダーが閉じる（readout は本日の日付、‹ › は enabled）',
  g7.calOpen === false && g7.centerDate === today && String(g7.readoutText).startsWith(mmdd(today)) &&
  g7.navDisabled.every((d) => d === false),
  { calOpen: g7.calOpen, centerDate: g7.centerDate, readoutText: g7.readoutText, navDisabled: g7.navDisabled });

// ===== 10. 未読ボタンクリックで全日の未読一覧（中心日表示「未読」・控件は止まる・検索語は空） =====
const expectUnreadRows = baseCount + 2;
await clickUnread(page);
const u1 = await snapshot(page);
log('unread-mode', { rows: u1.rows, expect: expectUnreadRows, readoutText: u1.readoutText, centerDate: u1.centerDate,
  seps: u1.seps, rowDays: u1.rowDays, navDisabled: u1.navDisabled, labelDisabled: u1.labelDisabled,
  searchValue: u1.searchValue, btnPressed: u1.btnPressed, unreadMode: u1.state && u1.state.unreadMode });
const c10 = {
  rowsEq: u1.rows === expectUnreadRows,
  rowsGe: u1.rows >= baseCount + 2,
  stateMode: Boolean(u1.state && u1.state.unreadMode === true),
  pastIn: u1.rowTitles.some((t) => String(t).includes(`全日未読位置検証 ${mmdd(pastDay)}`)),
  futureIn: u1.rowTitles.some((t) => String(t).includes(`全日未読位置検証 ${mmdd(futureDay)}`)),
  seps: u1.seps.length >= 2, pressed: u1.btnPressed === 'true', searchEmpty: u1.searchValue === '',
  sideEq: u1.sideText === String(Number(u1.btnText.replace('未読 ', ''))),
};
log('check10-parts', c10);
check('未読ボタンクリックで全日の未読一覧（作成した過去日・未来日の 2 件が中心日表示「未読」の列表に出る。件数とラベル・サイドバーは同一、対象日見出し付き、検索語は空）',
  u1.rows === expectUnreadRows && u1.rows >= baseCount + 2 &&
  u1.state && u1.state.unreadMode === true &&
  u1.rowTitles.some((t) => String(t).includes(`全日未読位置検証 ${mmdd(pastDay)}`)) &&
  u1.rowTitles.some((t) => String(t).includes(`全日未読位置検証 ${mmdd(futureDay)}`)) && u1.seps.length >= 2 &&
  u1.btnPressed === 'true' && u1.searchValue === '' && u1.sideText === String(Number(u1.btnText.replace('未読 ', ''))),
  { rows: u1.rows, expect: expectUnreadRows, baseCount, readoutText: u1.readoutText, rowIds: u1.rowIds, rowDays: u1.rowDays,
    rowTitles: u1.rowTitles, pastTitle: `全日未読位置検証 ${mmdd(pastDay)}`, futureTitle: `全日未読位置検証 ${mmdd(futureDay)}`,
    unreadMode: u1.state && u1.state.unreadMode,
    seps: u1.seps, btnPressed: u1.btnPressed, searchValue: u1.searchValue, sideText: u1.sideText, btnText: u1.btnText });
check('未読表示中は ‹ ›・中心日クリック・年月選択ラベルが止まる（全部 disabled）',
  u1.navDisabled.every((d) => d === true) && u1.labelDisabled === true,
  { navDisabled: u1.navDisabled, labelDisabled: u1.labelDisabled });
await pressKey(page, 'c');
const u2 = await snapshot(page);
check('未読表示中は C キーでも中心日が動かない（カレンダーは閉じたままラベル disabled、開くなら日付セルは全セル disabled）',
  (u2.calOpen === false && u2.labelDisabled === true) ||
  (u2.calOpen === true && u2.calDayCells > 0 && u2.calDisabledDays === u2.calDayCells && u2.labelDisabled === true),
  { calOpen: u2.calOpen, calDayCells: u2.calDayCells, calDisabledDays: u2.calDisabledDays, labelDisabled: u2.labelDisabled, centerDate: u2.centerDate });

// ===== 11. 全日表示中は未読ボタンが disabled（押せない）。T キーで未読表示を閉じて本日へ戻る =====
const d0 = await snapshot(page);   // 押す直前の全日の未読列表（この後の比較の基準）
await clickUnread(page);
const d1 = await snapshot(page);
check('全日表示中は未読ボタンが disabled で押せない（中心日読み上げは「未読」、列表・中心日・控件はそのまま、aria-pressed=true）',
  d1.readoutText === '未読' && d1.rows === d0.rows && d1.centerDate === d0.centerDate &&
  d1.btnDisabled === true && d1.btnPressed === 'true' &&
  d1.navDisabled.every((d) => d === true) && d1.labelDisabled === true &&
  d1.state && d1.state.unreadMode === true,
  { readoutText: d1.readoutText, rows: d1.rows, rowsBefore: d0.rows, centerDate: d1.centerDate,
    btnDisabled: d1.btnDisabled, btnPressed: d1.btnPressed,
    navDisabled: d1.navDisabled, labelDisabled: d1.labelDisabled, state: d1.state });
await pressKey(page, 't');
const d3 = await snapshot(page);
check('T キーは未読表示を閉じて本日へ戻る（readout は本日の日付、中心日は本日、控件 enabled、aria-pressed=false）',
  String(d3.readoutText).startsWith(mmdd(today)) && d3.centerDate === today && d3.rows === s0.rows &&
  d3.navDisabled.every((d) => d === false) && d3.btnPressed === 'false' &&
  d3.state && d3.state.unreadMode === false,
  { readoutText: d3.readoutText, centerDate: d3.centerDate, rows: d3.rows,
    navDisabled: d3.navDisabled, btnPressed: d3.btnPressed });

// ===== 12. 後片付け（DELETE → 未読数 2 減・ラベル・サイドバー・ボタン hidden 追従） =====
const delA = await apiFetch(page, 'DELETE', `/bulletins/${created[0]}`, null);
const delB = await apiFetch(page, 'DELETE', `/bulletins/${created[1]}`, null);
const z = await snapshot(page);
log('cleanup', { delA: delA.status, delB: delB.status, sideText: z.sideText, btnText: z.btnText, btnHidden: z.btnHidden, rows: z.rows });
check('検証投稿を DELETE で掃除できる（未読数は減る。ラベル「未読 N」とサイドバーの数字は同じまま、ボタンは hidden でない、列表は本日列表へ戻る）',
  delA.status === 200 && delB.status === 200 && z.sideText === String(Number(z.btnText.replace('未読 ', ''))) &&
  Number(z.sideText) < Number(u1.sideText) && Number(z.sideText) >= baseCount &&
  z.sideHidden === false && z.btnHidden === false && z.rows === base.rows,
  { delA: delA.status, delB: delB.status, sideText: z.sideText, btnText: z.btnText, sideHidden: z.sideHidden,
    btnHidden: z.btnHidden, rows: z.rows, baseRows: base.rows, countBefore: u1.sideText, baseCount });

await browser.close();
await pool.end();

console.log('\n===== 全検証結果 =====');
console.log(`合計 ${total} 項目、成功 ${total - failures.length}、失敗 ${failures.length}`);
if (failures.length) {
  failures.forEach((name) => console.log('FAIL', name));
  console.log('FAILURES');
  process.exit(1);
}
console.log('ALL PASS');
process.exit(0);



