/**
 * モデル共通の SQLite 接続 (database.sqlite)
 */
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import { DB_PATH } from '../../config/database.js';

export async function openDb() {
  const db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });
  await db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

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
