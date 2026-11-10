// 临时检查（削除してよい）: mail_messages / mail_accounts の現行カラムと health 確認
import fs from 'node:fs';
import https from 'node:https';
import { query, pool } from '../config/database.js';

const cols = await query(`
  SELECT table_name, column_name
  FROM information_schema.columns
  WHERE table_name IN ('mail_accounts', 'mail_messages')
  ORDER BY table_name, ordinal_position
`);
console.log(cols.rows.map((r) => `${r.table_name}.${r.column_name}`).join(' | '));

const ca = fs.readFileSync('certs/issystem-ca.crt');
https.get('https://127.0.0.1:3443/health', { ca }, (r) => console.log('health', r.statusCode))
  .on('error', (e) => console.log('server down:', e.code));

await pool.end();