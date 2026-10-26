/**
 * 決裁・承認申請 API 統合テスト (approvals)
 * 申請作成 → 一覧 → 詳細 → 承認処理のフローを検証する
 */
import request from 'supertest';
import app from '../src/app.js';
import { loginToken, bearer, pickId, closePool } from './helpers.js';

describe('Approval API (/api/approvals)', () => {
  let token;
  let approvalId = null;

  beforeAll(async () => {
    token = await loginToken(app);
  });

  afterAll(async () => {
    await closePool();
  });

  it('GET /api/approvals - 決裁申請の一覧が返ること', async () => {
    const res = await request(app).get('/api/approvals').set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.approvals.length).toBeGreaterThanOrEqual(3);
    expect(res.body.approvals.some((a) => a.status === 'PENDING')).toBe(true);
  });

  it('POST /api/approvals - 新規申請を 201 で作成できること', async () => {
    const res = await request(app)
      .post('/api/approvals')
      .set('Authorization', bearer(token))
      .send({
        title: 'Jest決裁申請',
        category: 'PURCHASE',
        description: 'テストによる自動生成申請',
        amount: 12000,
        approver_id: 't-tanaka',
      });
    expect(res.statusCode).toBe(201);
    approvalId = pickId(res.body);
    expect(approvalId).toBeTruthy();
    expect(res.body.approval.status).toBe('PENDING');
    expect(res.body.approval.applicant_id).toBe('kyomu01');
  });

  it('GET /api/approvals/:id - 作成した申請の詳細を取得できること', async () => {
    const res = await request(app)
      .get(`/api/approvals/${approvalId}`)
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(200);
    expect(res.body.approval.title).toBe('Jest決裁申請');
    expect(res.body.approval.approver_id).toBe('t-tanaka');
  });

  it('PUT /api/approvals/:id/process - 承認処理で status が APPROVED になること', async () => {
    const res = await request(app)
      .put(`/api/approvals/${approvalId}/process`)
      .set('Authorization', bearer(token))
      .send({ status: 'APPROVED', comment: 'Jest承認' });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    const detail = await request(app)
      .get(`/api/approvals/${approvalId}`)
      .set('Authorization', bearer(token));
    expect(detail.body.approval.status).toBe('APPROVED');
    expect(detail.body.approval.comment).toBe('Jest承認');
  });

  it('PUT /api/approvals/:id/process - 無効なステータスは 400', async () => {
    const res = await request(app)
      .put(`/api/approvals/${approvalId}/process`)
      .set('Authorization', bearer(token))
      .send({ status: 'MAYBE' });
    expect(res.statusCode).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('GET /api/approvals/:id - 存在しない ID は 404', async () => {
    const res = await request(app)
      .get('/api/approvals/not-exist')
      .set('Authorization', bearer(token));
    expect(res.statusCode).toBe(404);
  });
});
