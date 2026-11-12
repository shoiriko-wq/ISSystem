const lines = require('fs').readFileSync(process.argv[2], 'utf8').split(/\r?\n/);
let d = 0;
lines.forEach((l, i) => {
  const t = l.replace(/'[^']*'/g, '').replace(/"[^"]*"/g, '');
  for (const c of t) { if (c === '{') d++; if (c === '}') d--; }
  if (d < 0) console.log('NEG at line', i + 1, l);
});
console.log('final depth', d, 'lines', lines.length);

