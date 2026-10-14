import { normalizeForSearch } from '@open-ancestry/core';
import {
  getPersonSummaries,
  meta,
  type PersonSummary,
  type TreeStore,
  type Tx,
} from '@open-ancestry/db';
import { eventTypeLabel } from './edits';

/*
 * Tree checker (#57): possible duplicates, impossible dates and people
 * without sources, computed from the tree on request. Dismissals are meta
 * rows (`check.dismissed:<key>`), so dismissing is an undoable edit.
 */

export type CheckKind =
  | 'possible-duplicate'
  | 'death-before-birth'
  | 'child-born-before-parent'
  | 'parent-too-young'
  | 'parent-too-old'
  | 'event-after-death'
  | 'no-sources';

export type CheckCategory = 'duplicates' | 'dates' | 'sources';

const CATEGORY: Record<CheckKind, CheckCategory> = {
  'possible-duplicate': 'duplicates',
  'death-before-birth': 'dates',
  'child-born-before-parent': 'dates',
  'parent-too-young': 'dates',
  'parent-too-old': 'dates',
  'event-after-death': 'dates',
  'no-sources': 'sources',
};

export interface CheckIssue {
  /** Stable while the same people (and event) have the same problem: `kind:id+id[:eventId]`. */
  key: string;
  kind: CheckKind;
  category: CheckCategory;
  message: string;
  people: PersonSummary[];
}

export interface CheckReport {
  counts: Record<CheckCategory | 'dismissed', number>;
  /** Open issues, at most ITEM_LIMIT per category. */
  items: CheckIssue[];
  dismissed: CheckIssue[];
}

/** Rows listed per category; counts are always complete. */
export const ITEM_LIMIT = 500;
export const MIN_PARENT_AGE = 12;
export const MAX_PARENT_AGE = 70;
/** Years either way two dates may differ and still describe the same person. */
const DUPLICATE_YEARS = 2;
/** Slack for `abt.`, `est.` and `cal.` dates. */
const APPROXIMATE_YEARS = 2;
const DISMISSED = 'check.dismissed:';

/** Facts that normally come after a death and are not a problem then. */
const AFTER_DEATH_OK = new Set(['DEAT', 'BURI', 'CREM', 'PROB', 'WILL', '_FUN', '_DCAUSE', 'OBIT']);
const BIRTH_TYPES = ['BIRT', 'CHR', 'BAPM'];

/** Earliest and latest possible year of a stored date, or null when unknown. */
type Years = [number, number];

function yearRange(
  qualifier: string | null,
  sort: number | null,
  sortEnd: number | null,
): Years | null {
  if (sort === null || qualifier === 'text') return null;
  const first = Math.floor(sort / 10000);
  const last = Math.floor((sortEnd ?? sort) / 10000);
  switch (qualifier) {
    case 'about':
    case 'estimated':
    case 'calculated':
      return [first - APPROXIMATE_YEARS, last + APPROXIMATE_YEARS];
    case 'before':
    case 'to':
      return [-Infinity, last];
    case 'after':
    case 'from':
      return [first, Infinity];
    default:
      return [first, last];
  }
}

const showYear = (y: Years) => String(Number.isFinite(y[0]) ? y[0] : y[1]);

interface PersonRow {
  id: string;
  sex: string;
  given: string | null;
  surname: string | null;
  surname_key: string | null;
}

interface EventRow {
  person_id: string;
  event_id: string;
  type: string;
  custom_type: string | null;
  date_qualifier: string | null;
  date_sort: number | null;
  date_sort_end: number | null;
  is_preferred: number;
}

interface Person {
  id: string;
  sex: string;
  name: string;
  /** Normalized first given name and first surname sound key, for duplicate grouping. */
  given: string;
  sound: string;
  birth: Years | null;
  death: Years | null;
  events: { id: string; type: string; custom: string | null; years: Years }[];
}

