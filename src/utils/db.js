/**
 * モデル共通の PostgreSQL 接続アダプタ
 * SQLite と同じ get / all / run / query / exec / close API を共有プール上で提供する
 */
import { getDb, createDbAdapter, withTransaction, closeDatabase } from '../../config/database.js';

/**
 * モデル層用接続アダプタ（共有プールの借用）。close() は no-op。
 */
export async function openDb() {
  return getDb();
}

export { createDbAdapter, withTransaction, closeDatabase };

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

/**
 * プールに対する直接クエリヘルパー（モデル・スクリプト・テスト用）
 * SQL は SQLite スタイルの ? プレースホルダで渡される（内部で $n に変換）
 */
export async function query(sql, params = []) {
  const db = await getDb();
  return db.query(sql, params);
}

export async function get(sql, params = []) {
  const db = await getDb();
  return db.get(sql, params);
}

export async function all(sql, params = []) {
  const db = await getDb();
  return db.all(sql, params);
}

export async function run(sql, params = []) {
  const db = await getDb();
  return db.run(sql, params);
}
