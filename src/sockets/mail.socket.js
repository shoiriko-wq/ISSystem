/**
 * ISSystem Mail Realtime Socket Handlers
 * 開封時遅延本文取得 (mail:get_body) と添付ダウンロード (mail:get_attachment) を扱う。
 * 本文は DB キャッシュ (未キャッシュ時は IMAP へ取りに行く)。権限は mailService 側で検証 (self / admin)。
 */

import mailService from '../services/mail.service.js';

/**
 * メール関連の Socket.io ハンドラーをバインドする
 * @param {import('socket.io').Server} io
 * @param {import('socket.io').Socket} socket
 */
export default function registerMailSocketHandlers(io, socket) {
  const user = socket.user;

  // 本文の遅延取得 (詳細ペインを開いた時に本文が未キャッシュなら呼ぶ)
  socket.on('mail:get_body', async (payload, callback) => {
    if (typeof callback !== 'function') return;
    const messageId = payload?.id;
    if (!messageId) return callback({ success: false, message: 'メールIDが必要です' });
    try {
      const msg = await mailService.getFullMessage(messageId, user);
      callback({ success: true, message: msg });
    } catch (err) {
      callback({ success: false, message: err?.userMessage || '本文の取得に失敗しました' });
    }
  });

  // 添付ダウンロード (section を指定してバイト列を base64 で返す)
  socket.on('mail:get_attachment', async (payload, callback) => {
    if (typeof callback !== 'function') return;
    const messageId = payload?.id;
    const section = payload?.section;
    if (!messageId || !section) return callback({ success: false, message: 'メールIDと添付セクションが必要です' });
    try {
      const att = await mailService.getAttachment(user, messageId, section);
      // ArrayBuffer を base64 へ変換 (socket.io ack は JSON シリアライズされるため)
      const base64 = Buffer.from(att.bytes).toString('base64');
      callback({ success: true, name: att.name, type: att.type, base64 });
    } catch (err) {
      callback({ success: false, message: err?.userMessage || '添付の取得に失敗しました' });
    }
  });
}
