import { useId } from 'react';
import { Skeleton } from '../components/Skeleton/Skeleton';
import styles from './TreePage.module.css';

/** Card rows of the family view: grandparents, parents, focus couple, children. */
const rows = [4, 2, 2, 3];

/** Placeholder until the tree view (F9) lands: a skeleton sized like the real canvas. */
export function TreePage() {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      aria-busy="true"
      className={styles.canvas}
      data-surface="canvas"
    >
      <h1 id={headingId} className="oa-visually-hidden">
        Family tree
      </h1>
      <div className={styles.toolbar} data-surface="raised">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} width={36} height={36} />
        ))}
      </div>
      <div className={styles.rows}>
        {rows.map((count, row) => (
          <div key={row} className={styles.row}>
            {Array.from({ length: count }, (_, i) => (
              <Skeleton key={i} width={120} height={150} className={styles.card} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
