// Two-tone (saturated / inverted) chrome contrast rules: static checks that the
// contrast hooks live in the chrome scope, so the content area keeps its own
// contrast layer, and that the bar widgets get their own ink / plate colors.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cssDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "css");
const read = (name) => fs.readFileSync(path.join(cssDir, name), "utf8");
const vars = read("variables.css");
const readability = read("readability.css");

// The page-level chrome block must not remap the bar background tokens: those
// belong to the chrome elements, so the content area keeps the base light/dark
// contrast layer.
const blockOf = (selector) => {
  const start = vars.indexOf(selector + " {");
  if (start < 0) return "";
  return vars.slice(start, vars.indexOf("}", start) + 1);
};
const saturatedPageBlock = blockOf('html[data-chrome="saturated"][data-theme-mode="light"]');
const invertedPageBlock = blockOf('html[data-chrome="inverted"][data-theme-mode="dark"]');

const checks = [
  ["bar remaps are scoped to the bars", vars.includes('html[data-chrome="saturated"][data-theme-mode="light"] .app-header') && vars.includes('html[data-chrome="inverted"][data-theme-mode="dark"] .app-header')],
  ["the page-level saturated block keeps the content surfaces", saturatedPageBlock.includes("--bg-surface-strong") && !saturatedPageBlock.includes("--bg-header")],
  ["the page-level inverted block keeps the content surfaces", invertedPageBlock.includes("--bg-surface") && !invertedPageBlock.includes("--bg-sidebar")],
  ["saturated bars get white chrome ink", vars.includes("--chrome-text: #ffffff;")],
  ["inverted bars get the theme inverse ink", vars.includes("--chrome-text: var(--base-text-inverse);")],
  ["saturated content keeps a deepened strong surface", vars.includes("--bg-surface-strong: color-mix(in srgb, var(--base-bg-card) 84%, var(--base-text-main))")],
  ["inverted content keeps a lifted strong surface", vars.includes("--bg-surface: color-mix(in srgb, var(--base-bg-card) 90%, #ffffff)")],
  ["chat channel strip is part of the chrome scope", vars.includes('html[data-chrome="saturated"][data-theme-mode="light"] .chat-sidebar-channels') && vars.includes('html[data-chrome="inverted"][data-theme-mode="dark"] .chat-sidebar-channels')],
  ["saturated status chips are derived from the bar", vars.includes("--success-soft: color-mix(in srgb, var(--base-success) 24%, var(--base-text-main))")],
  ["inverted status chips are derived from the bar", vars.includes("--success-soft: color-mix(in srgb, var(--base-success) 22%, var(--base-bg-sidebar))")],
  ["white chips inside the bars take the content ink", vars.includes('html[data-chrome="saturated"][data-theme-mode="light"] .app-sidebar .bg-surface')],
  ["saturated badge ink is white", vars.includes('html[data-chrome="saturated"][data-theme-mode="light"] .app-sidebar .nav-badge')],
  ["inverted badge ink is the theme inverse", vars.includes('html[data-chrome="inverted"][data-theme-mode="dark"] .app-sidebar .nav-badge')],
  ["the clock / weather widgets get a dark plate on the saturated bar", vars.includes("background-color: rgba(0, 0, 0, 0.28) !important")],
  ["white bar ink gets a dark glow on the saturated bars", vars.includes("text-shadow: 0 1px 2px rgba(0, 0, 0, 0.35)")],
  ["the invitation button plate is deepened in light themes", readability.includes("color-mix(in srgb, var(--warning) 45%, #000000) !important")],
  ["schedule chips take the content ink in light themes", readability.includes('html[data-theme-mode="light"] .sched-cat-chip')],
  ["status ink leans to the theme tint for chip labels", vars.includes("--text-accent-strong: color-mix(in srgb, var(--accent-primary) 32%, var(--text-tint))")],
];

const failures = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
if (failures.length) {
  console.log(`\n${failures.length} / ${checks.length} chrome contrast checks failed`);
  process.exit(1);
}
console.log(`\nAll ${checks.length} chrome contrast checks passed`);
