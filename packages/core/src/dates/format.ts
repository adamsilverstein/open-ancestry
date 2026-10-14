import { monthCode } from './calendar';
import { parseDate } from './parse';
import type { Calendar, DateInput, DatePoint, ParsedDate } from './types';

export type DateStyle = 'long' | 'year';
export type GedcomVersion = '5.5.1' | '7';

export const asParsed = (date: DateInput): ParsedDate =>
  typeof date === 'string' ? parseDate(date) : date;

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
  const point = (p: DatePoint): string => {
    const year = yearText(p, 'B.C.');
    if (style === 'year') return year;
    const parts = [DISPLAY_CALENDAR[calendar] ?? ''];
    if (p.day !== undefined) parts.push(`${p.day} `);
    if (p.month !== undefined) {
      const code = monthCode(p.month, calendar);
      parts.push(`${code[0]}${code.slice(1).toLowerCase()} `);
    }
    return parts.join('') + year;
  };
  if (end) {
    return parsed.qualifier === 'between'
      ? `bet. ${point(start)} and ${point(end)}`
      : `from ${point(start)} to ${point(end)}`;
  }
  const text = (DISPLAY_PREFIX[parsed.qualifier] ?? '') + point(start);
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
  unknown: '',
};

/**
 * GEDCOM DATE payload. Version 7 has no dual years, INT or date phrases in the
 * value: dual years keep the first year, and the caller should write the
 * original text as a PHRASE when the result is empty or the date was interpreted.
 */
export function toGedcom(date: DateInput, version: GedcomVersion = '5.5.1'): string {
  const parsed = asParsed(date);
  const { start, end, calendar } = parsed;
  const v7 = version === '7';
  if (!start) {
    if (v7) return '';
    const phrase = (parsed.phrase ?? parsed.text).replace(/[()]/g, '').replace(/\s+/g, ' ').trim();
    return phrase && `(${phrase})`;
  }
  const point = (p: DatePoint): string => {
    const parts = [(v7 ? GEDCOM7_CALENDAR : GEDCOM551_CALENDAR)[calendar]];
    if (p.day !== undefined) parts.push(`${p.day} `);
    if (p.month !== undefined) parts.push(`${monthCode(p.month, calendar)} `);
    parts.push(v7 ? (p.year < 0 ? `${-p.year} BCE` : String(p.year)) : yearText(p, 'B.C.'));
    return parts.join('');
  };
  if (end) {
    return parsed.qualifier === 'between'
      ? `BET ${point(start)} AND ${point(end)}`
      : `FROM ${point(start)} TO ${point(end)}`;
  }
  if (parsed.qualifier === 'interpreted' && !v7) {
    return parsed.phrase
      ? `INT ${point(start)} (${parsed.phrase.replace(/[()]/g, '')})`
      : `INT ${point(start)}`;
  }
  return (GEDCOM_QUALIFIER[parsed.qualifier] ?? '') + point(start);
}
