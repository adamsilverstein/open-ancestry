import type { Calendar, DatePoint } from './types';

export const GREGORIAN_MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];
export const HEBREW_MONTHS = [
  'TSH',
  'CSH',
  'KSL',
  'TVT',
  'SHV',
  'ADR',
  'ADS',
  'NSN',
  'IYR',
  'SVN',
  'TMZ',
  'AAV',
  'ELL',
];
export const FRENCH_MONTHS = [
  'VEND',
  'BRUM',
  'FRIM',
  'NIVO',
  'PLUV',
  'VENT',
  'GERM',
  'FLOR',
  'PRAI',
  'MESS',
  'THER',
  'FRUC',
  'COMP',
];

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
  const table =
    calendar === 'hebrew'
      ? HEBREW_MONTHS
      : calendar === 'french_r'
        ? FRENCH_MONTHS
        : GREGORIAN_MONTHS;
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
  const leap =
    calendar === 'julian' ? y % 4 === 0 : (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return leap ? 29 : 28;
}

// Julian Day Number conversions (Fliegel and Van Flandern), astronomical years.
function gregorianToJdn(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return (
    d +
    Math.floor((153 * mm + 2) / 5) +
    365 * yy +
    Math.floor(yy / 4) -
    Math.floor(yy / 100) +
    Math.floor(yy / 400) -
    32045
  );
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

// Hebrew calendar (Dershowitz and Reingold, Calendrical Calculations): the
// molad of Tishri plus the postponement rules gives each year's new year day.
const HEBREW_EPOCH_JDN = 347998;

function hebrewElapsedDays(year: number): number {
  const months = Math.floor((235 * year - 234) / 19);
  const parts = 12084 + 13753 * months;
  const day = 29 * months + Math.floor(parts / 25920);
  return (3 * (day + 1)) % 7 < 3 ? day + 1 : day;
}

function hebrewNewYear(year: number): number {
  const ny0 = hebrewElapsedDays(year - 1);
  const ny1 = hebrewElapsedDays(year);
  const ny2 = hebrewElapsedDays(year + 1);
  const delay = ny2 - ny1 === 356 ? 2 : ny1 - ny0 === 382 ? 1 : 0;
  return HEBREW_EPOCH_JDN + ny1 + delay;
}

/** JDN of a Hebrew date; months in GEDCOM order (TSH = 1 .. ELL = 13). */
function hebrewToJdn(year: number, month: number, day: number): number {
  const newYear = hebrewNewYear(year);
  const length = hebrewNewYear(year + 1) - newYear;
  const leap = (7 * year + 1) % 19 < 7;
  // TSH CSH KSL TVT SHV ADR ADS NSN IYR SVN TMZ AAV ELL; ADS only exists in leap years.
  const lengths = [
    30,
    length % 10 === 5 ? 30 : 29,
    length % 10 === 3 ? 29 : 30,
    29,
    30,
    leap ? 30 : 29,
    leap ? 29 : 0,
    30,
    29,
    30,
    29,
    30,
    29,
  ];
  // Outside a leap year ADS can only mean the one Adar.
  const m = !leap && month === 7 ? 6 : month;
  let offset = 0;
  for (let i = 0; i < m - 1; i++) offset += lengths[i]!;
  return newYear + offset + day - 1;
}

// French Republican calendar: year I began on 22 Sep 1792 and years III, VII
// and XI were sextile (366 days). Later years follow the Romme rule.
const FRENCH_EPOCH_JDN = gregorianToJdn(1792, 9, 22);
const romme = (n: number) => Math.floor(n / 4) - Math.floor(n / 100) + Math.floor(n / 400);

function frenchToJdn(year: number, month: number, day: number): number {
  const sextiles =
    year <= 15 ? [3, 7, 11].filter((y) => y < year).length : 3 + romme(year - 1) - romme(14);
  return FRENCH_EPOCH_JDN + 365 * (year - 1) + sextiles + (month - 1) * 30 + day - 1;
}

/**
 * Exact days in a Hebrew or French Republican month, for range bounds.
 * (Parsing stays lenient and accepts day 30 / COMP 6 in every year.)
 */
export function exactMonthDays(
  calendar: 'hebrew' | 'french_r',
  year: number,
  month: number,
): number {
  if (calendar === 'french_r') {
    return month < 13 ? 30 : frenchToJdn(year + 1, 1, 1) - frenchToJdn(year, 13, 1);
  }
  const leap = (7 * year + 1) % 19 < 7;
  const m = !leap && month === 7 ? 6 : month;
  const next =
    m === 13 ? hebrewNewYear(year + 1) : hebrewToJdn(year, !leap && m === 6 ? 8 : m + 1, 1);
  return next - hebrewToJdn(year, m, 1);
}

/**
 * Gregorian year/month/day for a fully specified date in any calendar.
 * Julian and Hebrew are exact; French Republican is exact for the years it was
 * in use (I to XIV).
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
    case 'hebrew':
      return jdnToGregorian(hebrewToJdn(year, month, day));
    case 'french_r':
      return jdnToGregorian(frenchToJdn(year, month, day));
    default:
      return { year, month, day };
  }
}
