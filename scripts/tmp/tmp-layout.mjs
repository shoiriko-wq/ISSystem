import { fileURLToPath } from "node:url";
import path from "node:path";
import puppeteer from "puppeteer-core";

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

const ALL = ["titleBar", "h2", "toggle", "addBtn", "adminBtn", "panel", "chipsHolder", "chipRow", "chip1", "chip2",
  "tabs", "tabCal", "tabList", "viewArea", "navRow", "navInner", "prev", "monthLabel", "next", "menu", "frame"];

async function audit(label, keys = ALL) {
  const data = await page.evaluate((keys) => {
    const q = (s) => document.querySelector(s);
    const box = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const c = getComputedStyle(el);
      return { x: Math.round(r.x * 2), y: Math.round(r.y * 2), w: Math.round(r.width * 2), h: Math.round(r.height * 2), disp: c.display, vis: c.visibility, pad: c.padding, gap: c.gap, text: el.textContent.replace(/\s+/g, " ").trim().slice(0, 24) };
    };
    const sels = {
      titleBar: "#sched-title-bar",
      h2: "#sched-title-bar h2",
      toggle: "#sched-cat-toggle",
      addBtn: "#sched-add-btn",
      adminBtn: "#sched-cat-admin-btn",
      panel: "#sched-cat-panel",
      chipsHolder: "#sched-filter-chips",
      chipRow: "#sched-filter-chips > div:last-child",
      chip1: "#sched-filter-chips button",
      chip2: "#sched-filter-chips button:nth-of-type(2)",
      tabs: "#sched-mode-tabs",
      tabCal: "#sched-mode-calendar",
      tabList: "#sched-mode-list",
      viewArea: "#sched-view-area",
      navRow: "#sched-view-area > div:first-child",
      navInner: "#sched-view-area > div:first-child > div:first-child",
      prev: "#sched-prev-month",
      monthLabel: "#sched-month-label",
      next: "#sched-next-month",
      menu: "#sched-month-menu",
      frame: "#sched-calendar-frame",
    };
    const out = {};
    for (const k of keys) out[k] = box(q(sels[k]));
    return out;
  }, keys);
  console.log("===== STATE=" + label);
  for (const k of keys) console.log(k.padEnd(12), JSON.stringify(data[k]));
}

await audit("calendar+panel-open");
await page.evaluate(() => document.querySelector("#sched-cat-toggle").click());
await sleep(500);
await audit("calendar+panel-closed");
await page.evaluate(() => document.querySelector("#sched-mode-list").click());
await sleep(700);
await audit("list", ["tabs", "tabCal", "tabList", "navInner", "viewArea", "titleBar", "toggle"]);
await page.evaluate(() => document.querySelector("#sched-mode-calendar").click());
await sleep(700);
await page.evaluate(() => document.querySelector("#sched-month-menu-btn").click());
await sleep(400);
const menuInfo = await page.evaluate(() => {
  const b = (s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x * 2), y: Math.round(r.y * 2), w: Math.round(r.width * 2), h: Math.round(r.height * 2), t: el.textContent.replace(/\s+/g, " ").trim().slice(0, 10) };
  };
  return {
    menu: b("#sched-month-menu"),
    yearLabel: b("#sched-month-menu .min-w-\\[3\\.2rem\\]"),
    item1: b("#sched-month-menu .sched-month-item"),
    item2: b("#sched-month-menu .sched-month-item:nth-of-type(2)"),
    today: b("#sched-month-menu [data-menu-today]"),
    yearBtn: b('#sched-month-menu [data-menu-year="-1"]'),
  };
});
console.log("MENU_OPEN " + JSON.stringify(menuInfo));
await browser.close();
