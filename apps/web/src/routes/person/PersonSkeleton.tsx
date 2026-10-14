import { useId } from 'react';
import { Skeleton } from '../components/Skeleton/Skeleton';
import styles from './PersonPage.module.css';

const columns = [
  { rows: 6, height: 64 },
  { rows: 4, height: 56 },
  { rows: 5, height: 56 },
];

/** Placeholder until the person page (F11) lands: header band, tabs and the facts grid. */
export function PersonPage() {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} aria-busy="true">
      <h1 id={headingId} className="oa-visually-hidden">
        Person
      </h1>
      <div className={styles.header} data-surface="canvas">
        <Skeleton shape="circle" width={120} height={120} />
        <div className={styles.headerText}>
          <Skeleton shape="text" width={320} height={42} />
          <Skeleton shape="text" width={220} height={18} />
          <Skeleton shape="text" width={180} height={18} />
        </div>
      </div>
      <div className={styles.tabs}>
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} width={72} height={20} />
        ))}
      </div>
      <div className={styles.grid}>
        {columns.map((column, i) => (
          <div key={i} className={styles.column}>
            <Skeleton shape="text" width={120} height={26} />
            {Array.from({ length: column.rows }, (_, j) => (
              <Skeleton key={j} height={column.height} />
            ))}
          </div>
        ))}
      </div>
    </section>
  );
}
