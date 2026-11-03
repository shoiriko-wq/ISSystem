const p = require('@babel/parser');
const fs = require('fs');
const file = process.argv[2];
const L = fs.readFileSync(file, 'utf8').split('\n');
let lastOk = 0;
for (let n = L.length; n >= 1; n--) {
  const src = L.slice(0, n).join('\n');
  try {
    p.parse(src, { sourceType: 'module' });
    lastOk = n;
    break;
  } catch (e) {
    // keep going
  }
}
console.log('last parseable prefix length:', lastOk);
for (let n = lastOk; n <= Math.min(lastOk + 3, L.length); n++) {
  const src = L.slice(0, n).join('\n');
  try {
    p.parse(src, { sourceType: 'module' });
    console.log('n=' + n + ' OK');
  } catch (e) {
    console.log('n=' + n + ' ' + e.message);
  }
}
for (let n = lastOk + 1; n <= L.length; n++) {
  const src = L.slice(0, n).join('\n');
  try { p.parse(src, { sourceType: 'module' }); console.log('n=' + n + ' OK'); }
  catch (e) { console.log('n=' + n + ' ' + e.message); }
}