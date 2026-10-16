import { astronomical, toGregorian } from './calendar';
import { asParsed } from './format';
import type { DateInput, ParsedDate } from './types';

export interface Age {
  years: number;
  /** True when a qualifier or a missing day/month makes the age uncertain. */
  approximate: boolean;
  /** `25` or `about 25`. */
  text: string;
}

interface Reference {
  year: number;
  month?: number;
  day?: number;
  approximate: boolean;
}

/** The single Gregorian point a date stands for when computing ages. */
function reference(date: ParsedDate): Reference | undefined {
  const { start, end, calendar, qualifier } = date;
  if (!start) return undefined;
  // The Gregorian year a sort key falls in.
  const keyYear = (key: number) => astronomical(Math.floor(key / 10000));
  if (end) {
    // A range resolves to its middle year, from its Gregorian bounds, so mixed
    // and non-Gregorian calendars work.
    const year = Math.floor((keyYear(date.sortKey) + keyYear(date.sortKeyEnd!)) / 2);
    return { year, approximate: true };
  }
  if ((calendar === 'hebrew' || calendar === 'french_r') && start.day === undefined) {
    // A Hebrew or French month or year straddles two Gregorian years.
    return { year: keyYear(date.sortKey), approximate: true };
  }
  const approximate = qualifier !== 'exact' && qualifier !== 'interpreted';
  const year = start.dualYear ?? start.year;
  if (start.month !== undefined && start.day !== undefined) {
    // A dual date is Old Style: a Julian date in its new-style year (#298).
    const rules = start.dualYear !== undefined && calendar === 'gregorian' ? 'julian' : calendar;
    const g = toGregorian(rules, year, start.month, start.day);
    return { year: astronomical(g.year), month: g.month, day: g.day, approximate };
  }
  return { year: astronomical(year), month: start.month, approximate };
}

/** Age in whole years at an event, or undefined when unknown or negative. */
export function ageAt(birth: DateInput, event: DateInput): Age | undefined {
  const b = reference(asParsed(birth));
  const e = reference(asParsed(event));
  if (!b || !e) return undefined;
  let years = e.year - b.year;
  let approximate = b.approximate || e.approximate;
  if (b.month !== undefined && e.month !== undefined) {
    if (e.month < b.month) years--;
    else if (e.month === b.month) {
      if (b.day !== undefined && e.day !== undefined) {
        if (e.day < b.day) years--;
      } else approximate = true;
    }
  } else approximate = true;
  if (years < 0) return undefined;
  return { years, approximate, text: approximate ? `about ${years}` : String(years) };
}
