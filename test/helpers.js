/**
 * テスト共通ヘルパー (supertest + PostgreSQL プール制御)
 */
import request from 'supertest';
import { pool } from '../config/database.js';

/** seed.js が登録する教務主任アカウント */
export const seededUser = { staff_code: 'T2026001', password: 'password123' };

/**
 * 実在アカウントでログインし JWT を取得する
 * @param {import('express').Express} app
 */
export async function loginToken(app, { staff_code = seededUser.staff_code, password = seededUser.password } = {}) {
  const res = await request(app).post('/api/auth/login').send({ staff_code, password });
  if (res.statusCode !== 200) {
    throw new Error(`テストログイン失敗 (${res.statusCode}): ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

/** Authorization ヘッダ値を生成 */
export function bearer(token) {
  return `Bearer ${token}`;
}

/**
 * 作成系 API のレスポンスからリソース ID を抽出する
 * レスポンス包装形式 (approval / data / post / channel ... ) の揺れに耐える
 */
export function pickId(body) {
  const keys = ['approval', 'bulletin', 'post', 'channel', 'reservation', 'schedule', 'data', 'id'];
  for (const key of keys) {
    const value = body?.[key];
    if (typeof value === 'string') return value;
    if (value && typeof value.id === 'string') return value.id;
  }
  return null;
}

/** 各テストスイート終了時に PostgreSQL プールを閉じる (--forceExit 頼みの防止策) */
export async function closePool() {
  await pool.end();
}
