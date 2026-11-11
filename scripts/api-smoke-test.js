/**
 * API 統合スモークテスト (PostgreSQL 連携検証)
 * 起動済みサーバー（`npm start` = HTTPS/WSS 3443）へログインし、主要 GET/POST/PUT/DELETE と全トップレベルAPIを実行する
 * 使用: npm run api:check  (API_BASE 環境変数で URL 指定, 既定 https://127.0.0.1:3443/api)
 * 証明書: CA を明示的に渡す（NODE_EXTRA_CA_CERTS も TLS検証の無効化も使わない — AGENTS.md 第12条）
 */
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CA = [fs.readFileSync(path.join(ROOT, 'certs', 'issystem-ca.crt'))];
const BASE = process.env.API_BASE || 'https://127.0.0.1:3443/api';

let token = '';

// CA を明示した HTTPS リクエスト（fetch は自己署名証明書を弾くため node:https を使う）
function req(method, p, bodyText, tok = token) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE + p);
    const h = { 'Content-Type': 'application/json' };
    if (bodyText) h['Content-Length'] = String(Buffer.byteLength(bodyText));
    if (tok) h.Authorization = `Bearer ${tok}`;
    const r = https.request({ hostname: u.hostname, port: u.port || 443, path: u.pathname + u.search, method, headers: h, ca: CA }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (d += c));
      res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    r.on('error', reject);
    if (bodyText) r.write(bodyText);
    r.end();
  });
}

const loginRes = await req('POST', '/auth/login', JSON.stringify({ staff_code: 'T2026001', password: 'password123' }));
const loginJson = JSON.parse(loginRes.text || '{}');
token =
  loginJson.token ||
  loginJson.accessToken ||
  loginJson?.data?.token ||
  loginJson?.user?.token ||
  loginJson?.result?.token;

console.log('LOGIN', loginRes.status, 'KEYS', Object.keys(loginJson).join(','));
console.log('LOGIN_BODY', loginRes.text.slice(0, 400));

const show = (text, n = 160) => text.replace(/\s+/g, ' ').slice(0, n);

async function get(p) {
  const r = await req('GET', p);
  console.log(`GET ${p} -> ${r.status}`, show(r.text));
}

async function getJson(p) {
  const r = await req('GET', p);
  try {
    return JSON.parse(r.text);
  } catch {
    return {};
  }
}

async function post(p, payload) {
  const r = await req('POST', p, JSON.stringify(payload));
  console.log(`POST ${p} -> ${r.status}`, show(r.text, 220));
  try {
    return JSON.parse(r.text);
  } catch {
    return {};
  }
}

async function put(p, payload) {
  const r = await req('PUT', p, JSON.stringify(payload));
  console.log(`PUT ${p} -> ${r.status}`, show(r.text, 220));
  try {
    return JSON.parse(r.text);
  } catch {
    return {};
  }
}

async function del(p) {
  const r = await req('DELETE', p);
  console.log(`DELETE ${p} -> ${r.status}`, show(r.text, 220));
  try {
    return JSON.parse(r.text);
  } catch {
    return {};
  }
}

const facilitiesRes = await getJson('/facilities');
const facilities = facilitiesRes.data || facilitiesRes.facilities || [];
const facilityIds = facilities.map((f) => f.id);
console.log('FACILITY_IDS', facilityIds.slice(0, 4).join(','), `(count=${facilityIds.length})`);
await get('/facilities/daily-overview?date=2026-11-20');
// 月別予約件数（ミニカレンダーの「●」打点用）。seed の 2026-10 と今月の両方を叩く
const monthCounts = await getJson('/facilities/month-counts?date=2026-10-15');
const mcCounts = monthCounts.counts || {};
console.log(
  'MONTH_COUNTS_CHECK',
  monthCounts.month === '2026-10' && mcCounts['2026-10-15'] >= 1 && mcCounts['2026-10-16'] >= 1
    ? `OK (2026-10-15=${mcCounts['2026-10-15']}, 2026-10-16=${mcCounts['2026-10-16']})`
    : `NG (${JSON.stringify(mcCounts)})`
);
await get('/bulletins');
await get('/chat/channels');
await get('/approvals');

