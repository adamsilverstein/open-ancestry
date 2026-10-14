/**
 * Deterministic synthetic Ancestry-style GEDCOM 5.5.1 generator.
 *
 * Every name, place and record id is invented. The same seed and size always
 * produce byte-identical output, so fixtures and benchmarks are reproducible.
 *
 * Usage: npm run fixtures [-- --people 1000 --seed 1 --out fixtures/generated/x.ged]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

export interface GenerateOptions {
  people: number;
  seed?: number;
  /** Year used to decide who is still living. */
  currentYear?: number;
}

const GIVEN_MALE = [
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
  'Merrick',
  'Niall',
  'Orrin',
  'Perrin',
  'Quill',
  'Rowan',
  'Silas',
  'Tobin',
];
const GIVEN_FEMALE = [
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
  'Nerys',
  'Oriel',
  'Petra',
  'Rosalind',
  'Sabine',
  'Tamsin',
  'Wren',
  'Yarrow',
];
const SURNAMES = [
  'Ashgrove',
  'Bellweather',
  'Corran',
  'Dunmore',
  'Eldermoor',
  'Fallowfield',
  'Grimsworth',
  'Hollowell',
  'Ingleby',
  'Jessamy',
  'Kittering',
  'Larkspur',
  'Mosswood',
  'Netherby',
  'Orchardson',
  'Pennywhistle',
  'Quenby',
  'Rookhaven',
  'Stillwater',
  'Thistlewood',
];
const PLACES = [
  'Millbrook, Harlow County, Vermont, USA',
  'Elderford, Cask County, Ohio, USA',
  'Wrenfield, Pell County, Iowa, USA',
  'Stonemere, Ashby County, Pennsylvania, USA',
  'Larchmont Vale, Quill County, Oregon, USA',
  'Brackenridge, Thorne County, Ontario, Canada',
  'Hollin Cross, Westmarch, England',
  'Fernhaven, Dunlough, Ireland',
];
const SOURCES = [
  { title: '1900 United States Federal Census', apidDb: 7602 },
  { title: '1940 United States Federal Census', apidDb: 2442 },
  { title: 'U.S., Find a Grave Index, 1600s-Current', apidDb: 60525 },
  { title: 'U.S., World War I Draft Registration Cards, 1917-1918', apidDb: 6482 },
  { title: 'Ohio, U.S., County Marriage Records, 1774-1993', apidDb: 61378 },
];
const TAGS = [
  { name: 'Research Complete', category: 'Research Status' },
  { name: 'Unverified', category: 'Research Status' },
  { name: 'Brick Wall', category: 'Custom' },
];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** mulberry32: small, fast, deterministic PRNG. */
function createRandom(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
  };
}
type Random = ReturnType<typeof createRandom>;

interface Person {
  id: number;
  sex: 'M' | 'F';
  given: string;
  surname: string;
  birthYear: number;
  deathYear: number | undefined;
  famc: { fam: number; rel: 'Natural' | 'Adopted' | 'Step' } | undefined;
  fams: number[];
  milt: boolean;
}

interface Family {
  id: number;
  husb: number;
  wife: number;
  marrYear: number;
  children: number[];
}

/** Formats a date in one of the shapes Ancestry exports contain. */
function formatDate(rand: Random, year: number): string {
  const month = rand.int(1, 12);
  const day = rand.int(1, 28);
  const pad = (n: number) => String(n).padStart(2, '0');
  switch (rand.int(0, 11)) {
    case 0:
      return `ABT ${year}`;
    case 1:
      return `BEF ${year + 1}`;
    case 2:
      return `AFT ${year - 1}`;
    case 3:
      return `BET ${year - 2} AND ${year + 2}`;
    case 4:
      return `${pad(month)}/${pad(day)}/${year}`;
    case 5:
      return `${year}-${pad(month)}-${pad(day)}`;
    case 6:
      return `${MONTHS[month - 1]} ${year}`;
    case 7:
      return `${year}`;
    case 8: {
      const decade = year - (year % 10);
      return `${decade}-${decade + 9}`;
    }
    default:
      return `${day} ${MONTHS[month - 1]} ${year}`;
  }
}

