import { daysInMonth, monthNumber, monthsInYear } from './calendar';
import { pointKey, UNDATED_SORT_KEY } from './sort-key';
import type { Calendar, DatePoint, DateQualifier, ParsedDate } from './types';

/** Longer input is never a date; bail out before running any pattern on it. */
const MAX_DATE_LENGTH = 200;

const CALENDAR_PREFIX = /^(?:@#D([A-Z ]+)@|(GREGORIAN|JULIAN|HEBREW|FRENCH_R|FRENCH REPUBLICAN)(?= )) ?/;
const CALENDAR_NAMES: Record<string, Calendar> = {
  GREGORIAN: 'gregorian',
  JULIAN: 'julian',
  HEBREW: 'hebrew',
  'FRENCH R': 'french_r',
  FRENCH_R: 'french_r',
  'FRENCH REPUBLICAN': 'french_r',
  UNKNOWN: 'unknown',
  ROMAN: 'unknown',
};

const PHRASE = /^([^()]*?)\s*\(([^()]*)\)[\s.,;:]*$/;
const BETWEEN = /^(?:BET|BETWEEN|BTW)\.? (.+?) (?:AND|&|-|–) (.+)$/;
const FROM_TO = /^FROM (.+?) TO (.+)$/;
const FROM = /^FROM (.+)$/;
const TO = /^TO (.+)$/;
const INT = /^INT\.? (.+)$/;
const SIMPLE =
  /^(ABOUT|ABT|APPROXIMATELY|APPROX|AROUND|CIRCA|CA|C|CALCULATED|CALC|CAL|ESTIMATED|EST|BEFORE|BEF|AFTER|AFT|~)\.?(?: |(?=\d))(.+)$/;
const SIMPLE_QUALIFIERS: Record<string, DateQualifier> = {
  ABOUT: 'about',
  ABT: 'about',
  APPROXIMATELY: 'about',
  APPROX: 'about',
  AROUND: 'about',
  CIRCA: 'about',
  CA: 'about',
  C: 'about',
  '~': 'about',
  CALCULATED: 'calculated',
  CALC: 'calculated',
  CAL: 'calculated',
  ESTIMATED: 'estimated',
  EST: 'estimated',
  BEFORE: 'before',
  BEF: 'before',
  AFTER: 'after',
  AFT: 'after',
};
const YEAR_RANGE = /^(\d{3,4}) ?(?:-|–|TO) ?(\d{2}|\d{4})$/;
const DECADE = /^(\d{2,3})0S$/;
const ISO = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/;
const NUMERIC = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{3,4})$/;
const MONTH_YEAR = /^(\d{1,2})\/(\d{3,4})$/;
const ERA = / (B\.?C\.?(?:E\.?)?|A\.?D\.?)$/;
const DAY = /^(\d{1,2})(?:ST|ND|RD|TH)?$/;
const YEAR = /^(\d{1,4})(?:\/(\d{1,4}))?$/;
const WEEKDAY = /^(?:MON|TUE|TUES|WED|THU|THUR|THURS|FRI|SAT|SUN)(?:DAY|NESDAY|SDAY|URDAY)?\.?$/;

interface Point {
  point: DatePoint;
  calendar: Calendar;
}

/**
 * Parses GEDCOM 5.5.1 / 7 dates plus common Ancestry and hand-typed forms.
 * Never throws: anything it cannot read comes back as `qualifier: 'text'`.
 */
export function parseDate(text: string): ParsedDate {
  const original = typeof text === 'string' ? text : '';
  if (original.length > MAX_DATE_LENGTH) return textDate(original);
  let body = original.trim();
  let phrase: string | undefined;
  if (body.endsWith(')') || body.includes('(')) {
    const match = PHRASE.exec(body);
    if (!match) return textDate(original);
    phrase = match[2]!.trim();
    body = match[1]!;
    if (!body) return textDate(original, phrase);
  }
  const s = body.toUpperCase().replace(/\s+/g, ' ').replace(/[.,;:]+$/, '');
  return parseNormalized(original, s, phrase) ?? textDate(original, phrase);
}

