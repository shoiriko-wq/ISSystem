// 画面左側の灰色領域を覆っている要素を特定する（elementFromPoint）
import puppeteer from "puppeteer-core";

const exe = process.env.CHROME_PATH || "/usr/bin/google-chrome";
const base = process.env.UI_BASE || "https://127.0.0.1:3443";
const user = process.env.UI_USER || "T2026001";
const pass = process.env.UI_PASS || "password123";

const b = await puppeteer.launch({
  executablePath: exe,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--ignore-certificate-errors"],
});
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 860 });
await p.goto(base + "/", { waitUntil: "networkidle2" });
await p.type("#login-userid", user);
await p.type("#login-password", pass);
await p.evaluate(() => window.handleLoginClick());
await p.waitForSelector("#app-container:not(.hidden)", { timeout: 10000 });
await new Promise((r) => setTimeout(r, 1200));
await p.evaluate(() => document.querySelector('a[data-tab="schedule"]').click());
await new Promise((r) => setTimeout(r, 1600));

const pts = [[200, 300], [300, 200], [120, 120]];
const res = await p.evaluate((pts) => pts.map(([x, y]) => {
  const el = document.elementFromPoint(x, y);
  const cs = getComputedStyle(el);
  return {
    x, y, tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 70),
    z: cs.zIndex, pos: cs.position, w: Math.round(el.getBoundingClientRect().width),
    bg: cs.backgroundColor,
  };
}), pts);
console.log(JSON.stringify(res, null, 1));

// スクリーンショットのピクセルを Chromium で読んで描画状態を判定する
import fs from "node:fs";

async function sample(imgPath, points) {
  const b64 = fs.readFileSync(imgPath).toString("base64");
  const p2 = await b.newPage();
  await p2.setContent("<body style='margin:0'></body>");
  const res = await p2.evaluate(async (b64, points) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = "data:image/png;base64," + b64; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    return points.map(([x, y]) => {
      const d = ctx.getImageData(x, y, 1, 1).data;
      return { x, y, rgb: `rgb(${d[0]} ${d[1]} ${d[2]})` };
    });
  }, b64, points);
  await p2.close();
  return res;
}

// 領域内の暗い画素（文字・アイコンのストローク）を数える
const analyze = async (imgPath, region) => {
  const b64 = fs.readFileSync(imgPath).toString("base64");
  const p2 = await b.newPage();
  await p2.setContent("<body style='margin:0'></body>");
  const res = await p2.evaluate(async (b64, region) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = "data:image/png;base64," + b64; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const [x0, y0, x1, y1] = region;
    const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
    let dark = 0, mid = 0, total = 0;
    const hist = {};
    for (let i = 0; i < d.length; i += 4) {
      const lum = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      total++;
      if (lum < 110) dark++;
      else if (lum < 190) mid++;
      const key = `${Math.round(d[i] / 24) * 24},${Math.round(d[i + 1] / 24) * 24},${Math.round(d[i + 2] / 24) * 24}`;
      hist[key] = (hist[key] || 0) + 1;
    }
    const top = Object.entries(hist).sort((a, b2) => b2[1] - a[1]).slice(0, 6);
    return { total, dark, mid, top };
  }, b64, region);
  await p2.close();
  return res;
};

const titleImg = "scripts/output/tmp-sched-title.png";
// 列単位で「ボタン色（>=240）」と「アクセント色（青系）」の範囲を特定する
const columns = async (imgPath) => {
  const b64 = fs.readFileSync(imgPath).toString("base64");
  const p2 = await b.newPage();
  await p2.setContent("<body style='margin:0'></body>");
  const res = await p2.evaluate(async (b64) => {
    const img = new Image();
    await new Promise((r, j) => { img.onload = r; img.onerror = j; img.src = "data:image/png;base64," + b64; });
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, img.width, img.height).data;
    const runs = [];
    let cur = null;
    for (let x = 0; x < img.width; x++) {
      let white = 0, blue = 0, dark = 0;
      for (let y = 0; y < img.height; y++) {
        const i = (y * img.width + x) * 4;
        const r = d[i], g = d[i + 1], b2 = d[i + 2];
        if (r >= 240 && g >= 240 && b2 >= 240) white++;
        else if (b2 > 180 && r < 120) blue++;
        else if (r < 90 && g < 110 && b2 < 140) dark++;
      }
      const kind = blue > 4 ? "blue" : white > 4 ? "white" : dark > 1 ? "dark" : "bg";
      if (cur && cur.kind === kind) cur.x1 = x;
      else { cur = { kind, x0: x, x1: x }; runs.push(cur); }
    }
    return runs.filter((r) => r.kind !== "bg" && r.x1 - r.x0 > 6).map((r) => ({ kind: r.kind, x0: r.x0, x1: r.x1 }));
  }, b64);
  await p2.close();
  return res;
};

