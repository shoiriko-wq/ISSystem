/**
 * メールボックス移行 (2026/11/10)
 * mail_accounts に暗号化モード・フォルダ・差出人名の列を追加する。
 * mail_messages に folder（受信/送信ボックス）・uid（IMAP の UID）・recipients（宛先）の列を追加し、
 * 受信メッセージの UID 一意制約を作る。
 * 既存のモック受信メール（id が mail_seed_ で始まる行）は削除する（モックは撤廃）。
 * 実行: npm run db:mail-folders
 */
import { query, ensureSchema } from '../config/database.js';

await ensureSchema();

const steps = [
  "ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_tls TEXT NOT NULL DEFAULT 'none'",
  "ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_folder TEXT NOT NULL DEFAULT 'INBOX'",
  "ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS smtp_tls TEXT NOT NULL DEFAULT 'none'",
  "ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS sent_folder TEXT NOT NULL DEFAULT 'Sent'",
  "ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS display_name TEXT",
  "ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS folder TEXT NOT NULL DEFAULT 'inbox'",
  "ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS uid TEXT",
  "ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS recipients TEXT",
  'CREATE UNIQUE INDEX IF NOT EXISTS uniq_mail_messages_uid ON mail_messages(user_id, folder, uid)',
  "DELETE FROM mail_messages WHERE id LIKE 'mail_seed_%'",
];

for (const sql of steps) {
  const res = await query(sql);
  console.log(`OK: ${sql.slice(0, 64)}${sql.length > 64 ? '…' : ''} (${res.rowCount ?? 0} 影響)`);
}

const accounts = (await query('SELECT user_id, imap_tls, imap_folder, smtp_tls, sent_folder, display_name FROM mail_accounts ORDER BY user_id')).rows;
console.log(`mail_accounts の暗号化設定(${accounts.length}): ${accounts.map((r) => `${r.user_id}[IMAP:${r.imap_tls}/${r.imap_folder} SMTP:${r.smtp_tls}/${r.sent_folder}]`).join(' / ') || 'なし'}`);
const boxes = (await query("SELECT folder, COUNT(*) AS c FROM mail_messages GROUP BY folder ORDER BY folder")).rows;
console.log(`mail_messages の内訳: ${boxes.map((r) => `${r.folder}=${r.c}`).join(' / ') || '空'}`);
process.exit(0);
