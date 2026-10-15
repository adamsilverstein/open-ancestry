import { soundex } from '@open-ancestry/core';
import { norm, type SnapPerson, type Snapshot } from './snapshot';

/*
 * Matches people in an updated export to people already in the tree.
 * Ancestry renumbers xrefs between exports, so identity comes from evidence:
 * shared Ancestry record ids (_APID) on citations, names, birth and death
 * years, birth place, sex, and (in a second pass) whether their parents,
 * partners and children were matched to each other's relatives.
 */

export interface PersonMatch {
  existingId: string;
  incomingId: string;
  /** 0..1; HIGH_CONFIDENCE and up is safe to accept in bulk. */
  confidence: number;
  reasons: string[];
}

/** Below this a candidate is not a match: the incoming person is new. */
export const MATCH_THRESHOLD = 0.6;
/** At or above this a match is offered for bulk acceptance. */
export const HIGH_CONFIDENCE = 0.85;
/** A new person whose closest tree person scores this much may be a duplicate: offered unticked. */
export const POSSIBLE_MATCH = 0.4;
/** Each fact that differs (birth or death date, birth place) takes this off the shown confidence. */
const DIFFERENCE_PENALTY = 0.04;

/** The closest tree person for an incoming person that matched no one. */
export interface NearMiss {
  existingId: string;
  /** Evidence score, 0..1. */
  score: number;
  /** The tree person is matched to another incoming record. */
  taken: boolean;
}

/** Jaro-Winkler similarity of two strings, 0..1. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a ? 1 : 0;
  if (!a || !b) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aHit = new Array<boolean>(a.length).fill(false);
  const bHit = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bHit[j] || a[i] !== b[j]) continue;
      aHit[i] = bHit[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let k = 0;
  let transpositions = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aHit[i]) continue;
    while (!bHit[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const m = matches;
  const jaro = (m / a.length + m / b.length + (m - transpositions / 2) / m) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

function yearScore(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  const d = Math.abs(a - b);
  return d === 0 ? 1 : d <= 2 ? 0.7 : d <= 5 ? 0.3 : 0;
}

/**
 * Evidence score of a pair, without relatives. `corroboration` counts the
 * independent agreements beyond the name (birth year, death year, birth
 * place; a shared Ancestry record counts twice).
 */
const nameText = (n: { given: string | null; surname: string | null }) =>
  [n.given, n.surname].filter(Boolean).join(' ');

/** A person's normalized names and key facts, worked out once (matching compares many pairs). */
interface Prepared {
  names: { given: string; surname: string; primary: boolean; text: string }[];
  facts: Record<'BIRT.date' | 'DEAT.date' | 'BIRT.place', string>;
}
const prepared = new WeakMap<SnapPerson, Prepared>();
function prepare(p: SnapPerson): Prepared {
  let ready = prepared.get(p);
  if (ready) return ready;
  const fact = (type: string, part: 'date' | 'place') => {
    const events = p.events.filter((e) => e.row.type === type);
    const e = events.find((x) => x.isPreferred) ?? events[0];
    return norm(part === 'date' ? e?.row.date_text : e?.place);
  };
  ready = {
    names: p.names.map((n) => ({
      given: norm(n.given),
      surname: norm(n.surname),
      primary: !!n.is_primary || p.names.length === 1,
      text: nameText(n),
    })),
    facts: {
      'BIRT.date': fact('BIRT', 'date'),
      'DEAT.date': fact('DEAT', 'date'),
      'BIRT.place': fact('BIRT', 'place'),
    },
  };
  prepared.set(p, ready);
  return ready;
}

/**
 * Which of the tree person's names the incoming name is closest to, and how
 * to say so: the primary name and the person's other names are told apart.
 */