function parseNormalized(original: string, input: string, phrase: string | undefined): ParsedDate | undefined {
  let s = input;
  let calendar: Calendar = 'gregorian';
  // A calendar before the qualifier (`@#DJULIAN@ ABT 1700`) applies to every point.
  if (s.charCodeAt(0) >= 64) {
    const cal = readCalendar(s);
    if (cal === null) return undefined;
    if (cal) {
      calendar = cal.calendar;
      s = cal.rest;
    }
  }

  let match = INT.exec(s);
  if (match || phrase !== undefined) {
    let inner = match ? match[1]! : s;
    const simple = SIMPLE.exec(inner);
    if (simple) inner = simple[2]!;
    const p = parsePoint(inner, calendar);
    return p && single(original, 'interpreted', p, phrase);
  }

  if ((match = BETWEEN.exec(s))) return range(original, 'between', match[1]!, match[2]!, calendar);
  if ((match = FROM_TO.exec(s))) return range(original, 'from_to', match[1]!, match[2]!, calendar);
  if ((match = FROM.exec(s))) {
    const p = parsePoint(match[1]!, calendar);
    return p && single(original, 'from', p);
  }
  if ((match = TO.exec(s))) {
    const p = parsePoint(match[1]!, calendar);
    return p && single(original, 'to', p);
  }
  if ((match = SIMPLE.exec(s))) {
    const p = parsePoint(match[2]!, calendar);
    return p && single(original, SIMPLE_QUALIFIERS[match[1]!]!, p);
  }
  if ((match = DECADE.exec(s))) {
    const year = Number(match[1]) * 10;
    return year > 0 ? build(original, 'between', { point: { year }, calendar }, { point: { year: year + 9 }, calendar }) : undefined;
  }
  // `1890-95` is a range but `1890-09` is ISO year-month.
  if ((match = YEAR_RANGE.exec(s)) && (match[2]!.length === 4 || Number(match[2]) > 12)) {
    const start = Number(match[1]);
    let end = Number(match[2]);
    if (match[2]!.length === 2) end += start - (start % 100);
    return build(original, 'between', { point: { year: start }, calendar }, { point: { year: end }, calendar });
  }
  const p = parsePoint(s, calendar);
  return p && single(original, 'exact', p);
}

/** Reads a leading calendar escape or keyword. Null means an unknown calendar. */
function readCalendar(s: string): { calendar: Calendar; rest: string } | null | undefined {
  const match = CALENDAR_PREFIX.exec(s);
  if (!match) return undefined;
  const calendar = CALENDAR_NAMES[(match[1] ?? match[2])!.trim()];
  return calendar ? { calendar, rest: s.slice(match[0].length) } : null;
}

function parsePoint(input: string, defaultCalendar: Calendar): Point | undefined {
  let s = input;
  let calendar = defaultCalendar;
  const cal = readCalendar(s);
  if (cal === null) return undefined;
  if (cal) {
    calendar = cal.calendar;
    s = cal.rest;
  }

  let bc = false;
  const era = ERA.exec(s);
  if (era) {
    bc = era[1]!.startsWith('B');
    s = s.slice(0, era.index);
  }

  let year: number | undefined;
  let month: number | undefined;
  let day: number | undefined;
  let dual: string | undefined;
  let match: RegExpExecArray | null;

  if ((match = ISO.exec(s))) {
    year = Number(match[1]);
    month = Number(match[2]);
    day = match[3] === undefined ? undefined : Number(match[3]);
  } else if ((match = NUMERIC.exec(s))) {
    let a = Number(match[1]);
    let b = Number(match[3]);
    // US order (M/D/Y) unless that is impossible; dotted dates are European (D.M.Y).
    const dayFirst = match[2] === '.' ? b <= 12 : a > 12;
    if (dayFirst) [a, b] = [b, a];
    month = a;
    day = b;
    year = Number(match[4]);
  } else if ((match = MONTH_YEAR.exec(s))) {
    month = Number(match[1]);
    year = Number(match[2]);
  } else {
    const tokens = s.split(/[ ,-]+/);
    if (tokens[0] === '') tokens.shift();
    if (tokens.length > 1 && WEEKDAY.test(tokens[0]!)) tokens.shift();
    const words = tokens.map((t) => (t.endsWith('.') ? t.slice(0, -1) : t));
    const [t0 = '', t1 = '', t2 = ''] = words;
    if (words.length === 1) {
      ({ year, dual } = readYear(t0));
    } else if (words.length === 2) {
      // SEP 1941
      month = monthNumber(t0, calendar);
      if (month === undefined) return undefined;
      ({ year, dual } = readYear(t1));
    } else if (words.length === 3) {
      month = monthNumber(t1, calendar);
      if (month !== undefined) {
        // 5 SEP 1941, or 1941 SEP 5
        const yearFirst = /^\d{3,4}$/.test(t0);
        day = readDay(yearFirst ? t2 : t0);
        ({ year, dual } = readYear(yearFirst ? t0 : t2));
      } else {
        // Sep 5, 1941
        month = monthNumber(t0, calendar);
        day = readDay(t1);
        ({ year, dual } = readYear(t2));
      }
      if (month === undefined || day === undefined) return undefined;
    }
  }

  return validPoint(calendar, bc, year, month, day, dual);
}

