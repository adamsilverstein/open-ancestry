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

  return () => {
    let time = now();
    if (time <= lastTime) {
      time = lastTime;
      // Increment the 80-bit random part as a base-32 number.
      let i = lastRandom.length - 1;
      while (i >= 0 && lastRandom[i] === 31) lastRandom[i--] = 0;
      if (i < 0) throw new Error('ULID random component overflowed');
      lastRandom[i] = (lastRandom[i] as number) + 1;
    } else {
      lastTime = time;
      lastRandom = Array.from({ length: 16 }, random);
    }
    let timePart = '';
    for (let t = time, i = 0; i < 10; i++, t = Math.floor(t / 32)) {
      timePart = ALPHABET[t % 32] + timePart;
    }
    return timePart + lastRandom.map((d) => ALPHABET[d]).join('');
  };
}

/** Process-wide monotonic ULID generator. */
export const ulid = createUlidFactory();
