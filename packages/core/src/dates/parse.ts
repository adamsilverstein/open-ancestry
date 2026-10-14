import { daysInMonth, isHebrewLeap, monthNumber, monthsInYear } from './calendar';
import { pointKey, UNDATED_SORT_KEY } from './sort-key';
import type { Calendar, DatePoint, DateQualifier, ParsedDate } from './types';

/** Longer input is never a date; bail out before running any pattern on it. */
const MAX_DATE_LENGTH = 200;

const CALENDAR_PREFIX =
  /^(?:@#D([A-Z ]+)@|(GREGORIAN|JULIAN|HEBREW|FRENCH_R|FRENCH REPUBLICAN)(?= )) ?/;
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
const BET_SPAN = /^(?:BET|BETWEEN|BTW)\.? (.+)$/;
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
/**
 * `1850S`, `1700S`, `1850'S`, `1850S-1860S`: decades, or centuries when ending
 * in 00 before 2000 (`2000S` is the decade 2000-2009). In a two-sided span the
 * left side gives the first year. A right side ending in 00s is read at the
 * left side's granularity (`1660S-1700S` is 1660-1709, `1700S-1800S` is
 * 1700-1899); any other right side is a decade (`1700S-1750S` is 1700-1759).
 * After a plain year the right side is read alone (`FROM 1850 TO 1900S` is
 * 1850-1999).
 */
const DECADES = /^(\d{1,3}0)'?S(?: ?(?:-|–|TO) ?(\d{1,3}0)'?S)?$/;
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
  ambiguous?: boolean;
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
  const s = body
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:]+$/, '');
  return parseNormalized(original, s, phrase) ?? textDate(original, phrase);
}

function parseNormalized(
  original: string,
  input: string,
  phrase: string | undefined,
): ParsedDate | undefined {
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
    if (p) return single(original, 'from', p);
    return periodSpan(original, 'from', match[1]!, calendar);
  }
  if ((match = TO.exec(s))) {
    const p = parsePoint(match[1]!, calendar);
    if (p) return single(original, 'to', p);
    return periodSpan(original, 'to', match[1]!, calendar);
  }
  if ((match = BET_SPAN.exec(s))) {
    const span = yearSpan(match[1]!);
    return span && spanDate(original, 'between', span, calendar);
  }
  if ((match = SIMPLE.exec(s))) {
    const qualifier = SIMPLE_QUALIFIERS[match[1]!]!;
    const p = parsePoint(match[2]!, calendar);
    if (p) return single(original, qualifier, p);
    const span = yearSpan(match[2]!);
    return span && spanDate(original, qualifier, span, calendar);
  }
  const span = yearSpan(s);
  if (span) return spanDate(original, 'between', span, calendar);
  const p = parsePoint(s, calendar);
  return p && single(original, 'exact', p);
}

/** `1700s` alone is the eighteenth century; 21st-century `2000s` is a decade (#52). */
const isCentury = (first: number) => first % 100 === 0 && first < 2000;

/**
 * Last year of `<first>s`: a century when asked for and `<first>` can be one,
 * so `2000s` stays the decade 2000-2009 even after a century (#52).
 */
const lastYear = (first: number, century: boolean) =>
  first + (century && isCentury(first) ? 99 : 9);

/**
 * Years written as one span: `1850S` (decade), `1700S` (century), `1850S-1860S`,
 * `1850-1860` or `1850-60`. Undefined when `s` is not a span.
 */
function yearSpan(s: string, centuries?: boolean): [number, number] | undefined {
  let match = DECADES.exec(s);
  if (match) {
    const start = Number(match[1]);
    const end =
      match[2] === undefined
        ? lastYear(start, centuries ?? isCentury(start))
        : // A right side ending in 00s borrows the left side's granularity (`1660s-1700s`
          // is 1660-1709, `1700s-1800s` 1700-1899); any other right side is a decade.
          lastYear(Number(match[2]), isCentury(start));
    return start > 0 && end >= start ? [start, end] : undefined;
  }
  // `1890-95` is a range but `1890-09` is ISO year-month.
  match = YEAR_RANGE.exec(s);
  if (match && (match[2]!.length === 4 || Number(match[2]) > 12)) {
    const start = Number(match[1]);
    let end = Number(match[2]);
    if (match[2]!.length === 2) end += start - (start % 100);
    // Inverted ranges (`1850-13`) are typos, never a span, whatever qualifier precedes them.
    return end >= start ? [start, end] : undefined;
  }
  return undefined;
}

/**
 * A qualified span. GEDCOM has no "about between", so approximate spans keep
 * their range and the "about" survives only in `text`. Before a span is
 * before its last year and after it after its first: the loose reading, so
 * living inference never assumes more than was written, though `BEF 1850s`
 * exports as the weaker `BEF 1859`.
 */
