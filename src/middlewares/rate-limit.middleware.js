/**
 * レート制限ミドルウェア (v3.0.7: ログイン・招待コード登録/リセット・招待コード発行の総当たり対策)
 * express-rate-limit v8・メモリストア（単一サーバーのプロセス内ウィンドウ）。
 * keyGenerator が req.ip + 識別子/コード のカスタムキーを生成するため、IP 正規化オプションは不要。
 * trust proxy 未設定なので req.ip はソケット直結アドレス（X-Forwarded-For は信用されない）。
 * - ログイン: IP + 識別子（小文字正規化）キー、失敗のみカウント（成功はスキップ）、15分 5 回 → 429
 * - 招待コード登録: IP + コードキー、15分 5 試行 → 429（コード単位試行カウンタ）
 * - 招待コードによるパスワードリセット: IP + コード + staff_code キー、15分 5 試行 → 429
 * - 招待コード発行: IP + ユーザーキー、15分 30 回 → 429
 * - 認証系グローバル: IP キー、失敗のみ 1時間 60 回 → 429（識別子列挙保護）
 */
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';

const WINDOW_LOGIN = 15 * 60 * 1000;
const WINDOW_HOUR = 60 * 60 * 1000;

const base = {
  standardHeaders: 'draft-7',
  legacyHeaders: false,
};

// IPv6 は /48 で束ね、IPv4 はそのまま（v8 の ipKeyGenerator helper。警告 ERR_ERL_KEY_GEN_IPV6 対策）
const ipKey = (req) => ipKeyGenerator(req.ip, 48);

const normalizeId = (v) => String(v || '').trim().toLowerCase();

export const loginLimiter = rateLimit({
  ...base,
  windowMs: WINDOW_LOGIN,
  limit: 5,
  skipSuccessfulRequests: true,
  keyGenerator: (req) =>
    `login|${ipKey(req)}|${normalizeId(req.body?.staff_code || req.body?.staffCode || req.body?.username || req.body?.userId || req.body?.email)}`,
  message: { success: false, message: 'ログイン試行が多すぎます。15分後に再試行してください。' },
});

export const authIpLimiter = rateLimit({
  ...base,
  windowMs: WINDOW_HOUR,
  limit: 200, // 1時間 200 試行（失敗のみカウント）。NAT 共有 IP の通常運用（成功はカウントしない）で枯渇しない水準
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `authip|${ipKey(req)}`,
  message: { success: false, message: '認証系リクエストが多すぎます。1時間後に再試行してください。' },
});

export const registerInvitationLimiter = rateLimit({
  ...base,
  windowMs: WINDOW_LOGIN,
  limit: 5,
  keyGenerator: (req) => `register|${ipKey(req)}|${String(req.body?.invitationCode || '').trim().toUpperCase()}`,
  message: { success: false, message: 'この招待コードの試行回数上限を超えました。15分後に再試行してください。' },
});

export const resetInvitationLimiter = rateLimit({
  ...base,
  windowMs: WINDOW_LOGIN,
  limit: 5,
  keyGenerator: (req) =>
    `reset|${ipKey(req)}|${String(req.body?.invitationCode || '').trim().toUpperCase()}|${normalizeId(req.body?.staff_code)}`,
  message: { success: false, message: 'この招待コードの試行回数上限を超えました。15分後に再試行してください。' },
});

export const generateInvitationLimiter = rateLimit({
  ...base,
  windowMs: WINDOW_LOGIN,
  limit: 30,
  keyGenerator: (req) => `geninvite|${ipKey(req)}|${req.user?.id || 'anon'}`,
  message: { success: false, message: '招待コード発行が多すぎます。15分後に再試行してください。' },
});