function generateTree(rand: Random, target: number, currentYear: number) {
  const people: Person[] = [];
  const families: Family[] = [];

  const addPerson = (sex: 'M' | 'F', surname: string, birthYear: number): Person => {
    const person: Person = {
      id: people.length + 1,
      sex,
      given: rand.pick(sex === 'M' ? GIVEN_MALE : GIVEN_FEMALE),
      surname,
      birthYear,
      deathYear: undefined,
      famc: undefined,
      fams: [],
      milt: sex === 'M' && birthYear > 1870 && birthYear < 1930 && rand.chance(0.3),
    };
    const age = currentYear - birthYear;
    if (age > 100 || (age > 40 && rand.chance(age / 130))) {
      person.deathYear = Math.min(currentYear - 1, birthYear + rand.int(30, 95));
    }
    people.push(person);
    return person;
  };

  const marry = (a: Person, b: Person, year: number): Family => {
    const [husb, wife] = a.sex === 'M' ? [a, b] : [b, a];
    const family: Family = {
      id: families.length + 1,
      husb: husb.id,
      wife: wife.id,
      marrYear: year,
      children: [],
    };
    families.push(family);
    husb.fams.push(family.id);
    wife.fams.push(family.id);
    return family;
  };

  // Founding couples, then grow the tree generation by generation.
  let queue: Family[] = [];
  const founders = Math.max(1, Math.ceil(target / 400));
  for (let i = 0; i < founders && people.length + 2 <= target; i++) {
    const year = rand.int(1780, 1820);
    const husb = addPerson('M', rand.pick(SURNAMES), year);
    const wife = addPerson('F', rand.pick(SURNAMES), year + rand.int(-3, 5));
    queue.push(marry(husb, wife, year + rand.int(19, 28)));
  }

  while (people.length < target) {
    const nextQueue: Family[] = [];
    for (const family of queue) {
      if (people.length >= target) break;
      const husb = people[family.husb - 1] as Person;
      const childCount = rand.int(1, 5);
      for (let c = 0; c < childCount && people.length < target; c++) {
        const birthYear = family.marrYear + 1 + c * rand.int(1, 3);
        if (birthYear > currentYear - 1) break;
        const child = addPerson(rand.chance(0.5) ? 'M' : 'F', husb.surname, birthYear);
        const relRoll = rand.next();
        child.famc = {
          fam: family.id,
          rel: relRoll < 0.04 ? 'Adopted' : relRoll < 0.07 ? 'Step' : 'Natural',
        };
        family.children.push(child.id);

        const marriageYear = birthYear + rand.int(19, 32);
        if (marriageYear >= currentYear || people.length >= target || !rand.chance(0.85)) continue;
        const spouse = addPerson(
          child.sex === 'M' ? 'F' : 'M',
          rand.pick(SURNAMES),
          birthYear + rand.int(-4, 4),
        );
        nextQueue.push(marry(child, spouse, marriageYear));

        // Some people remarry.
        if (rand.chance(0.08) && people.length < target && marriageYear + 12 < currentYear) {
          const second = addPerson(
            child.sex === 'M' ? 'F' : 'M',
            rand.pick(SURNAMES),
            birthYear + rand.int(-2, 8),
          );
          nextQueue.push(marry(child, second, marriageYear + rand.int(8, 15)));
        }
      }
    }
    if (nextQueue.length === 0 && people.length + 2 <= target) {
      // Start a new founding line if every branch ended.
      const year = rand.int(1800, 1850);
      const husb = addPerson('M', rand.pick(SURNAMES), year);
      const wife = addPerson('F', rand.pick(SURNAMES), year + 2);
      nextQueue.push(marry(husb, wife, year + 22));
    }
    if (nextQueue.length === 0) {
      // One slot left and no open branch: add an unmarried founder.
      addPerson(rand.chance(0.5) ? 'M' : 'F', rand.pick(SURNAMES), rand.int(1800, 1850));
    }
    queue = nextQueue;
  }
  return { people, families };
}

