process.chdir('c:/Users/入江田　承/Documents/プログラミング/ISSystem');
process.env.NODE_EXTRA_CA_CERTS = 'c:/Users/入江田　承/Documents/プログラミング/ISSystem/certs/issystem-ca.crt';
process.env.CHROME_PATH = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const { execSync } = require('child_process');
try {
  const out = execSync('node scripts/test-bulletin-split.mjs', { encoding: 'utf8', maxBuffer: 40 * 1024 * 1024 });
  const lines = out.split('\n').filter((l) => /comment-post =|comment-send-e2e|FAIL |ALL PASSED/.test(l));
  console.log(lines.slice(0, 6).join('\n'));
} catch (e) {
  const out = (e.stdout || '') + (e.stderr || '');
  const lines = out.split('\n').filter((l) => /comment-post =|comment-send-e2e|FAIL |ALL PASSED/.test(l));
  console.log(lines.slice(0, 6).join('\n'));
}
