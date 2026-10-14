/** GEDCOM 7 `RESN` enumeration values. */
export type Restriction = 'CONFIDENTIAL' | 'LOCKED' | 'PRIVACY';

/**
 * A `RESN` value (5.5.1 single word, 7 comma list, or whatever a tool wrote)
 * as GEDCOM 7 restrictions. It fails closed: a word mentioning privacy or
 * confidentiality counts wherever it is, and any word it cannot read
 * (`restricted`, `share`) counts as PRIVACY. Empty or `public` is none.
 */
export function resnRestrictions(value: string | undefined): Restriction[] {
  const found = new Set<Restriction>();
  for (const word of (value ?? '').toLowerCase().split(/[^a-z]+/)) {
    if (!word || word === 'public') continue;
    if (word.includes('confidential')) found.add('CONFIDENTIAL');
    else if (word === 'locked') found.add('LOCKED');
    else found.add('PRIVACY');
  }
  return (['CONFIDENTIAL', 'LOCKED', 'PRIVACY'] as const).filter((r) => found.has(r));
}
