import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './EmptyState.module.css';

export interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  /** Heading level for the title; use 1 when the empty state is the page. */
  level?: 1 | 2 | 3;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  icon,
  title,
  level = 2,
  description,
  action,
  className,
}: EmptyStateProps) {
  const Heading = `h${level}` as const;
  return (
    <div className={cx(styles.empty, className)}>
      {icon && <div className={styles.icon}>{icon}</div>}
      <Heading className={cx(styles.title, level === 1 && styles.page)}>{title}</Heading>
      {description && <p className={styles.description}>{description}</p>}
      {action && <div className={styles.action}>{action}</div>}
    </div>
  );
}
