/**
 * モデル共通の PostgreSQL 接続ヘルパー (pg パスプールの共有)
 */
import { pool, query } from '../../config/database.js';

// レガシー互換: 旧コードの openDb() は非推奨 (pg のプール接続を使用すること)
export { pool, query };

export function todayJst() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
}

export function nowIso() {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

export function parseJson(value, fallback) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