function hex(rand: Random, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += rand.int(0, 15).toString(16);
  return out;
}

function uuid(rand: Random): string {
  return `${hex(rand, 8)}-${hex(rand, 4)}-${hex(rand, 4)}-${hex(rand, 4)}-${hex(rand, 12)}`;
}

/** Generates an Ancestry-style GEDCOM 5.5.1 file (UTF-8 BOM, LF line endings). */
export function generateGedcom({ people: target, seed = 1, currentYear = 2026 }: GenerateOptions) {
  const rand = createRandom(seed);
  const { people, families } = generateTree(rand, target, currentYear);
  const out: string[] = [];
  const line = (text: string) => out.push(text);

  line('0 HEAD');
  line('1 CHAR UTF-8');
  line('1 SOUR Ancestry.com Family Trees');
  line('2 DATA Synthetic Family Tree');
  line('2 VERS 2024.12');
  line('2 NAME Ancestry.com Member Trees');
  line('2 CORP Ancestry.com');
  line('2 _TREE Synthetic Family Tree');
  line(`3 RIN ${100000000 + seed}`);
  line('3 _ENV prd');
  line('1 GEDC');
  line('2 VERS 5.5.1');
  line('2 FORM LINEAGE-LINKED');
  line('1 SUBM @SUBM1@');

  const citation = (level: number, sourceIndex: number) => {
    const source = SOURCES[sourceIndex] as (typeof SOURCES)[number];
    line(`${level} SOUR @S${sourceIndex + 1}@`);
    line(`${level + 1} PAGE Year: ${rand.int(1850, 1950)}; Roll: T${rand.int(100, 999)}`);
    line(`${level + 1} _APID 1,${source.apidDb}::${rand.int(1000000, 99999999)}`);
    if (rand.chance(0.3)) {
      line(`${level + 1} DATA`);
      line(`${level + 2} WWW https://www.ancestry.com/search/collections/${source.apidDb}/`);
    }
  };
  const event = (tag: string, year: number) => {
    line(`1 ${tag}`);
    line(`2 DATE ${formatDate(rand, year)}`);
    line(`2 PLAC ${rand.pick(PLACES)}`);
    if (rand.chance(0.5)) citation(2, rand.int(0, SOURCES.length - 1));
  };

  let mediaCount = 0;
  const media: string[][] = [];
  for (const p of people) {
    line(`0 @I${p.id}@ INDI`);
    line(`1 NAME ${p.given} /${p.surname}/`);
    line(`2 GIVN ${p.given}`);
    line(`2 SURN ${p.surname}`);
    line(`1 SEX ${p.sex}`);
    event('BIRT', p.birthYear);
    if (rand.chance(0.25)) {
      const year = Math.min(currentYear - 1, p.birthYear + rand.int(5, 40));
      line('1 RESI');
      line(`2 DATE ${year}`);
      line(`2 PLAC ${rand.pick(PLACES)}`);
      line(
        `2 NOTE Marital Status: ${rand.pick(['Single', 'Married', 'Widowed'])}; Relation to Head of House: ${rand.pick(['Head', 'Wife', 'Son', 'Daughter'])}`,
      );
    }
    if (p.milt) {
      line('1 _MILT');
      line(`2 DATE ${p.birthYear + 18}`);
      line(`2 PLAC ${rand.pick(PLACES)}`);
      citation(2, 3);
    }
    if (p.deathYear !== undefined) {
      event('DEAT', p.deathYear);
      if (rand.chance(0.4)) {
        line('1 BURI');
        line(`2 PLAC ${rand.pick(PLACES)}`);
      }
    }
    if (p.famc) {
      line(`1 FAMC @F${p.famc.fam}@`);
      if (p.famc.rel !== 'Natural') {
        line(`2 _FREL ${p.famc.rel}`);
        line(`2 _MREL ${p.famc.rel}`);
      }
    }
    for (const fam of p.fams) {
      line(`1 FAMS @F${fam}@`);
      // Ancestry sometimes repeats the marriage on the individual as well.
      if (rand.chance(0.15)) {
        const family = families[fam - 1] as Family;
        line('1 MARR');
        line(`2 DATE ${family.marrYear}`);
      }
    }
    if (rand.chance(0.05)) {
      // Long notes are split with CONC (same line) and CONT (new line).
      line(`1 NOTE ${p.given} ${p.surname} was remembered by the family as a patient letter wri`);
      line(`2 CONC ter who kept careful accounts of every harvest, birth and journey.`);
      line(`2 CONT Recollections gathered from relatives in ${p.birthYear + 60}.`);
    }
    if (rand.chance(0.1)) line(`1 _MTTAG @T${rand.int(1, TAGS.length)}@`);
    if (rand.chance(0.12)) {
      mediaCount++;
      const oid = uuid(rand);
      line(`1 OBJE @O${mediaCount}@`);
      line('2 _PRIM Y');
      line(`1 _PHOTO @O${mediaCount}@`);
      media.push([
        `0 @O${mediaCount}@ OBJE`,
        `1 FILE https://mediasvc.ancestry.com/v2/image/namespaces/1093/media/${oid}.jpg?client=Trees`,
        '2 FORM jpg',
        `2 TITL Portrait of ${p.given} ${p.surname}`,
        `1 _OID ${oid}`,
      ]);
    }
  }

  for (const f of families) {
    line(`0 @F${f.id}@ FAM`);
    line(`1 HUSB @I${f.husb}@`);
    line(`1 WIFE @I${f.wife}@`);
    line('1 MARR');
    line(`2 DATE ${formatDate(rand, f.marrYear)}`);
    line(`2 PLAC ${rand.pick(PLACES)}`);
    if (rand.chance(0.3)) citation(2, 4);
    for (const child of f.children) line(`1 CHIL @I${child}@`);
  }

  SOURCES.forEach((source, i) => {
    line(`0 @S${i + 1}@ SOUR`);
    line(`1 TITL ${source.title}`);
    line('1 AUTH Ancestry.com');
    line('1 PUBL Lehi, UT, USA: Ancestry.com Operations, Inc.');
    line('1 REPO @R1@');
    line(`1 _APID 1,${source.apidDb}::0`);
  });
  line('0 @R1@ REPO');
  line('1 NAME Ancestry.com');
  for (const record of media) record.forEach(line);
  TAGS.forEach((tag, i) => {
    line(`0 @T${i + 1}@ _MTTAG`);
    line(`1 NAME ${tag.name}`);
    line(`1 _MTCAT ${tag.category}`);
  });
  line('0 @SUBM1@ SUBM');
  line('1 NAME Synthetic Submitter');
  line('0 TRLR');

  return `\uFEFF${out.join('\n')}\n`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      people: { type: 'string', multiple: true },
      seed: { type: 'string', default: '1' },
      out: { type: 'string' },
    },
  });
  const sizes = (values.people ?? ['1000', '10000']).map(Number);
  for (const people of sizes) {
    const file = values.out ?? join(import.meta.dirname, 'generated', `synthetic-${people}.ged`);
    await mkdir(dirname(file), { recursive: true });
    const text = generateGedcom({ people, seed: Number(values.seed) });
    await writeFile(file, text);
    console.log(`${file}: ${people} people, ${(text.length / 1024).toFixed(0)} KB`);
  }
}

if (import.meta.filename === process.argv[1]) {
  await main();
}
