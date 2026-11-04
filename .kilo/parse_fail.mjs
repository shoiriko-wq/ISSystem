// jest --json の結果から失敗テストのメッセージだけを UTF-8 で書き出す検証支援スクリプト
import fs from 'node:fs';

const raw = fs.readFileSync('tmp_results.json', 'utf8').replace(/^\uFEFF/, '');
const j = JSON.parse(raw);
const out = [];
out.push(`numFailedTestSuites=${j.numFailedTestSuites} numFailedTests=${j.numFailedTests} numTotalTests=${j.numTotalTests}`);

for (const r of j.testResults) {
  const suite = r.name.split(/[\\/]/).pop();
  for (const t of r.assertionResults) {
    if (t.status !== 'failed') continue;
    out.push(`\n=== [${suite}] ${t.fullName}`);
    for (const m of t.failureMessages) {
      out.push(m.replace(/\u001b\[[0-9;]*m/g, ''));
    }
  }
}
fs.writeFileSync('tmp_fail_detail.txt', out.join('\n'), 'utf8');
console.log('written', out.length, 'blocks');