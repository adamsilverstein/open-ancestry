import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BulkData } from '@open-ancestry/db';

/*
 * Synthetic trees for the tree view e2e tests. Every name is invented.
 *
 * The family tree, around Ada Vale (the home person):
 *
 *   Silas+Maud            (only loaded when Ezra's ancestors are expanded)
 *       |
 *   Ezra+Nell             (fetched with the first request, hidden until Abel is expanded)
 *       |
 *   Abel+Cora      Jonas+Lena   <- Jonas and Lena are reached twice (pedigree collapse)
 *       |          /        \
 *   Otto+Greta  (Greta)    Piers+Rhea
 *       |                     |
 *   Fenn, Bram   +   Elsa, Tilda
 *              |                         Rolf+Una (Ada's adoptive parents)
 *   Hugo, Ada, Ilsa                          |
 *   Corin+Ada+Lucan   <- two spouses        Ada
 *   (Hugo+Vera have Nico, a nephew; Fenn+Mae have Cass, a cousin)
 *     |        |
 *  Wren,Tobin  Mira
 *   Wren+Dax
 *      |
 *    Juno
 */

export interface SeedInfo {
  family: { tree: string; ids: Record<string, string> };
  /** Six generations of hard-to-fit names for the fan (see fanNamesGedcom). */
  fanNames: { tree: string; focusId: string };
  /** fixtures/ancestry-sample.ged, imported: ids by given name. */
  sample: { tree: string; ids: Record<string, string> };
  perf: PerfTree;
  /** Only with OA_PERF_100K=1 (the perf job): seeding 100,000 people takes several seconds. */
  perf100k?: PerfTree;
  /** Only with OA_PERF=1: one couple with 2,000 children (#209). */
  bigFamily?: { tree: string; fatherId: string; people: number };
}

export const FAMILY_TREE = 'e2e tree view family';
export const SAMPLE_TREE = 'e2e tree view sample';
export const FAN_NAMES_TREE = 'e2e tree view fan names';

/** Names that are hard to fit in a fan segment. Every one is invented. */
const HARD_NAMES = [
  'Johann Maximilian Wilhelm Friedrich /von Hohenzollern-Sigmaringen/',
  'Maria Theresia Wilhelmina Katharina /van Hoek/',
  '山田花子',
  '𝒜lice /Zed/',
  'John /Smith/ Jr.',
  'Ζωή /Παπαδοπούλου/',
  'Bartholomew /Featherstonehaugh/',
  'Wu',
];

/**
 * A GEDCOM of six generations (person n's parents are 2n and 2n + 1) whose
 * ancestors all carry hard names, for the fan's label fitting.
 */
