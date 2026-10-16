import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReimportSession } from '@open-ancestry/import';
import { ReimportSessions } from './reimports';

const session = () => ({ incoming: { close() {} } }) as unknown as ReimportSession;

describe('ReimportSessions', () => {
  it('drops the least recently used review, not one in use, when full', () => {
    const sessions = new ReimportSessions({ maxSessions: 2 });
    const first = sessions.add('Tree', 'a.ged', session());
    const second = sessions.add('Tree', 'b.ged', session());
    // The first review is still being worked on.
    expect(sessions.get(first.id)).toBeDefined();
    sessions.add('Tree', 'c.ged', session());
    expect(sessions.get(first.id)).toBeDefined();
    expect(sessions.get(second.id)).toBeUndefined();
  });

  describe('expiry without further calls (L4, #267)', () => {
    afterEach(() => vi.useRealTimers());

    it('drops an expired review and its spill folder on a timer', () => {
      vi.useFakeTimers();
      let closed = 0;
      const spilled = {
        incoming: { close: () => closed++ },
        incomingDir: null,
        mediaDir: null,
      } as unknown as ReimportSession;
      const sessions = new ReimportSessions({ maxAgeMs: 1000, sweepMs: 500 });
      sessions.add('Tree', 'a.ged', spilled);
      vi.advanceTimersByTime(900);
      expect(closed).toBe(0);
      // No add/get/hasTree call: the timer alone frees it.
      vi.advanceTimersByTime(700);
      expect(closed).toBe(1);
      sessions.closeAll();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('never keeps the process alive for its timer', () => {
      const sessions = new ReimportSessions({ sweepMs: 10 });
      expect(sessions.sweeping?.hasRef()).toBe(false);
      sessions.closeAll();
    });
  });
});
