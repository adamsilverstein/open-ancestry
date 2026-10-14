import type { CSSProperties } from 'react';
import { cx } from '../../lib/cx';
import styles from './Skeleton.module.css';

export interface SkeletonProps {
  /** CSS length or px number. Size skeletons to the final content to avoid layout shift. */
  width?: number | string;
  height?: number | string;
  shape?: 'text' | 'rect' | 'circle';
  className?: string;
  style?: CSSProperties;
}

/** Decorative placeholder; mark the loading container with aria-busy instead. */
export function Skeleton({ width, height, shape = 'rect', className, style }: SkeletonProps) {
  return (
    <span
      aria-hidden
      data-testid="skeleton"
      className={cx(styles.skeleton, styles[shape], className)}
      style={{ width, height, ...style }}
    />
  );
}
