#!/usr/bin/env node
/**
 * scripts/rotate-mail-enc-key.mjs
 * mail_accounts の AES-256-GCM 暗号化キーを MAIL_ENC_SECRET 基準（scrypt）へ
 * ローテする移行ツール（2026/11/8 監査 Critical 対策）。
 *
 * 使い方:
 *   .env の MAIL_ENC_SECRET を新値へ変更したうえで、
 *   `npm run rotate:mail-key -- OLD_SECRET=<旧MAIL_ENC_SECRET>`
 *   （2026/11/8 以前の sha256(旧JWT_SECRET) キーで暗号化された行は
 *    `OLD_JWT_SECRET=<旧JWT_SECRET>` で再暗号化できる）
 *   再暗号化後にサーバーを再起動する。
 */

import crypto from 'node:crypto';
import { query } from '../config/database.js';
import config from '../config/default.js';

const ALGO = 'aes-256-gcm';
const KEY_SALT = 'issystem-mail-enc-v2';

// OLD_SECRET=... / OLD_JWT_SECRET=... は argv（npm run -- KEY=v）と env の両方に対応
const argMap = {};
for (const a of process.argv.slice(2)) {
  const m = /^([A-Z_]+)=(.*)$/.exec(a);
  if (m) argMap[m[1]] = m[2];
}
const oldMailSecret = argMap.OLD_SECRET || process.env.OLD_MAIL_ENC_SECRET || null;
const oldJwtSecret = argMap.OLD_JWT_SECRET || process.env.OLD_JWT_SECRET || null;

const newKey = crypto.scryptSync(String(config.mail.encSecret), KEY_SALT, 32);
const legacyKeys = [];
if (oldMailSecret) legacyKeys.push(crypto.scryptSync(String(oldMailSecret), KEY_SALT, 32));
if (oldJwtSecret) legacyKeys.push(crypto.createHash('sha256').update(String(oldJwtSecret)).digest());
if (legacyKeys.length === 0) {
  console.warn('[rotate] OLD_SECRET / OLD_JWT_SECRET が未指定。新キーで復号できない行はスキップします。');
}

function decryptWith(key, payload) {
  try {
    const [ivB64, tagB64, dataB64] = String(payload || '').split(':');
    const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

const rows = (await query('SELECT id, password_enc FROM mail_accounts')).rows;
let migrated = 0;
for (const row of rows) {
  if (decryptWith(newKey, row.password_enc)) continue; // 新キーで復号できる = 変更不要
  let plain = null;
  for (const k of legacyKeys) {
    plain = decryptWith(k, row.password_enc);
    if (plain !== null) break;
  }
  if (plain === null) {
    console.warn(`[rotate] ${row.id}: 旧キーで復号できないためスキップ（該当ユーザーはメール接続設定を再登録）`);
    continue;
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, newKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const payload = `${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${enc.toString('base64')}`;
  await query('UPDATE mail_accounts SET password_enc = $1 WHERE id = $2', [payload, String(row.id)]);
  migrated++;
}
console.log(`[rotate] mail_accounts ${rows.length} 件 / 新キーへ再暗号化 ${migrated} 件（新キー ${rows.length - migrated - 0} 件は据え置き）`);
process.exit(0);
