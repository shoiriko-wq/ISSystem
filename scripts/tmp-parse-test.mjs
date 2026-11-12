import { parseCsv } from './tmp-parse.mjs';

const csv = String.raw`# c\r\nname,grade\r\n1-1,1\r\n`;
console.log('INPUT_JSON=' + JSON.stringify(csv));
console.log('OUT=' + JSON.stringify(parseCsv(csv)));

const csv2 = String.raw`name,grade\r\n1-1,1\r\n1-2,2\r\n`;
console.log('OUT2=' + JSON.stringify(parseCsv(csv2)));

const rows = parseCsv(csv);
console.log('ROWS=' + JSON.stringify(rows));

const quoted = parseCsv('name,grades\r\nA,\"[1, 2]\"\r\nB,\r\n');
console.log('QUOTED=' + JSON.stringify(quoted));

const lf = parseCsv('name,seats\nX,30\nY,40\n');
console.log('LF=' + JSON.stringify(lf));