function nameMatch(e: SnapPerson, i: SnapPerson): { score: number; reason: string | null } {
  const names = prepare(e).names;
  const incoming = prepare(i).names.find((n) => n.primary) ?? prepare(i).names[0];
  let best = { given: jaroWinkler(e.given, i.given), primary: true, text: '' };
  for (const n of names) {
    const g = jaroWinkler(n.given, i.given);
    if (g > best.given || (g === best.given && n.primary && (!best.primary || !best.text))) {
      best = { given: g, primary: n.primary, text: n.text };
    }
  }
  // A married name in one export and a birth name in the other is common: take the best surname.
  let surname = jaroWinkler(e.surname, i.surname);
  for (const n of names) surname = Math.max(surname, jaroWinkler(n.surname, i.surname));
  const exported = incoming?.text ?? '';
  let reason: string | null = null;
  if (best.given === 1 && surname === 1) {
    reason = best.primary ? 'same name' : `matches another name (${best.text})`;
  } else if (best.given > 0.85 && surname > 0.85) {
    reason = best.primary
      ? `similar name (${best.text} / ${exported})`
      : `similar to another name (${best.text} / ${exported})`;
  }
  return { score: (best.given + surname) / 2, reason };
}

function baseScore(
  e: SnapPerson,
  i: SnapPerson,
): { score: number; reasons: string[]; corroboration: number; differences: number } {
  const reasons: string[] = [];
  const shared = [...i.apids].filter((apid) => e.apids.has(apid));
  const name = nameMatch(e, i);
  const parts: [number, number | null][] = [
    [0.5, name.score],
    [0.2, yearScore(e.birthYear, i.birthYear)],
    [0.15, yearScore(e.deathYear, i.deathYear)],
    [0.15, e.birthPlace && i.birthPlace ? (e.birthPlace === i.birthPlace ? 1 : 0.2) : null],
  ];
  let total = 0;
  let weight = 0;
  for (const [w, s] of parts) {
    if (s === null) continue;
    total += w * s;
    weight += w;
  }
  let score = total / weight;
  if (name.reason) reasons.push(name.reason);
  if (e.birthYear !== null && e.birthYear === i.birthYear) reasons.push('same birth year');
  if (e.deathYear !== null && e.deathYear === i.deathYear) reasons.push('same death year');
  if (e.birthPlace && e.birthPlace === i.birthPlace) reasons.push('same birth place');
  const sexKnown = e.row.sex !== 'U' && i.row.sex !== 'U';
  if (sexKnown && e.row.sex !== i.row.sex) {
    score *= 0.3;
    reasons.push('different sex');
  }
  const birthGap =
    e.birthYear !== null && i.birthYear !== null ? Math.abs(e.birthYear - i.birthYear) : 0;
  // A corrected birth year is common; matched relatives (second pass) can still confirm the pair.
  if (birthGap > 10) score *= 0.5;
  if (shared.length && !(sexKnown && e.row.sex !== i.row.sex)) {
    score = Math.max(score, Math.min(0.99, 0.9 + 0.03 * shared.length));
    reasons.push(`${shared.length} shared Ancestry record${shared.length > 1 ? 's' : ''}`);
  }
  // Facts both records have that say different things: the match is not certain.
  let differences = 0;
  for (const [fact, label] of [
    ['BIRT.date', 'different birth date'],
    ['DEAT.date', 'different death date'],
    ['BIRT.place', 'different birth place'],
  ] as const) {
    const a = prepare(e).facts[fact];
    const b = prepare(i).facts[fact];
    if (a && b && a !== b) {
      differences++;
      reasons.push(label);
    }
  }
  const corroboration =
    ((yearScore(e.birthYear, i.birthYear) ?? 0) >= 0.7 ? 1 : 0) +
    ((yearScore(e.deathYear, i.deathYear) ?? 0) >= 0.7 ? 1 : 0) +
    (e.birthPlace && e.birthPlace === i.birthPlace ? 1 : 0) +
    (shared.length ? 2 : 0);
  return { score, reasons, corroboration, differences };
}

