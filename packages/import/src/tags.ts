import type { ChildRelationship, NameType, Privacy, RelationshipType } from '@open-ancestry/db';

const words = (list: string) => new Set(list.trim().split(/\s+/));

/*
 * GEDCOM and vendor vocabulary the mapper understands. Anything not listed
 * here stays in raw_record and is reported in unmapped_line.
 */

/** Individual events and attributes (GEDCOM 5.5.1 and 7, LDS ordinances). */
export const INDI_EVENTS = words(`
  ADOP BAPL BAPM BARM BASM BIRT BLES BURI CAST CENS CHR CHRA CONF CONL CREM DEAT DSCR EDUC
  EMIG ENDL EVEN FACT FCOM GRAD IDNO IMMI INIL NATI NATU NCHI NMR OCCU ORDN PROB PROP RELI
  RESI RETI SLGC SSN TITL WILL
`);

/** Family events and attributes. */
export const FAM_EVENTS = words(`
  ANUL CENS DIV DIVF ENGA EVEN FACT MARB MARC MARL MARR MARS NCHI RESI SLGS
`);

/**
 * Ancestry and Family Tree Maker custom facts. Other underscore tags count as
 * events when they carry a DATE, PLAC, TYPE or AGE.
 */
export const CUSTOM_EVENTS = words(`
  _ADPF _ADPM _ATTR _BRTM _CIRC _DCAUSE _DEG _DEST _DNA _ELEC _EMPLOY _EXCM _FUN _HEIG _INTE
  _MBON _MDCL _MILT _MILTID _MISN _NAMS _ORDI _SEPR _WEIG
`);

export const EVENT_HINT_TAGS = new Set(['DATE', 'PLAC', 'TYPE', 'AGE']);

/** Facts where a second occurrence is an alternate (conflicting evidence), not another event. */
export const SINGULAR_EVENTS = new Set(['BIRT', 'CHR', 'BAPM', 'DEAT', 'BURI', 'CREM']);

/** Facts that prove death for living inference. */
export const DEATH_EVENTS = new Set(['DEAT', 'BURI', 'CREM']);
export const OTHER_DEATH_FACTS = new Set(['PROB', '_FUN', '_DCAUSE']);
/** Birth substitutes when there is no BIRT. */
export const BIRTH_SUBSTITUTES = ['CHR', 'BAPM', 'CHRA'];

const RELATIONSHIPS: Record<string, ChildRelationship> = {
  natural: 'biological',
  birth: 'biological',
  biological: 'biological',
  adopted: 'adopted',
  step: 'step',
  foster: 'foster',
  related: 'related',
  guardian: 'guardian',
  private: 'private',
  unknown: 'unknown',
  sealing: 'unknown',
  other: 'unknown',
};

/** Ancestry `_FREL`/`_MREL` or GEDCOM `PEDI` value to a child relationship. */
export function childRelationship(value: string | undefined): ChildRelationship | undefined {
  return value === undefined ? undefined : RELATIONSHIPS[value.trim().toLowerCase()];
}

const NAME_TYPES: Record<string, NameType> = {
  birth: 'birth',
  married: 'married',
  marriedname: 'married',
  maiden: 'maiden',
  aka: 'aka',
  alias: 'aka',
  'also known as': 'aka',
  nickname: 'aka',
  immigrant: 'immigrant',
  professional: 'professional',
  religious: 'religious',
  other: 'other',
};

export function nameType(value: string | undefined): NameType {
  return NAME_TYPES[(value ?? '').trim().toLowerCase()] ?? 'other';
}

const PRIVACY_RANK: Privacy[] = ['public', 'private', 'confidential', 'locked'];

/** GEDCOM `RESN` (5.5.1 single value or 7.0 comma list) to the most restrictive privacy level. */
export function privacy(value: string | undefined): Privacy | undefined {
  let best: Privacy | undefined;
  for (const part of (value ?? '').split(',')) {
    const word = part.trim().toLowerCase();
    const level: Privacy | undefined =
      word === 'privacy' ? 'private' : PRIVACY_RANK.find((p) => p === word && p !== 'public');
    if (level && (!best || PRIVACY_RANK.indexOf(level) > PRIVACY_RANK.indexOf(best))) best = level;
  }
  return best;
}

/** Family Tree Maker `_STAT` to a relationship type. */
export function relationshipStatus(value: string | undefined): RelationshipType | undefined {
  const v = (value ?? '').toLowerCase();
  if (/civil|domestic/.test(v)) return 'civil_union';
  if (/partner|friend|single|never|unmarried/.test(v)) return 'partners';
  if (/married|spouse/.test(v)) return 'married';
  if (/unknown/.test(v)) return 'unknown';
  return undefined;
}
