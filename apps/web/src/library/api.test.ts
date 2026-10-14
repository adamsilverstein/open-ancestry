import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, deleteTree, hasImportExtension, importIntoNewTree } from './api';

describe('import helpers', () => {
  it('accepts GEDCOM and GEDZIP extensions in any case', () => {
    expect(hasImportExtension('Family.GED')).toBe(true);
    expect(hasImportExtension('export.gedcom')).toBe(true);
    expect(hasImportExtension('tree.zip')).toBe(true);
    expect(hasImportExtension('tree.gdz')).toBe(true);
    expect(hasImportExtension('notes.txt')).toBe(false);
    expect(hasImportExtension('ged')).toBe(false);
  });
});

/** Every session fetch issues a new token, like a restarted server. */
let tokens = 0;

describe('importIntoNewTree and mutations', () => {
  afterEach(() => vi.unstubAllGlobals());

  function server(handle: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; method: string; token?: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        calls.push({ url, method: init.method ?? 'GET', token: headers['x-oa-token'] });
        if (url === '/api/session') {
          return Response.json({ token: `t${++tokens}`, tokenHeader: 'x-oa-token' });
        }
        return handle(url, init);
      }),
    );
    return calls;
  }

  it('uploads to the server-owned import route and reports the new tree', async () => {
    const calls = server((url, init) => {
      expect(init.body).toBeInstanceOf(FormData);
      return url === '/api/import'
        ? Response.json({ jobId: 'j1', job: { tree: 'Vale 2' } }, { status: 202 })
        : Response.json({}, { status: 404 });
    });
    expect(await importIntoNewTree(new File(['0 HEAD'], 'Vale.ged'))).toEqual({
      jobId: 'j1',
      tree: 'Vale 2',
    });
    // No tree is created or deleted from the client.
    expect(
      calls.filter((c) => c.url !== '/api/session').map((c) => `${c.method} ${c.url}`),
    ).toEqual(['POST /api/import']);
  });

  it('refreshes the session token once after a 403 (server restarted)', async () => {
    let attempts = 0;
    const calls = server(() =>
      ++attempts === 1
        ? Response.json({ error: { code: 'forbidden', message: 'bad token' } }, { status: 403 })
        : new Response(null, { status: 204 }),
    );
    await deleteTree('T');
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(2);
    expect(deletes[0]!.token).not.toBe(deletes[1]!.token);

    attempts = -10;
    server(() =>
      Response.json({ error: { code: 'forbidden', message: 'still no' } }, { status: 403 }),
    );
    const error = await deleteTree('T').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(403);
  });
});
