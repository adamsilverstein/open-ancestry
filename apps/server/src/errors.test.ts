import { describe, expect, it } from 'vitest';
import { createServer } from './index';
import { HOST } from './test/helpers';

/** A server with one extra route that throws `error`. */
async function throwing(error: unknown) {
  const app = createServer({ library: '/nonexistent-oa-library' });
  app.get('/api/boom', async () => {
    throw error;
  });
  const res = await app.inject({ method: 'GET', url: '/api/boom', headers: { host: HOST } });
  await app.close();
  return res;
}

describe('error envelope', () => {
  it('hides internal errors behind a generic 500', async () => {
    const res = await throwing(new Error('SQLITE secret path /Users/x'));
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({
      error: { code: 'internal_error', message: 'Internal server error' },
    });
  });

  it.each([
    [Object.assign(new Error('bad media'), { statusCode: 415 }), 415, 'unsupported_media_type'],
    [Object.assign(new Error('bad'), { statusCode: 400 }), 400, 'bad_request'],
    [Object.assign(new Error('gone'), { statusCode: 404 }), 404, 'not_found'],
    [
      Object.assign(new Error('UNIQUE failed'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }),
      409,
      'conflict',
    ],
  ])('maps %s', async (error, status, code) => {
    const res = await throwing(error);
    expect(res.statusCode).toBe(status);
    expect(res.json().error.code).toBe(code);
  });
});
