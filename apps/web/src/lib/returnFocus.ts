/*
 * Where focus goes when a dialog closes. Most editing dialogs are opened from
 * a button's onClick or a menu item rather than a Radix Trigger, so Radix has
 * nothing to return focus to and drops it on <body>. Dialogs record their
 * opener instead, falling back to the last control focused or pressed outside
 * any overlay (a menu item's trigger, or a button WebKit never focused on click).
 */

const OVERLAY = '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]';
const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]';

let lastOutside: HTMLElement | null = null;
let installed = false;

function remember(target: EventTarget | null) {
  if (target instanceof HTMLElement && target !== document.body && !target.closest(OVERLAY)) {
    lastOutside = target;
  }
}

/** Starts tracking the last control used outside overlays. Safe to call more than once. */
export function trackFocus(): void {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  document.addEventListener('focusin', (event) => remember(event.target), true);
  document.addEventListener(
    'pointerdown',
    (event) => remember((event.target as Element | null)?.closest?.(FOCUSABLE) ?? null),
    true,
  );
}

/** The element a dialog opening now should return focus to. */
export function captureOpener(): HTMLElement | null {
  const active = document.activeElement;
  // Menu items and list options disappear with their menu; use what opened the menu.
  if (active instanceof HTMLElement && active !== document.body) {
    const overlay = active.closest(OVERLAY);
    if (!overlay || overlay.matches('[role="dialog"], [role="alertdialog"]')) return active;
  }
  return lastOutside;
}

/** Still on the page and not inside a dialog that is closing. */
function usable(element: HTMLElement | null | undefined): element is HTMLElement {
  if (!element?.isConnected) return false;
  const dialog = element.closest('[role="dialog"], [role="alertdialog"]');
  return !dialog || dialog.getAttribute('data-state') !== 'closed';
}

/** Focuses the first usable candidate; returns whether one was found. */
export function returnFocus(
  ...candidates: (HTMLElement | null | undefined | (() => HTMLElement | null | undefined))[]
): boolean {
  for (const candidate of candidates) {
    const element = typeof candidate === 'function' ? candidate() : candidate;
    if (usable(element)) {
      element.focus();
      return true;
    }
  }
  return false;
}
