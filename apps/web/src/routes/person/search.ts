export const PERSON_TABS = ['facts', 'gallery', 'notes', 'lifestory', 'sources'] as const;
export type PersonTab = (typeof PERSON_TABS)[number];

export interface PersonSearch {
  /** Absent means Facts, so the default URL stays clean. */
  tab?: Exclude<PersonTab, 'facts'>;
  /** The tree the id belongs to; ids repeat across copied trees. Filled in on arrival. */
  tree?: string;
}

export function validatePersonSearch(search: Record<string, unknown>): PersonSearch {
  const valid: PersonSearch = {};
  const tab = search.tab;
  if (
    typeof tab === 'string' &&
    tab !== 'facts' &&
    (PERSON_TABS as readonly string[]).includes(tab)
  ) {
    valid.tab = tab as PersonSearch['tab'];
  }
  if (typeof search.tree === 'string' && search.tree) valid.tree = search.tree;
  return valid;
}