/**
 * Blocking: only people who share a key are compared. Comparing everyone who
 * shares a name sound made matching quadratic in how common a name is (#202).
 * Now a person is compared with same-name tree people by birth year, nearest
 * first: everyone within NEAR_YEARS, then outward up to YEAR_WINDOW years
 * until MAX_NEAR candidates are found. Same-name people who share a death
 * year are always compared, however far apart their birth years: an export
 * that turns "BET 1920 AND 1929" into "1 JAN 1929" moves the birth year
 * further than the nearest few reach in a crowded name; for the same reason a
 * tree person born in a range is compared with any birth year inside it. A
 * name with at most
 * SMALL_BLOCK tree people is compared in full, and a person without a birth
 * year meets the same-name people without one (up to MAX_UNDATED). Surname sound with the exact
 * birth year finds a changed given name; when
 * that key is crowded it is used only for people with no same-name tree
 * person born nearby.
 */
const NEAR_YEARS = 2;
const YEAR_WINDOW = 15;
const MAX_NEAR = 8;
/**
 * A name with at most this many tree people (with or without a birth year) is
 * compared in full: rare names reach any birth year, so a typo like 1857 for
 * 1875 still finds the person (or at least names them as the closest).
 */
const SMALL_BLOCK = 16;
/** Most same-name tree people without a birth year that a person without one is compared with. */
const MAX_UNDATED = 64;

/** Given and surname sounds, for every name the person has, so married names meet birth names. */
function nameKeys(p: SnapPerson): { names: string[]; surnames: string[] } {
  const given = p.given ? soundex(p.given) : '';
  const surnames = [
    ...new Set(
      [p.surname, ...p.names.map((n) => norm(n.surname))].filter(Boolean).map((s) => soundex(s!)),
    ),
  ];
  const names = surnames.map((s) => `${given}:${s}`);
  if (!names.length && given) names.push(`${given}:`);
  return { names, surnames };
}

/** Tree people with one name key: those with a birth year sorted by it, and the rest. */
interface NameBlock {
  years: number[];
  ids: string[];
  undated: string[];
  /** People born within a range wider than NEAR_YEARS (`BET 1940 AND 1949`). */
  ranges: { start: number; end: number; id: string }[];
}

/** The tree's people indexed by blocking key. */
class Blocks {
  private readonly byName = new Map<string, NameBlock>();
  private readonly bySurnameYear = new Map<string, string[]>();
  /** `name@deathYear`: same-name people who died the same year. */
  private readonly byNameDeath = new Map<string, string[]>();

  constructor(people: Iterable<SnapPerson>) {
    const dated = new Map<string, { year: number; id: string }[]>();
    for (const p of people) {
      const { names, surnames } = nameKeys(p);
      for (const name of names) {
        if (p.deathYear !== null) {
          const key = `${name}@${p.deathYear}`;
          const list = this.byNameDeath.get(key);
          if (list) list.push(p.row.id);
          else this.byNameDeath.set(key, [p.row.id]);
        }
        let block = this.byName.get(name);
        if (!block) {
          block = { years: [], ids: [], undated: [], ranges: [] };
          this.byName.set(name, block);
          dated.set(name, []);
        }
        if (p.birthYear === null) block.undated.push(p.row.id);
        else dated.get(name)!.push({ year: p.birthYear, id: p.row.id });
        if (
          p.birthYear !== null &&
          p.birthYearEnd !== null &&
          p.birthYearEnd - p.birthYear > NEAR_YEARS
        ) {
          block.ranges.push({ start: p.birthYear, end: p.birthYearEnd, id: p.row.id });
        }
      }
      if (p.birthYear !== null) {
        for (const s of surnames) {
          const key = `${s}:${p.birthYear}`;
          const list = this.bySurnameYear.get(key);
          if (list) list.push(p.row.id);
          else this.bySurnameYear.set(key, [p.row.id]);
        }
      }
    }
    for (const [name, list] of dated) {
      list.sort((a, b) => a.year - b.year);
      const block = this.byName.get(name)!;
      block.years = list.map((x) => x.year);
      block.ids = list.map((x) => x.id);
    }
  }

