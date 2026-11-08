/**
 * ISSystem Unit Tests - Error Middleware (v3.0.8, §15 監査 #5)
 * stack トレース秘匿検証: development + ループバックのみ stack を返す。
 * 本番・外部 IP (LAN 越し開発) では絶対にレスポンスに stack を含めない。
 */

import { errorHandler, notFoundHandler } from '../src/middlewares/error.middleware.js';
import { closePool } from './helpers.js';

function mockRes() {
  return {
    statusCode: 200,
    jsonBody: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
  };
}

describe('error.middleware - stack 出力秘匿', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it('production では stack をレスポンスに含めない', () => {
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    const req = { ip: '127.0.0.1', method: 'GET', originalUrl: '/api/x' };
    errorHandler(new Error('boom-500'), req, res, () => {});
    expect(res.statusCode).toBe(500);
    expect(res.jsonBody.stack).toBeUndefined();
  });

  it('development + ループバック (127.0.0.1) では stack を返す', () => {
    process.env.NODE_ENV = 'development';
    const res = mockRes();
    const req = { ip: '127.0.0.1', method: 'GET', originalUrl: '/api/x' };
    errorHandler(new Error('boom-dev'), req, res, () => {});
    expect(res.jsonBody.stack).toContain('Error: boom-dev');
  });

  it('development + 外部 IP (LAN 越し) では stack を返さない', () => {
    process.env.NODE_ENV = 'development';
    const res = mockRes();
    const req = { ip: '203.0.113.5', method: 'GET', originalUrl: '/api/x' };
    errorHandler(new Error('boom-lan'), req, res, () => {});
    expect(res.jsonBody.stack).toBeUndefined();
  });

  it('404 notFoundHandler は 404 ApiError を生成し stack を含めない', () => {
    process.env.NODE_ENV = 'production';
    const res = mockRes();
    const req = { ip: '127.0.0.1', method: 'GET', originalUrl: '/api/nope' };
    notFoundHandler(req, res, (err) => errorHandler(err, req, res, () => {}));
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody.stack).toBeUndefined();
  });

  afterAll(async () => {
    await closePool();
  });
});
