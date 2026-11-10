// UIテストのログ（テキストファイル）を要約する補助スクリプト。
// 使い方: node scripts/parse-ui.mjs ログファイル
// ALL PASS 行と FAIL/NG 行を集めて、テストの合否を数値で確認できるようにする。
import { readFileSync, existsSync } from 'node:fs';

const file = process.argv[2];
if (!file || !existsSync(file)) {
  console.log('ログファイルが見付かりません:', file);
  process.exit(0);
}

const lines = readFileSync(file, 'utf8').split(/\r?\n/);
const pass = lines.filter((l) => /ALL PASS/.test(l));
const fails = [];
lines.forEach((l, i) => {
  const t = l.trim();
  if (/^(FAIL|NG)/.test(t)) {
    fails.push(`行 ${i + 1}: ${t.slice(0, 150)}  直前: ${(lines[i - 1] || '').slice(0, 70)}`);
  }
});

console.log(`ファイル: ${file} (${lines.length}行)`);
console.log('ALL PASS 行数:', pass.length);
pass.forEach((l) => console.log('  PASS:', l.slice(0, 90)));
console.log('FAIL/NG 行数:', fails.length);
fails.forEach((f) => console.log('  FAIL:', f));