  /** Adds the tree people worth comparing with an incoming person to `into`. */
  candidates(p: SnapPerson, into: Set<string>): void {
    const { names, surnames } = nameKeys(p);
    /** Whether a same-name tree person was born within NEAR_YEARS. */
    let nearby = false;
    for (const name of names) {
      const block = this.byName.get(name);
      if (!block) continue;
      if (block.ids.length + block.undated.length <= SMALL_BLOCK) {
        for (const id of block.ids) into.add(id);
        for (const id of block.undated) into.add(id);
        if (p.birthYear !== null) {
          nearby ||= block.years.some((y) => Math.abs(y - p.birthYear!) <= NEAR_YEARS);
        }
        continue;
      }
      if (p.deathYear !== null) {
        for (const id of this.byNameDeath.get(`${name}@${p.deathYear}`) ?? []) into.add(id);
      }
      if (p.birthYear === null) {
        // Without dates nothing ranks them, so a crowd of undated namesakes is left out.
        if (block.undated.length <= MAX_UNDATED) for (const id of block.undated) into.add(id);
        continue;
      }
      nearby = nearestByYear(block, p.birthYear, into) || nearby;
      // A range refined to one of its years ("BET 1940 AND 1949" to 1949) is still near.
      for (const r of block.ranges) {
        if (r.start - NEAR_YEARS <= p.birthYear && p.birthYear <= r.end + NEAR_YEARS)
          into.add(r.id);
      }
    }
    if (p.birthYear === null) return;
    for (const s of surnames) {
      const ids = this.bySurnameYear.get(`${s}:${p.birthYear}`) ?? [];
      // A crowded surname-and-year key is only a fallback, for someone with no
      // same-name tree person nearby (their given name may have changed).
      if (ids.length <= MAX_NEAR || !nearby) for (const id of ids) into.add(id);
    }
  }
}

/**
 * Walks out from `year` in both directions, nearest birth year first (see
 * Blocks). Returns whether anyone was born within NEAR_YEARS.
 */
function nearestByYear(block: NameBlock, year: number, into: Set<string>): boolean {
  const { years, ids } = block;
  // First index with a birth year >= `year`.
  let lo = 0;
  let hi = years.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (years[mid]! < year) lo = mid + 1;
    else hi = mid;
  }
  let left = lo - 1;
  let right = lo;
  let taken = 0;
  let near = false;
  for (;;) {
    const dl = left >= 0 ? year - years[left]! : Infinity;
    const dr = right < years.length ? years[right]! - year : Infinity;
    const d = Math.min(dl, dr);
    if (d > YEAR_WINDOW || (d > NEAR_YEARS && taken >= MAX_NEAR)) return near;
    if (d <= NEAR_YEARS) near = true;
    if (dl <= dr) into.add(ids[left--]!);
    else into.add(ids[right++]!);
    taken++;
  }
}

/** Counters for tests and profiling. */
export interface MatchStats {
  /** Pairs scored. */
  comparisons: number;
}

interface Candidate {
  e: string;
  i: string;
  /** Ranking score: uncapped, so confirming relatives can separate pairs that tie on evidence. */
  score: number;
  reasons: string[];
  corroboration: number;
  /** Facts both have that differ (see `DIFFERENCE_PENALTY`). */
  differences: number;
  agree: number;
  /** The part of the score that is only the kept-xref hint. */
  hint: number;
}

/** Ancestry sometimes keeps xrefs: a small nudge, never enough to settle a tie on its own. */
const XREF_HINT = 0.15;

