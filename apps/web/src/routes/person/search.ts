export const PERSON_TABS = ['facts', 'gallery', 'notes', 'lifestory', 'sources'] as const;
export type PersonTab = (typeof PERSON_TABS)[number];

export interface PersonSearch {
  /** Absent means Facts, so the default URL stays clean. */
  tab?: Exclude<PersonTab, 'facts'>;
}

/**
 * Every key is set, undefined when invalid: TanStack Router merges a route's
 * validated search over the raw one, so an unset key lets the raw value through.
 */
export function validatePersonSearch(search: Record<string, unknown>): PersonSearch {
  const tab = search.tab;
  return {
    tab:
      typeof tab === 'string' && tab !== 'facts' && (PERSON_TABS as readonly string[]).includes(tab)
        ? (tab as PersonSearch['tab'])
        : undefined,
  };
}
