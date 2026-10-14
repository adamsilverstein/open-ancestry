import { useEffect, useRef, useState, type ReactNode } from 'react';
import styles from './Gallery.module.css';

export interface VirtualGridProps<T> {
  items: T[];
  getKey: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Narrowest a tile may get; columns fill the width. */
  minTileWidth?: number;
  rowHeight?: number;
  gap?: number;
  /** Extra pixels rendered above and below the viewport. */
  overscan?: number;
}

/**
 * A grid that only mounts the rows near the viewport. The page itself
 * scrolls, so visibility comes from the grid's position in the window.
 */
export function VirtualGrid<T>({
  items,
  getKey,
  renderItem,
  minTileWidth = 168,
  rowHeight = 228,
  gap = 12,
  overscan = 600,
}: VirtualGridProps<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [view, setView] = useState({ top: 0, height: 900 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setWidth(rect.width);
      setView({ top: -rect.top, height: window.innerHeight });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener('scroll', measure, { passive: true });
    window.addEventListener('resize', measure);
    return () => {
      observer.disconnect();
      window.removeEventListener('scroll', measure);
      window.removeEventListener('resize', measure);
    };
  }, []);

  const columns = Math.max(1, Math.floor((width + gap) / (minTileWidth + gap)));
  const rows = Math.ceil(items.length / columns);
  const stride = rowHeight + gap;
  const first = Math.max(0, Math.floor((view.top - overscan) / stride));
  const last = Math.min(rows, Math.ceil((view.top + view.height + overscan) / stride));
  const visible = items.slice(first * columns, last * columns);

  return (
    <div ref={ref} className={styles.virtual} style={{ height: Math.max(0, rows * stride - gap) }}>
      <ul
        className={styles.grid}
        style={{
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
          gridAutoRows: rowHeight,
          gap,
          transform: `translateY(${first * stride}px)`,
        }}
      >
        {visible.map((item, i) => (
          <li key={getKey(item)}>{renderItem(item, first * columns + i)}</li>
        ))}
      </ul>
    </div>
  );
}
