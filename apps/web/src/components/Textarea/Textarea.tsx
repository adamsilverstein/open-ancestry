import type { ComponentProps } from 'react';
import { cx } from '../../lib/cx';
import { Field } from '../Field/Field';
import fieldStyles from '../Field/Field.module.css';
import styles from './Textarea.module.css';

export interface TextareaProps extends Omit<ComponentProps<'textarea'>, 'id'> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
}

export function Textarea({ label, hint, error, className, rows = 4, ...rest }: TextareaProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <textarea
          rows={rows}
          className={cx(fieldStyles.control, styles.textarea, className)}
          {...control}
          {...rest}
        />
      )}
    </Field>
  );
}
