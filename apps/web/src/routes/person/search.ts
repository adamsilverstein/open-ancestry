export const PERSON_TABS = ['facts', 'gallery', 'notes', 'lifestory', 'sources'] as const;
export type PersonTab = (typeof PERSON_TABS)[number];

export interface PersonSearch {
  /** Absent means Facts, so the default URL stays clean. */
  tab?: Exclude<PersonTab, 'facts'>;
}

export function validatePersonSearch(search: Record<string, unknown>): PersonSearch {
  const tab = search.tab;
  return typeof tab === 'string' &&
    tab !== 'facts' &&
    (PERSON_TABS as readonly string[]).includes(tab)
    ? { tab: tab as PersonSearch['tab'] }
    : {};
}
