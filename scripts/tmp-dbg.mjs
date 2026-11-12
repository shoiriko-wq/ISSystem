import fs from 'node:fs';
const src = fs.readFileSync('scripts/seed-data.js', 'utf8')
  .replace("import { query, closeDatabase } from '../config/database.js';", 'const query = null; const closeDatabase = async () => {};')
  .replace('const dataRows = rows.filter', 'globalThis.__rawrows = rows; const dataRows = rows.filter');
fs.writeFileSync('scripts/tmp-parse.mjs', src);
const { parseCsv } = await import('./tmp-parse.mjs');
const NL = String.fromCharCode(13, 10);
const csv = ['# c', 'name,grade', '1-1,1', '1-2,2'].join(NL) + String.fromCharCode(10);
const out = parseCsv(csv);
console.log('RAW=' + JSON.stringify(globalThis.__rawrows));
console.log('OUT=' + JSON.stringify(out));

const dq = String.fromCharCode(34);
const qcsv = ['name,grades', 'A,' + dq + '[1, 2]' + dq, 'B,'].join(NL) + String.fromCharCode(10);
console.log('Q=' + JSON.stringify(parseCsv(qcsv)));

const lf = ['name,seats', 'X,30', 'Y,40'].join(String.fromCharCode(10)) + String.fromCharCode(10);
console.log('L=' + JSON.stringify(parseCsv(lf)));

