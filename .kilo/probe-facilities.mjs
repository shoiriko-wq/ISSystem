import { query, ensureSchema } from '../config/database.js';
await ensureSchema();
const rows = (await query('SELECT id, name, category FROM resources ORDER BY id')).rows;
console.log('resources:', JSON.stringify(rows));
const resv = (await query('SELECT id, resource_id, facility_id, title, is_cancelled FROM reservations ORDER BY id')).rows;
console.log('reservations:', JSON.stringify(resv));
const cells = (await query('SELECT cell_key, cell_id FROM facility_cells LIMIT 20')).rows;
console.log('cells:', JSON.stringify(cells));
process.exit(0);
