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
function baseScore(
  e: SnapPerson,
  i: SnapPerson,
): { score: number; reasons: string[]; corroboration: number } {
  const reasons: string[] = [];
  const shared = [...i.apids].filter((apid) => e.apids.has(apid));
  const given = jaroWinkler(e.given, i.given);
  // A married name in one export and a birth name in the other is common: take the best surname.
  const surname = Math.max(
    jaroWinkler(e.surname, i.surname),
    ...e.names.map((n) => jaroWinkler(norm(n.surname), i.surname)),
  );
  const parts: [number, number | null][] = [
    [0.5, (given + surname) / 2],
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
  if (given > 0.92 && surname > 0.92) reasons.push('same name');
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
  const corroboration =
    ((yearScore(e.birthYear, i.birthYear) ?? 0) >= 0.7 ? 1 : 0) +
    ((yearScore(e.deathYear, i.deathYear) ?? 0) >= 0.7 ? 1 : 0) +
    (e.birthPlace && e.birthPlace === i.birthPlace ? 1 : 0) +
    (shared.length ? 2 : 0);
  return { score, reasons, corroboration };
}

/**
 * Blocking keys: only people sharing one are compared. Given and surname
 * sounds (for every name the person has, so married names meet birth names),
 * and surname sound with birth year (for a changed given name).
 */
const blockKeys = (p: SnapPerson): string[] => {
  const keys = new Set<string>();
  const given = p.given ? soundex(p.given) : '';
  const surnames = new Set([p.surname, ...p.names.map((n) => norm(n.surname))].filter(Boolean));
  for (const surname of surnames) {
    const s = soundex(surname);
    keys.add(`n:${given}:${s}`);
    if (p.birthYear !== null) keys.add(`y:${s}:${p.birthYear}`);
  }
  if (!surnames.size && given) keys.add(`n:${given}:`);
  return [...keys];
};

interface Candidate {
  e: string;
  i: string;
  /** Ranking score: uncapped, so confirming relatives can separate pairs that tie on evidence. */
  score: number;
  reasons: string[];
  corroboration: number;
  agree: number;
}

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

export function matchPeople(existing: Snapshot, incoming: Snapshot): Map<string, PersonMatch> {
  // Candidate pairs: same surname sound, same given-name sound and birth year, or a shared record.
  const blocks = new Map<string, string[]>();
  const byApid = new Map<string, string[]>();
  for (const e of existing.people.values()) {
    for (const key of blockKeys(e)) {
      const list = blocks.get(key);
      if (list) list.push(e.row.id);
      else blocks.set(key, [e.row.id]);
    }
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
    for (const key of blockKeys(i)) for (const id of blocks.get(key) ?? []) ids.add(id);
    for (const apid of i.apids) for (const id of byApid.get(apid) ?? []) ids.add(id);
    for (const id of ids) {
      const base = baseScore(existing.people.get(id)!, i);
      let { score } = base;
      const reasons = [...base.reasons];
      if (id === sameXref) {
        score += 0.15;
        reasons.push('same xref as the last import');
      }
      if (score >= MATCH_THRESHOLD - 0.4) {
        candidates.push({
          e: id,
          i: i.row.id,
          score,
          reasons,
          corroboration: base.corroboration,
          agree: 0,
        });
      }
    }
  }

  // Second pass: relatives that were matched to each other confirm (or tell apart) a pair.
  const first = assign(candidates, capacityOf);
  const toExisting = new Map([...first.values()].map((c) => [c.i, c.e]));
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
        top = Math.max(top, x.score);
      }
    }
    return top;
  };
  const perExisting = new Map<string, number>();
  for (const c of final.values()) perExisting.set(c.e, (perExisting.get(c.e) ?? 0) + 1);
  const result = new Map<string, PersonMatch>();
  for (const c of final.values()) {
    const merged = (perExisting.get(c.e) ?? 0) > 1;
    if (merged) c.reasons = [...c.reasons, 'merged in this tree'];
    let confidence = Math.max(0, Math.min(1, c.score));
    // Name alone (or one detail) is not enough to merge records in bulk.
    if (c.corroboration + (c.agree ? 1 : 0) < MIN_CORROBORATION) {
      confidence = Math.min(confidence, CHECK_CONFIDENCE);
      c.reasons = [...c.reasons, 'little evidence beyond the name'];
    }
    const rival = Math.max(best('i', c.i, c), merged ? -Infinity : best('e', c.e, c));
    if (rival >= c.score - TIE_MARGIN) {
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
  return result;
}
