import { useCallback, useSyncExternalStore } from 'react';

/**
 * Phones: the tree's toolbar moves to the bottom and the minimap starts
 * hidden. Keep in step with the `max-width: 599px` queries in the CSS.
 */
export const NARROW_SCREEN = '(max-width: 599px)';

export function matchesMedia(query: string): boolean {
  return typeof window !== 'undefined' && window.matchMedia(query).matches;
}

/** Whether the media query matches, re-rendering when that changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => matchesMedia(query));
}
