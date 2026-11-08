/**
 * サイドメニュー収納の回帰テスト（実ブラウザ検証）
 *
 * ルール（`layouts.css` §6 と `main.js`）:
 *  R1. 768px以上は画面幅を問わず**常時収納**（幅 67.125px = 正方形タイル 2.25rem +
 *      sidebar/nav の左右余白、ラベル/版数/バッヂは非表示）。
 *  R2. ホバリングでせり出し（14.25rem = 249.375px）、ラベルが表示される。
 *  R3. カーソル離脱・サイドバー外クリックで収納へ戻る（クリック後のフォーカス保持も閉じる）。
 *  R4. 収納状態でも項目クリックでタブが切り替わる（main は収納幅分の左余白 4.2rem）。
 *  R5. 収納状態で水平スクロール（見切れ）が発生しない。
 *  R6. トースト（画面右下）が収納サイドバーのせり出しを覆わない（覆すと実クリックが
 *      トーストに当たり、アイコンの初回クリックが吸収される）。
 *  R7. せり出し時は未読バッヂが枠の右側（枠右端から 20px 以内）へ縦に揃う
 *      （ラベル長で列がずれず、ラベル・バッヂとも枠内で見切れない）。
 *      収納時はバッヂ非表示。
 *  R8. 未読 0（hidden クラス）のバッヂはせり出し時も表示しない。
 *  R9. 100 件超キャップの「99+」バッヂ（main.js が 100 以上を 99+ に丸める）でも
 *      メニュー名が省略（…）されない。3桁数字（999）を出すことはない。
 *  R10. 収納時とせり出し時で位置が揃う — 行の左端・高さ・上端は同一、アイコン中心も
 *      同一（±1.5px）。アニメーションは sidebar 幅（とラベル幅）のみが変化し、
 *      上下方向の移動は発生しない（真横スライドのみ）。
 *  R11. ホバリングのリング（outline var(--ring-width)+outline-offset）と行ホバーの
 *      スライド（translateX(3px)）が sidebar / nav の overflow クリップ境界（枠線を
 *      引いた位置）で切られない。
 *  R12. マウスを行に乗せた（行ホバー＝スライド+リング）状態でもラベルの省略（…）が
 *      出ない（ラベルの箱が文字幅より 2px 以上広い）。
 *  M1-M3. 767px 以下は画面下バー（アイコンのみ）で、クリックでタブが切り替わり、
 *      トーストは画面下バーを覆わない（バー分だけ下余白を上げる）。
 *
 * 実行: npm run test:ui:sidebar  （ISSystem サーバーが必要）
 * options: UI_BASE=https://127.0.0.1:3443 UI_USER=T2026001 UI_PASS=password123
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'scripts', 'output');
const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
// 横幅が広い画面・768px以上の中幅・収納下限の順
const VIEWPORTS = [1440, 1280, 1024, 768];

function findChrome() {
  const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium'].filter(Boolean);
  for (const p of candidates) if (fs.existsSync(p)) return p;
  throw new Error('Chrome/Chromium が見つかりません。CHROME_PATH を指定してください。');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const failures = [];
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(name);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} - ${name}${detail ? ` -> ${detail}` : ''}`);
};

// サイドバー実測幅・ラベル/版数の表示状態・main の左余白・水平見切れ量
// rows: 収納時とせり出し時の各行（左端・上端・高さ・アイコン中心・バッヂ右端・ラベル切れ）
const probe = (page) => page.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  const version = document.querySelector('.sidebar-version');
  const mainEl = document.querySelector('main');
  const toastEl = document.getElementById('toast-container');
  const overlapToast = (() => {
    if (!toastEl) return null;
    const a = toastEl.getBoundingClientRect(), b = sb.getBoundingClientRect();
    return !(a.right <= b.left + 1 || a.left >= b.right - 1 || a.bottom <= b.top + 1 || a.top >= b.bottom - 1);
  })();
  const cs = getComputedStyle(sb);
  const navEl = sb.querySelector('nav');
  const ncs = getComputedStyle(navEl);
  const sbR = sb.getBoundingClientRect();
  // 行の右端にホバーリングのリング（outline var(--ring-width) 3 + outline-offset 2 = 5px）を足した位置
  // （hover の translateX(3px) は getBoundingClientRect に反映済みなので足さない）
  const RING = 3 + 2;
  const rows = [...sb.querySelectorAll('.nav-item:not(.hidden)')].map((el) => {
    const r = el.getBoundingClientRect();
    const svg = el.querySelector('svg, i');
    const sr = svg.getBoundingClientRect();
    const lab = el.querySelector('.nav-label');
    const badge = el.querySelector('.nav-badge');
    return {
      tab: el.dataset.tab,
      left: Math.round(r.left * 10) / 10,
      right: Math.round(r.right * 10) / 10,
      top: Math.round(r.top * 10) / 10,
      h: Math.round(r.height * 10) / 10,
      iconCenter: Math.round((sr.left + sr.width / 2) * 10) / 10,
      ringRight: Math.round((r.right + RING) * 10) / 10,
      ringLeft: Math.round((r.left - RING) * 10) / 10,
      labelShown: getComputedStyle(lab).display !== 'none' && lab.clientWidth > 1,
      labelTruncated: lab.scrollWidth > lab.clientWidth + 1,
      // 省略記号（…）はテキスト幅がラベルの箱を超えた時に描画される（== も … が出る）。
      // テキスト幅は Range で実測する（scrollWidth は箱と等価なので箱との差が0になる）。
      labelRoom: (() => {
        const rng = document.createRange();
        rng.selectNodeContents(lab);
        return Math.round((lab.getBoundingClientRect().width - rng.getBoundingClientRect().width) * 10) / 10;
      })(),
      labelRight: Math.round(lab.getBoundingClientRect().right * 10) / 10,
      badgeRight: badge && getComputedStyle(badge).display !== 'none'
        ? Math.round(badge.getBoundingClientRect().right * 10) / 10 : null,
    };
  });
  const labelShownRows = rows.filter((r) => r.labelShown);
  return {
    sidebar: Math.round(sbR.width),
    labelShown: labelShownRows.length > 0,
    versionShown: getComputedStyle(version).display !== 'none',
    mainPadLeft: parseFloat(getComputedStyle(mainEl).paddingLeft),
    overflow: document.documentElement.scrollWidth - innerWidth,
    hover: sb.classList.contains('is-hover'),
    focus: sb.classList.contains('is-focus'),
    toastItems: toastEl ? toastEl.children.length : 0,
    overlapToast,
    toastBottom: toastEl ? Math.round(innerHeight - toastEl.getBoundingClientRect().bottom) : null,
    toastLeft: toastEl ? Math.round(toastEl.getBoundingClientRect().left) : null,
    toastZ: toastEl ? parseInt(getComputedStyle(toastEl).zIndex, 10) : null,
    sidebarZ: parseInt(getComputedStyle(sb).zIndex, 10),
    // せり出し時の未読バッヂ：右端が枠の右側へ縦に揃い、枠内に収まるか
    badgeRights: rows.map((r) => r.badgeRight).filter((v) => v !== null),
    labelRights: labelShownRows.map((r) => r.labelRight),
    truncatedTabs: rows.filter((r) => r.labelShown && (r.labelTruncated || r.labelRoom < 2)).map((r) => `${r.tab}(room=${r.labelRoom})`),
    rows,
    boxRight: Math.round(sbR.right * 10) / 10,
    // overflow のクリップ境界（padding box の端 = 枠線を引いた位置）
    clipRight: Math.round((sbR.right - parseFloat(cs.borderRightWidth)) * 10) / 10,
    clipLeft: Math.round((sbR.left + parseFloat(cs.borderLeftWidth)) * 10) / 10,
    navClipRight: Math.round((navEl.getBoundingClientRect().right - parseFloat(ncs.borderRightWidth)) * 10) / 10,
    navClipLeft: Math.round((navEl.getBoundingClientRect().left + parseFloat(ncs.borderLeftWidth)) * 10) / 10,
    navOverflow: ncs.overflowX,
  };
});

// showToast() はグローバルでない（main.js が import して使う）ため、
// トーストの実 DOM（.toast）をコンテナへ入れてコンテナの位置/重なりを測る。
const spawnToast = (page) => page.evaluate(() => {
  const c = document.getElementById('toast-container');
  const d = document.createElement('div');
  d.className = 'toast border-accent text-accent-strong flex items-center justify-between gap-2';
  d.textContent = 'トースト位置検証（右下・収納サイドバーを覆わない）';
  c.appendChild(d);
  return c.children.length;
});

fs.mkdirSync(OUT_DIR, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: findChrome(), headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors']
});

for (const vw of VIEWPORTS) {
  const page = await browser.newPage();
  await page.setViewport({ width: vw, height: 900 });
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
  await page.type('#login-userid', USER);
  await page.type('#login-password', PASS);
  await page.evaluate(() => window.handleLoginClick());
  await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
  await sleep(1200);

  const tag = `vw=${vw}`;
  // バッジ描画・位置検証のため未読数を固定（100 件超のキャップ「99+」のバッヂでもメニュー名が隠れないかを検証）
  await page.evaluate(() => {
    for (const [id, n] of [['bulletin-unread-count', '99+'], ['chat-unread-count', '99+'], ['mail-unread-count', '99+']]) {
      const el = document.getElementById(id);
      if (el) { el.classList.remove('hidden'); el.textContent = n; }
    }
  });
  const rest = await probe(page);
  check(`${tag} R1: 初期は収納（幅 50-68px）`, rest.sidebar >= 50 && rest.sidebar <= 68, `sidebar=${rest.sidebar}px`);
  check(`${tag} R1: 収納中はラベル・版数が非表示`, !rest.labelShown && !rest.versionShown, `label=${rest.labelShown} version=${rest.versionShown}`);
  check(`${tag} R1: 収納中は未読バッヂも非表示（枠に収まらないため）`, rest.badgeRights.length === 0, `badgeRights=${JSON.stringify(rest.badgeRights)}`);

  // ホバリングでせり出し
  const sbBox = await (await page.$('.app-sidebar')).boundingBox();
  await page.mouse.move(sbBox.x + 10, sbBox.y + sbBox.height / 2);
  await spawnToast(page);
  await sleep(500);
  const hov = await probe(page);
  check(`${tag} R2: ホバリングでせり出し（190-290px）＋ラベル表示`, hov.sidebar >= 190 && hov.sidebar <= 290 && hov.labelShown, `sidebar=${hov.sidebar}px label=${hov.labelShown}`);

  // R9: 100 件超のキャップ「99+」バッヂでもメニュー名が省略（…）されない
  check(`${tag} R9: 99+（100 件超キャップ）バッヂでもメニュー名が隠れない（ラベル省略 … なし）`,
    hov.truncatedTabs.length === 0, `truncated=${JSON.stringify(hov.truncatedTabs)}`);

  // R10: 収納時とせり出し時の位置が揃う（行の左端・上端・高さ・アイコン中心が同一 = 真横スライドのみ）
  const alignedRows = rest.rows.length === hov.rows.length && rest.rows.every((r, i) => {
    const h = hov.rows[i];
    return r.tab === h.tab && Math.abs(r.left - h.left) <= 1 && Math.abs(r.top - h.top) <= 1
      && Math.abs(r.h - h.h) <= 1 && Math.abs(r.iconCenter - h.iconCenter) <= 1.5;
  });
  const posDetail = rest.rows.map((r, i) => `${r.tab} L${r.left}->${hov.rows[i].left} T${r.top}->${hov.rows[i].top} H${r.h}->${hov.rows[i].h} I${r.iconCenter}->${hov.rows[i].iconCenter}`).join(' | ');
  check(`${tag} R10: 収納時とせり出し時の位置が揃う（左端・行高・上端・アイコン中心が同一／アニメーションは真横スライドのみ）`,
    alignedRows, posDetail);

  // R11: ホバリングのリング（outline var(--ring-width) 3 + outline-offset 2）＋
  // 行ホバー時のスライド（translateX(3px)）がクリップ境界（nav / sidebar の
  // overflow 境界＝枠線を引いた位置）で切られない。
  const clipR = Math.min(hov.clipRight, hov.navClipRight);
  const clipL = Math.max(hov.clipLeft, hov.navClipLeft);
  const noClip = hov.rows.every((r) => r.ringRight + 3 <= clipR + 0.5 && r.ringLeft >= clipL - 0.5)
    && rest.rows.every((r) => r.ringRight + 3 <= Math.min(rest.clipRight, rest.navClipRight) + 0.5
      && r.ringLeft >= Math.max(rest.clipLeft, rest.navClipLeft) - 0.5);
  check(`${tag} R11: ホバリングリング＋スライドが見切れない（収納・せり出し両状態でリング右端+スライド3px がクリップ境界内に収まる）`,
    noClip, `clipRight=${clipR} clipLeft=${clipL} ringMax=${Math.max(...hov.rows.map((r) => r.ringRight)) + 3} ringMin=${Math.min(...hov.rows.map((r) => r.ringLeft))} rowMaxRight=${Math.max(...hov.rows.map((r) => r.right))} navOverflow=${hov.navOverflow}`);

  // R12: マウスを実際の行に乗せた（行ホバー＝translateX(3px)＋リング）状態でも
  // ラベルの省略（…）とリングの見切れが起こらないことを各行で確認する。
  const rowHoverIssues = [];
  for (let i = 0; i < hov.rows.length; i++) {
    const r = hov.rows[i];
    await page.mouse.move((r.left + r.right) / 2, r.top + r.h / 2);
    await sleep(160);
    const p = await probe(page);
    const rr = p.rows[i];
    const clipR2 = Math.min(p.clipRight, p.navClipRight);
    const rowHovered = rr.ringRight > r.ringRight + 2.5; // スライド(3px)が効いている行
    if (rr.labelRoom < 2 || rr.ringRight > clipR2 + 0.5 || !rowHovered) {
      rowHoverIssues.push(`${r.tab}(room=${rr.labelRoom},ringRight=${rr.ringRight},clip=${clipR2},slide=${rowHovered})`);
    }
  }
  check(`${tag} R12: 行ホバー（スライド+リング）でもラベル省略（…）なし・リング見切れなし`,
    rowHoverIssues.length === 0, JSON.stringify(rowHoverIssues));


  // R7: せり出し時は未読バッヂが枠の右側へ縦に揃う（ラベル長で列がずれない）。
  // ラベル・バッヂの右端が枠内（見切れなし）で、バッヂの右端同士が 1px 以内に揃い、
  // 列は枠の右側から 20px 以内（右端に寄っている）。
  const badgeAligned = hov.badgeRights.length >= 3
    && Math.max(...hov.badgeRights) - Math.min(...hov.badgeRights) <= 1
    && hov.badgeRights.every((r) => r <= hov.boxRight - 2)
    && hov.badgeRights.every((r) => r >= hov.boxRight - 20);
  const labelsInside = hov.labelRights.length >= 5 && hov.labelRights.every((r) => r <= hov.boxRight - 2);
  check(`${tag} R7: 未読バッヂは枠の右側（20px 以内）へ縦に揃い枠内に収まる（右端差 1px 以内・ラベルも見切れなし）`,
    badgeAligned && labelsInside,
    `badgeRights=${JSON.stringify(hov.badgeRights)} labelRights=${JSON.stringify(hov.labelRights)} boxRight=${hov.boxRight}`);

  // 未読 0 はせり出し時にも出さない（hidden を !important で display 強制しない）
  const zeroHidden = await page.evaluate(() => {
    const el = document.getElementById('chat-unread-count');
    el.classList.add('hidden');
    return getComputedStyle(el).display === 'none';
  });
  check(`${tag} R8: 未読 0 のバッヂはせり出し時も非表示（count 0 を display 強制しない）`, zeroHidden);

  // R6: トースト（画面右下）がせり出しサイドバーを覆わない。覆すと実クリックがトーストに当たる
  // （ログイン直後のトーストが左下に出ると、チャット左カラムのフッター等が押せなくなる）。
  check(`${tag} R6: トーストが収納サイドバー（せり出し含む）を覆わない（右下・トーストがサイドバーより上）`,
    hov.toastItems > 0 && hov.overlapToast === false && hov.toastLeft > hov.sidebar && hov.toastZ >= hov.sidebarZ,
    `toastItems=${hov.toastItems} overlap=${hov.overlapToast} toastLeft=${hov.toastLeft} sidebar=${hov.sidebar} toastZ=${hov.toastZ} sidebarZ=${hov.sidebarZ}`);

  // 離脱で収納へ戻る
  await page.mouse.move(vw - 30, 500);
  await sleep(500);
  const back = await probe(page);
  check(`${tag} R3: カーソル離脱で収納へ戻る（68px 以下）`, back.sidebar <= 68 && !back.hover && !back.focus, `sidebar=${back.sidebar}px hover=${back.hover}`);

  // 収納状態で項目をクリック → タブ切替＋フォーカスでせり出し
  await page.click('.app-sidebar [data-tab="seating"]');
  await sleep(450);
  const clicked = await probe(page);
  const tabOk = await page.evaluate(() => {
    const v = document.getElementById('view-seating');
    const nav = document.querySelector('.app-sidebar [data-tab="seating"]');
    return { viewActive: v.classList.contains('active'), navActive: nav.classList.contains('active') };
  });
  check(`${tag} R4: 収納状態のクリックでタブが切り替わる`, tabOk.viewActive && tabOk.navActive, JSON.stringify(tabOk));
  check(`${tag} R3: クリック（フォーカス）中はせり出しを保持`, clicked.sidebar >= 190 && clicked.labelShown, `sidebar=${clicked.sidebar}px focus=${clicked.focus}`);

  // main の左余白（収納幅分が常時確保されている）と水平見切れ
  check(`${tag} R4: main の左余白は収納幅以上（67px 以上）`, back.mainPadLeft >= 67, `paddingLeft=${back.mainPadLeft}px`);
  check(`${tag} R5: 水平スクロールが発生しない`, back.overflow <= 0, `overflow=${back.overflow}px`);

  const el = await page.$('.app-sidebar');
  await el.screenshot({ path: path.join(OUT_DIR, `sidebar-collapse-${vw}.png`) });
  await page.mouse.move(sbBox.x + 10, sbBox.y + sbBox.height / 2);
  await sleep(400);
  await (await page.$('.app-sidebar')).screenshot({ path: path.join(OUT_DIR, `sidebar-collapse-${vw}-hover.png`) });

  await page.close();
}

// ===== 767px 以下（画面下バー：アイコンのみ、トーストはバー分だけ上げる） =====
const mobilePage = await browser.newPage();
await mobilePage.setViewport({ width: 390, height: 800 });
await mobilePage.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await mobilePage.type('#login-userid', USER);
await mobilePage.type('#login-password', PASS);
await mobilePage.evaluate(() => window.handleLoginClick());
await mobilePage.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1200);

const mProbe = await probe(mobilePage);
await spawnToast(mobilePage);
await sleep(150);
const bar = await mobilePage.evaluate(() => {
  const sb = document.querySelector('.app-sidebar');
  const tc = document.getElementById('toast-container');
  const r = sb.getBoundingClientRect(), t = tc.getBoundingClientRect();
  return {
    barTop: Math.round(r.top), barH: Math.round(r.height), barW: Math.round(r.width),
    toastBottom: Math.round(t.bottom), toastItems: tc.children.length
  };
});
check('M1: 767px 以下は画面下バー（全幅・アイコンのみ、ラベル非表示）',
  bar.barW >= 388 && bar.barH >= 55 && bar.barH <= 80 && !mProbe.labelShown,
  `barW=${bar.barW} barH=${bar.barH} label=${mProbe.labelShown}`);
check('M3: トーストが画面下バーを覆わない（バー分だけ下余白を上げる）',
  bar.toastItems > 0 && bar.toastBottom <= bar.barTop,
  `toastItems=${bar.toastItems} toastBottom=${bar.toastBottom} barTop=${bar.barTop}`);

const iconBox = await (await mobilePage.$('.app-sidebar [data-tab="seating"]')).boundingBox();
await mobilePage.mouse.click(iconBox.x + iconBox.width / 2, iconBox.y + iconBox.height / 2);
await sleep(450);
const mTab = await mobilePage.evaluate(() => ({
  viewActive: document.getElementById('view-seating').classList.contains('active'),
  navActive: document.querySelector('.app-sidebar [data-tab="seating"]').classList.contains('active')
}));
check('M2: 画面下バーのアイコン実クリックでタブが切り替わる', mTab.viewActive && mTab.navActive, JSON.stringify(mTab));
await mobilePage.screenshot({ path: path.join(OUT_DIR, 'sidebar-collapse-390-bar.png') });
await mobilePage.close();

await browser.close();
if (failures.length) {
  console.log(`\n=== FAIL: ${failures.length} 件 ===\n${failures.map((f) => ` - ${f}`).join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`\n=== ALL PASSED: サイドメニュー収納（768px以上は幅を問わず常時収納） ===`);
}
