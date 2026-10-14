import { openMemoryTree, persons, families, events, places, type TreeStore } from '../index';

/** Deterministic clock: each call advances one second from 2026-01-01. */
export function fixedClock(start = Date.UTC(2026, 0, 1)) {
  let t = start;
  return () => {
    const iso = new Date(t).toISOString();
    t += 1000;
    return iso;
  };
}

export function memoryTree(): TreeStore {
  return openMemoryTree({ clock: fixedClock() });
}

export interface SmallFamily {
  grandpa: string;
  grandma: string;
  dad: string;
  mom: string;
  me: string;
  sister: string;
  spouse: string;
  kid: string;
  grandkid: string;
  parentsFamily: string;
  grandparentsFamily: string;
  myFamily: string;
}

/**
 * Three-generation synthetic family, all invented names:
 *
 *   Orrin Vale = Tamsin Reed
 *          |
 *   Ivo Vale = Nerys Holt
 *          |
 *   +------+-------+
 *   Ellis Vale = Briony Fenn,  Petra Vale
 *          |
 *   Quill Vale
 *          |
 *   Juniper Vale
 */
export function seedSmallFamily(store: TreeStore): SmallFamily {
  return store.transact('seed', (tx) => {
    const place = places.create(tx, { name: 'Brackenford', full_name: 'Brackenford, Wexmoor' });
    const person = (sex: 'M' | 'F', given: string, surname: string, birthYear?: number) => {
      const p = persons.create(tx, {
        sex,
        names: [{ given, surname, surname_key: surname.toUpperCase().slice(0, 3) }],
      });
      if (birthYear !== undefined) {
        events.create(tx, {
          type: 'BIRT',
          date_text: String(birthYear),
          date_sort: birthYear * 10000 + 701,
          place_id: place.id,
          roles: [{ person_id: p.id }],
        });
      }
      return p.id;
    };
    const grandpa = person('M', 'Orrin', 'Vale', 1900);
    const grandma = person('F', 'Tamsin', 'Reed', 1902);
    const dad = person('M', 'Ivo', 'Vale', 1930);
    const mom = person('F', 'Nerys', 'Holt', 1932);
    const me = person('M', 'Ellis', 'Vale', 1960);
    const sister = person('F', 'Petra', 'Vale', 1962);
    const spouse = person('F', 'Briony', 'Fenn', 1961);
    const kid = person('M', 'Quill', 'Vale', 1990);
    const grandkid = person('F', 'Juniper', 'Vale', 2020);
    const grandparentsFamily = families.create(tx, {
      partner1_id: grandpa,
      partner2_id: grandma,
      relationship_type: 'married',
      children: [{ child_id: dad }],
    }).id;
    const parentsFamily = families.create(tx, {
      partner1_id: dad,
      partner2_id: mom,
      relationship_type: 'married',
      children: [{ child_id: me }, { child_id: sister, sort_order: 1 }],
    }).id;
    const myFamily = families.create(tx, {
      partner1_id: me,
      partner2_id: spouse,
      relationship_type: 'married',
      children: [{ child_id: kid }],
    }).id;
    families.create(tx, { partner1_id: kid, children: [{ child_id: grandkid }] });
    return {
      grandpa,
      grandma,
      dad,
      mom,
      me,
      sister,
      spouse,
      kid,
      grandkid,
      parentsFamily,
      grandparentsFamily,
      myFamily,
    };
  }).result;
}
