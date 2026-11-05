/**
 * CORS Origin 設定パーサー
 *
 * `CLIENT_ORIGIN` は単一URL、`*`、またはカンマ区切りリストで指定する。
 * カンマを含む場合は配列化して cors / socket.io に渡す（単一文字列では一致しないため）。
 *
 * @param {string|undefined} raw 環境変数の値
 * @param {string|boolean} fallback 未設定時の既定値（app: true, socket.io: '*'）
 */
export const parseCorsOrigin = (raw, fallback = true) => {
  if (!raw) return fallback;
  if (raw.includes(',')) {
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return list.length ? list : fallback;
  }
  return raw.trim();
};

export default parseCorsOrigin;
