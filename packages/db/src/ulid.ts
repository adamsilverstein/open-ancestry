import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export interface UlidOptions {
  now?: () => number;
  /** Returns an integer in [0, 32). Defaults to crypto randomness. */
  random?: () => number;
}

/**
 * Returns a monotonic ULID generator: ids sort by creation time, and ids made
 * in the same millisecond (or after the clock steps back) still increase.
 */
export function createUlidFactory({
  now = Date.now,
  random = () => randomInt(32),
}: UlidOptions = {}): () => string {
  let lastTime = -1;
  let lastRandom: number[] = [];
  // The importer asks for ~150k ids per second of work, so the encoded time
  // prefix is cached per millisecond and only the changed tail of the random
  // part is re-encoded on each increment.
  let prefix = '';
  let suffix = '';

  return () => {
    let time = now();
    if (time <= lastTime) {
      // Increment the 80-bit random part as a base-32 number.
      let i = lastRandom.length - 1;
      while (i >= 0 && lastRandom[i] === 31) lastRandom[i--] = 0;
      if (i < 0) throw new Error('ULID random component overflowed');
      lastRandom[i] = (lastRandom[i] as number) + 1;
      let tail = '';
      for (let j = i; j < 16; j++) tail += ALPHABET[lastRandom[j] as number];
      suffix = suffix.slice(0, i) + tail;
    } else {
      lastTime = time;
      lastRandom = Array.from({ length: 16 }, random);
      suffix = lastRandom.map((d) => ALPHABET[d]).join('');
      prefix = '';
      for (let i = 0; i < 10; i++, time = Math.floor(time / 32))
        prefix = ALPHABET[time % 32] + prefix;
    }
    return prefix + suffix;
  };
}

/** Process-wide monotonic ULID generator. */
export const ulid = createUlidFactory();
