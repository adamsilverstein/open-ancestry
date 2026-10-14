export type DateQualifier =
  | 'exact'
  | 'about'
  | 'calculated'
  | 'estimated'
  | 'before'
  | 'after'
  | 'between'
  | 'from'
  | 'to'
  | 'from_to'
  | 'interpreted'
  | 'text';

export type Calendar = 'gregorian' | 'julian' | 'hebrew' | 'french_r' | 'unknown';

/** One calendar date. Years before 1 AD are negative (44 B.C. is -44); there is no year 0. */
export interface DatePoint {
  year: number;
  month?: number;
  day?: number;
  /** New-style year of a dual date: `1750/51` has year 1750 and dualYear 1751. */
  dualYear?: number;
}

export interface ParsedDate {
  /** The input exactly as given. */
  text: string;
  qualifier: DateQualifier;
  start?: DatePoint;
  /** Second date of `between` and `from_to` ranges. */
  end?: DatePoint;
  calendar: Calendar;
  /** Integer YYYYMMDD for indexed sorting; see sort-key.ts. */
  sortKey: number;
  /** Upper bound of a range, same encoding as sortKey. */
  sortKeyEnd?: number;
  /** False only when qualifier is 'text'. */
  valid: boolean;
  /** Free text from `INT date (phrase)` or a bare `(phrase)`. */
  phrase?: string;
}

/** Anything the date helpers accept: a parsed date or raw text to parse. */
export type DateInput = ParsedDate | string;
