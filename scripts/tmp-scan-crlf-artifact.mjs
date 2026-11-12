/** tmp-scan-crlf-artifact.mjs: リテラル "\r\n" テキスト（バックスラッシュrバックスラッシュn）がソースに混入していないか走査する */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIRS = ['src', 'public/js', 'scripts'];
const hits = [];

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
    if (!/\.(js|mjs|json|md|example|txt)$/.test(e.name)) continue;
    const text = fs.readFileSync(p, 'utf8');
    let i = 0;
    while ((i = text.indexOf('\\r\\n', i)) !== -1) {
      const ctx = text.slice(Math.max(0, i - 25), i + 27).replace(/\r/g, '<CR>').replace(/\n/g, '<LF>');
      hits.push(`${path.relative(ROOT, p)} @${i}: ${ctx}`);
      i += 4;
    }
  }
}

for (const d of DIRS) walk(path.join(ROOT, d));
console.log(`hits=${hits.length}`);
hits.forEach((h) => console.log(h));
