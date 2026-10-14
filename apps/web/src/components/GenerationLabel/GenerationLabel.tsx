import type { ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './GenerationLabel.module.css';

export interface GenerationLabelProps {
  /** e.g. `Grandparents`, `Children`. */
  children: ReactNode;
  className?: string;
}

/** Muted generation caption drawn on the tree canvas. */
export function GenerationLabel({ children, className }: GenerationLabelProps) {
  return <p className={cx(styles.label, className)}>{children}</p>;
}
