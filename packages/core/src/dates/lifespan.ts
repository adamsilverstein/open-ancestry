/**
 * Lifespans as every view shows them (design system `LifespanText`):
 * `1911–1957`, `1947–Living`, `abt. 1842–1911`, `1846–bef. 1920`, `b. 1820`.
 * Tree cards, the person page, lists and the palette all use these, so an
 * uncertain date never reads as a fact in one place and not in another.
 */
import { parseDate } from './parse';
import type { DateQualifier } from './types';

/** The qualifiers a lifespan keeps, abbreviated. */
export type LifeQualifier = 'abt' | 'bef' | 'aft' | 'est' | 'cal';

/** A year-level date for display. Years before 1 AD are negative. */
export interface LifeDate {
  year: number;
  qualifier?: LifeQualifier | undefined;
  /** New-style year of a dual date: `year` 1750 with `dualYear` 1751 reads `1750/51`. */
  dualYear?: number | undefined;
  /** Shown instead of the year, for a decade or century (`1850s`). */
  label?: string | undefined;
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

const yearOfKey = (key: number) => Math.floor(key / 10000);

/** Ranges up to this many years read as about their middle year. */
const NARROW_RANGE_YEARS = 10;

/**
 * A range's year-level form: one year when it starts and ends in it, a
 * decade or century as written (`1850s`), about the middle year for a
 * narrow range (`BET 1870 AND 1872` is `abt. 1871`), and its start bound
 * for a wide one (`BET 1800 AND 1850` is `aft. 1800`), so a card never
 * claims more precision than the record has.
 */
function rangeLifeDate(first: number, last: number | undefined, text?: string | null): LifeDate {
  if (last === undefined) return { year: first, qualifier: 'abt' };
  if (last === first) return { year: first };
  const span = /(\d{3,4})'?s\b/i.exec(text ?? '');
  if (span && Number(span[1]) === first && (last === first + 9 || last === first + 99)) {
    return { year: first, label: `${first}s` };
  }
  if (last - first <= NARROW_RANGE_YEARS) {
    return { year: Math.floor((first + last) / 2), qualifier: 'abt' };
  }
  return { year: first, qualifier: 'aft' };
}

/**
 * The year-level date of a stored event (`dateSort`, `dateQualifier` and
 * `dateText`, as the database and API keep them), or undefined without a
 * sortable date. Ranges read as `rangeLifeDate` says; an open period reads
 * as before or after its bound (`FROM 1890` is `aft. 1890`).
 */
export function lifeDate(
  event:
    | { dateSort?: number | null; dateQualifier?: string | null; dateText?: string | null }
    | null
    | undefined,
): LifeDate | undefined {
  if (!event?.dateSort) return undefined;
  const year = yearOfKey(event.dateSort);
  const kind = event.dateQualifier as DateQualifier;
  if (kind === 'between' || kind === 'from_to') {
    const end = event.dateText ? parseDate(event.dateText).sortKeyEnd : undefined;
    return rangeLifeDate(year, end === undefined ? undefined : yearOfKey(end), event.dateText);
  }
  if (kind === 'from') return { year, qualifier: 'aft' };
  if (kind === 'to') return { year, qualifier: 'bef' };
  const qualifier = ABBREVIATION[kind];
  const date: LifeDate = qualifier ? { year, qualifier } : { year };
  // A dual date reads as written elsewhere (`1750/51`), not as its sort year.
  if (event.dateText?.includes('/')) {
    const start = parseDate(event.dateText).start;
    if (start?.dualYear !== undefined) {
      date.year = start.year;
      date.dualYear = start.dualYear;
    }
  }
  return date;
}

export function formatLifeDate({ year, qualifier, dualYear, label }: LifeDate): string {
  const shown = label
    ? label
    : year < 0
      ? `${-year} B.C.`
      : dualYear !== undefined
        ? `${year}/${String(dualYear % 100).padStart(2, '0')}`
        : String(year);
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
