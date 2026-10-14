export const PERSON_TABS = ['facts', 'gallery', 'notes', 'lifestory', 'sources'] as const;
export type PersonTab = (typeof PERSON_TABS)[number];

export interface PersonSearch {
  /** Absent means Facts, so the default URL stays clean. */
  tab?: Exclude<PersonTab, 'facts'>;
  /** Opens the Edit person dialog (the tree's quick view Edit links here). */
  edit?: true;
}

export function validatePersonSearch(search: Record<string, unknown>): PersonSearch {
  const valid: PersonSearch = {};
  const tab = search.tab;
  if (
    typeof tab === 'string' &&
    tab !== 'facts' &&
    (PERSON_TABS as readonly string[]).includes(tab)
  )
    valid.tab = tab as PersonSearch['tab'];
  if (search.edit === true || search.edit === 'true') valid.edit = true;
  return valid;
}
