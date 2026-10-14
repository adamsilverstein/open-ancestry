import { useCallback, useSyncExternalStore } from 'react';

/**
 * The phone layout: a narrow screen, or a phone held in landscape (a touch
 * screen too short for the desktop layout). The one breakpoint the app's
 * phone-specific layouts share.
 */
export const PHONE_LAYOUT_QUERY = '(max-width: 640px), (pointer: coarse) and (max-height: 500px)';

/** Whether a CSS media query matches, updated as it changes. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    [query],
  );
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

/** True in the phone layout (`PHONE_LAYOUT_QUERY`). */
export function usePhoneLayout(): boolean {
  return useMediaQuery(PHONE_LAYOUT_QUERY);
}
