import { useId, type ReactNode } from 'react';
import { cx } from '../../lib/cx';
import styles from './Panel.module.css';

export interface PanelProps {
  title?: string;
  /** Controls shown at the right of the header. */
  actions?: ReactNode;
  /** Sunken panels sit inside other surfaces. */
  variant?: 'raised' | 'sunken';
  headingLevel?: 2 | 3;
  className?: string;
  children?: ReactNode;
}

/** Titled surface; a labelled region when it has a title. */
export function Panel({
  title,
  actions,
  variant = 'raised',
  headingLevel = 2,
  className,
  children,
}: PanelProps) {
  const id = useId();
  const Heading = `h${headingLevel}` as const;
  return (
    <section
      aria-labelledby={title ? id : undefined}
      className={cx(styles.panel, styles[variant], className)}
    >
      {(title || actions) && (
        <header className={styles.header}>
          {title && (
            <Heading id={id} className={styles.title}>
              {title}
            </Heading>
          )}
          {actions && <div className={styles.actions}>{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}
