import type { ComponentProps, ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';
import { cx } from '../../lib/cx';
import styles from './Button.module.css';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ComponentProps<'button'> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner, sets aria-busy and disables the button. */
  loading?: boolean;
  iconStart?: ReactNode;
  iconEnd?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  iconStart,
  iconEnd,
  disabled,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(styles.button, styles[variant], styles[size], className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <LoaderCircle className={styles.spinner} size={16} aria-hidden /> : iconStart}
      {children}
      {iconEnd}
    </button>
  );
}
