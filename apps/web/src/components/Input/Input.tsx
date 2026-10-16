import { useId, type ComponentProps } from 'react';
import { cx } from '../../lib/cx';
import { Field } from '../Field/Field';
import fieldStyles from '../Field/Field.module.css';

export interface InputProps extends Omit<ComponentProps<'input'>, 'id'> {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  /**
   * Values to suggest while typing (a native datalist, so any text is still
   * allowed); the field is announced as a combobox when given.
   */
  suggestions?: readonly string[] | undefined;
}

export function Input({ label, hint, error, className, suggestions, ...rest }: InputProps) {
  const listId = useId();
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <>
          <input
            className={cx(fieldStyles.control, className)}
            {...control}
            {...(suggestions ? { list: listId } : {})}
            {...rest}
          />
          {suggestions && (
            <datalist id={listId}>
              {suggestions.map((value) => (
                <option key={value} value={value} />
              ))}
            </datalist>
          )}
        </>
      )}
    </Field>
  );
}
