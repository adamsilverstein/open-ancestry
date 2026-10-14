import { useId, type ComponentProps } from 'react';
import { CircleAlert, CircleCheck, Info } from 'lucide-react';
import { cx } from '../../lib/cx';
import { describeDate } from '../../lib/datePreview';
import { Field } from '../Field/Field';
import fieldStyles from '../Field/Field.module.css';
import styles from './DateInput.module.css';

export interface DateInputProps extends Omit<ComponentProps<'input'>, 'id' | 'value' | 'onChange'> {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  hint?: string | undefined;
  error?: string | undefined;
}

const ICONS = { valid: CircleCheck, ambiguous: Info, invalid: CircleAlert } as const;

/**
 * Genealogical date field: the text is kept as typed, and a live preview
 * shows how the parser reads it (`abt. 1900 · about`), flags numeric dates
 * that could be read either way, and says when text is not a date.
 */
export function DateInput({
  label,
  value,
  onValueChange,
  hint = 'For example 5 Sep 1941, abt. 1890, bef. 1900, bet. 1890 and 1895',
  error,
  className,
  ...rest
}: DateInputProps) {
  const previewId = useId();
  const preview = describeDate(value);
  const Icon = preview.status === 'empty' ? null : ICONS[preview.status];
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <>
          <input
            className={cx(fieldStyles.control, className)}
            value={value}
            onChange={(event) => onValueChange(event.currentTarget.value)}
            autoComplete="off"
            spellCheck={false}
            {...control}
            aria-describedby={[previewId, control['aria-describedby']].filter(Boolean).join(' ')}
            {...rest}
          />
          <p
            id={previewId}
            className={cx(styles.preview, styles[preview.status])}
            aria-live="polite"
            data-testid="date-preview"
          >
            {Icon && <Icon size={14} aria-hidden />}
            {preview.text}
          </p>
        </>
      )}
    </Field>
  );
}
