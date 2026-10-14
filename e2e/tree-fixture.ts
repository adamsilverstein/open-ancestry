import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bulkInsert,
  createTree,
  createUlidFactory,
  generateSyntheticTree,
  ulid,
  type InsertRow,
  type TreeStore,
} from '@open-ancestry/db';

/*
 * The e2e tree: a hand-built Ashdown family (every name invented) with
 * alternates, sources, Ancestry _APIDs, tags and notes, inside a 10k-person
 * synthetic tree for the performance budget.
 */

export const FIXTURE_TREE = 'fixture';
export const MANIFEST = 'manifest.json';

const PERSON_KEYS = [
  'rowan',
  'edmund',
  'clara',
  'silas',
  'horace',
  'felix',
  'mabel',
  'tobias',
  'wendell',
  'iris',
  'lena',
  'arthur',
  'pip',
] as const;
type PersonKey = (typeof PERSON_KEYS)[number];

/** Fixed ids for the hand-built family, so specs can import them before setup runs. */
const fixedId = createUlidFactory({ now: () => 1_750_000_000_000, random: () => 7 });
export const FIXTURE_PEOPLE = Object.fromEntries(
  PERSON_KEYS.map((key) => [key, fixedId()]),
) as Record<PersonKey, string>;

/** Record ids the tests navigate to. */
export interface FixtureManifest {
  tree: string;
  home: string;
  people: Record<PersonKey, string>;
  /** A person deep in the synthetic tree, with parents and children. */
  synthetic: string;
}

const now = '2026-01-01T00:00:00.000Z';
const stamp = { created_at: now, updated_at: now };
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

type FixtureTable =
  | 'import_batch'
  | 'person'
  | 'person_name'
  | 'place'
  | 'event'
  | 'event_role'
  | 'family'
  | 'family_child'
  | 'source'
  | 'citation'
  | 'citation_link'
  | 'tag'
  | 'tag_link'
  | 'note'
  | 'note_link';
type FixtureData = { [T in FixtureTable]: InsertRow<T>[] };

const QUALIFIERS = { ABT: 'about', BEF: 'before', AFT: 'after' } as const;

/** Minimal date handling for fixture text like `12 MAR 1880` or `ABT 1879`. */
function dateColumns(text: string) {
  const parts = text.split(' ');
  const qualifier = parts[0] && parts[0] in QUALIFIERS ? parts.shift()! : null;
  const year = Number(parts.at(-1));
  const month = parts.length > 1 ? MONTHS.indexOf(parts.at(-2)!) + 1 : 7;
  const day = parts.length > 2 ? Number(parts[0]) : 1;
  return {
    date_text: text,
    date_qualifier: qualifier ? QUALIFIERS[qualifier as keyof typeof QUALIFIERS] : 'exact',
    date_sort: year * 10000 + month * 100 + day,
    calendar: 'gregorian',
  };
}

