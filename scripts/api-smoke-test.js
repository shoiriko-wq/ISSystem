/**
 * API 統合スモークテスト (PostgreSQL 連携検証)
 * 起動済みサーバーへログインし、主要 GET/POST/PUT/DELETE エンドポイントを実行する
 * 使用: npm run api:check  (API_BASE 環境変数で URL 指定, 既定 http://localhost:3100/api)
 */

const BASE = process.env.API_BASE || 'http://localhost:3100/api';

const loginRes = await fetch(`${BASE}/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ staff_code: 'T2026001', password: 'password123' }),
});

const loginJson = await loginRes.json().catch(() => ({}));
const token =
  loginJson.token ||
  loginJson.accessToken ||
  loginJson?.data?.token ||
  loginJson?.user?.token ||
  (loginJson?.user && loginJson.user.token) ||
  loginJson?.result?.token;

console.log('LOGIN', loginRes.status, 'KEYS', Object.keys(loginJson).join(','));
console.log('LOGIN_BODY', JSON.stringify(loginJson).slice(0, 400));

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

const show = (text, n = 160) => text.replace(/\s+/g, ' ').slice(0, n);

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers });
  const body = await res.text();
  console.log(`GET ${path} -> ${res.status}`, show(body));
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { headers });
  return res.json().catch(() => ({}));
}

async function post(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  console.log(`POST ${path} -> ${res.status}`, show(JSON.stringify(json), 220));
  return json;
}

async function put(path, payload) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  console.log(`PUT ${path} -> ${res.status}`, show(JSON.stringify(json), 220));
  return json;
}

await get('/facilities');
await get('/facilities/daily-overview?date=2026-11-20');
await get('/bulletins');
await get('/chat/channels');
await get('/approvals');

// 実行ごとに一意な日付を用いて、既存データ蓄積による誤判定 (常時 409) を防ぐ
const uniqDate = new Date(Date.now() + 40 * 86400000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });

const reservation = {
  facility_id: '1',
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

async function del(path) {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers });
  const json = await res.json().catch(() => ({}));
  console.log(`DELETE ${path} -> ${res.status}`, show(JSON.stringify(json), 220));
  return json;
}

// --- 広域 GET 網羅 (モデル / サービスの整合確認) ---
const sweep = [
  '/auth/me',
  '/users',
  '/bulletins/post_1',
  '/chat/channels/general/messages',
  '/chat/channels/general/members',
  '/facilities/1/reservations?date=2026-11-20',
  '/schedules',
  '/schedules/categories',
  '/schedules/today',
  '/seating/layouts',
  '/seating/master',
  '/exam',
  '/exam/masters',
  '/news/dashboard-widget',
  '/audit/logs',
];

for (const path of sweep) {
  await get(path);
}

// --- 掲示板作成 / コメント / 既読 / 承認 ---
const bulletin = await post('/bulletins', {
  title: 'API確認回覧',
  content: 'スモークテストによる自動生成投稿',
  post_type: 'NOTICE',
  priority: 'NORMAL',
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
  facility_id: '2',
  title: 'API確認予約B',
  target_date: '2026-12-05',
  start_time: '10:00',
  end_time: '11:00',
});
const reservationId = newRes?.reservation?.id || newRes?.data?.id;

if (reservationId) {
  await del(`/facilities/reservations/${reservationId}`);
}

process.exit(0);
