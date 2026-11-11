/**
 * メール複数アカウント移行 (2026/11/11)
 * mail_accounts の UNIQUE(user_id) を撤去して UNIQUE (user_id, lower(email_address)) に置き換え、
 * 1ユーザーの複数メールアカウント（アカウントタブ）を許可する。
 * mail_messages に account_id（アカウント所属・ON DELETE CASCADE）を足し、
 * UID 一意制約を UNIQUE (account_id, folder, uid)（アカウント単位の重複排除）へ作り直す。
 * 旧DBの孤立メッセージ（account_id NULL）はそのユーザーの最古アカウントへ割り当てる。
 * 実行: npm run db:mail-accounts
 */
import { query, ensureSchema } from '../config/database.js';

await ensureSchema();

const steps = [
  'ALTER TABLE mail_accounts DROP CONSTRAINT IF EXISTS mail_accounts_user_id_key',
  'CREATE UNIQUE INDEX IF NOT EXISTS uniq_mail_accounts_user_email ON mail_accounts(user_id, lower(email_address))',
  'ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES mail_accounts(id) ON DELETE CASCADE',
  `UPDATE mail_messages m SET account_id = a.id
   FROM mail_accounts a
   WHERE m.user_id = a.user_id AND m.account_id IS NULL
     AND a.created_at = (SELECT MIN(b.created_at) FROM mail_accounts b WHERE b.user_id = m.user_id)`,
  'DROP INDEX IF EXISTS uniq_mail_messages_uid',
  'CREATE UNIQUE INDEX IF NOT EXISTS uniq_mail_messages_uid ON mail_messages(account_id, folder, uid)',
  'CREATE INDEX IF NOT EXISTS idx_mail_messages_account_time ON mail_messages(account_id, received_at DESC)',
];

for (const sql of steps) {
  const res = await query(sql);
  const flat = sql.replace(/\s+/g, ' ').trim();
  console.log(`OK: ${flat.slice(0, 64)}${flat.length > 64 ? '…' : ''} (${res.rowCount ?? 0} 影響)`);
}

const orphan = (await query('SELECT COUNT(*) AS c FROM mail_messages WHERE account_id IS NULL')).rows[0].c;
const accounts = (await query('SELECT user_id, email_address FROM mail_accounts ORDER BY created_at')).rows;
console.log(`mail_accounts のアカウント(${accounts.length}): ${accounts.map((r) => `${r.user_id}<${r.email_address}>`).join(' / ') || 'なし'}`);
const boxes = (await query('SELECT account_id, folder, COUNT(*) AS c FROM mail_messages GROUP BY account_id, folder ORDER BY account_id, folder')).rows;
console.log(`mail_messages の内訳: ${boxes.map((r) => `${r.account_id}[${r.folder}]=${r.c}`).join(' / ') || '空'}`);
console.log(`アカウント未所属のメッセージ: ${orphan} 件`);
if (Number(orphan) > 0) {
  console.log('⚠️ アカウント未所属のメッセージが残っています（アカウントを作成すると割り当て対象になります）');
}
process.exit(0);