function buildFamily(data: FixtureData) {
  const place = (full: string) => {
    const id = ulid();
    data.place.push({ id, name: full.split(',')[0]!, full_name: full, ...stamp });
    return id;
  };
  const places = {
    brackenford: place('Brackenford, Westmere'),
    wexmoor: place('Wexmoor, Westmere'),
    thornbury: place('Thornbury, Northvale'),
    ashcombe: place('Ashcombe, Eastholm'),
  };

  const event = (
    owner: { person_id: string } | { family_id: string },
    type: string,
    date: string | null,
    placeId: string | null,
    extra: { value?: string; is_preferred?: 0 | 1 } = {},
  ) => {
    const id = ulid();
    data.event.push({
      id,
      type,
      ...(date ? dateColumns(date) : {}),
      place_id: placeId,
      value: extra.value ?? null,
      ...stamp,
    });
    data.event_role.push({
      id: ulid(),
      event_id: id,
      ...owner,
      is_preferred: extra.is_preferred ?? 1,
    });
    return id;
  };

  const person = (
    key: PersonKey,
    sex: 'M' | 'F',
    given: string,
    surname: string,
    birth: string | null,
    death: string | null,
  ) => {
    const id = FIXTURE_PEOPLE[key];
    data.person.push({ id, sex, living: death ? 'dead' : 'living', ...stamp });
    data.person_name.push({
      id: ulid(),
      person_id: id,
      given,
      surname,
      full_text: `${given} /${surname}/`,
      is_primary: 1,
    });
    if (birth) event({ person_id: id }, 'BIRT', birth, places.brackenford);
    if (death) event({ person_id: id }, 'DEAT', death, places.thornbury);
    return id;
  };

  const family = (p1: string | null, p2: string | null, kids: string[], marriage?: string) => {
    const id = ulid();
    data.family.push({
      id,
      partner1_id: p1,
      partner2_id: p2,
      relationship_type: 'married',
      ...stamp,
    });
    kids.forEach((child, i) =>
      data.family_child.push({ id: ulid(), family_id: id, child_id: child, sort_order: i }),
    );
    if (marriage) event({ family_id: id }, 'MARR', marriage, places.ashcombe);
    return id;
  };

  const silas = person('silas', 'M', 'Silas', 'Ashdown', '4 APR 1822', '9 JAN 1890');
  const horace = person('horace', 'M', 'Horace', 'Ashdown', '1848', '1910');
  const felix = person('felix', 'M', 'Felix', 'Ashdown', '1876', '1939');
  const edmund = person('edmund', 'M', 'Edmund', 'Ashdown', '2 FEB 1850', '17 AUG 1901');
  const clara = person('clara', 'F', 'Clara', 'Penhallow', '1853', '1930');
  const mabel = person('mabel', 'F', 'Mabel', 'Ashdown', '1878', '1960');
  // Rowan: the home person. Birth comes with an alternate below.
  const rowan = person('rowan', 'M', 'Rowan', 'Ashdown', null, '3 NOV 1950');
  const tobias = person('tobias', 'M', 'Tobias', 'Ashdown', '22 JUL 1883', '1952');
  const wendell = person('wendell', 'M', 'Wendell', 'Ashdown', '1912', '1980');
  const iris = person('iris', 'F', 'Iris', 'Vale', '1885', '6 MAY 1940');
  const lena = person('lena', 'F', 'Lena', 'Ashdown', '30 SEP 1906', null);
  const arthur = person('arthur', 'M', 'Arthur', 'Ashdown', '1909', '1944');
  const pip = person('pip', 'M', 'Pip', 'Ashdown', '1935', '2001');

  family(silas, null, [edmund, horace]);
  family(horace, null, [felix]);
  family(edmund, clara, [mabel, rowan, tobias], '1876');
  family(tobias, null, [wendell]);
  family(rowan, iris, [lena, arthur], '14 JUN 1905');
  family(arthur, null, [pip]);

  const birth = event({ person_id: rowan }, 'BIRT', '12 MAR 1880', places.brackenford);
  event({ person_id: rowan }, 'BIRT', 'ABT 1879', places.wexmoor, { is_preferred: 0 });
  event({ person_id: rowan }, 'RESI', '1900', places.wexmoor);
  const census = event({ person_id: rowan }, 'CENS', '1911', places.thornbury);
  event({ person_id: rowan }, 'OCCU', '1910', places.thornbury, { value: 'Blacksmith' });
  event({ person_id: rowan }, 'BURI', '8 NOV 1950', places.thornbury);

  const source = (title: string, apid: string | null) => {
    const id = ulid();
    data.source.push({ id, title, apid, ...stamp });
    return id;
  };
  const cite = (
    sourceId: string,
    owner: { owner_type: 'event' | 'person'; owner_id: string },
    page: string,
    quality: number,
    apid: string | null,
  ) => {
    const id = ulid();
    data.citation.push({ id, source_id: sourceId, page, quality, apid, ...stamp });
    data.citation_link.push({ id: ulid(), citation_id: id, ...owner });
  };
  cite(
    source('1911 Northvale Census', '1,7572::0'),
    { owner_type: 'event', owner_id: census },
    'Thornbury, folio 12, schedule 88',
    3,
    '1,7572::30542144',
  );
  cite(
    source('Brackenford Parish Register', null),
    { owner_type: 'event', owner_id: birth },
    'Baptisms 1880, entry 41',
    2,
    null,
  );
  cite(
    source('Ashdown Family Bible', null),
    { owner_type: 'person', owner_id: rowan },
    'Births page',
    1,
    null,
  );

  const tagId = ulid();
  data.tag.push({ id: tagId, name: 'Blacksmiths', category: 'Occupation', ...stamp });
  data.tag_link.push({ id: ulid(), tag_id: tagId, owner_type: 'person', owner_id: rowan });

  const noteId = ulid();
  data.note.push({
    id: noteId,
    text: 'Rowan kept the forge on Mill Lane for forty years.',
    ...stamp,
  });
  data.note_link.push({ id: ulid(), note_id: noteId, owner_type: 'person', owner_id: rowan });

  return {
    rowan,
    edmund,
    clara,
    silas,
    horace,
    felix,
    mabel,
    tobias,
    wendell,
    iris,
    lena,
    arthur,
    pip,
  };
}

const emptyData = (): FixtureData => ({
  import_batch: [],
  person: [],
  person_name: [],
  place: [],
  event: [],
  event_role: [],
  family: [],
  family_child: [],
  source: [],
  citation: [],
  citation_link: [],
  tag: [],
  tag_link: [],
  note: [],
  note_link: [],
});

/** Loads the Ashdown family (home person: Rowan) into a store, e.g. an in-memory tree. */
export function loadAshdownFamily(store: TreeStore, extra?: Partial<FixtureData>): void {
  const data = { ...emptyData(), ...extra };
  buildFamily(data);
  bulkInsert(store, data);
  store.db
    .prepare("INSERT INTO meta (key, value) VALUES ('home_person_id', ?)")
    .run(FIXTURE_PEOPLE.rowan);
}

/** Creates `<library>/fixture.oatree` (family plus 10k synthetic people) and its manifest. */
export function buildFixtureLibrary(library: string): FixtureManifest {
  mkdirSync(library, { recursive: true });
  const store = createTree(join(library, `${FIXTURE_TREE}.oatree`), { name: 'Ashdown family' });
  const { focusId, ...synthetic } = generateSyntheticTree({ people: 10_000 });
  loadAshdownFamily(store, synthetic);
  store.close();

  const manifest: FixtureManifest = {
    tree: FIXTURE_TREE,
    home: FIXTURE_PEOPLE.rowan,
    people: FIXTURE_PEOPLE,
    synthetic: focusId,
  };
  writeFileSync(join(library, MANIFEST), JSON.stringify(manifest));
  return manifest;
}