function loadPeople(store: TreeStore): Map<string, Person> {
  const people = new Map<string, Person>();
  const rows = store
    .stmt(
      `SELECT p.id, p.sex, n.given, n.surname, n.surname_key
       FROM person p LEFT JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1`,
    )
    .all() as PersonRow[];
  for (const r of rows) {
    people.set(r.id, {
      id: r.id,
      sex: r.sex,
      name: [r.given, r.surname].filter(Boolean).join(' ') || 'Unnamed person',
      given: normalizeForSearch(r.given ?? '').split(' ')[0] ?? '',
      sound: (r.surname_key ?? '').split(' ')[0] ?? '',
      birth: null,
      death: null,
      events: [],
    });
  }
  const events = store
    .stmt(
      `SELECT r.person_id, e.id AS event_id, e.type, e.custom_type, e.date_qualifier,
              e.date_sort, e.date_sort_end, r.is_preferred
       FROM event_role r JOIN event e ON e.id = r.event_id
       WHERE r.role = 'principal' AND r.person_id IS NOT NULL
       ORDER BY r.is_preferred DESC, r.sort_order`,
    )
    .all() as EventRow[];
  const birthRank = new Map<string, number>();
  for (const e of events) {
    const person = people.get(e.person_id);
    const years = yearRange(e.date_qualifier, e.date_sort, e.date_sort_end);
    if (!person || !years) continue;
    person.events.push({ id: e.event_id, type: e.type, custom: e.custom_type, years });
    // Preferred facts come first; BIRT beats a christening or baptism.
    const rank = BIRTH_TYPES.indexOf(e.type);
    if (rank >= 0 && rank < (birthRank.get(person.id) ?? Infinity)) {
      birthRank.set(person.id, rank);
      person.birth = years;
    }
    if (e.type === 'DEAT' && !person.death) person.death = years;
  }
  return people;
}

/** Biological (or unknown) parent and child pairs. */
function parentLinks(store: TreeStore): [parent: string, child: string][] {
  const rows = store
    .stmt(
      `SELECT f.partner1_id AS parent, fc.child_id AS child FROM family_child fc
         JOIN family f ON f.id = fc.family_id
       WHERE f.partner1_id IS NOT NULL AND fc.partner1_rel IN ('biological', 'unknown')
       UNION ALL
       SELECT f.partner2_id, fc.child_id FROM family_child fc
         JOIN family f ON f.id = fc.family_id
       WHERE f.partner2_id IS NOT NULL AND fc.partner2_rel IN ('biological', 'unknown')`,
    )
    .all() as { parent: string; child: string }[];
  return rows.map((r) => [r.parent, r.child]);
}

function unsourced(store: TreeStore): string[] {
  return (
    store
      .stmt(
        `SELECT p.id FROM person p
         WHERE NOT EXISTS (SELECT 1 FROM citation_link cl
                           WHERE cl.owner_type = 'person' AND cl.owner_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM event_role r
                           JOIN citation_link cl ON cl.owner_type = 'event' AND cl.owner_id = r.event_id
                           WHERE r.person_id = p.id AND r.role = 'principal')
         ORDER BY p.id`,
      )
      .all() as { id: string }[]
  ).map((r) => r.id);
}

const close = (a: Years | null, b: Years | null) =>
  a !== null && b !== null && a[0] - DUPLICATE_YEARS <= b[1] && b[0] - DUPLICATE_YEARS <= a[1];
const conflict = (a: Years | null, b: Years | null) => a !== null && b !== null && !close(a, b);
const sexesAgree = (a: string, b: string) =>
  a === b || ['U', 'X'].includes(a) || ['U', 'X'].includes(b);

interface Draft {
  kind: CheckKind;
  ids: string[];
  eventId?: string;
  message: string;
}

