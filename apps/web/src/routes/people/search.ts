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
}

export function validatePeopleSearch(search: Record<string, unknown>): PeopleSearch {
  const result: PeopleSearch = {};
  const sort = oneOf(PEOPLE_SORTS, search.sort);
  if (sort && sort !== 'surname') result.sort = sort;
  if (search.dir === 'desc') result.dir = 'desc';
  const sex = oneOf(PEOPLE_SEXES, search.sex);
  if (sex) result.sex = sex;
  const living = oneOf(PEOPLE_LIVING, search.living);
  if (living) result.living = living;
  if (typeof search.tag === 'string' && /^[0-9A-Za-z_-]{1,64}$/.test(search.tag)) {
    result.tag = search.tag;
  }
  return result;
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
