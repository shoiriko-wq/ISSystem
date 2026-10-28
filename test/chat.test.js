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
    expect(res.body.data.some((c) => c.id === 'general')).toBe(true);
  });

  it('GET /api/chat/channels/general/members - シード済みメンバー一覧が返ること', async () => {
    const res = await request(app)
      .get('/api/chat/channels/general/members')
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.count).toBeGreaterThanOrEqual(5);
    expect(res.body.data.some((m) => m.user_id === 'kyomu01')).toBe(true);
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

  it('DELETE /api/chat/channels/:id - 自作チャンネルを削除できること', async () => {
    const res = await request(app)
      .delete(`/api/chat/channels/${channelId}`)
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('DELETE /api/chat/channels/general - 公開チャンネルは削除不可 (400)', async () => {
    const res = await request(app)
      .delete('/api/chat/channels/general')
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(400);
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