function findIssues(store: TreeStore): Draft[] {
  const people = loadPeople(store);
  const drafts: Draft[] = [];
  const name = (id: string) => people.get(id)?.name ?? 'Unknown person';

  // Duplicates: same first given name and surname sound, compatible sex, and
  // at least one pair of dates that agree with none that disagree.
  const groups = new Map<string, Person[]>();
  for (const p of people.values()) {
    if (!p.given || !p.sound) continue;
    const key = `${p.sound}|${p.given}`;
    const group = groups.get(key);
    if (group) group.push(p);
    else groups.set(key, [p]);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (!sexesAgree(a.sex, b.sex)) continue;
        if (conflict(a.birth, b.birth) || conflict(a.death, b.death)) continue;
        if (!close(a.birth, b.birth) && !close(a.death, b.death)) continue;
        const ids = [a.id, b.id].sort();
        drafts.push({
          kind: 'possible-duplicate',
          ids,
          message: `Possible duplicate: ${name(ids[0]!)} and ${name(ids[1]!)}`,
        });
      }
    }
  }

  for (const p of people.values()) {
    if (p.birth && p.death && p.death[1] < p.birth[0]) {
      drafts.push({
        kind: 'death-before-birth',
        ids: [p.id],
        message: `Died in ${showYear(p.death)}, before birth in ${showYear(p.birth)}`,
      });
    }
    if (p.death) {
      for (const e of p.events) {
        // A birth after death is reported once, as death-before-birth.
        if (AFTER_DEATH_OK.has(e.type) || BIRTH_TYPES.includes(e.type)) continue;
        if (e.years[0] <= p.death[1]) continue;
        drafts.push({
          kind: 'event-after-death',
          ids: [p.id],
          eventId: e.id,
          message: `${eventTypeLabel(e.type, e.custom)} in ${showYear(e.years)}, after death in ${showYear(p.death)}`,
        });
      }
    }
  }

  for (const [parentId, childId] of parentLinks(store)) {
    const parent = people.get(parentId)?.birth;
    const child = people.get(childId)?.birth;
    if (!parent || !child) continue;
    if (child[1] < parent[0]) {
      drafts.push({
        kind: 'child-born-before-parent',
        ids: [childId, parentId],
        message: `${name(childId)} was born in ${showYear(child)}, before parent ${name(parentId)} (born ${showYear(parent)})`,
      });
      continue;
    }
    const youngest = child[0] - parent[1];
    const oldest = child[1] - parent[0];
    if (oldest < MIN_PARENT_AGE) {
      drafts.push({
        kind: 'parent-too-young',
        ids: [parentId, childId],
        message: `${name(parentId)} was ${oldest} at the birth of ${name(childId)}`,
      });
    } else if (youngest > MAX_PARENT_AGE) {
      drafts.push({
        kind: 'parent-too-old',
        ids: [parentId, childId],
        message: `${name(parentId)} was ${youngest} at the birth of ${name(childId)}`,
      });
    }
  }

  for (const id of unsourced(store)) {
    drafts.push({ kind: 'no-sources', ids: [id], message: `No sources for ${name(id)}` });
  }
  return drafts;
}

const keyOf = (d: Draft) => `${d.kind}:${d.ids.join('+')}${d.eventId ? `:${d.eventId}` : ''}`;

export function dismissedKeys(store: TreeStore): Set<string> {
  const rows = store
    .stmt('SELECT key FROM meta WHERE key >= ? AND key < ?')
    .all(DISMISSED, `${DISMISSED}￿`) as { key: string }[];
  return new Set(rows.map((r) => r.key.slice(DISMISSED.length)));
}

/** Every open and dismissed issue in the tree, with people summaries. */
export function checkTree(store: TreeStore): CheckReport {
  const drafts = findIssues(store);
  const dismissed = dismissedKeys(store);
  const counts = { duplicates: 0, dates: 0, sources: 0, dismissed: 0 };
  const open: Draft[] = [];
  const closed: Draft[] = [];
  const shown = { duplicates: 0, dates: 0, sources: 0 };
  for (const d of drafts) {
    if (dismissed.has(keyOf(d))) {
      counts.dismissed++;
      if (closed.length < ITEM_LIMIT) closed.push(d);
      continue;
    }
    const category = CATEGORY[d.kind];
    counts[category]++;
    if (shown[category]++ < ITEM_LIMIT) open.push(d);
  }
  const ids = [...new Set([...open, ...closed].flatMap((d) => d.ids))];
  const summaries = new Map(getPersonSummaries(store, ids).map((s) => [s.id, s]));
  const issue = (d: Draft): CheckIssue => ({
    key: keyOf(d),
    kind: d.kind,
    category: CATEGORY[d.kind],
    message: d.message,
    people: d.ids.flatMap((id) => summaries.get(id) ?? []),
  });
  return { counts, items: open.map(issue), dismissed: closed.map(issue) };
}

/** Marks issues dismissed (or restores them); returns how many rows changed. */
export function setDismissed(tx: Tx, keys: string[], dismissed: boolean): number {
  let changed = 0;
  for (const key of new Set(keys)) {
    const metaKey = `${DISMISSED}${key}`;
    const exists = tx.store.getRow('meta', metaKey) !== undefined;
    if (dismissed && !exists) {
      meta.set(tx, metaKey, tx.now);
      changed++;
    } else if (!dismissed && exists) {
      meta.delete(tx, metaKey);
      changed++;
    }
  }
  return changed;
}

/** `Dismiss check: No sources for Ada Vale`, or `Dismiss 3 checks`. */
export function dismissLabel(store: TreeStore, keys: string[], dismissed: boolean): string {
  const verb = dismissed ? 'Dismiss' : 'Restore';
  if (keys.length !== 1) return `${verb} ${keys.length} checks`;
  const draft = findIssues(store).find((d) => keyOf(d) === keys[0]);
  return draft ? `${verb} check: ${draft.message}` : `${verb} check`;
}
