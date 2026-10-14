import {
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type FocusEvent,
  type KeyboardEvent,
} from 'react';
import { cx } from '../../lib/cx';
import { nextIndex, type Orientation } from '../../lib/roving';
import styles from './Toolbar.module.css';

export interface ToolbarProps extends ComponentProps<'div'> {
  /** Accessible name for the toolbar. */
  label: string;
  orientation?: Orientation;
}

const focusable = 'button:not(:disabled)';

function items(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(focusable)];
}

/** Makes `active` the toolbar's single Tab stop. */
function setTabStop(root: HTMLElement, active: HTMLElement | undefined) {
  for (const item of items(root)) item.tabIndex = item === active ? 0 : -1;
}

/** ARIA toolbar: one Tab stop, arrow keys (plus Home/End) move between controls. */
export function Toolbar({
  label,
  orientation = 'horizontal',
  className,
  onKeyDown,
  onFocus,
  ...rest
}: ToolbarProps) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (ref.current) setTabStop(ref.current, items(ref.current)[0]);
  }, []);

  function handleFocus(event: FocusEvent<HTMLDivElement>) {
    onFocus?.(event);
    if (event.target !== event.currentTarget) setTabStop(event.currentTarget, event.target);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    const list = items(event.currentTarget);
    const current = list.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    const next = nextIndex(event.key, current, list.length, orientation);
    if (next === null) return;
    event.preventDefault();
    list[next]?.focus();
  }

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      aria-orientation={orientation}
      className={cx(styles.toolbar, styles[orientation], className)}
      onKeyDown={handleKeyDown}
      onFocus={handleFocus}
      {...rest}
    />
  );
}