/** Without at least this much agreement beyond the name, a match is never "high confidence". */
const MIN_CORROBORATION = 2;
/** Confidence given to matches that are possible but must be checked by the user. */
const CHECK_CONFIDENCE = 0.8;
/** Two candidates closer than this are a tie the user has to settle. */
const TIE_MARGIN = 0.05;

/**
 * One-to-one, best scores first, except that a person merged in the tree
 * (several of the last import's records point at them) takes as many
 * incoming people as records were merged into them.
 */
function assign(
  candidates: Candidate[],
  capacity: (existingId: string) => number,
): Map<string, Candidate> {
  const byIncoming = new Map<string, Candidate>();
  const taken = new Map<string, number>();
  for (const c of [...candidates].sort(
    (x, y) => y.score - x.score || (x.i < y.i ? -1 : x.i > y.i ? 1 : 0),
  )) {
    const used = taken.get(c.e) ?? 0;
    if (c.score < MATCH_THRESHOLD || byIncoming.has(c.i) || used >= capacity(c.e)) continue;
    byIncoming.set(c.i, c);
    taken.set(c.e, used + 1);
  }
  return byIncoming;
}

/**
 * Matches incoming people to the tree's. `nearMisses`, when given, receives
 * the closest tree person (and score) of each incoming person that matched
 * no one, so the review can say why they are new.
 */
