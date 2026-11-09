/**
 * 職員全体（公開）チャット撤廃マイグレーション (2026/11/9 v3.1.2)
 * chat_channels から 'general' / 'chat-all' / 'all' を削除する。
 * 参加者・メッセージ・既読ログは ON DELETE CASCADE で同時に削除される。
 * 個人が作成したグループのみが残る。実行: npm run db:drop-general-chat
 */
import { query, ensureSchema } from '../config/database.js';

const LEGACY_IDS = ['general', 'chat-all', 'all'];

await ensureSchema();

for (const legacyId of LEGACY_IDS) {
  const chan = (await query('SELECT id, name FROM chat_channels WHERE id = ?', [legacyId])).rows;
  if (!chan.length) {
    console.log(`${legacyId}: 存在しない（対応不要）`);
    continue;
  }
  const counts = {
    messages: (await query('SELECT COUNT(*) AS c FROM chat_messages WHERE channel_id = ?', [legacyId])).rows[0].c,
    reads: (await query('SELECT COUNT(*) AS c FROM chat_message_reads WHERE channel_id = ?', [legacyId])).rows[0].c,
    members: (await query('SELECT COUNT(*) AS c FROM chat_channel_members WHERE channel_id = ?', [legacyId])).rows[0].c,
  };
  const deleted = await query('DELETE FROM chat_channels WHERE id = ? RETURNING id', [legacyId]);
  console.log(`撤去: ${chan[0].name} (${legacyId}) メッセージ=${counts.messages} 既読ログ=${counts.reads} メンバー=${counts.members} 削除行=${deleted.rowCount}`);
}

const left = (await query('SELECT id, name, type FROM chat_channels ORDER BY created_at ASC, id ASC')).rows;
console.log(`残存グループ(${left.length}): ${left.map((r) => `${r.name}[${r.id}:${r.type}]`).join(' / ') || 'なし'}`);
const publicLeft = left.filter((r) => r.type === 'PUBLIC');
console.log(`PUBLIC（職員全体）残存: ${publicLeft.length}件`);
process.exit(0);
