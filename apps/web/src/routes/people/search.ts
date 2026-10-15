import {
  PEOPLE_LIVING,
  PEOPLE_SEXES,
  PEOPLE_SORTS,
  type PeopleLiving,
  type PeopleParams,
  type PeopleSex,
  type PeopleSort,
} from '../../api/search';

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | undefined =>
  typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

/** `/people` URL search params; defaults are left out so the plain URL stays clean. */
export interface PeopleSearch {
  sort?: Exclude<PeopleSort, 'surname'>;
  dir?: 'desc';
  sex?: PeopleSex;
  living?: PeopleLiving;
  tag?: string;
  /** Never from the URL: the list pages itself. Set so a raw `limit` is dropped. */
  limit?: undefined;
}

/**
 * Every key is set, undefined when invalid or the default: TanStack Router
 * merges a route's validated search over the raw one, so an unset key lets
 * the raw value through. `limit` is not ours to take from the URL at all.
 */
export function validatePeopleSearch(search: Record<string, unknown>): PeopleSearch {
  const sort = oneOf(PEOPLE_SORTS, search.sort);
  return {
    sort: sort && sort !== 'surname' ? sort : undefined,
    dir: search.dir === 'desc' ? 'desc' : undefined,
    sex: oneOf(PEOPLE_SEXES, search.sex),
    living: oneOf(PEOPLE_LIVING, search.living),
    tag:
      typeof search.tag === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(search.tag)
        ? search.tag
        : undefined,
    limit: undefined,
  };
}

export function toPeopleParams(search: PeopleSearch): PeopleParams {
  return {
    sort: search.sort ?? 'surname',
    dir: search.dir ?? 'asc',
    sex: search.sex,
    living: search.living,
    tag: search.tag,
  };
}
