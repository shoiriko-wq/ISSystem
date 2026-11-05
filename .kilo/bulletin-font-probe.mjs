/**
 * 職員掲示板の文字サイズ検証: APIで投稿を1件作成し、カレンダーからその日を開いて
 * 見出し・本文・ラベル・ボタンなどの実測フォントサイズを分布で報告する。
 */
import puppeteer from "puppeteer";

const BASE = "http://localhost:3000";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 20000 });
await sleep(1500);
const token = await page.evaluate(() => localStorage.getItem("isystem_token"));
const jst = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString("sv-SE", { timeZone: "Asia/Tokyo" });

const date = jst(4);
const created = await fetch(`${BASE}/api/bulletins`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
  body: JSON.stringify({
    title: "FontProbeTitle",
    content: "フォントサイズの検証用本文です。改行を含む文章。\n2行目。",
    category: "NOTICE",
    publish_start_date: date,
    publish_end_date: date,
  }),
});
console.log("SEED_BULLETIN", created.status);

await page.evaluate(() => {
  const a = document.querySelector('a[data-tab="bulletin"]');
  if (a) a.click();
});
await sleep(1800);

const sizes = await page.evaluate((dstr) => {
  const input = document.getElementById("bulletin-day-date");
  if (input) {
    input.value = dstr;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
  return Boolean(input);
}, date);
await sleep(1600);

const dist = await page.evaluate(() => {
  const out = [];
  const seen = new Set();
  document.querySelectorAll("#view-bulletin *").forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return;
    const fs = parseFloat(getComputedStyle(el).fontSize);
    const cls = String(el.className || "").slice(0, 40);
    const key = el.tagName + " " + cls;
    if (seen.has(key)) return;
    seen.add(key);
    out.push([fs, key]);
  });
  const counts = {};
  for (const [fs] of out) {
    const k = Math.round(fs);
    counts[k] = (counts[k] || 0) + 1;
  }
  return {
    min: Math.min(...out.map((x) => x[0])),
    dist: Object.entries(counts).map(([k, v]) => `${k}px:${v}`),
    small: out.filter(([fs]) => fs < 14).slice(0, 12),
    title: getComputedStyle(document.querySelector(".pane-title") || document.body).fontSize,
    bodyText: getComputedStyle(document.querySelector(".pane-body-text") || document.body).fontSize,
  };
});
console.log("BULLETIN_SIZES", JSON.stringify(dist));

await browser.close();