function readYear(token: string): { year?: number; dual?: string } {
  const match = YEAR.exec(token);
  return match ? { year: Number(match[1]), dual: match[2] } : {};
}

function readDay(token: string): number | undefined {
  const match = DAY.exec(token);
  return match ? Number(match[1]) : undefined;
}

function validPoint(
  calendar: Calendar,
  bc: boolean,
  year: number | undefined,
  month: number | undefined,
  day: number | undefined,
  dual: string | undefined,
): Point | undefined {
  if (year === undefined || year === 0 || Number.isNaN(year)) return undefined;
  const point: DatePoint = { year: bc ? -year : year };
  if (month !== undefined) {
    if (!(month >= 1 && month <= monthsInYear(calendar))) return undefined;
    point.month = month;
  }
  if (day !== undefined) {
    if (month === undefined || !(day >= 1 && day <= daysInMonth(calendar, point.year, month))) return undefined;
    point.day = day;
  }
  if (dual !== undefined) {
    // Dual dating (Old Style / New Style) only exists for Gregorian and Julian years.
    if (bc || year < 100 || (calendar !== 'gregorian' && calendar !== 'julian')) return undefined;
    const size = 10 ** dual.length;
    let next = year - (year % size) + Number(dual);
    if (next <= year) next += size;
    if (next !== year + 1) return undefined;
    point.dualYear = next;
  }
  return { point, calendar };
}

function single(original: string, qualifier: DateQualifier, p: Point, phrase?: string): ParsedDate {
  const { point, calendar } = p;
  const bound = qualifier === 'before' ? 'low' : qualifier === 'after' ? 'high' : 'mid';
  const key = pointKey(point, calendar, bound);
  const date: ParsedDate = {
    text: original,
    qualifier,
    start: point,
    calendar,
    sortKey: qualifier === 'before' ? key - 1 : qualifier === 'after' ? key + 1 : key,
    valid: true,
  };
  if (phrase) date.phrase = phrase;
  return date;
}

function range(original: string, qualifier: DateQualifier, a: string, b: string, calendar: Calendar): ParsedDate | undefined {
  const start = parsePoint(a, calendar);
  const end = start && parsePoint(b, calendar);
  return end && build(original, qualifier, start!, end);
}

function build(original: string, qualifier: DateQualifier, start: Point, end: Point): ParsedDate | undefined {
  const sortKey = pointKey(start.point, start.calendar, 'low');
  const sortKeyEnd = pointKey(end.point, end.calendar, 'high');
  if (sortKey > sortKeyEnd) return undefined;
  return {
    text: original,
    qualifier,
    start: start.point,
    end: end.point,
    calendar: start.calendar,
    sortKey,
    sortKeyEnd,
    valid: true,
  };
}

function textDate(text: string, phrase?: string): ParsedDate {
  const date: ParsedDate = { text, qualifier: 'text', calendar: 'gregorian', sortKey: UNDATED_SORT_KEY, valid: false };
  if (phrase) date.phrase = phrase;
  return date;
}
