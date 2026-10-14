import { getPersonDetail, openMemoryTree } from '@open-ancestry/db';
import { FIXTURE_PEOPLE, loadAshdownFamily } from '../../../../e2e/tree-fixture';
import type { PersonDetail } from '../api/types';

let store: ReturnType<typeof openMemoryTree> | undefined;

/** Person detail from the e2e Ashdown family, built in memory once per test file. */
export function fixtureDetail(key: keyof typeof FIXTURE_PEOPLE): PersonDetail {
  if (!store) {
    store = openMemoryTree();
    loadAshdownFamily(store);
  }
  return getPersonDetail(store, FIXTURE_PEOPLE[key])!;
}
