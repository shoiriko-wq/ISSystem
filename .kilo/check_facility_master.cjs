const parser = require('@babel/parser');
const fs = require('fs');
const files = [
  'scripts/test-facility-master.mjs',
  'public/js/socket.js',
  'public/js/modules/facility.module.js',
];
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  try {
    parser.parse(src, { sourceType: 'module', allowAwaitOutsideFunction: true, ecmaFeatures: { jsx: true } });
    console.log(f + ': PARSE OK');
  } catch (e) {
    console.log(f + ': PARSE FAIL ' + e.message);
  }
}
const src = fs.readFileSync('public/js/modules/facility.module.js', 'utf8');
let depth = 0;
let line = 1;
for (const ch of src) {
  if (ch === '\n') line++;
  if (ch === '{') depth++;
  if (ch === '}') depth--;
  if (ch === '}' && depth < 0) console.log('negative depth at line ' + line);
}
console.log('final brace depth = ' + depth);
console.log('lines = ' + src.split('\n').length);
const socketSrc = fs.readFileSync('public/js/socket.js', 'utf8');
let d2 = 0, l2 = 1;
for (const ch of socketSrc) {
  if (ch === '\n') l2++;
  if (ch === '{') d2++;
  if (ch === '}') d2--;
  if (ch === '}' && d2 < 0) console.log('socket negative depth at line ' + l2);
}
console.log('socket final depth = ' + d2);
