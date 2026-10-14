import { describe, expect, it } from 'vitest';
import { createUlidFactory, ulid } from './index';

describe('ulid', () => {
  it('produces 26-character Crockford base32 ids', () => {
    expect(ulid()).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('encodes the timestamp in the first 10 characters', () => {
    const next = createUlidFactory({ now: () => 0, random: () => 0 });
    expect(next()).toBe('0000000000' + '0000000000000000');
    const at = createUlidFactory({ now: () => 1_700_000_000_000, random: () => 0 });
    expect(at().slice(0, 10)).toBe('01HF7YAT00');
  });

  it('is strictly increasing within the same millisecond', () => {
    const next = createUlidFactory({ now: () => 1000 });
    const ids = Array.from({ length: 1000 }, next);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stays increasing if the clock goes backwards', () => {
    let t = 5000;
    const next = createUlidFactory({ now: () => t });
    const a = next();
    t = 4000;
    expect(next() > a).toBe(true);
  });
});
