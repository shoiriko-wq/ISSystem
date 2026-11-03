const esprima = require('esprima');
const fs = require('fs');
const src = fs.readFileSync('public/js/modules/facility.module.js', 'utf8');
const toks = esprima.tokenize(src);
let d = 0;
for (let i = 0; i < toks.length; i++) {
  const tk = toks[i];
  if (tk.type === 'Punctuator' && tk.value === '{') d++;
  if (tk.type === 'Punctuator' && tk.value === '}') {
    d--;
    if (d < 0) {
      console.log('extra } index ' + i);
      for (let j = Math.max(0, i - 8); j < Math.min(toks.length, i + 3); j++) {
        console.log(j, toks[j].type, JSON.stringify(toks[j].value), toks[j].line);
      }
      d = 0;
    }
  }
}
console.log('done, final ' + d);