import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { phoneticKeys } from '@open-ancestry/core';
import {
  bulkInsert,
  createTree,
  events,
  generateSyntheticTree,
  meta,
  names,
  persons,
  places,
  tagLinks,
  tags,
  type Tx,
} from '@open-ancestry/db';

/*
 * Synthetic trees for search and people-list e2e. Every name is invented.
 * `Search fixture` is a 10k generated tree plus a few hand-placed people with
 * distinctive names; `Hundred thousand` is a 100k generated tree for the
 * virtualized list.
 */

export const SEARCH_TREE = 'Search fixture';
export const BIG_TREE = 'Hundred thousand';
export const BIG_TREE_PEOPLE = 100_000;
export const SEARCH_TREE_PEOPLE = 10_000 + 3;

/** The hand-placed people, by stable external id. */
export const NAMED = {
  wren: '@WREN@',
  ezra: '@EZRA@',
  mabyn: '@MABYN@',
} as const;

const key = (surname: string) => phoneticKeys(surname).join(' ') || null;

function addPerson(
  tx: Tx,
  externalId: string,
  sex: 'M' | 'F',
  nameList: { given: string; surname: string; type?: 'birth' | 'married' }[],
  birth?: { date: string; place: string },
  death?: { date: string },
) {
  const person = persons.create(tx, {
    sex,
    living: death ? 'dead' : 'living',
    external_id: externalId,
  });
  nameList.forEach((n, i) =>
    names.add(tx, person.id, { ...n, surname_key: key(n.surname), sort_order: i }),
  );
  if (birth) {
    const place =
      (
        tx.store.stmt('SELECT id FROM place WHERE full_name = ?').get(birth.place) as
          { id: string } | undefined
      )?.id ?? places.create(tx, { name: birth.place.split(',')[0]!, full_name: birth.place }).id;
    const year = Number(birth.date.slice(-4));
    events.create(tx, {
      type: 'BIRT',
      date_text: birth.date,
      date_qualifier: 'exact',
      date_sort: year * 10000 + 615,
      place_id: place,
      roles: [{ person_id: person.id, role: 'principal' }],
    });
  }
  if (death) {
    const year = Number(death.date.slice(-4));
    events.create(tx, {
      type: 'DEAT',
      date_text: death.date,
      date_qualifier: 'exact',
      date_sort: year * 10000 + 615,
      roles: [{ person_id: person.id, role: 'principal' }],
    });
  }
  return person.id;
}

export function buildSearchLibrary(library: string): void {
  if (!existsSync(join(library, `${SEARCH_TREE}.oatree`))) {
    const store = createTree(join(library, `${SEARCH_TREE}.oatree`), { name: SEARCH_TREE });
    bulkInsert(store, generateSyntheticTree({ people: 10_000, seed: 7 }));
    store.transact('Seed named people', (tx) => {
      const wren = addPerson(
        tx,
        NAMED.wren,
        'F',
        [
          { given: 'Wren', surname: 'Thackeray' },
          { given: 'Wren', surname: 'Abernathy', type: 'married' },
        ],
        { date: '15 JUN 1850', place: 'Kestrel Cove, Saltmarsh' },
        { date: '2 MAR 1921' },
      );
      addPerson(
        tx,
        NAMED.ezra,
        'M',
        [{ given: 'Ezra', surname: 'Thackery' }],
        {
          date: '1849',
          place: 'Kestrel Cove, Saltmarsh',
        },
        { date: '1910' },
      );
      addPerson(tx, NAMED.mabyn, 'F', [{ given: 'Mabyn', surname: 'Thackeray' }]);
      const tag = tags.create(tx, { name: 'Brick wall', category: 'Research' });
      tagLinks.create(tx, { tag_id: tag.id, owner_type: 'person', owner_id: wren });
      meta.setHomePerson(tx, wren);
    });
    store.close();
  }
  if (!existsSync(join(library, `${BIG_TREE}.oatree`))) {
    const store = createTree(join(library, `${BIG_TREE}.oatree`), { name: BIG_TREE });
    bulkInsert(store, generateSyntheticTree({ people: BIG_TREE_PEOPLE, seed: 3 }));
    store.close();
  }
}
