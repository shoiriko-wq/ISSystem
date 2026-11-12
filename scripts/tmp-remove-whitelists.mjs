/** 一時クリーンアップ: ホワイトリスト撤去で生じた行の連結を元へ戻す (CRLF 整形) */
import fs from 'node:fs';

const CRLF = String.raw`\r\n`;
const fixes = [
  ['src/services/basicinfo.service.js', [
    ['};function isKyomu(user) {', '};' + CRLF + CRLF + 'function isKyomu(user) {'],
    ['checkClassNameDup(p.grade, p.name);    if (kind ===', 'checkClassNameDup(p.grade, p.name);' + CRLF + '    if (kind ==='],
    [');      await checkClassNameDup(', ');' + CRLF + '      await checkClassNameDup('],
    ["if (kind === 'class') {      const counts", "if (kind === 'class') {" + CRLF + '      const counts'],
  ]],
  ['src/services/subject.service.js', [
    ['const NAME_MAX = 20;function isKyomu(user) {', 'const NAME_MAX = 20;' + CRLF + CRLF + 'function isKyomu(user) {'],
    ['  }  return name;', '  }' + CRLF + '  return name;'],
    ['    }    if (Number(target.plan_count) > 0) {', '    }' + CRLF + '    if (Number(target.plan_count) > 0) {'],
  ]],
];

for (const [file, subs] of fixes) {
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of subs) {
    const before = src;
    src = src.split(from).join(to);
    console.log(`${file}: ${before === src ? 'NOT FOUND' : 'fixed'} (${from.slice(0, 24)})`);
  }
  fs.writeFileSync(file, src, 'utf8');
}
