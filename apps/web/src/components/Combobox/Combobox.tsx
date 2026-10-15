import { useId, useState } from 'react';
import * as RadixPopover from '@radix-ui/react-popover';
import { Command } from 'cmdk';
import { Check, ChevronDown } from 'lucide-react';
import { cx } from '../../lib/cx';
import { substringFilter } from '../../lib/filter';
import { Field } from '../Field/Field';
import fieldStyles from '../Field/Field.module.css';
import selectStyles from '../Select/Select.module.css';
import styles from './Combobox.module.css';

export interface ComboboxOption {
  value: string;
  label: string;
}

export interface ComboboxProps {
  label: string;
  options: ComboboxOption[];
  value?: string | undefined;
  onValueChange?: (value: string) => void;
  placeholder?: string;
  searchLabel?: string;
  emptyText?: string;
  hint?: string | undefined;
  error?: string | undefined;
  disabled?: boolean;
  /**
   * Server-side search: called as the user types, and `options` are shown as
   * given (no client filtering). Show `emptyText` until there are results.
   */
  onSearchChange?: (query: string) => void;
  /** Label for the selected value when it is not among the current `options`. */
  selectedLabel?: string | undefined;
}

/** Searchable single select: a trigger button opening a filterable listbox. */
export function Combobox({
  label,
  options,
  value,
  onValueChange,
  placeholder = 'Select…',
  searchLabel = `Search ${label.toLowerCase()}`,
  emptyText = 'No matches',
  hint,
  error,
  disabled,
  onSearchChange,
  selectedLabel,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  return (
    <Field label={label} hint={hint} error={error}>
      {(control) => (
        <RadixPopover.Root open={open} onOpenChange={setOpen}>
          <RadixPopover.Trigger
            role="combobox"
            aria-expanded={open}
            aria-haspopup="listbox"
            aria-controls={open ? listId : undefined}
            disabled={disabled}
            className={cx(fieldStyles.control, selectStyles.trigger)}
            data-placeholder={selected ? undefined : ''}
            {...control}
          >
            <span>{selected?.label ?? selectedLabel ?? placeholder}</span>
            <ChevronDown size={16} aria-hidden className={selectStyles.chevron} />
          </RadixPopover.Trigger>
          <RadixPopover.Portal>
            <RadixPopover.Content
              className={cx(selectStyles.content, styles.content)}
              align="start"
              sideOffset={4}
              aria-label={label}
            >
              <Command
                className={styles.command}
                filter={substringFilter}
                shouldFilter={!onSearchChange}
                label={label}
              >
                <Command.Input
                  className={styles.input}
                  placeholder={searchLabel}
                  aria-label={searchLabel}
                  onValueChange={onSearchChange}
                />
                <Command.List id={listId} className={cx(selectStyles.viewport, styles.list)}>
                  <Command.Empty className={styles.empty}>{emptyText}</Command.Empty>
                  {options.map((option) => (
                    <Command.Item
                      key={option.value}
                      // Remote results can share a label; the id keeps items distinct.
                      value={onSearchChange ? option.value : option.label}
                      className={selectStyles.item}
                      onSelect={() => {
                        onValueChange?.(option.value);
                        setOpen(false);
                      }}
                    >
                      {option.label}
                      {option.value === value && (
                        <Check size={16} aria-hidden className={selectStyles.indicator} />
                      )}
                    </Command.Item>
                  ))}
                </Command.List>
              </Command>
            </RadixPopover.Content>
          </RadixPopover.Portal>
        </RadixPopover.Root>
      )}
    </Field>
  );
}
