import { BookMarked, ExternalLink } from 'lucide-react';
import { cx } from '../../lib/cx';
import styles from './SourceItem.module.css';

/** GEDCOM QUAY: 0 unreliable, 1 questionable, 2 secondary, 3 primary. */
export type SourceQuality = 0 | 1 | 2 | 3;

const qualityLabel: Record<SourceQuality, string> = {
  0: 'Unreliable',
  1: 'Questionable',
  2: 'Secondary evidence',
  3: 'Primary evidence',
};

export interface SourceItemProps {
  title: string;
  /** Citation detail (page, entry). */
  citation?: string | undefined;
  quality?: SourceQuality | undefined;
  /** External record, e.g. the Ancestry `_APID` link. Opens in a new tab. */
  externalUrl?: string | undefined;
  externalLabel?: string;
  className?: string;
}

export function SourceItem({
  title,
  citation,
  quality,
  externalUrl,
  externalLabel = 'View record',
  className,
}: SourceItemProps) {
  return (
    <div className={cx(styles.item, className)}>
      <BookMarked size={16} aria-hidden className={styles.icon} />
      <div className={styles.body}>
        <p className={styles.title}>{title}</p>
        {citation && <p className={styles.citation}>{citation}</p>}
        <div className={styles.meta}>
          {quality !== undefined && (
            <span className={cx(styles.chip, styles[`q${quality}`])}>{qualityLabel[quality]}</span>
          )}
          {externalUrl && (
            <a className={styles.link} href={externalUrl} target="_blank" rel="noreferrer noopener">
              {externalLabel}
              <span className="oa-visually-hidden"> (opens in a new tab)</span>
              <ExternalLink size={12} aria-hidden />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