// 実行ごとに一意な日付を用いて、既存データ蓄積による誤判定 (常時 409) を防ぐ
const uniqDate = new Date(Date.now() + 40 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

const reservation = {
  facility_id: facilityIds[0] || 'fac_1',
  title: 'API確認予約',
  target_date: uniqDate,
  start_time: '15:00',
  end_time: '16:00',
};

const firstReservation = await post('/facilities/reservations', reservation);
const secondReservation = await post('/facilities/reservations', reservation); // 二重予約 -> 409 期待

// テスト予約は後片付けしてデータを蓄積させない
const firstReservationId = firstReservation?.reservation?.id || firstReservation?.data?.id;
if (firstReservationId) {
  await del(`/facilities/reservations/${firstReservationId}`);
}
console.log('RESERVATION_CHECK', firstReservation?.success === true && secondReservation?.success === false ? 'OK (201 → 409)' : 'NG');

// --- 招待コード発行とパスワード再設定 (新規登録・パスワード再設定で共用される共通コード) ---
const invitation = await post('/auth/generate-invitation', {});
const inviteCode = invitation?.code || invitation?.invitation?.code;
console.log('INVITATION_CODE_CHECK', inviteCode ? `OK (${inviteCode})` : 'NG (code がトップレベルで返っていない)');

// 未登録の教職員番号でのパスワード再設定 -> 404 期待 (このコードは消費されない)
const resetRes = await req('POST', '/auth/reset-password-invitation', JSON.stringify({ invitationCode: inviteCode, staff_code: 'T99999999', newPassword: 'ResetPass123!' }), '');
let resetJson = {};
try {
  resetJson = JSON.parse(resetRes.text);
} catch {}
console.log('POST /auth/reset-password-invitation ->', resetRes.status, show(JSON.stringify(resetJson), 220));
console.log('RESET_PASSWORD_CHECK', resetRes.status === 404 ? 'OK (未登録教職員番号は 404)' : 'NG');

// --- 決裁ワークフロー (approvals) と専用チャット自動連携の検証 ---
const created = await post('/approvals', {
  title: 'API決裁申請確認',
  category: 'PURCHASE',
  description: 'スモークテストによる自動生成申請',
  amount: 15000,
  approver_id: 't-tanaka',
});

const approvalId = created?.approval?.id || created?.data?.id || created?.id;

if (approvalId) {
  await get(`/approvals/${approvalId}`);
  await put(`/approvals/${approvalId}/process`, { status: 'APPROVED', comment: 'スモークテスト承認' });
}

// --- 広域 GET 網羅 (モデル / サービスの整合確認・全トップレベルAPIを叩く＝第7条) ---
const sweep = [
  '/auth/me',
  '/users',
  '/subjects',
  '/basic-info',
  '/bulletins/post_1',
  // ★ 職員全体チャット撤廃（v3.1.2）: general は存在しない。seed の参加グループ kyomu を叩く
  '/chat/channels/kyomu/messages',
  '/chat/channels/kyomu/members',
  `/facilities/${facilityIds[0] || 'fac_1'}/reservations?date=2026-11-20`,
  '/schedules',
  '/schedules/categories',
  '/schedules/today',
  '/seating/layouts',
  '/seating/master',
  '/seating/matrix',
  '/seating/students/search?name=%E8%99%88',
  '/exam',
  '/exam/masters',
  '/exam-survey-status',
  '/staff/pool',
  '/news',
  '/news/weather',
  '/news/health',
  // ★ 「記事を共有」の行き先は news_links（チャット投稿はしない＝v3.1.7）。共有リンク一覧を叩く
  '/news/links',
  '/news/dashboard-widget',
  '/absences',
  '/absences/teachers',
  '/mail/account',
  '/mail/messages',
  '/audit/logs',
];

for (const path of sweep) {
  await get(path);
}

// --- 掲示板作成 / コメント / 既読 / 承認 ---
const bulletin = await post('/bulletins', {
  title: 'API確認掲示',
  content: 'スモークテストによる自動生成投稿',
  author_id: 'kyomu01',
});
const bulletinId =
  bulletin?.post?.id || bulletin?.bulletin?.id || bulletin?.data?.id || bulletin?.id;

if (bulletinId) {
  await post(`/bulletins/${bulletinId}/comments`, {
    comment: 'API確認コメント',
    user_id: 't-tanaka',
  });
  await put('/bulletins/post_1/read', { status: 'READ', user_id: 'kyomu01' });
  await put(`/bulletins/${bulletinId}/approve`, { approved: true });
}

// --- チャットチャンネル作成 / メッセージ投稿 / 既読 ---
const channel = await post('/chat/channels', {
  name: 'API確認チャンネル',
  type: 'GROUP',
  member_ids: ['kyomu01', 't-tanaka'],
});
const channelId = channel?.channel?.id || channel?.data?.id || channel?.id;

if (channelId) {
  await post(`/chat/channels/${channelId}/messages`, {
    sender_id: 'kyomu01',
    message: 'API確認メッセージ',
  });
  await get(`/chat/channels/${channelId}/messages`);
  await put(`/chat/channels/${channelId}/read`, {});
}

// --- スケジュール CRUD (カテゴリ複数紐付け・カテゴリフィルタ) ---
const categoryRes = await getJson('/schedules/categories');
const categories = categoryRes.categories || categoryRes.data || [];
console.log('CATEGORIES', categories.length, categories.map((c) => `${c.id}:${c.name}:${c.color_key}`).join(' '));

// --- 部署カテゴリの権限検証 (追加・改名・削除は教務部 KYOMU のみ) ---
const adminLoginRes = await req('POST', '/auth/login', JSON.stringify({ staff_code: 'T2026000', password: 'password123' }), '');
const adminJson = JSON.parse(adminLoginRes.text || '{}');
const adminToken = adminJson.token || adminJson?.data?.token || adminJson?.user?.token;
const asAdmin = async (method, p, payload = null) => {
  const r = await req(method, p, payload ? JSON.stringify(payload) : undefined, adminToken);
  let j = {};
  try {
    j = JSON.parse(r.text);
  } catch {}
  return { status: r.status, json: j };
};

const adminCreate = await asAdmin('POST', '/schedules/categories', { name: 'API確認部署', color_key: 'SLATE', sort_order: 91 });
console.log('CATEGORY_CREATE_BY_ADMIN', adminCreate.status, adminCreate.status === 403 ? 'OK (ADMIN拒否)' : 'NG');

const kyomuCreateRes = await req('POST', '/schedules/categories', JSON.stringify({ name: 'API確認部署', color_key: 'SLATE', sort_order: 91 }));
let kyomuCreate = {};
try {
  kyomuCreate = JSON.parse(kyomuCreateRes.text);
} catch {}
const newCatId = kyomuCreate?.category?.id || kyomuCreate?.data?.id;
console.log('CATEGORY_CREATE_BY_KYOMU', kyomuCreateRes.status, kyomuCreateRes.status === 201 ? 'OK' : 'NG');

if (newCatId) {
  const adminDel = await asAdmin('DELETE', `/schedules/categories/${newCatId}`);
  console.log('CATEGORY_DELETE_BY_ADMIN', adminDel.status, adminDel.status === 403 ? 'OK (ADMIN拒否)' : 'NG');
  const adminPut = await asAdmin('PUT', `/schedules/categories/${newCatId}`, { name: 'API確認部署' });
  console.log('CATEGORY_UPDATE_BY_ADMIN', adminPut.status, adminPut.status === 403 ? 'OK (ADMIN拒否)' : 'NG');
  const kyomuDelRes = await req('DELETE', `/schedules/categories/${newCatId}`);
  console.log('CATEGORY_DELETE_BY_KYOMU', kyomuDelRes.status, kyomuDelRes.status === 200 ? 'OK' : 'NG');
}

const schedule = await post('/schedules', {
  title: 'API確認予定',
  event_date: '2026-12-01',
  category: 'MEETING',
  category_ids: categories.slice(0, 2).map((c) => c.id),
  created_by_user_id: 'kyomu01',
});
const scheduleId = schedule?.schedule?.id || schedule?.data?.id || schedule?.id;

if (scheduleId) {
  const createdCatIds = (schedule?.schedule?.categoryIds || []).map(Number);
  console.log('SCHEDULE_CATEGORY_IDS', JSON.stringify(createdCatIds), createdCatIds.length >= 2 ? 'OK (multi)' : 'NG');
  // カテゴリフィルタ (いずれか1つ以上を含む行事のみ)
  await get(`/schedules?startDate=2026-12-01&endDate=2026-12-01&categoryIds=${categories[0].id}`);
  await get(`/schedules?startDate=2026-12-01&endDate=2026-12-01&categoryIds=${categories[1].id}`);
  const outsideCat = categories.find((c) => !createdCatIds.includes(c.id));
  const outside = await getJson(`/schedules?startDate=2026-12-01&endDate=2026-12-01&categoryIds=${outsideCat.id}`);
  const listed = (outside.data || outside.schedules || []).some((s) => s.id === scheduleId);
  console.log('CATEGORY_FILTER', listed ? 'NG (未選択カテゴリで混入)' : 'OK (OR条件で除外)');
  await put(`/schedules/${scheduleId}`, { title: 'API確認予定(更新)', category_ids: [categories[0].id] });
  await del(`/schedules/${scheduleId}`);
}

// --- 予約作成 → キャンセル ---
const newRes = await post('/facilities/reservations', {
  facility_id: facilityIds[1] || 'fac_2',
  title: 'API確認予約B',
  target_date: '2026-12-05',
  start_time: '10:00',
  end_time: '11:00',
});
const reservationId = newRes?.reservation?.id || newRes?.data?.id;

if (reservationId) {
  await del(`/facilities/reservations/${reservationId}`);
}

// --- 全トップレベルAPI被覆確認（読取専用 GET。各セグメントがスモークで叩かれる） ---
// 読取のみでデータを変えない。ステータスを表示し、スモークが全APIセグメントを網羅していることを
// node scripts/verify-docs.mjs が src/routes/index.js と突き合わせて検証する。
const coveragePaths = [
  '/subjects',
  '/basic-info',
  '/mail/account',
  '/exam-survey-status',
  '/staff/pool',
  '/external/news',
  '/external/weather',
  '/absences',
];
for (const p of coveragePaths) {
  await get(p);
}

process.exit(0);
