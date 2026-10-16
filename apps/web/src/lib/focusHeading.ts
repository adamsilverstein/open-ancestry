/** How long to wait for the next page's heading to render. */
const HEADING_WAIT_MS = 3000;

/**
 * Moves focus to the page's `h1` once it renders, so a screen reader announces
 * the page a palette result (or similar) just opened (issue #200). The heading
 * gets `tabindex="-1"`: focusable from script, not in the tab order.
 */
export function focusMainHeading(): void {
  const start = performance.now();
  // If the user moves focus while the page loads, leave it where they put it.
  const before = document.activeElement;
  const tick = () => {
    const active = document.activeElement;
    // Focus that merely fell to <body> (the palette closing) does not count.
    if (active && active !== before && active !== document.body && active.isConnected) return;
    const heading = document.querySelector<HTMLElement>('main h1');
    if (heading) {
      if (!heading.hasAttribute('tabindex')) heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      return;
    }
    if (performance.now() - start < HEADING_WAIT_MS) requestAnimationFrame(tick);
  };
  // After the next frame: the new route renders after the navigation settles.
  requestAnimationFrame(tick);
}
