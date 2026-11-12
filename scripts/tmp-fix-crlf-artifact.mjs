/** tmp-fix-crlf-artifact.mjs: ソースに混入したリテラル "\r\n" テキストを実改行へ直す（文字列リテラル内の正しいエスケープは触らない） */
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const NL = String.fromCharCode(13, 10);
const LIT = String.fromCharCode(92, 114, 92, 110); // バックスラッシュ r バックスラッシュ n

// 壊れた個所（実改行になるはずだったリテラルテキスト）の置換表
const fixes = [
  ['src/services/basicinfo.service.js', [
    [`};${LIT}${LIT}function isKyomu(user) {`, `};${NL}${NL}function isKyomu(user) {`],
    [`checkClassNameDup(p.grade, p.name);${LIT}    if (kind === 'room')`, `checkClassNameDup(p.grade, p.name);${NL}    if (kind === 'room')`],
    ['見つかりません。`);' + LIT + '      await checkClassNameDup', '見つかりません。`);' + NL + '      await checkClassNameDup'],
    [`if (kind === 'class') {${LIT}      const counts`, `if (kind === 'class') {${NL}      const counts`],
  ]],
  ['src/services/subject.service.js', [
    [`const NAME_MAX = 20;${LIT}${LIT}function isKyomu(user) {`, `const NAME_MAX = 20;${NL}${NL}function isKyomu(user) {`],
    [`}${LIT}  return name;`, `}${NL}  return name;`],
    [`}${LIT}    if (Number(target.p`, `}${NL}    if (Number(target.p`],
  ]],
];

for (const [rel, pairs] of fixes) {
  const p = path.join(ROOT, rel);
  let text = fs.readFileSync(p, 'utf8');
  for (const [from, to] of pairs) {
    const n = text.split(from).length - 1;
    if (n === 0) { console.log(`MISS ${rel}: ${JSON.stringify(from.slice(0, 24))}`); continue; }
    text = text.split(from).join(to);
    console.log(`FIXED ${rel} x${n}`);
  }
  fs.writeFileSync(p, text, 'utf8');
}