// H2 と lucide svg のペイント関連プロパティを列挙する
const paint = await p.evaluate(() => {
  const h2 = document.querySelector("#sched-title-bar h2");
  const svg = h2.querySelector("svg");
  const pick = (el) => {
    const c = getComputedStyle(el);
    const o = {};
    for (const k of ["color", "-webkit-text-fill-color", "-webkit-text-stroke-color", "-webkit-text-stroke-width",
      "filter", "backdrop-filter", "mix-blend-mode", "opacity", "visibility", "display", "fill", "stroke",
      "stroke-width", "text-shadow", "font-size", "font-family", "line-height", "letter-spacing"]) {
      o[k] = c.getPropertyValue(k);
    }
    return o;
  };
  const svgAttr = svg ? {
    viewBox: svg.getAttribute("viewBox"), width: svg.getAttribute("width"), height: svg.getAttribute("height"),
    fill: svg.getAttribute("fill"), style: svg.getAttribute("style"), cls: String(svg.getAttribute("class")),
    childCount: svg.childNodes.length,
  } : null;
  return { h2: pick(h2), svg: svg ? pick(svg) : null, svgAttr, h2html: h2.innerHTML.slice(0, 120) };
});
console.log("PAINT", JSON.stringify(paint, null, 1));
await b.close();
process.exit(0);
await h2Handle.screenshot({ path: "scripts/output/tmp-sched-h2.png" });
const h2rect = await p.evaluate(() => {
  const r = document.querySelector("#sched-title-bar h2").getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
});
console.log("H2RECT", JSON.stringify(h2rect));
const h2px = await analyze("scripts/output/tmp-sched-h2.png", [0, 0, 272, 125]);
console.log("H2PIX", JSON.stringify(h2px));
await b.close();
process.exit(0);
const textRect = await p.evaluate(() => {
  const h2 = document.querySelector("#sched-title-bar h2");
  const nodes = [...h2.childNodes].map((n) => ({
    type: n.nodeType, name: n.nodeName, text: (n.textContent || "").trim().slice(0, 20),
    rect: (n.nodeType === 3 ? new Range(n).getBoundingClientRect() : n.getBoundingClientRect
      ? n.getBoundingClientRect() : null),
  }));
  return nodes.map((n) => ({
    type: n.type, name: n.name, text: n.text,
    rect: n.rect ? { x: Math.round(n.rect.x), y: Math.round(n.rect.y), w: Math.round(n.rect.width), h: Math.round(n.rect.height) } : null,
  }));
});
console.log("H2NODES", JSON.stringify(textRect, null, 1));

// H2 タイトルの描画色・祖先の style・パネル閉状態でのタイトルバー measured clip を確認する
const info = await p.evaluate(() => {
  const h2 = document.querySelector("#sched-title-bar h2");
  const cs = h2 ? getComputedStyle(h2) : null;
  const chain = [];
  let node = h2;
  for (let i = 0; i < 5 && node; i++) {
    const c = getComputedStyle(node);
    chain.push({
      tag: node.tagName, id: node.id, cls: String(node.className).slice(0, 40),
      color: c.color, bg: c.backgroundColor, opacity: c.opacity, vis: c.visibility,
      disp: c.display, font: c.fontFamily.slice(0, 24), fs: c.fontSize,
    });
    node = node.parentElement;
  }
  const tb = document.querySelector("#sched-title-bar").getBoundingClientRect();
  return { chain, clip: { x: Math.round(tb.x), y: Math.round(tb.y), width: Math.round(tb.width), height: Math.round(tb.height) } };
});
console.log(JSON.stringify(info, null, 1));
await p.screenshot({ path: "scripts/output/tmp-sched-title.png", clip: info.clip });
const overlay = await p.evaluate(() => {
  const out = [];
  document.querySelectorAll("body *").forEach((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width > 200 && r.x < 400 && r.y < 400 && cs.display !== "none" && cs.visibility !== "hidden") {
      out.push({
        tag: el.tagName, id: el.id, cls: String(el.className).slice(0, 60),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
        z: cs.zIndex, pos: cs.position, bg: cs.backgroundColor,
      });
    }
  });
  return out.slice(0, 14);
});
console.log(JSON.stringify(overlay, null, 1));

await b.close();
