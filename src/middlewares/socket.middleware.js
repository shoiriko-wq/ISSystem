/**
 * ISSystem Socket.io Security Middleware
 * WSS 接続の Origin 許可リスト照合・JWT 厳格検証・ハンドラー側ロール/ペイロード検証
 *
 * 経緯（2026/11/7 セキュリティ監査 Critical #1）:
 * 旧 socket.index.js は `demo-jwt-token-*` を無条件通過させ、NODE_ENV≠production では
 * jwt.verify 失敗時に dev-user（TEACHER）として接続を許可していた（裏口）。
 * また socket.io の cors origin は '*'（クライアントOrigin無制限）だった。
 * 本モジュールで「検証失敗は常時拒否」「Origin は明示リストのみ」を統一実装する。
 */

import jwt from 'jsonwebtoken';
import config from '../../config/default.js';

/** 編集ロック対象として許されるリソース種別ホワイトリスト（lock:* ハンドラー用） */
export const SOCKET_RESOURCE_TYPES = new Set([
  'seating',
  'exam',
  'schedule',
  'facility',
  'approval',
  'bulletin',
  'mail',
  'chat',
]);

/** 在席ステータスの正規値（authService.updateStatus の validStatuses と一致させる） */
export const SEATING_STATUSES = new Set(['PRESENT', 'CLASS', 'TRIP', 'LEAVE', 'IN', 'OUT']);

/**
 * SSL_HOSTS から自サーバー Origin（https://host:port）集合を導出する
 * @returns {Set<string>}
 */
function buildDefaultOrigins() {
  const hosts = (process.env.SSL_HOSTS || 'localhost,127.0.0.1')
    .split(',')
    .map((s) => s.trim())
    .filter((h) => h && h !== '::1');
  const port = process.env.SSL_PORT || 3443;
  const set = new Set();
  hosts.forEach((h) => set.add(`https://${h}:${port}`.toLowerCase()));
  return set;
}

const DEFAULT_ORIGINS = buildDefaultOrigins();

/**
 * 接続要求の Origin が許可リスト内か
 * @param {string|undefined} origin socket.handshake.headers.origin
 * @returns {boolean}
 */
export function isSocketOriginAllowed(origin) {
  // Origin を送らないのは非ブラウザクライアント（Node の socket.io-client / 監視スクリプト）。
  // CORS はブラウザ側の概念であり、ブラウザは常に Origin を送るため、
  // Origin 付き要求は必ず明示リストで照合する。
  if (!origin) return true;

  const configured = (config.socket?.corsOrigins || []).map((s) => String(s).trim().toLowerCase());
  if (configured.includes('*')) {
    console.warn('[Socket Auth] SOCKET_CORS_ORIGINS=* が設定されています（Origin 無制限）。本番運用では禁止。');
    return true;
  }

  const normalized = String(origin).trim().toLowerCase();
  return configured.includes(normalized) || DEFAULT_ORIGINS.has(normalized);
}

/**
 * JWT を厳格検証して socket.user に格納するオブジェクトを得る
 * 検証失敗（失効・不正署名・プレフィックストークン）は常に throw する。
 * @param {string|undefined} rawToken handshake.auth.token / Authorization ヘッダー
 * @returns {{id:string,name:string,role:string,grade:string|null,department:string|null}}
 */
export function verifySocketToken(rawToken) {
  if (!rawToken) throw new Error('Authentication error: Token missing');

  const token = rawToken.startsWith('Bearer ') ? rawToken.split(' ')[1] : rawToken;
  const secret = config.auth?.jwtSecret || process.env.JWT_SECRET;
  if (!secret) throw new Error('Authentication error: JWT secret unavailable');

  const decoded = jwt.verify(token, secret); // 失敗時は jwt 側で throw（ExceptionError / TokenExpiredError）
  const role = decoded.role || 'TEACHER';
  return {
    id: decoded.id,
    name: decoded.name || '教員',
    role,
    is_kyomu: role === 'KYOMU' || decoded.is_kyomu === true,
    grade: decoded.grade ?? null,
    department: decoded.department ?? null,
  };
}

/**
 * socket.user のロールが許可リスト内か（ハンドラー内ロール gate）
 * @param {import('socket.io').Socket} socket
 * @param {string[]} roles 許可ロール（'KYOMU','ADMIN','TEACHER'）
 * @returns {boolean}
 */
export function socketHasRole(socket, roles) {
  const role = socket.user?.role;
  return Boolean(role) && roles.includes(role);
}

/**
 * ロール gate 失敗時に ack へ返す標準応答
 * @param {string[]} roles
 */
export function roleDenied(roles) {
  return { success: false, error: `権限がありません（必要ロール: ${roles.join(' / ')}）` };
}

/**
 * ロックリソース種別ホワイトリスト検証
 * @param {string} resourceType
 * @returns {boolean}
 */
export function isAllowedResourceType(resourceType) {
  return SOCKET_RESOURCE_TYPES.has(String(resourceType || '').trim().toLowerCase());
}

/**
 * ペイロード文字列を長さ上限付きでサニタイズ（制御文字・改行を除去）
 * @param {unknown} value
 * @param {number} max 最大長（既定128）
 * @returns {string|null} null の場合は不正入力
 */
export function sanitizeSocketString(value, max = 128) {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[\r\n\t\u0000]/g, '').trim();
  if (!cleaned || cleaned.length > max) return null;
  return cleaned;
}

export default {
  isSocketOriginAllowed,
  verifySocketToken,
  socketHasRole,
  roleDenied,
  isAllowedResourceType,
  sanitizeSocketString,
  SOCKET_RESOURCE_TYPES,
  SEATING_STATUSES,
};
