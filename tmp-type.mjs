import { Client } from 'pg';
import config from './config/default.js';
const c = new Client(config.db);
await c.connect();
const t = await c.query("SELECT table_name, column_name, data_type FROM information_schema.columns WHERE column_name LIKE '%teacher_id' AND table_name LIKE 'exam%' ORDER BY table_name");
console.log(t.rows.map(r=>r.table_name+'.'+r.column_name+':'+r.data_type).join('\n'));
await c.end();
