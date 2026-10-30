import { query, closeDatabase } from './src/utils/db.js';

await query('ALTER TABLE exam_masters ADD COLUMN IF NOT EXISTS notes TEXT');
const cols = await query(
  "SELECT table_name, column_name FROM information_schema.columns WHERE table_name='exam_masters' ORDER BY column_name"
);
console.log(cols.rows.map((r) => r.column_name).join(','));
await closeDatabase();
