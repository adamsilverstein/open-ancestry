import { daysInMonth, monthCode, monthsInYear } from './calendar';
import { parseDate } from './parse';
import type { Calendar, DateInput, DatePoint, ParsedDate } from './types';

export type DateStyle = 'long' | 'year';
export type GedcomVersion = '5.5.1' | '7';

export const asParsed = (date: DateInput): ParsedDate =>
  typeof date === 'object' && date !== null ? date : parseDate(date);

const DISPLAY_PREFIX: Partial<Record<ParsedDate['qualifier'], string>> = {
  about: 'abt. ',
  calculated: 'cal. ',
  estimated: 'est. ',
  before: 'bef. ',
  after: 'aft. ',
  from: 'from ',
  to: 'to ',
  interpreted: 'int. ',
};
const DISPLAY_CALENDAR: Partial<Record<Calendar, string>> = {
  julian: 'Julian ',
  hebrew: 'Hebrew ',
  french_r: 'French Republican ',
};

function yearText(point: DatePoint, bc: string): string {
  if (point.year < 0) return `${-point.year} ${bc}`;
  if (point.dualYear === undefined) return String(point.year);
  return `${point.year}/${String(point.dualYear % 100).padStart(2, '0')}`;
}

/**
 * Display text per the design system: `5 Sep 1941`, `abt. 1890`,
 * `bet. 1890 and 1895`. The `year` style drops day and month for lifespans.
 * Unparseable text is shown as entered.
 */
export function formatDate(date: DateInput, style: DateStyle = 'long'): string {
  const parsed = asParsed(date);
  const { start, end, calendar } = parsed;
  if (!start) return parsed.text.trim();
  const point = (p: DatePoint, cal: Calendar = calendar): string => {
    const year = yearText(p, 'B.C.');
    if (style === 'year') return year;
    const parts = [DISPLAY_CALENDAR[cal] ?? ''];
    if (p.day !== undefined) parts.push(`${p.day} `);
    if (p.month !== undefined) {
      const code = monthCode(p.month, cal);
      parts.push(`${code[0]}${code.slice(1).toLowerCase()} `);
    }
    return parts.join('') + year;
  };
  let text: string;
  if (end) {
    const last = point(end, parsed.endCalendar);
    text =
      parsed.qualifier === 'between'
        ? `bet. ${point(start)} and ${last}`
        : `from ${point(start)} to ${last}`;
  } else text = (DISPLAY_PREFIX[parsed.qualifier] ?? '') + point(start);
  return parsed.phrase ? `${text} (${parsed.phrase})` : text;
}

const GEDCOM_QUALIFIER: Partial<Record<ParsedDate['qualifier'], string>> = {
  about: 'ABT ',
  calculated: 'CAL ',
  estimated: 'EST ',
  before: 'BEF ',
  after: 'AFT ',
  from: 'FROM ',
  to: 'TO ',
};
const GEDCOM551_CALENDAR: Record<Calendar, string> = {
  gregorian: '',
  julian: '@#DJULIAN@ ',
  hebrew: '@#DHEBREW@ ',
  french_r: '@#DFRENCH R@ ',
  unknown: '@#DUNKNOWN@ ',
};
const GEDCOM7_CALENDAR: Record<Calendar, string> = {
  gregorian: '',
  julian: 'JULIAN ',
  hebrew: 'HEBREW ',
  french_r: 'FRENCH_R ',
  // GEDCOM 7 has no keyword for an unknown calendar, so v7 exports the bare date.
  unknown: '',
};

const CALENDARS = new Set<Calendar>(['gregorian', 'julian', 'hebrew', 'french_r', 'unknown']);

/** Guards against hand-built ParsedDate objects carrying non-numeric parts into an export. */
function isSafePoint(p: DatePoint | undefined, calendar: Calendar): boolean {
  if (!p || !Number.isSafeInteger(p.year) || p.year === 0 || Math.abs(p.year) > 9999) return false;
  if (p.year < 0 && (calendar === 'hebrew' || calendar === 'french_r')) return false;
  if (p.month !== undefined) {
    if (!Number.isSafeInteger(p.month) || p.month < 1 || p.month > monthsInYear(calendar))
      return false;
  }
  if (p.day !== undefined) {
    if (p.month === undefined || !Number.isSafeInteger(p.day) || p.day < 1) return false;
    // A dual-dated day is an Old Style (Julian) day in the new-style year.
    const rules = p.dualYear === undefined ? calendar : 'julian';
    if (p.day > daysInMonth(rules, p.dualYear ?? p.year, p.month)) return false;
  }
  return p.dualYear === undefined || p.dualYear === p.year + 1;
}

/**
 * Makes free text safe inside a GEDCOM `(phrase)`: one line, no control or
 * format characters, no parentheses, and `@` doubled as GEDCOM 5.5.1 requires.
 */
export function gedcomPhrase(text: unknown): string {
  return String(text ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}()]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/@/g, '@@');
}

/**
 * GEDCOM DATE payload, always a single line. Version 7 has no dual years, INT
 * or date phrases in the value: dual years use the new-style year, and the caller
 * should write the original text as a PHRASE (escaped by its own writer) when
 * the result is empty or the date was interpreted.
 */
export function toGedcom(date: DateInput, version: GedcomVersion = '5.5.1'): string {
  const parsed = asParsed(date);
  const { start, end } = parsed;
  const known = (cal: Calendar | undefined) => (cal && CALENDARS.has(cal) ? cal : undefined);
  const calendar = known(parsed.calendar) ?? 'gregorian';
  const endCalendar = known(parsed.endCalendar) ?? calendar;
  const v7 = version === '7';
  if (!isSafePoint(start, calendar) || (end !== undefined && !isSafePoint(end, endCalendar))) {
    if (v7) return '';
    const phrase = gedcomPhrase(parsed.phrase ?? parsed.text);
    return phrase && `(${phrase})`;
  }
  const point = (p: DatePoint, given: Calendar = calendar): string => {
    // GEDCOM 7 has no dual years. A dual date is an Old Style (Julian) date,
    // so it is written as one in its new-style year: 29 FEB 1699/1700 becomes
    // JULIAN 29 FEB 1700, a day the Gregorian calendar does not have.
    const dual = v7 && p.dualYear !== undefined;
    const cal = dual && given === 'gregorian' ? 'julian' : given;
    const parts = [(v7 ? GEDCOM7_CALENDAR : GEDCOM551_CALENDAR)[cal]];
    if (p.day !== undefined) parts.push(`${p.day} `);
    if (p.month !== undefined) parts.push(`${monthCode(p.month, cal)} `);
    const year = p.dualYear ?? p.year;
    parts.push(v7 ? (year < 0 ? `${-year} BCE` : String(year)) : yearText(p, 'B.C.'));
    return parts.join('');
  };
  if (end) {
    return parsed.qualifier === 'from_to'
      ? `FROM ${point(start!)} TO ${point(end, endCalendar)}`
      : `BET ${point(start!)} AND ${point(end, endCalendar)}`;
  }
  if (parsed.qualifier === 'interpreted' && !v7) {
    const phrase = gedcomPhrase(parsed.phrase);
    return phrase ? `INT ${point(start!)} (${phrase})` : `INT ${point(start!)}`;
  }
  return (GEDCOM_QUALIFIER[parsed.qualifier] ?? '') + point(start!);
}
