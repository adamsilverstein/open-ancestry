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
  if (end || calendar === 'hebrew' || calendar === 'french_r') {
    // Ranges and approximate calendars only resolve to a year.
    const year = end ? Math.floor((yearOf(start) + yearOf(end)) / 2) : astronomical(Math.floor(date.sortKey / 10000));
    return { year, approximate: true };
  }
  const approximate = qualifier !== 'exact' && qualifier !== 'interpreted';
  const year = start.dualYear ?? start.year;
  if (start.month !== undefined && start.day !== undefined) {
    const g = toGregorian(calendar, year, start.month, start.day);
    return { year: astronomical(g.year), month: g.month, day: g.day, approximate };
  }
  return { year: astronomical(year), month: start.month, approximate };
}

const yearOf = (p: { year: number; dualYear?: number }) => astronomical(p.dualYear ?? p.year);

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
