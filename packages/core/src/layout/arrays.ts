/*
 * Array helpers for layouts of any size. `Math.min(...xs)` and
 * `push(...items)` pass every element as an argument, which overflows the
 * stack at around 120k elements (one bad FAM record holding everyone).
 */

export function minOf(values: readonly number[]): number {
  let min = Infinity;
  for (const v of values) if (v < min) min = v;
  return min;
}

export function maxOf(values: readonly number[]): number {
  let max = -Infinity;
  for (const v of values) if (v > max) max = v;
  return max;
}

/** Appends `items` to `target`, element by element. */
export function pushAll<T>(target: T[], items: readonly T[]): void {
  for (const item of items) target.push(item);
}
