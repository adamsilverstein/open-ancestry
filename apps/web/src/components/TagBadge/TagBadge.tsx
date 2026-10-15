import type { CSSProperties } from 'react';
import { displayText } from '@open-ancestry/core';
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

export function TagBadge({ label: raw, color, variant = 'badge', className }: TagBadgeProps) {
  // Tag names come from imported files too: clean out direction overrides (#190).
  const label = displayText(raw);
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
      <bdi>{label}</bdi>
    </span>
  );
}
