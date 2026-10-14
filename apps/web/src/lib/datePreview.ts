import { formatDate, parseDate, type DateQualifier } from '@open-ancestry/core';

export interface DatePreview {
  /** `ambiguous`: a numeric date that could be read month-first or day-first. */
  status: 'empty' | 'valid' | 'ambiguous' | 'invalid';
  text: string;
}

const QUALIFIER_WORDS: Partial<Record<DateQualifier, string>> = {
  about: 'about',
  calculated: 'calculated',
  estimated: 'estimated',
  before: 'before',
  after: 'after',
  between: 'between',
  from: 'from',
  to: 'to',
  from_to: 'from–to',
  interpreted: 'interpreted',
};

/** Swaps month and day of a numeric `M/D/Y` reading, if that is a real date. */
function dayFirst(text: string): string | null {
  const match = /^\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{3,4})\s*$/.exec(text);
  if (!match) return null;
  const [, a, b, year] = match;
  const swapped = parseDate(
    `${Number(a)} ${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][Number(b) - 1] ?? ''} ${year}`,
  );
  return swapped.valid ? formatDate(swapped) : null;
}

/**
 * What the date parser makes of typed text, for the live preview under a
 * date field: `abt. 1900 · about`, an ambiguity warning, or a note that the
 * text will be kept as written.
 */
export function describeDate(text: string): DatePreview {
  if (!text.trim()) return { status: 'empty', text: '' };
  const parsed = parseDate(text);
  if (!parsed.valid) {
    return { status: 'invalid', text: 'Not a recognized date. It will be kept as text.' };
  }
  const shown = formatDate(parsed);
  const word = QUALIFIER_WORDS[parsed.qualifier];
  const base = word ? `${shown} · ${word}` : shown;
  if (parsed.ambiguous) {
    const other = dayFirst(text);
    return {
      status: 'ambiguous',
      text: `${base} · could also be read day first${other ? ` (${other})` : ''}`,
    };
  }
  return { status: 'valid', text: base };
}
