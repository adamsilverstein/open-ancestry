export type DateQualifier = 'abt' | 'bef' | 'aft' | 'est' | 'cal';

/** A year-level date for display; full date handling lives in packages/core. */
export interface LifeDate {
  year: number;
  qualifier?: DateQualifier | undefined;
}

export interface Lifespan {
  birth?: LifeDate | undefined;
  death?: LifeDate | undefined;
  living?: boolean | undefined;
}

export function formatLifeDate(date: LifeDate): string {
  return date.qualifier ? `${date.qualifier}. ${date.year}` : String(date.year);
}

/** Formats `1911–1957`, `1947–Living`, `abt. 1890–1955`, `b. 1820` or `d. 1880`. */
export function formatLifespan({ birth, death, living }: Lifespan): string {
  const start = birth ? formatLifeDate(birth) : '';
  if (living) return start ? `${start}–Living` : 'Living';
  if (birth && death) return `${start}–${formatLifeDate(death)}`;
  if (birth) return `b. ${start}`;
  if (death) return `d. ${formatLifeDate(death)}`;
  return '';
}
