/**
 * ISSystem Access Log File Output (v3.0.8, §15 監査 #5 ログ権限/保存期間管理)
 * morgan stream: data/logs/access-YYYY-MM-DD.log を日次ローテーション、
 * ディレクトリ権限 700 (所有者のみ)、ファイル権限 600。
 * 保持: 監査ログと同じ cron (3:00 AM) で AUDIT_RETENTION_DAYS 経過後のファイルを削除。
 * morgan combined/dev 行 (IP・URL・ステータス) のみ。auth.service.js は照合失敗時
 * identifier を出すため bcrypt ハッシュ ($2b$...) はログに現れない。
 */

import fs from 'fs';
import path from 'path';
import config from '../../config/default.js';

const LOG_DIR = config.logging.logDir;

let currentDate = null;
let currentStream = null;

function todayFileName() {
  const d = new Date();
  const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `access-${ymd}.log`;
}

function ensurePermissions() {
  fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o700 });
  // 既存ディレクトリには mkdir の mode が適用されないため chmodSync で 700 を強制
  try {
    fs.chmodSync(LOG_DIR, 0o700);
  } catch (e) {
    console.warn('[AccessLog] ディレクトリ権限設定に失敗:', e.message);
  }
}

function getStream() {
  const fileName = todayFileName();
  if (currentStream && currentDate === fileName) return currentStream;
  ensurePermissions();
  const filePath = path.join(LOG_DIR, fileName);
  const existed = fs.existsSync(filePath);
  const stream = fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
  if (existed) {
    // 既存ファイルは createWriteStream の mode が無視されるため chmodSync で 600 を強制
    try {
      fs.chmodSync(filePath, 0o600);
    } catch (e) {
      console.warn('[AccessLog] ファイル権限設定に失敗:', e.message);
    }
  }
  if (currentStream) {
    try {
      currentStream.end();
    } catch (e) {
      /* 旧 stream のクローズ失敗は無視 */
    }
  }
  currentStream = stream;
  currentDate = fileName;
  return currentStream;
}

/** morgan の stream オプションに渡すオブジェクト (遅延作成・日次切替) */
export function createAccessLogStream() {
  return {
    write: (chunk) => {
      try {
        getStream().write(chunk);
      } catch (e) {
        console.warn('[AccessLog] 書き込み失敗:', e.message);
      }
    },
  };
}

/**
 * 保持期間を超過したアクセスログファイルを削除 (cron 3:00 AM が呼ぶ)
 * @param {number} days 保持日数 (config.limits.auditRetentionDays)
 * @returns {string[]} 削除したファイル名
 */
export function cleanupAccessLogs(days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const removed = [];
  try {
    for (const f of fs.readdirSync(LOG_DIR)) {
      const m = f.match(/^access-(\d{4}-\d{2}-\d{2})\.log$/);
      if (!m) continue;
      // ファイル名の日付 (その日の 23:59:59) が cutoff より前なら削除
      const fileEnd = new Date(`${m[1]}T23:59:59`);
      if (fileEnd < cutoff) {
        fs.unlinkSync(path.join(LOG_DIR, f));
        removed.push(f);
      }
    }
  } catch (e) {
    console.warn('[AccessLog] クリーンアップ失敗:', e.message);
  }
  return removed;
}

export default createAccessLogStream;
