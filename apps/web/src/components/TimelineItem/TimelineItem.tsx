import type { ReactNode } from 'react';
import { BookMarked, Users } from 'lucide-react';
import { cx } from '../../lib/cx';
import styles from './TimelineItem.module.css';

export type TimelineVariant = 'own' | 'family' | 'alternate';

export interface TimelineItemProps {
  /** Year column, e.g. `1911` or `abt. 1890`. */
  year?: string | number | undefined;
  /** Age at the event, in years. */
  age?: number | undefined;
  title: string;
  /** Full display date, e.g. `5 Sep 1911`. */
  date?: string | undefined;
  place?: string | undefined;
  sourceCount?: number | undefined;
  /** `own` event, `family` event (sunken, e.g. a sibling's birth), or `alternate` fact. */
  variant?: TimelineVariant;
  /** Row actions, e.g. an edit IconButton. */
  actions?: ReactNode;
  className?: string;
}

/** One row of the person timeline. Render inside an `<ol>`. */
export function TimelineItem({
  year,
  age,
  title,
  date,
  place,
  sourceCount = 0,
  variant = 'own',
  actions,
  className,
}: TimelineItemProps) {
  return (
    <li className={cx(styles.item, styles[variant], className)}>
      <div className={styles.when}>
        <span className={styles.year}>{year}</span>
        {age !== undefined && <span className={styles.age}>Age {age}</span>}
      </div>
      <div className={styles.body}>
        <p className={styles.title}>
          {variant === 'family' && (
            <>
              <Users size={14} aria-hidden className={styles.familyIcon} />
              <span className="oa-visually-hidden">Family event</span>
            </>
          )}
          {title}
          {variant === 'alternate' && <span className={styles.chip}>alternate</span>}
        </p>
        {(date || place) && (
          <p className={styles.detail}>{[date, place].filter(Boolean).join(' · ')}</p>
        )}
        {variant !== 'family' && (
          <p className={cx(styles.sources, sourceCount === 0 && styles.unsourced)}>
            <BookMarked size={12} aria-hidden />
            {sourceCount === 0
              ? 'No sources'
              : `${sourceCount} source${sourceCount === 1 ? '' : 's'}`}
          </p>
        )}
      </div>
      {actions && <div className={styles.actions}>{actions}</div>}
    </li>
  );
}
