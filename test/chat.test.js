/**
 * チャット・協議室 API 統合テスト (chat)
 * チャンネル作成 → メッセージ投稿 → 既読 → メンバー一覧 → 削除を検証する
 */
import request from 'supertest';
import app from '../src/app.js';
import { loginToken, bearer, pickId, closePool } from './helpers.js';

describe('Chat API (/api/chat)', () => {
  let token;
  let channelId = null;

  beforeAll(async () => {
    token = await loginToken(app);
  });

  afterAll(async () => {
    await closePool();
  });

  it('GET /api/chat/channels - 参加中のチャンネル一覧が返ること', async () => {
    const res = await request(app).get('/api/chat/channels').set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
    // ★ 職員全体チャット撤廃（2026/11/9 v3.1.2）: general / PUBLIC は存在しない
    expect(res.body.data.some((c) => c.id === 'general')).toBe(false);
    expect(res.body.data.some((c) => c.type === 'PUBLIC')).toBe(false);
  });

  it('GET /api/chat/channels/kyomu/members - シード済みグループのメンバー一覧が返ること', async () => {
    const res = await request(app)
      .get('/api/chat/channels/kyomu/members')
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(2);
    expect(res.body.data.some((m) => m.user_id === 'kyomu01')).toBe(true);
    expect(res.body.data.some((m) => m.user_id === 't-tanaka')).toBe(true);
  });

  it('POST /api/chat/channels - 新規チャンネルを 201 で作成できること', async () => {
    const res = await request(app)
      .post('/api/chat/channels')
      .set('Authorization', bearer(token))
      .send({
        name: 'Jest確認チャンネル',
        type: 'GROUP',
        member_ids: ['kyomu01', 't-tanaka'],
        memberIds: ['kyomu01', 't-tanaka'],
      });
    expect(res.statusCode).toBe(201);
    channelId = pickId(res.body);
    expect(channelId).toBeTruthy();
    expect(res.body.data.name).toBe('Jest確認チャンネル');
  });

  it('POST /api/chat/channels/:id/messages - メッセージを 201 で投稿できること', async () => {
    const res = await request(app)
      .post(`/api/chat/channels/${channelId}/messages`)
      .set('Authorization', bearer(token))
      .send({ sender_id: 'kyomu01', message: 'Jest確認メッセージ' });
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
  });

  it('POST /api/chat/channels/:id/messages - 新着メッセージの未読者はメンバー（送信者以外）であること', async () => {
    const res = await request(app)
      .post(`/api/chat/channels/${channelId}/messages`)
      .set('Authorization', bearer(token))
      .send({ sender_id: 'kyomu01', message: '未読者名簿確認メッセージ' });
    expect(res.statusCode).toBe(201);

    const sent = res.body.data || res.body.messageData || res.body.chatMessage || res.body.message;
    // 投稿直後に未読者名簿が空だと「全員既読」表示化してしまう（UI 症状の根元）
    expect(Array.isArray(sent.unreadIds)).toBe(true);
    expect(Array.isArray(sent.unreaders)).toBe(true);
    expect(sent.unreadIds.includes('kyomu01')).toBe(false);
    expect(sent.unreadIds.length).toBeGreaterThanOrEqual(1);
    expect(sent.unreaders.length).toBe(sent.unreadIds.length);
    expect(sent.unreadIds.includes('t-tanaka')).toBe(true);
  });

  it('GET /api/chat/channels/:id/messages - 投稿したメッセージが取得できること', async () => {
    const res = await request(app)
      .get(`/api/chat/channels/${channelId}/messages`)
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.data.some((m) => m.message === 'Jest確認メッセージ')).toBe(true);
    expect(res.body.data.every((m) => 'sender_avatar' in m)).toBe(true);
  });

  it('PUT /api/chat/channels/:id/read - 既読位置を更新できること', async () => {
    const res = await request(app)
      .put(`/api/chat/channels/${channelId}/read`)
      .set('Authorization', bearer(token))
      .send({});
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/chat/channels/:id/messages - 自分の既読更新で他人の未読まで消えない（一斉全員既読化しない）', async () => {
    const res = await request(app)
      .get(`/api/chat/channels/${channelId}/messages`)
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);

    const target = res.body.data.find((m) => m.message === '未読者名簿確認メッセージ');
    expect(target).toBeTruthy();
    // 送信者（自分）は未読者名簿の対象外
    expect(target.unreadIds.includes('kyomu01')).toBe(false);
    // 未閲覧メンバー（田中先生）の未読はそのまま残る＝自分の既読更新で全員既読化しない
    expect(target.unreadIds.includes('t-tanaka')).toBe(true);
    expect(target.unreadIds.length).toBeGreaterThanOrEqual(1);
  });

  it('DELETE /api/chat/channels/:id - 自作チャンネルを削除できること', async () => {
    const res = await request(app)
      .delete(`/api/chat/channels/${channelId}`)
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('GET /api/chat/channels/grade1/messages - 非メンバーはグループを閲覧不可 (403)', async () => {
    // ★ 職員全体チャット撤廃（2026/11/9 v3.1.2）: PUBLIC の抜け道が無いためメンバーのみ閲覧できる
    const res = await request(app)
      .get('/api/chat/channels/grade1/messages')
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(403);
    expect(res.body.success).toBe(false);
  });

  it('DELETE /api/chat/channels/general - 職員全体チャンネルは撤廃済み (404)', async () => {
    const res = await request(app)
      .delete('/api/chat/channels/general')
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('POST /api/chat/channels - チャンネル名欠落は 400', async () => {
    const res = await request(app)
      .post('/api/chat/channels')
      .set('Authorization', bearer(token))
      .send({ type: 'GROUP' });
    expect(res.statusCode).toBe(400);
  });
});
