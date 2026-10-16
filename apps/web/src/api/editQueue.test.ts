import { onlineManager, QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryClient as appClient } from '../app/queryClient';
import { apiSend, ApiError } from './client';
import type * as Client from './client';
import { editKey, editScope } from './edits';
import { undoRedo } from './history';

vi.mock('./client', async (original) => {
  const actual = await original<typeof Client>();
  return { ...actual, apiSend: vi.fn() };
});

afterEach(() => {
  vi.mocked(apiSend).mockReset();
  onlineManager.setOnline(true);
});

/** A deferred: a promise and the function that resolves it. */
function deferred<T = void>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('undo joins the edit queue', () => {
  it('runs after edits made before it, and edits made after it wait for it', async () => {
    const client = new QueryClient();
    client.setQueryData(['current-tree'], 'Tree');
    const order: string[] = [];
    const slow = deferred();
    vi.mocked(apiSend).mockImplementation(async (_method, path) => {
      order.push(`undo ${path}`);
      return { batch: null };
    });
    const edit = (name: string, wait?: Promise<void>) =>
      client
        .getMutationCache()
        .build(client, {
          mutationKey: editKey('Tree'),
          scope: editScope('Tree'),
          mutationFn: async () => {
            await wait;
            order.push(name);
          },
        })
        .execute(undefined);

    const first = edit('edit before', slow.promise);
    const undone = undoRedo(client, 'undo');
    // Fired in the gap before the undo request goes out.
    const after = edit('edit after');
    await Promise.resolve();
    expect(order).toEqual([]);
    slow.resolve();
    await Promise.all([first, undone, after]);
    expect(order).toEqual(['edit before', 'undo /trees/Tree/undo', 'edit after']);
  });
});

describe('the app query client', () => {
  it('never pauses saves or reads while the browser thinks it is offline', async () => {
    expect(appClient.getDefaultOptions().mutations?.networkMode).toBe('always');
    expect(appClient.getDefaultOptions().queries?.networkMode).toBe('always');
    onlineManager.setOnline(false);
    const ran = await appClient
      .getMutationCache()
      .build(appClient, { mutationFn: async () => 'saved' })
      .execute(undefined);
    expect(ran).toBe('saved');
  });
});

describe('apiSend timeout', () => {
  it('turns a hung write into a clear timeout error, and leaves uploads alone', async () => {
    const actual = await vi.importActual<typeof Client>('./client');
    const signals: (AbortSignal | undefined)[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/session') {
        return new Response(JSON.stringify({ token: 't', tokenHeader: 'x-oa-token' }));
      }
      signals.push(init?.signal ?? undefined);
      if (init?.body instanceof FormData) return new Response(JSON.stringify({ ok: true }));
      throw new DOMException('timed out', 'TimeoutError');
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const error = (await actual
        .apiSend('POST', '/trees/T/batch', { x: 1 })
        .catch((e: unknown) => e)) as ApiError;
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ code: 'timeout' });
      expect(error.message).toMatch(/did not answer within 30 seconds/);
      expect(signals[0]).toBeInstanceOf(AbortSignal);

      await actual.apiSend('POST', '/import', new FormData());
      expect(signals[1]).toBeUndefined();
      expect(actual.SEND_TIMEOUT_MS).toBe(30_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
