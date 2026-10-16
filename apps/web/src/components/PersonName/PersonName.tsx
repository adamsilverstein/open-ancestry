import { displayText } from '@open-ancestry/core';
import styles from './PersonName.module.css';
import { cx } from '../../lib/cx';

export interface PersonNameProps {
  name: string;
  className?: string;
}

/**
 * A person's name, isolated from the text around it (`<bdi>`), so a
 * right-to-left name cannot reorder the lifespan or label after it, and with
 * control and bidi override characters removed (#190).
 */
export function PersonName({ name, className }: PersonNameProps) {
  return (
    <bdi className={cx(styles.name, className)} data-person-name="">
      {displayText(name)}
    </bdi>
  );
}
