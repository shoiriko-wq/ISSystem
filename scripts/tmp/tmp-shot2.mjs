// 目視確認用スクリーンショット（カテゴリパネル開 / 閉 / 1日一覧モード）
import puppeteer from "puppeteer-core";

const exe = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const base = process.env.UI_BASE || "https://127.0.0.1:3443";
const user = process.env.UI_USER || "T2026001";
const pass = process.env.UI_PASS || "password123";

const browser = await puppeteer.launch({
  executablePath: exe,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });
await page.goto(`${base}/`, { waitUntil: "networkidle2" });
await page.type("#login-userid", user);
await page.type("#login-password", pass);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector("#app-container:not(.hidden)", { timeout: 10000 });
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => {
  localStorage.setItem("isschedule_view_mode", "calendar");
  document.querySelector('a[data-tab="schedule"]').click();
});
const clip = { x: 0, y: 0, width: 1280, height: 700 };
const zoom = { x: 60, y: 80, width: 620, height: 120 };
await new Promise((r) => setTimeout(r, 1800));

const sel = [
  ".app-sidebar",
  "#app-body",
  "#view-schedule",
  "#sched-title-bar",
  "#sched-title-label",
  "#sched-cat-toggle",
  "#sched-cat-status",
  "#sched-cat-panel",
  "#sched-summary",
  "#sched-cat-chip-row",
  "#sched-select-all",
  "#sched-calendar-frame",
  "#sched-mode-calendar",
  "#sched-mode-list",
  "#sched-month-label",
];
const measure = (label) =>
  page.evaluate((s, l) => ({
    label: l,
    boxes: s.map((k) => {
      const el = document.querySelector(k);
      if (!el) return { k, missing: true };
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      return {
        k, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        hidden: el.hidden, vis: cs.visibility, text: el.textContent.trim().slice(0, 22),
      };
    }),
  }), sel, label);

// 1) パネルを開いた状態
await page.evaluate(() => document.querySelector("#sched-cat-toggle").click());
await new Promise((r) => setTimeout(r, 600));
console.log("OPEN", JSON.stringify(await measure("open"), null, 1));
await page.screenshot({ path: "scripts/output/tmp-sched-open.png", clip });

// 2) パネルを閉じた状態（タイトルバーの拡大クリップも撮る）
await page.evaluate(() => document.querySelector("#sched-cat-toggle").click());
await new Promise((r) => setTimeout(r, 600));
console.log("CLOSED", JSON.stringify(await measure("closed"), null, 1));
await page.screenshot({ path: "scripts/output/tmp-sched-closed.png", clip });
await page.screenshot({ path: "scripts/output/tmp-sched-title.png", clip: zoom });

// 3) 1日一覧タブへ keyboard（Enter）で切替 → フォーカスが活性タブに残るか
await page.evaluate(() => document.querySelector("#sched-mode-list").focus());
await page.keyboard.press("Enter");
await new Promise((r) => setTimeout(r, 500));
console.log("DAY", JSON.stringify(await page.evaluate(() => ({
  focusTag: document.activeElement.tagName,
  focusId: document.activeElement.id,
  selected: document.querySelector('[aria-selected="true"]')?.id,
  panelOpen: !document.querySelector("#sched-cat-panel").hidden,
}))));
await page.screenshot({ path: "scripts/output/tmp-sched-day.png", clip });

await browser.close();