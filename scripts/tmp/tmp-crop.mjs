// スケジュールUIのクロースアップ撮影（deviceScaleFactor=2）：タイトルバー・パネル・タブ＋年月ナビ
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "output");
const base = process.env.UI_BASE || "https://127.0.0.1:3443";
const user = process.env.UI_USER || "T2026001";
const pass = process.env.UI_PASS || "password123";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 2 });
await page.goto(`${base}/`, { waitUntil: "networkidle2" });
await page.type("#login-userid", user);
await page.type("#login-password", pass);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector("#app-container:not(.hidden)", { timeout: 10000 });
await sleep(1200);
await page.evaluate(() => {
  localStorage.setItem("isschedule_view_mode", "calendar");
  document.querySelector('a[data-tab="schedule"]').click();
});
await sleep(1600);

const shoot = async (sel, name) => {
  const el = await page.$(sel);
  if (!el) { console.log("missing", sel); return; }
  await el.screenshot({ path: path.join(OUT, `crop-${name}.png`) });
  console.log("shot", name);
};

// 1. タイトルバー（パネル閉状態）
await shoot("#sched-title-bar", "sched-titlebar-closed");
// 2. パネルを開いた状態：タイトルバー＋パネル
await page.evaluate(() => document.querySelector("#sched-cat-toggle").click());
await sleep(600);
await shoot("#sched-title-bar", "sched-titlebar-open");
await shoot("#sched-cat-panel", "sched-panel");
// 3. タブ＋年月ナビ（カレンダーモード）
await shoot("#sched-calendar-frame", "sched-frame-calendar");
// 4. 1日一覧モードのタブ＋ナビ＋先頭行
await page.evaluate(() => document.querySelector("#sched-mode-list").click());
await sleep(800);
const frame = await page.$("#sched-calendar-frame");
const clip = await frame.boundingBox();
await page.screenshot({ path: path.join(OUT, "crop-sched-frame-list.png"), clip: { x: clip.x, y: clip.y, width: clip.width, height: Math.min(clip.height, 460) } });
console.log("shot frame-list");
// タブボタン2つ・トグル・年月ナビの min-width / 実幅 / flex / box-sizing を確認する
const info = await page.evaluate(() => {
  const pick = (el) => {
    const c = getComputedStyle(el);
    return {
      sel: el.id, text: el.textContent.replace(/\s+/g, " ").trim().slice(0, 12),
      width: Math.round(el.getBoundingClientRect().width * 2) / 2,
      minWidth: c.minWidth, widthCSS: c.width, flex: c.flex, boxSizing: c.boxSizing,
      fontSize: c.fontSize, paddingLeft: c.paddingLeft, paddingRight: c.paddingRight,
    };
  };
  const out = [
    pick(document.getElementById("sched-mode-calendar")),
    pick(document.getElementById("sched-mode-list")),
    pick(document.getElementById("sched-cat-toggle")),
    pick(document.getElementById("sched-month-menu-btn")),
  ];
  const rules = [];
  for (const sheet of document.styleSheets) {
    let rs;
    try { rs = sheet.cssRules; } catch { continue; }
    for (const r of rs) {
      if (r.selectorText && r.selectorText.includes("sched-mode-btn") && r.style && r.style.minWidth) {
        rules.push(r.selectorText + " -> min-width: " + r.style.minWidth);
      }
    }
  }
  return [out, rules];
});
for (const s of info[0]) console.log(JSON.stringify(s));
console.log("RULES: " + info[1].join(" | "));
await browser.close();
const styles = await page.evaluate(() => {
  const keys = ["color", "background-color", "border-top-color", "border-top-width", "border-left-width",
    "box-shadow", "font-size", "font-weight", "text-align", "padding", "line-height", "letter-spacing",
    "opacity", "visibility", "display", "flex", "height", "border-radius", "outline-color"];
  const dump = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return { sel, missing: true };
    const c = getComputedStyle(el);
    const o = { sel, text: el.textContent.replace(/\s+/g, " ").trim().slice(0, 18) };
    for (const k of keys) o[k] = c.getPropertyValue(k);
    return o;
  };
  return [
    dump("#sched-calendar-frame > div:first-child"),
    dump("#sched-mode-calendar"),
    dump("#sched-mode-list"),
    dump("#sched-cat-toggle"),
    dump("#sched-add-btn"),
    dump("#sched-cat-admin-btn"),
    dump("#sched-select-all"),
    dump("#sched-filter-chips button"),
    dump("#sched-filter-chips button:nth-of-type(2)"),
    dump("#sched-prev-month"),
    dump("#sched-month-menu-btn"),
    dump("#sched-next-month"),
  ];
});
for (const s of styles) console.log(JSON.stringify(s));
await browser.close();

const probe = async () => {
  await page.evaluate(() => {
    const bar = document.querySelector("#sched-title-bar");
    bar.insertAdjacentHTML("afterbegin",
      '<h2 style="color:rgb(255,0,0)">TESTA</h2>' +
      '<span style="color:rgb(0,0,255)">TESTB</span>' +
      '<span class="text-main" style="color:rgb(0,128,0)">TESTC</span>' +
      '<span style="color:rgb(0,0,0);font-weight:700">TESTD</span>');
  });
  await sleep(400);
  const el = await page.$("#sched-title-bar");
  await el.screenshot({ path: path.join(OUT, "crop-sched-probe.png") });
  const b64 = fs.readFileSync(path.join(OUT, "crop-sched-probe.png")).toString("base64");
  const p2 = await browser.newPage();
  await p2.setContent("<body style='margin:0'></body>");
  const res = await p2.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = "data:image/png;base64," + b64; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const count = (test) => { let n = 0; for (let i = 0; i < d.length; i += 4) if (test(d[i], d[i + 1], d[i + 2])) n++; return n; };
    return {
      w: img.width, h: img.height,
      red: count((r, g, b2) => r > 200 && g < 60 && b2 < 60),
      blue: count((r, g, b2) => b2 > 200 && r < 60 && g < 60),
      green: count((r, g, b2) => g > 100 && g < 180 && r < 60 && b2 < 60),
      black: count((r, g, b2) => r < 40 && g < 40 && b2 < 40),
    };
  }, b64);
  await p2.close();
  console.log("PROBE", JSON.stringify(res));
};
await probe();
await browser.close();

