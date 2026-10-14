import { notifyManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { currentTreeQuery } from './queries';
import { useSearchPeople } from './search';

/*
 * #112: palette results within 50ms of the last key. The e2e perf check scales
 * its budget for slow CI machines, which would hide a reintroduced debounce,
 * so this pins the scheduling itself with fake timers: no timer ever runs
 * unless a request hangs.
 */

let pending: { q: string; resolve: () => void }[];

function respond() {
  const next = pending.shift()!;
  next.resolve();
}

const flush = () => act(async () => {});

function setup(initial: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(currentTreeQuery.queryKey, 'tree');
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(({ q }) => useSearchPeople(q), { initialProps: { q: initial }, wrapper });
}

const requested = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([url]) => new URL(String(url), 'http://x').searchParams.get('q'));

beforeEach(() => {
  pending = [];
  // Only timers are faked: React Query notifies through microtasks here, so a pending
  // setTimeout in the hook (a debounce) would show as a request that never goes out.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  notifyManager.setScheduler((cb) => queueMicrotask(cb));
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (url: string, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const q = new URL(url, 'http://x').searchParams.get('q')!;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('', 'AbortError')));
          pending.push({
            q,
            resolve: () => resolve(new Response(JSON.stringify({ items: [] }), { status: 200 })),
          });
        }),
    ),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  notifyManager.setScheduler((cb) => setTimeout(cb, 0));
});

describe('useSearchPeople scheduling', () => {
  it('searches the first key at once, with no timer', async () => {
    const hook = setup('m');
    await flush();
    expect(requested()).toEqual(['m']);
    respond();
    await flush();
    expect(hook.result.current.pending).toBe(false);
    hook.rerender({ q: 'mo' });
    await flush();
    expect(requested()).toEqual(['m', 'mo']);
  });

  it('keys typed during a search wait for it, then search only the latest text', async () => {
    const hook = setup('m');
    await flush();
    hook.rerender({ q: 'mo' });
    hook.rerender({ q: 'mos' });
    hook.rerender({ q: 'moss' });
    await flush();
    expect(requested()).toEqual(['m']);
    expect(hook.result.current.pending).toBe(true);
    respond();
    await flush();
    expect(requested()).toEqual(['m', 'moss']);
    respond();
    await flush();
    expect(hook.result.current.stale).toBe(false);
  });

  it('stops waiting for a request that hangs', async () => {
    const hook = setup('m');
    await flush();
    hook.rerender({ q: 'mo' });
    await flush();
    expect(requested()).toEqual(['m']);
    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    await flush();
    expect(requested()).toEqual(['m', 'mo']);
  });
});
