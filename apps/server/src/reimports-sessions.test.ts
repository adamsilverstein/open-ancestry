import { describe, expect, it } from 'vitest';
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
});
