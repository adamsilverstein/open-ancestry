import type { BulkData } from './bulk';
import type { InsertRow } from './types';
import { createUlidFactory } from './ulid';

/*
 * Deterministic synthetic trees for tests and benchmarks, built directly as
 * rows (no GEDCOM involved). Every name and place is invented.
 */

const SURNAMES = [
  'Ashgrove',
  'Bellweather',
  'Corran',
  'Dunmore',
  'Eldermoor',
  'Fairholt',
  'Greaves',
  'Hollowell',
  'Ingleby',
  'Jessamy',
  'Kestrel',
  'Larkspur',
  'Mosswood',
  'Nettlefield',
  'Oakhart',
  'Pennyroyal',
  'Quarrier',
  'Rookwood',
  'Sedgemoor',
  'Thistlewood',
  'Underhill',
  'Vantage',
  'Wrenfield',
  'Yarrow',
];
const GIVEN = {
  M: [
    'Alder',
    'Bram',
    'Cassius',
    'Dorian',
    'Ellis',
    'Fenn',
    'Garrick',
    'Hollis',
    'Ivo',
    'Jasper',
    'Kester',
    'Linus',
  ],
  F: [
    'Adela',
    'Briony',
    'Celandine',
    'Delphine',
    'Elowen',
    'Fern',
    'Greer',
    'Hazel',
    'Isolde',
    'Juniper',
    'Linnea',
    'Marigold',
  ],
} as const;
const TOWNS = [
  'Brackenford',
  'Wexmoor',
  'Thornbury',
  'Fenmark',
  'Ashcombe',
  'Larkhollow',
  'Mirewick',
  'Saltmarsh',
];
const REGIONS = ['Westmere', 'Northvale', 'Eastholm'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

export interface SyntheticOptions {
  people: number;
  seed?: number;
  /** Year used to decide who is still living. */
  currentYear?: number;
}

export type SyntheticTree = Required<
  Pick<
    BulkData,
    | 'import_batch'
    | 'person'
    | 'person_name'
    | 'place'
    | 'event'
    | 'event_role'
    | 'family'
    | 'family_child'
  >
> & {
  /** A person in the middle generations, with ancestors and descendants. */
  focusId: string;
};

/** mulberry32 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Generates `people` persons over many generations: founder couples, children
 * with BIRT (and DEAT for the long dead) events, and married-in spouses whose
 * families continue the line breadth-first.
 */
export function generateSyntheticTree({
  people,
  seed = 1,
  currentYear = 2026,
}: SyntheticOptions): SyntheticTree {
  const random = rng(seed);
  const int = (n: number) => Math.floor(random() * n);
  const pick = <T>(list: readonly T[]): T => list[int(list.length)] as T;
  const id = createUlidFactory({ now: () => 1_700_000_000_000, random: () => int(32) });
  const now = '2026-01-01T00:00:00.000Z';
  const batchId = id();

  const tree: SyntheticTree = {
    import_batch: [
      {
        id: batchId,
        file_name: `synthetic-${people}.ged`,
        status: 'completed',
        started_at: now,
        finished_at: now,
      },
    ],
    person: [],
    person_name: [],
    place: [],
    event: [],
    event_role: [],
    family: [],
    family_child: [],
    focusId: '',
  };
  const stamp = { created_at: now, updated_at: now };

  for (const region of REGIONS) {
    for (const town of TOWNS) {
      tree.place.push({ id: id(), name: town, full_name: `${town}, ${region}`, ...stamp });
    }
  }

  const addEvent = (type: string, year: number, owner: Partial<InsertRow<'event_role'>>) => {
    const month = int(12);
    const day = 1 + int(28);
    const eventId = id();
    tree.event.push({
      id: eventId,
      type,
      date_text: `${day} ${MONTHS[month]} ${year}`,
      date_qualifier: 'exact',
      date_sort: year * 10000 + (month + 1) * 100 + day,
      calendar: 'gregorian',
      place_id: pick(tree.place).id,
      import_batch_id: batchId,
      ...stamp,
    });
    tree.event_role.push({ id: id(), event_id: eventId, ...owner });
  };

  const addPerson = (sex: 'M' | 'F', surname: string, birthYear: number): string => {
    const personId = id();
    const deathYear = birthYear + 40 + int(50);
    const dead = deathYear < currentYear;
    tree.person.push({
      id: personId,
      sex,
      living: dead ? 'inferred_dead' : 'inferred_living',
      external_id: `@I${tree.person.length + 1}@`,
      import_batch_id: batchId,
      ...stamp,
    });
    const given = pick(GIVEN[sex]);
    tree.person_name.push({
      id: id(),
      person_id: personId,
      given,
      surname,
      full_text: `${given} /${surname}/`,
      surname_key: surname.slice(0, 4).toUpperCase(),
      is_primary: 1,
    });
    addEvent('BIRT', birthYear, { person_id: personId });
    if (dead) addEvent('DEAT', deathYear, { person_id: personId });
    return personId;
  };

  interface Couple {
    familyId: string;
    surname: string;
    year: number;
    generation: number;
  }
  const queue: Couple[] = [];
  // Unmarried children by generation and sex, so lines can marry into each other.
  const singles = new Map<string, { id: string; familyId: string; surname: string }[]>();
  const addFamily = (p1: string, p2: string, surname: string, year: number, generation: number) => {
    const familyId = id();
    tree.family.push({
      id: familyId,
      partner1_id: p1,
      partner2_id: p2,
      relationship_type: 'married',
      external_id: `@F${tree.family.length + 1}@`,
      import_batch_id: batchId,
      ...stamp,
    });
    addEvent('MARR', year + 22, { family_id: familyId });
    queue.push({ familyId, surname, year: year + 25, generation });
  };
  const founders = () => {
    const surname = pick(SURNAMES);
    const year = 1650 + int(30);
    const husband = addPerson('M', surname, year);
    const wife = addPerson('F', pick(SURNAMES), year + int(5));
    addFamily(husband, wife, surname, year, 0);
  };

  for (let i = 0; i < 6 && tree.person.length < people; i++) founders();
  while (tree.person.length < people) {
    const couple = queue.shift();
    if (!couple) {
      founders();
      continue;
    }
    const generation = couple.generation + 1;
    const kids = 1 + int(4);
    for (let k = 0; k < kids && tree.person.length < people; k++) {
      const sex = random() < 0.5 ? 'M' : 'F';
      const birthYear = couple.year + k * 2 + int(2);
      const child = addPerson(sex, couple.surname, birthYear);
      tree.family_child.push({
        id: id(),
        family_id: couple.familyId,
        child_id: child,
        sort_order: k,
      });
      if (random() >= 0.7) {
        const key = `${generation}${sex}`;
        singles.set(key, [
          ...(singles.get(key) ?? []),
          { id: child, familyId: couple.familyId, surname: couple.surname },
        ]);
        continue;
      }
      // Half the time marry a single from another family of the same generation.
      const pool = singles.get(`${generation}${sex === 'M' ? 'F' : 'M'}`) ?? [];
      const match = random() < 0.5 ? pool.findIndex((s) => s.familyId !== couple.familyId) : -1;
      let spouse: string;
      let spouseSurname: string;
      if (match >= 0) {
        const [single] = pool.splice(match, 1);
        spouse = single?.id as string;
        spouseSurname = single?.surname as string;
      } else if (tree.person.length < people) {
        spouseSurname = pick(SURNAMES);
        spouse = addPerson(sex === 'M' ? 'F' : 'M', spouseSurname, birthYear + int(5) - 2);
      } else {
        break;
      }
      const [p1, p2] = sex === 'M' ? [child, spouse] : [spouse, child];
      addFamily(p1, p2, sex === 'M' ? couple.surname : spouseSurname, birthYear, generation);
    }
  }

  // Middle of the generated order: a child with several ancestor generations above.
  const children = tree.family_child;
  tree.focusId = (children[Math.floor(children.length / 2)]?.child_id ??
    tree.person[0]?.id) as string;
  return tree;
}
