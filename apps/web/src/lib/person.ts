import type { LifeDate } from './lifespan';

export type Sex = 'M' | 'F' | 'U';

export type TagColor = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface TagSummary {
  label: string;
  color: TagColor;
}

/** What tree cards, lists and popovers need to show a person. */
export interface PersonSummary {
  id: string;
  name: string;
  sex: Sex;
  birth?: LifeDate | undefined;
  death?: LifeDate | undefined;
  living?: boolean | undefined;
  photoUrl?: string | undefined;
  tags?: TagSummary[] | undefined;
  sourceCount?: number | undefined;
}

export const sexLabel: Record<Sex, string> = { M: 'male', F: 'female', U: 'sex unknown' };

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '';
  const last = parts.length > 1 ? (parts.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase() || '?';
}
