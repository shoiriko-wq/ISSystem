/** 監査ログにメール設定の記録が残っているか確認 */
import { query, closeDatabase } from '../config/database.js';

const cols = await query('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 1');
console.log('columns:', Object.keys(cols.rows[0] || {}).join(','));

const rows = await query(
  "SELECT action, resource_type, resource_id, new_value FROM audit_logs WHERE action LIKE 'MAIL_%' ORDER BY created_at DESC LIMIT 3"
);
console.log(JSON.stringify(rows.rows, null, 2));

const mail = await query('SELECT id, user_id, email_address, imap_host, imap_port, smtp_host, smtp_port, status, password_enc FROM mail_accounts ORDER BY updated_at DESC LIMIT 3');
console.log('mail_accounts rows:', mail.rows.map((r) => ({ ...r, password_enc: (r.password_enc || '').slice(0, 18) })));

await closeDatabase();
