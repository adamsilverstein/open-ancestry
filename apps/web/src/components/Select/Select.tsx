import * as RadixSelect from '@radix-ui/react-select';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from '../../lib/cx';
import { Field } from '../Field/Field';
import fieldStyles from '../Field/Field.module.css';
import styles from './Select.module.css';

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectProps {
  label: string;
  options: SelectOption[];
  value?: string | undefined;
  defaultValue?: string | undefined;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  hint?: string | undefined;
  error?: string | undefined;
  disabled?: boolean;
  name?: string;
}

export function Select({
  label,
  options,
  value,
  defaultValue,
  onValueChange,
  placeholder = 'Select…',
  hint,
  error,
  disabled,
  name,
}: SelectProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <RadixSelect.Root
          value={value}
          defaultValue={defaultValue}
          onValueChange={onValueChange}
          disabled={disabled}
          name={name}
        >
          <RadixSelect.Trigger className={cx(fieldStyles.control, styles.trigger)} {...control}>
            <RadixSelect.Value placeholder={placeholder} />
            <RadixSelect.Icon className={styles.chevron}>
              <ChevronDown size={16} aria-hidden />
            </RadixSelect.Icon>
          </RadixSelect.Trigger>
          <RadixSelect.Portal>
            <RadixSelect.Content className={styles.content} position="popper" sideOffset={4}>
              <RadixSelect.Viewport className={styles.viewport}>
                {options.map((option) => (
                  <RadixSelect.Item
                    key={option.value}
                    value={option.value}
                    disabled={option.disabled}
                    className={styles.item}
                  >
                    <RadixSelect.ItemText>{option.label}</RadixSelect.ItemText>
                    <RadixSelect.ItemIndicator className={styles.indicator}>
                      <Check size={16} aria-hidden />
                    </RadixSelect.ItemIndicator>
                  </RadixSelect.Item>
                ))}
              </RadixSelect.Viewport>
            </RadixSelect.Content>
          </RadixSelect.Portal>
        </RadixSelect.Root>
      )}
    </Field>
  );
}
