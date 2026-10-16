/**
 * Lifespans as every view shows them (design system `LifespanText`):
 * `1911–1957`, `1947–Living`, `abt. 1842–1911`, `1846–bef. 1920`, `b. 1820`.
 * Tree cards, the person page, lists and the palette all use these, so an
 * uncertain date never reads as a fact in one place and not in another.
 */
import type { DateQualifier } from './types';

/** The qualifiers a lifespan keeps, abbreviated. */
export type LifeQualifier = 'abt' | 'bef' | 'aft' | 'est' | 'cal';

/** A year-level date for display. Years before 1 AD are negative. */
export interface LifeDate {
  year: number;
  qualifier?: LifeQualifier | undefined;
}

export interface Lifespan {
  birth?: LifeDate | undefined;
  death?: LifeDate | undefined;
  living?: boolean | undefined;
}

const ABBREVIATION: Partial<Record<DateQualifier, LifeQualifier>> = {
  about: 'abt',
  before: 'bef',
  after: 'aft',
  estimated: 'est',
  calculated: 'cal',
};

/**
 * The year-level date of a stored event (`date_sort` and `date_qualifier`,
 * as the database and API keep them), or undefined without a sortable date.
 * Ranges show their first year.
 */
export function lifeDate(
  event: { dateSort?: number | null; dateQualifier?: string | null } | null | undefined,
): LifeDate | undefined {
  if (!event?.dateSort) return undefined;
  const year = Math.floor(event.dateSort / 10000);
  const qualifier = ABBREVIATION[event.dateQualifier as DateQualifier];
  return qualifier ? { year, qualifier } : { year };
}

export function formatLifeDate({ year, qualifier }: LifeDate): string {
  const shown = year < 0 ? `${-year} B.C.` : String(year);
  return qualifier ? `${qualifier}. ${shown}` : shown;
}

/** `1911–1957`, `1947–Living`, `abt. 1890–1955`, `b. 1820`, `d. 1880`, or `''`. */
export function formatLifespan({ birth, death, living }: Lifespan): string {
  const start = birth ? formatLifeDate(birth) : '';
  if (living) return start ? `${start}–Living` : 'Living';
  if (birth && death) return `${start}–${formatLifeDate(death)}`;
  if (birth) return `b. ${start}`;
  if (death) return `d. ${formatLifeDate(death)}`;
  return '';
}
