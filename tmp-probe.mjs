import fs from 'node:fs';
import cp from 'node:child_process';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();
const used = new Set();
const files = cp.execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter((f) => /\.(js|mjs|sql)$/.test(f));
for (const f of files) {
  let t = '';
  try { t = fs.readFileSync(f, 'utf8'); } catch { continue; }
  for (const m of t.matchAll(/(?:FROM|INTO|UPDATE|JOIN)\s+([a-z_]+)/gi)) used.add(m[1]);
}
const pool = new Pool({ host: 'localhost', port: 5432, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME });
const r = await pool.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
const have = new Set(r.rows.map((x) => x.tablename));
const noise = new Set(['set', 'select', 'the', 'a', 'pg', 'from_']);
const missing = [...used].filter((t) => !have.has(t) && !noise.has(t)).sort();
console.log('MISSING-IN-DB:', missing.join(' '));
console.log('DB-TABLE-COUNT:', have.size);
await pool.end();