export function fanNamesGedcom(): string {
  const lines = ['0 HEAD', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8'];
  for (let n = 1; n < 64; n++) {
    const name = n === 1 ? 'Ann /Lee/' : HARD_NAMES[(n - 2) % HARD_NAMES.length]!;
    lines.push(`0 @I${n}@ INDI`, `1 NAME ${name}`, `1 SEX ${n % 2 === 0 ? 'M' : 'F'}`);
    lines.push('1 BIRT', `2 DATE ${2000 - 25 * Math.floor(Math.log2(n))}`);
    if (n < 32) lines.push(`1 FAMC @F${n}@`);
    if (n > 1) lines.push(`1 FAMS @F${Math.floor(n / 2)}@`);
  }
  for (let n = 1; n < 32; n++) {
    lines.push(`0 @F${n}@ FAM`, `1 HUSB @I${2 * n}@`, `1 WIFE @I${2 * n + 1}@`, `1 CHIL @I${n}@`);
  }
  lines.push('0 TRLR');
  return lines.join('\n') + '\n';
}
export const PERF_TREE = 'e2e tree view 10k';
export const PERF_TREE_100K = 'e2e tree view 100k';

export interface PerfTree {
  tree: string;
  focusId: string;
  /**
   * A person with thousands of descendants within eight generations: the first
   * founder in the 10k tree, the densest such view in the 100k tree.
   */
  wideId: string;
  people: number;
}
export const BIG_FAMILY_TREE = 'e2e tree view big family';
export const SEED_FILE = 'tree-view-seed.json';

type Sex = 'M' | 'F';
interface PersonSpec {
  key: string;
  given: string;
  surname: string;
  sex: Sex;
  born: number;
  died?: number;
}

const people: PersonSpec[] = [
  { key: 'silas', given: 'Silas', surname: 'Vale', sex: 'M', born: 1790, died: 1860 },
  { key: 'maud', given: 'Maud', surname: 'Penn', sex: 'F', born: 1795, died: 1870 },
  { key: 'ezra', given: 'Ezra', surname: 'Vale', sex: 'M', born: 1820, died: 1890 },
  { key: 'nell', given: 'Nell', surname: 'Crane', sex: 'F', born: 1824, died: 1899 },
  { key: 'abel', given: 'Abel', surname: 'Vale', sex: 'M', born: 1850, died: 1920 },
  { key: 'cora', given: 'Cora', surname: 'Dune', sex: 'F', born: 1852, died: 1931 },
  { key: 'jonas', given: 'Jonas', surname: 'Hale', sex: 'M', born: 1850, died: 1915 },
  { key: 'lena', given: 'Lena', surname: 'Frost', sex: 'F', born: 1853, died: 1925 },
  { key: 'otto', given: 'Otto', surname: 'Vale', sex: 'M', born: 1880, died: 1950 },
  { key: 'greta', given: 'Greta', surname: 'Hale', sex: 'F', born: 1885, died: 1960 },
  { key: 'piers', given: 'Piers', surname: 'Hale', sex: 'M', born: 1882, died: 1940 },
  { key: 'rhea', given: 'Rhea', surname: 'Lund', sex: 'F', born: 1890, died: 1970 },
  { key: 'fenn', given: 'Fenn', surname: 'Vale', sex: 'M', born: 1909, died: 1980 },
  { key: 'bram', given: 'Bram', surname: 'Vale', sex: 'M', born: 1911, died: 1957 },
  { key: 'elsa', given: 'Elsa', surname: 'Hale', sex: 'F', born: 1915, died: 1999 },
  { key: 'tilda', given: 'Tilda', surname: 'Hale', sex: 'F', born: 1918, died: 2000 },
  { key: 'rolf', given: 'Rolf', surname: 'Grey', sex: 'M', born: 1910, died: 1985 },
  { key: 'una', given: 'Una', surname: 'Grey', sex: 'F', born: 1912, died: 1990 },
  { key: 'hugo', given: 'Hugo', surname: 'Vale', sex: 'M', born: 1939, died: 2001 },
  { key: 'ada', given: 'Ada', surname: 'Vale', sex: 'F', born: 1941 },
  { key: 'ilsa', given: 'Ilsa', surname: 'Vale', sex: 'F', born: 1944 },
  { key: 'corin', given: 'Corin', surname: 'Ash', sex: 'M', born: 1938, died: 1990 },
  { key: 'lucan', given: 'Lucan', surname: 'Reed', sex: 'M', born: 1945, died: 2010 },
  { key: 'wren', given: 'Wren', surname: 'Ash', sex: 'F', born: 1965 },
  { key: 'tobin', given: 'Tobin', surname: 'Ash', sex: 'M', born: 1968 },
  { key: 'mira', given: 'Mira', surname: 'Reed', sex: 'F', born: 1975 },
  { key: 'dax', given: 'Dax', surname: 'Hart', sex: 'M', born: 1963 },
  { key: 'juno', given: 'Juno', surname: 'Hart', sex: 'F', born: 1990 },
  { key: 'vera', given: 'Vera', surname: 'Moss', sex: 'F', born: 1941, died: 2015 },
  { key: 'nico', given: 'Nico', surname: 'Vale', sex: 'M', born: 1966 },
  { key: 'mae', given: 'Mae', surname: 'Orr', sex: 'F', born: 1912, died: 1990 },
  { key: 'cass', given: 'Cass', surname: 'Vale', sex: 'F', born: 1936, died: 2010 },
];

/** [family key, partner1, partner2, children (with optional relationship)] */
type FamilySpec = [string, string | null, string | null, (string | [string, 'adopted'])[]];
const families: FamilySpec[] = [
  ['f-silas', 'silas', 'maud', ['ezra']],
  ['f-ezra', 'ezra', 'nell', ['abel']],
  ['f-abel', 'abel', 'cora', ['otto']],
  ['f-jonas', 'jonas', 'lena', ['greta', 'piers']],
  ['f-otto', 'otto', 'greta', ['fenn', 'bram']],
  ['f-piers', 'piers', 'rhea', ['elsa', 'tilda']],
  ['f-bram', 'bram', 'elsa', ['hugo', 'ada', 'ilsa']],
  ['f-rolf', 'rolf', 'una', [['ada', 'adopted']]],
  ['f-corin', 'corin', 'ada', ['wren', 'tobin']],
  ['f-lucan', 'lucan', 'ada', ['mira']],
  ['f-dax', 'dax', 'wren', ['juno']],
  ['f-hugo', 'hugo', 'vera', ['nico']],
  ['f-fenn', 'fenn', 'mae', ['cass']],
];

const now = '2026-01-01T00:00:00.000Z';
const stamp = { created_at: now, updated_at: now };

/** Rows for the handcrafted family; ids are readable (`p-ada`, `f-bram`). */
export function familyRows(): { data: BulkData; ids: Record<string, string> } {
  const ids: Record<string, string> = {};
  const data = {
    person: [],
    person_name: [],
    event: [],
    event_role: [],
    family: [],
    family_child: [],
  } as Required<
    Pick<BulkData, 'person' | 'person_name' | 'event' | 'event_role' | 'family' | 'family_child'>
  >;
  const event = (owner: string, type: string, year: number) => {
    const id = `e-${owner}-${type}`;
    data.event.push({
      id,
      type,
      date_text: `5 SEP ${year}`,
      date_qualifier: 'exact',
      date_sort: year * 10000 + 905,
      calendar: 'gregorian',
      ...stamp,
    });
    data.event_role.push({ id: `r-${owner}-${type}`, event_id: id, person_id: `p-${owner}` });
  };
  for (const p of people) {
    const id = `p-${p.key}`;
    ids[p.key] = id;
    data.person.push({
      id,
      sex: p.sex,
      living: p.died ? 'dead' : 'living',
      ...stamp,
    });
    data.person_name.push({
      id: `n-${p.key}`,
      person_id: id,
      given: p.given,
      surname: p.surname,
      full_text: `${p.given} /${p.surname}/`,
      is_primary: 1,
    });
    event(p.key, 'BIRT', p.born);
    if (p.died) event(p.key, 'DEAT', p.died);
  }
  const childOrder = new Map<string, number>();
  for (const [key, p1, p2, kids] of families) {
    ids[key] = key;
    data.family.push({
      id: key,
      partner1_id: p1 ? `p-${p1}` : null,
      partner2_id: p2 ? `p-${p2}` : null,
      relationship_type: 'married',
      ...stamp,
    });
    kids.forEach((kid, i) => {
      const [child, rel] = typeof kid === 'string' ? [kid, 'biological' as const] : kid;
      const order = childOrder.get(child) ?? 0;
      childOrder.set(child, order + 1);
      data.family_child.push({
        id: `c-${key}-${child}`,
        family_id: key,
        child_id: `p-${child}`,
        partner1_rel: rel,
        partner2_rel: rel,
        sort_order: i,
        child_order: order,
        is_preferred: order === 0 ? 1 : 0,
      });
    });
  }
  return { data, ids };
}

/**
 * One couple with `children` children: bad data the import accepts (one
 * "unknown parents" family holding everyone), which once took 38 seconds to
 * label (#209).
 */
export function bigFamilyRows(children: number): BulkData {
  const person = (id: string, sex: Sex, given: string, born: number) => ({ id, sex, given, born });
  const everyone = [
    person('p-big-father', 'M', 'Aldous', 1800),
    person('p-big-mother', 'F', 'Briony', 1802),
    ...Array.from({ length: children }, (_, i) =>
      person(`p-big-${i}`, i % 2 ? 'F' : 'M', `Kit ${i + 1}`, 1820 + (i % 40)),
    ),
  ];
  return {
    person: everyone.map(({ id, sex }) => ({ id, sex, living: 'dead', ...stamp })),
    person_name: everyone.map(({ id, given }) => ({
      id: `n-${id}`,
      person_id: id,
      given,
      surname: 'Mallow',
      full_text: `${given} /Mallow/`,
      is_primary: 1,
    })),
    family: [
      {
        id: 'f-big',
        partner1_id: 'p-big-father',
        partner2_id: 'p-big-mother',
        relationship_type: 'married',
        ...stamp,
      },
    ],
    family_child: Array.from({ length: children }, (_, i) => ({
      id: `c-big-${i}`,
      family_id: 'f-big',
      child_id: `p-big-${i}`,
      partner1_rel: 'biological',
      partner2_rel: 'biological',
      sort_order: i,
      child_order: 0,
      is_preferred: 1,
    })),
  };
}

/** The seed written by global-setup.ts, read by the specs. */
export function readSeed(): SeedInfo {
  const library = process.env.OA_E2E_LIBRARY;
  if (!library) throw new Error('OA_E2E_LIBRARY is not set; run through e2e/playwright.config.ts');
  return JSON.parse(readFileSync(join(library, SEED_FILE), 'utf8')) as SeedInfo;
}
