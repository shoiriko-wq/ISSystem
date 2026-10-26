/**
 * コード内で参照されているテーブル名を一覧化する開発支援スクリプト
 * 使用: npm run db:tables
 */
import fs from 'fs';
import path from 'path';

const roots = ['src', 'scripts'];
const names = new Set();
const re = /(FROM|JOIN|INSERT INTO|UPDATE|ALTER TABLE|CREATE TABLE(?: IF NOT EXISTS)?)\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi;

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!/\.(js|sql|mjs)$/.test(e.name)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const m of text.matchAll(re)) names.add(m[2]);
  }
}

for (const r of roots) if (fs.existsSync(r)) walk(r);
console.log([...names].sort().join('\n'));