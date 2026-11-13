/**
 * メール本文キャッシュ化移行 (2026/11/13)
 * mail_messages.body を NULL 許可化し、新着検知時はヘッダ（件名・差出人・日時・添付有無）だけ保存して本文は NULL にする。
 * 本文はユーザが詳細を開いた時に IMAP text/plain を取得して UPDATE する (TOAST が TEXT を自動圧縮)。
 * 添付一覧 (attachments JSON)・has_attachments・html_stripped フラグ列を追加する。
 * 受信から body_cache_days 日超の受信ボックス本文だけを夜間 cron で NULL に戻す (データ肥大化防止)。
 * 実行: npm run db:mail-cache
 */
import { query, ensureSchema } from '../config/database.js';

await ensureSchema();

const steps = [
  'ALTER TABLE mail_messages ALTER COLUMN body DROP NOT NULL',
  "ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS attachments TEXT NOT NULL DEFAULT '[]'",
  'ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS has_attachments INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS html_stripped INTEGER NOT NULL DEFAULT 0',
  'CREATE INDEX IF NOT EXISTS idx_mail_messages_received ON mail_messages(received_at)',
];

for (const sql of steps) {
  const res = await query(sql);
  const flat = sql.replace(/\s+/g, ' ').trim();
  console.log(`OK: ${flat.slice(0, 70)}${flat.length > 70 ? '…' : ''} (${res.rowCount ?? 0} 影響)`);
}

const withBody = (await query("SELECT COUNT(*) AS c FROM mail_messages WHERE folder = 'inbox' AND body IS NOT NULL")).rows[0].c;
const nullBody = (await query("SELECT COUNT(*) AS c FROM mail_messages WHERE folder = 'inbox' AND body IS NULL")).rows[0].c;
console.log(`受信ボックス本文: 保存済み ${withBody} 件 / 本文未取得(NULL) ${nullBody} 件`);
process.exit(0);
