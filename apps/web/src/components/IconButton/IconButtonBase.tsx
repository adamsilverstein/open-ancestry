import type { ComponentProps, ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './IconButton.module.css';

export interface IconButtonBaseProps extends Omit<ComponentProps<'button'>, 'children'> {
  /** Accessible name. */
  label: string;
  icon: ReactNode;
  size?: 'sm' | 'md';
  variant?: 'ghost' | 'secondary' | 'canvas';
  /** Toggle state; renders aria-pressed when set. */
  pressed?: boolean | undefined;
  /** Announced via aria-keyshortcuts. */
  shortcut?: string | undefined;
}

/**
 * IconButton without the tooltip, for code on the initial bundle where the
 * tooltip's positioning library is not worth its weight.
 */
export function IconButtonBase({
  label,
  icon,
  size = 'md',
  variant = 'ghost',
  pressed,
  shortcut,
  className,
  type = 'button',
  ...rest
}: IconButtonBaseProps) {
  return (
    <button
      type={type}
      aria-label={label}
      aria-pressed={pressed}
      aria-keyshortcuts={shortcut}
      className={cx(styles.iconButton, styles[size], styles[variant], className)}
      {...rest}
    >
      {icon}
    </button>
  );
}
