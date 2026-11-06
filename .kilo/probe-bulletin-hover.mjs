/**
 * 蜿ｳ繝壹う繝ｳ縲瑚ｩｳ邏ｰ縲阪・繧ｿ繝ｳ縺ｨ繧ｳ繝｡繝ｳ繝磯∽ｿ｡繝懊ち繝ｳ繧定ｨ域ｸｬ縺吶ｋ險ｺ譁ｭ繧ｹ繧ｯ繝ｪ繝励ヨ
 * 螳溯｡・ node .kilo/probe-bulletin-hover.mjs   ・・SSystem 繧ｵ繝ｼ繝舌・縺悟ｿ・ｦ・ｼ・
 *  options: UI_BASE / UI_USER / UI_PASS / CHROME_PATH
 */
import puppeteer from 'puppeteer-core';

const BASE = process.env.UI_BASE || 'https://127.0.0.1:3443';
const USER = process.env.UI_USER || 'T2026001';
const PASS = process.env.UI_PASS || 'password123';
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', ignoreHTTPSErrors: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 900 });
await page.goto(`${BASE}/`, { waitUntil: 'networkidle2' });
await page.type('#login-userid', USER);
await page.type('#login-password', PASS);
await page.evaluate(() => window.handleLoginClick());
await page.waitForSelector('#app-container:not(.hidden)', { timeout: 10000 });
await sleep(1000);
await page.evaluate(() => document.querySelector('a[data-tab="bulletin"]').click());
await sleep(900);

// 謚慕ｨｿ縺ｮ縺ゅｋ譌･繧帝∈繧薙〒驕ｸ謚・
await page.evaluate(() => {
  document.getElementById('bulletin-day-current').click();
  const day = document.querySelector('#bulletin-mini-cal .mini-cal-has[data-cal-date]');
  if (day) day.click();
});
await sleep(700);

const measure = (selector) => page.evaluate((sel) => {
  const btn = document.querySelector(sel);
  if (!btn) return { missing: sel };
  const pane = document.getElementById('bulletin-detail-pane');
  const body = pane.querySelector('.bulletin-detail-body');
  const textarea = document.getElementById('bulletin-comment-input');
  const box = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom),
      w: Math.round(r.width), h: Math.round(r.height),
      borderTop: parseFloat(cs.borderTopWidth), borderRight: parseFloat(cs.borderRightWidth),
      borderBottom: parseFloat(cs.borderBottomWidth), borderLeft: parseFloat(cs.borderLeftWidth),
      paddingTop: parseFloat(cs.paddingTop), paddingRight: parseFloat(cs.paddingRight),
      paddingBottom: parseFloat(cs.paddingBottom), paddingLeft: parseFloat(cs.paddingLeft),
      overflowX: cs.overflowX, overflowY: cs.overflowY,
    };
  };
  const parseShadow = (shadow) => {
    // "0 6px 18px 0px, 0 0 0 4px color" -> 蜷・ｽｱ縺ｮ [x,y,blur,spread]・・olor 蜀・・謨ｰ蟄励ｒ諡ｾ繧上↑縺・ｼ・
    const parts = shadow.split(/,(?![^(]*\))/).map((s) => s.trim());
    return parts.filter((p) => p !== 'none').map((p) => {
      const nums = (p.match(/-?\d+(?:\.\d+)?px/g) || []).map((n) => parseFloat(n.replace('px', '')));
      return { x: nums[0] || 0, y: nums[1] || 0, blur: nums[2] || 0, spread: nums[3] || 0 };
    });
  };
  const transformY = (t) => {
    if (!t || t === 'none') return 0;
    const m = t.match(/translateY\((-?\d+(?:\.\d+)?)px\)/);
    return m ? parseFloat(m[1]) : 0;
  };
  // 繝帙ヰ繝ｼ蠖ｱ繧貞性繧√◆謠冗判繝懊ャ繧ｯ繧ｹ繧偵√せ繧ｯ繝ｭ繝ｼ繝ｫ繧ｳ繝ｳ繝・リ縺ｮ padding box・茨ｼ拂lip 蠅・阜・峨→豈碑ｼ・
  const report = (container) => {
    const c = box(container);
    const b = box(btn);
    const cs = getComputedStyle(btn);
    const shadows = parseShadow(cs.boxShadow);
    const lift = -transformY(cs.transform); // 繝槭う繝翫せ = 荳頑婿蜷・
    const spread = Math.max(0, ...shadows.map((s) => s.spread));
    const padBox = {
      left: c.left + c.borderLeft, top: c.top + c.borderTop,
      right: c.right - c.borderRight, bottom: c.bottom - c.borderBottom,
    };
    const room = {
      top: Math.round(b.top - padBox.top - lift),
      right: Math.round(padBox.right - b.right),
      left: Math.round(b.left - padBox.left),
      bottom: Math.round(padBox.bottom - b.bottom + lift),
    };
    return {
      clip: container.className.split(' ')[0],
      overflowX: c.overflowX, overflowY: c.overflowY,
      pad: `${c.paddingTop}/${c.paddingRight}/${c.paddingBottom}/${c.paddingLeft}`,
      spread, room,
      clipTop: room.top < spread, clipRight: room.right < spread,
      clipLeft: room.left < spread, clipBottom: room.bottom < spread,
    };
  };
  return {
    sel,
    text: btn.textContent.replace(/\s+/g, ' ').trim(),
    cls: btn.className,
    btnBox: box(btn),
    bg: getComputedStyle(btn).backgroundColor,
    color: getComputedStyle(btn).color,
    fontSize: getComputedStyle(btn).fontSize,
    minHeight: getComputedStyle(btn).minHeight,
    boxShadow: getComputedStyle(btn).boxShadow,
    transform: getComputedStyle(btn).transform,
    textareaW: textarea ? Math.round(textarea.getBoundingClientRect().width) : null,
    formW: textarea ? Math.round(textarea.parentElement.getBoundingClientRect().width) : null,
    bodyClip: report(body),
    paneClip: report(pane),
  };
}, selector);

const detail = await measure('#bulletin-detail-pane [data-bulletin-detail]');
console.log('DETAIL', JSON.stringify(detail));

await page.hover('#bulletin-detail-pane [data-bulletin-detail]');
await sleep(400);
console.log('DETAIL-HOVER', JSON.stringify(await measure('#bulletin-detail-pane [data-bulletin-detail]')));

const send = await measure('#bulletin-detail-pane [data-bulletin-comment]');
console.log('SEND', JSON.stringify(send));

await page.hover('#bulletin-detail-pane [data-bulletin-comment]');
await sleep(400);
console.log('SEND-HOVER', JSON.stringify(await measure('#bulletin-detail-pane [data-bulletin-comment]')));

const el = await page.$('#bulletin-detail-pane');
await el.screenshot({ path: '.kilo/probe-bulletin-hover.png' });
console.log('shot -> .kilo/probe-bulletin-hover.png');
await browser.close();