export function matchPeople(
  existing: Snapshot,
  incoming: Snapshot,
  nearMisses?: Map<string, NearMiss>,
  stats?: MatchStats,
): Map<string, PersonMatch> {
  // Candidate pairs: same name sounds and birth era, same surname sound and birth year, or a shared record.
  const blocks = new Blocks(existing.people.values());
  const byApid = new Map<string, string[]>();
  for (const e of existing.people.values()) {
    for (const apid of e.apids) {
      const list = byApid.get(apid);
      if (list) list.push(e.row.id);
      else byApid.set(apid, [e.row.id]);
    }
  }
  const capacity = new Map<string, number>();
  for (const owner of existing.importXrefs.values())
    capacity.set(owner, (capacity.get(owner) ?? 0) + 1);
  const capacityOf = (id: string) => Math.max(1, capacity.get(id) ?? 1);

  const candidates: Candidate[] = [];
  for (const i of incoming.people.values()) {
    const ids = new Set<string>();
    // Ancestry sometimes keeps xrefs between exports: the last import's mapping is a hint.
    const sameXref = i.row.external_id ? existing.importXrefs.get(i.row.external_id) : undefined;
    if (sameXref) ids.add(sameXref);
    blocks.candidates(i, ids);
    for (const apid of i.apids) for (const id of byApid.get(apid) ?? []) ids.add(id);
    for (const id of ids) {
      if (stats) stats.comparisons++;
      const base = baseScore(existing.people.get(id)!, i);
      let { score } = base;
      const reasons = [...base.reasons];
      const hint = id === sameXref ? XREF_HINT : 0;
      if (hint) {
        score += hint;
        reasons.push('same xref as the last import');
      }
      if (score >= MATCH_THRESHOLD - 0.4) {
        candidates.push({
          e: id,
          i: i.row.id,
          score,
          reasons,
          corroboration: base.corroboration,
          differences: base.differences,
          agree: 0,
          hint,
        });
      }
    }
  }

  // Close runners-up: another tree person for this record, or another record for this person.
  const byKey = { e: new Map<string, Candidate[]>(), i: new Map<string, Candidate[]>() };
  for (const c of candidates) {
    for (const key of ['e', 'i'] as const) {
      const list = byKey[key].get(c[key]);
      if (list) list.push(c);
      else byKey[key].set(c[key], [c]);
    }
  }
  const best = (key: 'e' | 'i', id: string, except: Candidate) => {
    let top = -Infinity;
    for (const x of byKey[key].get(id) ?? []) {
      if (x !== except && (key === 'i' ? x.e !== except.e : x.i !== except.i)) {
        top = Math.max(top, x.score - x.hint);
      }
    }
    return top;
  };
  /** Whether another candidate for either side of the pair is as likely, on evidence alone. */
  const tied = (c: Candidate, merged: boolean) =>
    Math.max(best('i', c.i, c), merged ? -Infinity : best('e', c.e, c)) >=
    c.score - c.hint - TIE_MARGIN;

  // Second pass: relatives that were matched to each other confirm (or tell apart) a pair.
  // A relative whose own match was a coin toss proves nothing, or identical
  // families would confirm whichever pairing happened to come first.
  const first = assign(candidates, capacityOf);
  const toExisting = new Map(
    [...first.values()].filter((c) => !tied(c, capacityOf(c.e) > 1)).map((c) => [c.i, c.e]),
  );
  for (const c of candidates) {
    const e = existing.people.get(c.e)!;
    const i = incoming.people.get(c.i)!;
    let agree = 0;
    let contradict = 0;
    for (const [incomingRelatives, existingRelatives] of [
      [i.parents, new Set(e.parents)],
      [i.spouses, new Set(e.spouses)],
      [i.children, new Set(e.children)],
    ] as const) {
      for (const r of incomingRelatives) {
        const mapped = toExisting.get(r);
        if (!mapped) continue;
        // A relative matched to someone who is not this person's relative argues against the pair.
        if (existingRelatives.has(mapped)) agree++;
        else if (existingRelatives.size) contradict++;
      }
    }
    c.agree = agree;
    c.score += 0.1 * Math.min(agree, 3) - 0.15 * Math.min(contradict, 3);
    if (agree) c.reasons = [...c.reasons, `${agree} matching relative${agree > 1 ? 's' : ''}`];
    if (contradict) {
      c.reasons = [...c.reasons, `${contradict} relative${contradict > 1 ? 's' : ''} disagree`];
    }
  }
  const final = assign(candidates, capacityOf);
  const perExisting = new Map<string, number>();
  for (const c of final.values()) perExisting.set(c.e, (perExisting.get(c.e) ?? 0) + 1);
  const result = new Map<string, PersonMatch>();
  for (const c of final.values()) {
    const merged = (perExisting.get(c.e) ?? 0) > 1;
    if (merged) c.reasons = [...c.reasons, 'merged in this tree'];
    // Never 100% while a fact differs, however strong the rest of the evidence.
    let confidence = Math.max(0, Math.min(1 - DIFFERENCE_PENALTY * c.differences, c.score));
    // Name alone (or one detail) is not enough to merge records in bulk.
    if (c.corroboration + (c.agree ? 1 : 0) < MIN_CORROBORATION) {
      confidence = Math.min(confidence, CHECK_CONFIDENCE);
      c.reasons = [...c.reasons, 'little evidence beyond the name'];
    }
    // Evidence alone decides a tie: two people the export can't tell apart are the user's call.
    if (tied(c, merged)) {
      confidence = Math.min(confidence, CHECK_CONFIDENCE);
      c.reasons = [...c.reasons, 'another person is as likely'];
    }
    result.set(c.i, {
      existingId: c.e,
      incomingId: c.i,
      confidence: Math.round(confidence * 100) / 100,
      reasons: c.reasons,
    });
  }
  if (nearMisses) {
    const closest = new Map<string, Candidate>();
    for (const c of candidates) {
      if (result.has(c.i)) continue;
      const best = closest.get(c.i);
      if (!best || c.score - c.hint > best.score - best.hint) closest.set(c.i, c);
    }
    const taken = new Set([...result.values()].map((m) => m.existingId));
    for (const [i, c] of closest) {
      nearMisses.set(i, {
        existingId: c.e,
        score: Math.round(Math.max(0, Math.min(1, c.score - c.hint)) * 100) / 100,
        taken: taken.has(c.e),
      });
    }
  }
  return result;
}
