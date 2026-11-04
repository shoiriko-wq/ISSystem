// jest を --json で実行し、失敗テストのメッセージだけを UTF-8 ファイルに書き出す検証支援スクリプト
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const target = process.argv[2] || null;
const args = ['--experimental-vm-modules', 'node_modules/jest/bin/jest.js', '--runInBand', '--json', '--silent'];
if (target) args.push(target);

execFile('node', args, { maxBuffer: 200 * 1024 * 1024 }, (err, stdout, stderr) => {
  let j;
  try {
    j = JSON.parse(stdout);
  } catch (e) {
    fs.writeFileSync('tmp_fail_detail.txt', 'JSON parse failed: ' + e.message + '\n' + stdout.slice(0, 4000), 'utf8');
    console.log('parse failed');
    return;
  }
  const out = [`numFailedTestSuites=${j.numFailedTestSuites} numFailedTests=${j.numFailedTests} numTotalTests=${j.numTotalTests}`];
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
  console.log('suites:', j.numFailedTestSuites, 'failed tests:', j.numFailedTests, 'total:', j.numTotalTests);
});