function spanDate(
  original: string,
  qualifier: DateQualifier,
  [start, end]: [number, number],
  calendar: Calendar,
): ParsedDate | undefined {
  if (qualifier === 'before') return single(original, 'before', { point: { year: end }, calendar });
  if (qualifier === 'after') return single(original, 'after', { point: { year: start }, calendar });
  return build(
    original,
    'between',
    { point: { year: start }, calendar },
    { point: { year: end }, calendar },
  );
}

/**
 * `FROM` or `TO` a span. A span written as a range (`FROM 1850s-1860s`,
 * `FROM 1850-60`) is the whole period. A single decade or century is read
 * loosely, as with BEF and AFT: from its first year (`FROM 1850s` is
 * `FROM 1850`), to its last (`TO 1850s` is `TO 1859`). TO a range keeps
 * only its end (`TO 1850-60` is `TO 1860`): the period ends there, and
 * where it began is not part of a TO date.
 */
function periodSpan(
  original: string,
  qualifier: 'from' | 'to',
  s: string,
  calendar: Calendar,
): ParsedDate | undefined {
  // `TO 1850s TO 1860s` repeats the keyword; that is no period.
  if (/(?:^| )(?:FROM|TO) /.test(s)) return undefined;
  const span = yearSpan(s);
  if (!span) return undefined;
  const [start, end] = span;
  if (qualifier === 'from' && /-|–| TO /.test(s)) {
    return build(
      original,
      'from_to',
      { point: { year: start }, calendar },
      { point: { year: end }, calendar },
    );
  }
  return single(original, qualifier, {
    point: { year: qualifier === 'from' ? start : end },
    calendar,
  });
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
  let ambiguous = false;

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
    ambiguous = a !== b && a <= 12 && b <= 12;
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

  const p = validPoint(calendar, bc, year, month, day, dual);
  if (p && ambiguous) p.ambiguous = true;
  return p;
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
  // B.C./BCE only exists for Gregorian and Julian years.
  if (bc && (calendar === 'hebrew' || calendar === 'french_r')) return undefined;
  const point: DatePoint = { year: bc ? -year : year };
  if (month !== undefined) {
    if (!(month >= 1 && month <= monthsInYear(calendar))) return undefined;
    // Adar II (ADS) only exists in leap years; elsewhere it can only mean Adar.
    point.month = calendar === 'hebrew' && month === 7 && !isHebrewLeap(year) ? 6 : month;
  }
  if (day !== undefined) {
    if (month === undefined || !(day >= 1 && day <= daysInMonth(calendar, point.year, month)))
      return undefined;
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
  if (p.ambiguous) date.ambiguous = true;
  return date;
}

function range(
  original: string,
  qualifier: DateQualifier,
  a: string,
  b: string,
  calendar: Calendar,
): ParsedDate | undefined {
  // Either side may be a span itself: `BET 1850S AND 1860S` runs 1850-1869.
  // As in a hyphenated span, a right side ending in 00s borrows the left side's
  // granularity (`BET 1660s AND 1700s` ends in 1709, `FROM 1700s TO 1800s` in 1899) and
  // any other right side is a decade. After a plain year the right side is read alone.
  const left = DECADES.exec(a);
  const centuries = left ? isCentury(Number(left[2] ?? left[1])) : undefined;
  const side = (s: string, i: 0 | 1): Point | undefined => {
    const span = yearSpan(s, i === 1 ? centuries : undefined);
    return parsePoint(s, calendar) ?? (span && { point: { year: span[i] }, calendar });
  };
  const start = side(a, 0);
  const end = start && side(b, 1);
  return end && build(original, qualifier, start!, end);
}

function build(
  original: string,
  qualifier: DateQualifier,
  start: Point,
  end: Point,
): ParsedDate | undefined {
  const sortKey = pointKey(start.point, start.calendar, 'low');
  const sortKeyEnd = pointKey(end.point, end.calendar, 'high');
  if (sortKey > sortKeyEnd) return undefined;
  const date: ParsedDate = {
    text: original,
    qualifier,
    start: start.point,
    end: end.point,
    calendar: start.calendar,
    sortKey,
    sortKeyEnd,
    valid: true,
  };
  if (end.calendar !== start.calendar) date.endCalendar = end.calendar;
  if (start.ambiguous || end.ambiguous) date.ambiguous = true;
  return date;
}

function textDate(text: string, phrase?: string): ParsedDate {
  const date: ParsedDate = {
    text,
    qualifier: 'text',
    calendar: 'gregorian',
    sortKey: UNDATED_SORT_KEY,
    valid: false,
  };
  if (phrase) date.phrase = phrase;
  return date;
}
