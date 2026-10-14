import type { CSSProperties } from 'react';
import { cx } from '../../lib/cx';
import type { TagColor } from '../../lib/person';
import styles from './TagBadge.module.css';

export interface TagBadgeProps {
  label: string;
  color: TagColor;
  /** `dot` shows only the color dot, with the label as its accessible name. */
  variant?: 'badge' | 'dot';
  className?: string;
}

export function TagBadge({ label, color, variant = 'badge', className }: TagBadgeProps) {
  const style = { '--oa-tag-color': `var(--oa-tag-${color})` } as CSSProperties;
  if (variant === 'dot') {
    return (
      <span
        role="img"
        aria-label={`Tag: ${label}`}
        title={label}
        className={cx(styles.dot, className)}
        style={style}
      />
    );
  }
  return (
    <span className={cx(styles.badge, className)} style={style}>
      <span className={styles.dot} aria-hidden />
      {label}
    </span>
  );
}
