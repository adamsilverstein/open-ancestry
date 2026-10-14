import type { Calendar, DatePoint } from './types';

export const GREGORIAN_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
export const HEBREW_MONTHS = ['TSH', 'CSH', 'KSL', 'TVT', 'SHV', 'ADR', 'ADS', 'NSN', 'IYR', 'SVN', 'TMZ', 'AAV', 'ELL'];
export const FRENCH_MONTHS = ['VEND', 'BRUM', 'FRIM', 'NIVO', 'PLUV', 'VENT', 'GERM', 'FLOR', 'PRAI', 'MESS', 'THER', 'FRUC', 'COMP'];

const GREGORIAN_LOOKUP = new Map<string, number>();
GREGORIAN_MONTHS.forEach((abbr, i) => GREGORIAN_LOOKUP.set(abbr, i + 1));
[
  'JANUARY',
  'FEBRUARY',
  'MARCH',
  'APRIL',
  'MAY',
  'JUNE',
  'JULY',
  'AUGUST',
  'SEPTEMBER',
  'OCTOBER',
  'NOVEMBER',
  'DECEMBER',
].forEach((name, i) => GREGORIAN_LOOKUP.set(name, i + 1));
GREGORIAN_LOOKUP.set('SEPT', 9);

const HEBREW_LOOKUP = new Map(HEBREW_MONTHS.map((m, i) => [m, i + 1]));
const FRENCH_LOOKUP = new Map(FRENCH_MONTHS.map((m, i) => [m, i + 1]));

/** Month number for an upper-case month token in the given calendar. */
export function monthNumber(token: string, calendar: Calendar): number | undefined {
  if (calendar === 'hebrew') return HEBREW_LOOKUP.get(token);
  if (calendar === 'french_r') return FRENCH_LOOKUP.get(token);
  return GREGORIAN_LOOKUP.get(token);
}

export function monthCode(month: number, calendar: Calendar): string {
  const table = calendar === 'hebrew' ? HEBREW_MONTHS : calendar === 'french_r' ? FRENCH_MONTHS : GREGORIAN_MONTHS;
  return table[month - 1]!;
}

export function monthsInYear(calendar: Calendar): number {
  return calendar === 'hebrew' || calendar === 'french_r' ? 13 : 12;
}

/** Historical year (no year 0) to astronomical year (1 B.C. is 0). */
export const astronomical = (year: number): number => (year < 0 ? year + 1 : year);
const historical = (year: number): number => (year <= 0 ? year - 1 : year);

const DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function daysInMonth(calendar: Calendar, year: number, month: number): number {
  if (calendar === 'hebrew') return 30;
  if (calendar === 'french_r') return month === 13 ? 6 : 30;
  if (month !== 2) return DAYS[month - 1]!;
  const y = astronomical(year);
  const leap = calendar === 'julian' ? y % 4 === 0 : (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return leap ? 29 : 28;
}

// Julian Day Number conversions (Fliegel and Van Flandern), astronomical years.
function gregorianToJdn(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

function julianToJdn(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - 32083;
}

function jdnToGregorian(jdn: number): Required<Pick<DatePoint, 'year' | 'month' | 'day'>> {
  const a = jdn + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return {
    day: e - Math.floor((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * Math.floor(m / 10),
    year: historical(100 * b + d - 4800 + Math.floor(m / 10)),
  };
}

// Hebrew months mapped to the Gregorian month they mostly fall in (Tishri ~ September).
const HEBREW_TO_GREGORIAN_MONTH = [9, 10, 11, 12, 1, 2, 3, 3, 4, 5, 6, 7, 8];
const FRENCH_EPOCH_JDN = gregorianToJdn(1792, 9, 22);

/**
 * Gregorian year/month/day for a fully specified date in any calendar.
 * Julian is exact; Hebrew and French Republican are approximate (within a few
 * weeks), which is enough to sort them among Gregorian dates.
 */
export function toGregorian(
  calendar: Calendar,
  year: number,
  month: number,
  day: number,
): Required<Pick<DatePoint, 'year' | 'month' | 'day'>> {
  switch (calendar) {
    case 'julian':
      return jdnToGregorian(julianToJdn(astronomical(year), month, day));
    case 'hebrew': {
      const m = HEBREW_TO_GREGORIAN_MONTH[month - 1]!;
      return { year: m >= 9 ? year - 3761 : year - 3760, month: m, day: Math.min(day, 28) };
    }
    case 'french_r':
      return jdnToGregorian(FRENCH_EPOCH_JDN + Math.floor((year - 1) * 365.2425) + (month - 1) * 30 + day - 1);
    default:
      return { year, month, day };
  }
}
