import { describe, expect, it } from 'vitest';
import { layoutFamily } from './index';
import { makeGraph } from './test-graphs';

describe('scale', { timeout: 60_000 }, () => {
  // Bad data the import accepts: one FAM record holding everyone. 100k passes,
  // 150k throws RangeError from Math.min(...xs) spreads in family.ts.
  it('lays out one family with 150k children without a stack overflow', () => {
    const people: Record<string, 'M' | 'F'> = { dad: 'M', mom: 'F' };
    const kids = Array.from({ length: 150_000 }, (_, i) => `k${i}`);
    for (const k of kids) people[k] = 'M';
    const g = makeGraph(people, [['F', 'dad', 'mom', kids]]);
    expect(() => layoutFamily(g, 'dad')).not.toThrow();
  });
});
