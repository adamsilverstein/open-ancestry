import type { ComponentProps } from 'react';
import { cx } from '../../lib/cx';
import { Field } from '../Field/Field';
import fieldStyles from '../Field/Field.module.css';

export interface InputProps extends Omit<ComponentProps<'input'>, 'id'> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
}

export function Input({ label, hint, error, className, ...rest }: InputProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => <input className={cx(fieldStyles.control, className)} {...control} {...rest} />}
    </Field>
  );
}
