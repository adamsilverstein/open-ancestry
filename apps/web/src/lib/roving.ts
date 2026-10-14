export type Orientation = 'horizontal' | 'vertical';

/** Returns the item index a roving-focus key moves to, or null if the key is not handled. */
export function nextIndex(
  key: string,
  current: number,
  count: number,
  orientation: Orientation,
): number | null {
  const [prev, next] =
    orientation === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
  if (key === next) return (current + 1) % count;
  if (key === prev) return (current - 1 + count) % count;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
