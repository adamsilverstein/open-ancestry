import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, hasImportExtension, importIntoNewTree, treeNameFromFile } from './api';

describe('import helpers', () => {
  it('accepts GEDCOM and GEDZIP extensions in any case', () => {
    expect(hasImportExtension('Family.GED')).toBe(true);
    expect(hasImportExtension('export.gedcom')).toBe(true);
    expect(hasImportExtension('tree.zip')).toBe(true);
    expect(hasImportExtension('tree.gdz')).toBe(true);
    expect(hasImportExtension('notes.txt')).toBe(false);
    expect(hasImportExtension('ged')).toBe(false);
  });

  it('turns a file name into a tree name the library accepts', () => {
    expect(treeNameFromFile('Vale Family Tree.ged')).toBe('Vale Family Tree');
    expect(treeNameFromFile('a/b:c%d.ged')).toBe('a b c d');
    expect(treeNameFromFile('..hidden..ged')).toBe('hidden');
    expect(treeNameFromFile('CON.ged')).toBe('Imported CON');
    expect(treeNameFromFile('.ged')).toBe('Imported');
    expect(treeNameFromFile(`${'x'.repeat(200)}.ged`)).toHaveLength(90);
  });
});

describe('importIntoNewTree', () => {
  afterEach(() => vi.unstubAllGlobals());

  function server(handlers: ((url: string, init: RequestInit) => Response | undefined)[]) {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit = {}) => {
        calls.push({ url, method: init.method ?? 'GET', body: init.body });
        if (url === '/api/session') return Response.json({ token: 't', tokenHeader: 'x-oa-token' });
        for (const handler of handlers) {
          const response = handler(url, init);
          if (response) return response;
        }
        return Response.json({ error: { code: 'not_found', message: 'nope' } }, { status: 404 });
      }),
    );
    return calls;
  }

  it('adds a number when the name is taken, then uploads', async () => {
    const calls = server([
      (url, init) =>
        url === '/api/trees' && JSON.parse(String(init.body)).name === 'Vale'
          ? Response.json({ error: { code: 'conflict', message: 'exists' } }, { status: 409 })
          : undefined,
      (url, init) =>
        url === '/api/trees'
          ? Response.json({ tree: { id: JSON.parse(String(init.body)).name } }, { status: 201 })
          : undefined,
      (url) =>
        url.endsWith('/import') ? Response.json({ jobId: 'j1' }, { status: 202 }) : undefined,
    ]);
    const result = await importIntoNewTree(new File(['0 HEAD'], 'Vale.ged'));
    expect(result).toEqual({ jobId: 'j1', tree: 'Vale 2' });
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET /api/session',
      'POST /api/trees',
      'POST /api/trees',
      'POST /api/trees/Vale%202/import',
    ]);
  });

  it('removes the new tree when the upload is refused', async () => {
    const calls = server([
      (url) =>
        url === '/api/trees' ? Response.json({ tree: { id: 'T' } }, { status: 201 }) : undefined,
      (url) =>
        url.endsWith('/import')
          ? Response.json(
              { error: { code: 'payload_too_large', message: 'too big' } },
              { status: 413 },
            )
          : undefined,
      (url, init) => (init.method === 'DELETE' ? new Response(null, { status: 204 }) : undefined),
    ]);
    const error = await importIntoNewTree(new File(['x'], 'T.ged')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(413);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', url: '/api/trees/T' });
  });
});
