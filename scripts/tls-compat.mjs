/**
 * TLS セッションキャッシュの無効化（環境依存の握手不良対策・2026/11/16）
 *
 * Node 24 のグローバル HTTPS エージェントは TLS セッションキャッシュ
 * （既定 maxCachedSessions=100）を持つ。プライベートCA（certs/issystem-ca.crt）の
 * サーバーはこの Windows 環境で TLS1.3 のセッション再開（セッションチケット）の握手が壊れ、
 * CA を正しく渡していても
 * 「Client network socket disconnected before secure TLS connection was established」になる（実測）。
 * CA を明示する検証スクリプト（AGENTS.md 第12条）はこの関数を呼んでキャッシュを無効化する。
 * 検証強度（ca と rejectUnauthorized:true）は一切変更しない。
 */
import https from 'node:https';

export function disableTlsSessionCache() {
  if (https.globalAgent?.options) https.globalAgent.options.maxCachedSessions = 0;
}
