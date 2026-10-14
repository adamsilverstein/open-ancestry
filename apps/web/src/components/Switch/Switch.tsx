import { useId, type ComponentProps } from 'react';
import { cx } from '../../lib/cx';
import styles from './Switch.module.css';

export interface SwitchProps extends Omit<ComponentProps<'input'>, 'type' | 'id' | 'role'> {
  label: string;
}

/** Native checkbox with role="switch"; on/off is shown by knob position, not color alone. */
export function Switch({ label, className, ...rest }: SwitchProps) {
  const id = useId();
  return (
    <div className={cx(styles.row, className)}>
      <input id={id} type="checkbox" role="switch" className={styles.switch} {...rest} />
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
    </div>
  );
}
