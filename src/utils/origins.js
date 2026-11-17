/**
 * CORS Origin 設定パーサー
 *
 * `CLIENT_ORIGIN` は単一URL、`*`、またはカンマ区切りリストで指定する。
 * カンマを含む場合は配列化して cors / socket.io に渡す（単一文字列では一致しないため）。
 *
 * @param {string|undefined} raw 環境変数の値
 * @param {string|boolean} fallback 未設定時の既定値（app: true, socket.io: ワイルドカード）
 */
export const parseCorsOrigin = (raw, fallback = true) => {
  if (!raw) return fallback;
  if (raw.includes(',')) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length ? list : fallback;
  }
  return raw.trim();
};

/**
 * Origin をブラウザが送る形へ正規化する（WHATWG URL の origin は既定ポートを省略する）
 *
 * ブラウザの Origin ヘッダーは https の 443 と http の 80 を書かない。
 * 例: ページが https://10.232.77.7:443 で開かれても Origin は 'https://10.232.77.7'。
 * 許可リスト側が ':443' 付きだと文字列一致が永不成立になり、Socket ハンドシェイクが 400 で落ちる
 * （2026/11/17 の本番障害。SSL_PORT が既定ポート以外の開発環境では偶然一致していた）。
 * 両側をこの正規化へ通すことで ':443' 形・省略形のどちらを .env に書いても一致する。
 *
 * @param {string} raw Origin 文字列（ワイルドカード '*' はそのまま返す）
 * @returns {string} 正規化 Origin（解析不能なら小文字化した生値）
 */
export const normalizeOrigin = (raw) => {
  const trimmed = String(raw ?? '').trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed === '*') return '*';
  try {
    return new URL(trimmed).origin.toLowerCase();
  } catch {
    return trimmed;
  }
};

/**
 * Origin が許可リスト内か（両側を正規化して照合、wildcard '*' は明示設定時のみ許可）
 * @param {string} origin 要求側の Origin
 * @param {string[]|string} list 許可リスト（環境変数の未正規化値でも可）
 * @returns {boolean}
 */
export const originMatches = (origin, list) => {
  const allowed = (Array.isArray(list) ? list : [list]).map((s) => normalizeOrigin(s));
  if (allowed.includes('*')) return true;
  return allowed.includes(normalizeOrigin(origin));
};

export default parseCorsOrigin;