import { useEffect, useState } from 'react';

/*
 * Forms on the person page that hold typed changes, so a page that leaves
 * because its person was deleted elsewhere can say those changes were
 * discarded instead of dropping them without a word.
 */

const dirty = new Set<symbol>();

/** Whether any mounted form holds changes it has not saved. */
export function hasDirtyForms(): boolean {
  return dirty.size > 0;
}

/** Marks this form dirty while `value` differs from the value it opened with. */
export function useDirtyForm(value: unknown): void {
  const [key] = useState(() => Symbol('form'));
  const [opened] = useState(() => JSON.stringify(value));
  const changed = JSON.stringify(value) !== opened;
  useEffect(() => {
    if (changed) dirty.add(key);
    else dirty.delete(key);
    return () => {
      dirty.delete(key);
    };
  }, [changed, key]);
}
