import { cx } from '../../lib/cx';
import { formatLifespan, type Lifespan } from '../../lib/lifespan';
import styles from './LifespanText.module.css';

export interface LifespanTextProps extends Lifespan {
  className?: string;
}

/** `1911–1957`, `1947–Living`, `abt. 1890–1955`, `b. 1820`, with tabular numerals. */
export function LifespanText({ className, ...lifespan }: LifespanTextProps) {
  const text = formatLifespan(lifespan);
  if (!text) return null;
  return <span className={cx(styles.lifespan, className)}>{text}</span>;
}
