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
export const ITEM_LIMIT = 200;
export const MIN_PARENT_AGE = 12;
export const MAX_PARENT_AGE = 70;
/** Years either way two dates may differ and still describe the same person. */
const DUPLICATE_YEARS = 2;
/**
 * Widest date range that counts as evidence two people are the same: `BEF
 * 1965` or `BET 1800 AND 1900` agrees with too much to suggest a duplicate
 * (though it can still rule one out).
 */
const AGREEING_SPAN_YEARS = 10;
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

/** First and last possible `date_sort` day of an exact Gregorian date, or null. */
type Days = [number, number];

function daySpan(
  text: string | null,
  qualifier: string | null,
  sort: number | null,
  calendar: string | null,
): Days | null {
  if (qualifier !== 'exact' || sort === null || !text || calendar) return null;
  const t = text.trim().toUpperCase();
  // A month or a year alone sorts mid-way through it; widen it back out.
  if (/^\d{1,2}\s+[A-Z]/.test(t)) return [sort, sort];
  const month = Math.floor(sort / 100) * 100;
  if (/^[A-Z]{3,}\.?\s+\d/.test(t)) return [month + 1, month + 31];
  const year = Math.floor(sort / 10000) * 10000;
  return [year + 101, year + 1231];
}

/** A known date, in years (with slack for approximations) and, when exact, in days. */
interface Dated {
  years: Years;
  days: Days | null;
}

/** Certainly before: the latest `a` could be is earlier than the earliest `b` could be. */
const before = (a: Dated, b: Dated) =>
  a.years[1] < b.years[0] || (a.days !== null && b.days !== null && a.days[1] < b.days[0]);

interface NameRow {
  person_id: string;
  is_primary: number;
  given: string | null;
  surname: string | null;
  surname_key: string | null;
}

interface EventRow {
  person_id: string;
  event_id: string;
  type: string;
  custom_type: string | null;
  date_text: string | null;
  calendar: string | null;
  date_qualifier: string | null;
  date_sort: number | null;
  date_sort_end: number | null;
  is_preferred: number;
  sort_order: number;
}

interface Person {
  id: string;
  sex: string;
  name: string;
  /** `sound|given` per name: first surname sound key and normalized first given name. */
  keys: Set<string>;
  birth: Dated | null;
  death: Dated | null;
  events: ({ id: string; type: string; custom: string | null } & Dated)[];
}

function loadPeople(store: TreeStore): Map<string, Person> {
  const people = new Map<string, Person>();
  const rows = store.stmt('SELECT id, sex FROM person').all() as { id: string; sex: string }[];
  for (const r of rows) {
    people.set(r.id, {
      id: r.id,
      sex: r.sex,
      name: 'Unnamed person',
      keys: new Set(),
      birth: null,
      death: null,
      events: [],
    });
  }
  const names = store
    .stmt('SELECT person_id, is_primary, given, surname, surname_key FROM person_name')
    .all() as NameRow[];
  for (const n of names) {
    const person = people.get(n.person_id);
    if (!person) continue;
    if (n.is_primary === 1) {
      person.name = [n.given, n.surname].filter(Boolean).join(' ') || person.name;
    }
    const given = normalizeForSearch(n.given ?? '').split(' ')[0] ?? '';
    const sound = (n.surname_key ?? '').split(' ')[0] ?? '';
    if (given && sound) person.keys.add(`${sound}|${given}`);
  }
  const events = store
    .stmt(
      `SELECT r.person_id, e.id AS event_id, e.type, e.custom_type, e.date_text, e.calendar,
              e.date_qualifier,
              e.date_sort, e.date_sort_end, r.is_preferred, r.sort_order
       FROM event_role r JOIN event e ON e.id = r.event_id
       WHERE r.role = 'principal' AND r.person_id IS NOT NULL`,
    )
    .all() as EventRow[];
  // Unsorted (sorting every role costs more than the rest of the scan): the
  // lowest rank wins, so BIRT beats a christening, then preferred facts, then order.
  const birthRank = new Map<string, number>();
  const deathRank = new Map<string, number>();
  for (const e of events) {
    const person = people.get(e.person_id);
    const years = yearRange(e.date_qualifier, e.date_sort, e.date_sort_end);
    if (!person || !years) continue;
    const dated = {
      years,
      days: daySpan(e.date_text, e.date_qualifier, e.date_sort, e.calendar),
    };
    person.events.push({ id: e.event_id, type: e.type, custom: e.custom_type, ...dated });
    const order = (e.is_preferred ? 0 : 1e8) + e.sort_order;
    const type = BIRTH_TYPES.indexOf(e.type);
    if (type >= 0 && type * 1e9 + order < (birthRank.get(person.id) ?? Infinity)) {
      birthRank.set(person.id, type * 1e9 + order);
      person.birth = dated;
    }
    if (e.type === 'DEAT' && order < (deathRank.get(person.id) ?? Infinity)) {
      deathRank.set(person.id, order);
      person.death = dated;
    }
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

/**
 * People with no citation on themselves, their names, their own facts, or a
 * family they are a partner in (or its facts, such as the marriage).
 */
function unsourced(store: TreeStore): string[] {
  const sourced = new Set(
    store
      .stmt(
        `SELECT owner_id FROM citation_link WHERE owner_type = 'person'
         UNION SELECT n.person_id FROM citation_link cl
           JOIN person_name n ON cl.owner_type = 'person_name' AND n.id = cl.owner_id
         UNION SELECT r.person_id FROM citation_link cl
           JOIN event_role r ON cl.owner_type = 'event' AND r.event_id = cl.owner_id
           WHERE r.role = 'principal' AND r.person_id IS NOT NULL
         UNION SELECT f.id FROM citation_link cl
           JOIN family f ON cl.owner_type = 'family' AND f.id = cl.owner_id
         UNION SELECT r.family_id FROM citation_link cl
           JOIN event_role r ON cl.owner_type = 'event' AND r.event_id = cl.owner_id
           WHERE r.family_id IS NOT NULL`,
      )
      .pluck()
      .all() as string[],
  );
  // Family ids stand for their partners.
  const partners = store.stmt('SELECT id, partner1_id, partner2_id FROM family').all() as {
    id: string;
    partner1_id: string | null;
    partner2_id: string | null;
  }[];
  for (const f of partners) {
    if (!sourced.has(f.id)) continue;
    if (f.partner1_id) sourced.add(f.partner1_id);
    if (f.partner2_id) sourced.add(f.partner2_id);
  }
  return (store.stmt('SELECT id FROM person ORDER BY id').pluck().all() as string[]).filter(
    (id) => !sourced.has(id),
  );
}

const close = (a: Years, b: Years) =>
  a[0] - DUPLICATE_YEARS <= b[1] && b[0] - DUPLICATE_YEARS <= a[1];
const bounded = (y: Years) => y[1] - y[0] <= AGREEING_SPAN_YEARS;
/** Both dates are narrow and overlap: evidence for the same person. */
const agree = (a: Dated | null, b: Dated | null) =>
  a !== null && b !== null && bounded(a.years) && bounded(b.years) && close(a.years, b.years);
/** The dates cannot be the same event, open-ended or not. */
const conflict = (a: Dated | null, b: Dated | null) =>
  a !== null && b !== null && !close(a.years, b.years);
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

  // Duplicates: same first given name and surname sound in any of their names
  // (a maiden and a married name), compatible sex, and a pair of narrow dates
  // that agree with none that disagree.
  const groups = new Map<string, Person[]>();
  for (const p of people.values()) {
    for (const key of p.keys) {
      const group = groups.get(key);
      if (group) group.push(p);
      else groups.set(key, [p]);
    }
  }
  const paired = new Set<string>();
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!;
        const b = group[j]!;
        if (!sexesAgree(a.sex, b.sex)) continue;
        if (conflict(a.birth, b.birth) || conflict(a.death, b.death)) continue;
        if (!agree(a.birth, b.birth) && !agree(a.death, b.death)) continue;
        const ids = [a.id, b.id].sort();
        const pair = ids.join('+');
        if (paired.has(pair)) continue;
        paired.add(pair);
        drafts.push({
          kind: 'possible-duplicate',
          ids,
          message: `Possible duplicate: ${name(ids[0]!)} and ${name(ids[1]!)}`,
        });
      }
    }
  }

  for (const p of people.values()) {
    if (p.birth && p.death && before(p.death, p.birth)) {
      drafts.push({
        kind: 'death-before-birth',
        ids: [p.id],
        message: `Died in ${showYear(p.death.years)}, before birth in ${showYear(p.birth.years)}`,
      });
    }
    if (p.death) {
      for (const e of p.events) {
        // A birth after death is reported once, as death-before-birth.
        if (AFTER_DEATH_OK.has(e.type) || BIRTH_TYPES.includes(e.type)) continue;
        if (!before(p.death, e)) continue;
        drafts.push({
          kind: 'event-after-death',
          ids: [p.id],
          eventId: e.id,
          message: `${eventTypeLabel(e.type, e.custom)} in ${showYear(e.years)}, after death in ${showYear(p.death.years)}`,
        });
      }
    }
  }

  for (const [parentId, childId] of parentLinks(store)) {
    const parent = people.get(parentId)?.birth?.years;
    const child = people.get(childId)?.birth?.years;
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

/** The issues found by the last scan of each tree, and the state of the tree it saw. */
const scans = new WeakMap<TreeStore, { version: string; drafts: Draft[] }>();

/** Changes whenever any connection (this one, or an import worker's) writes to the tree. */
function treeVersion(store: TreeStore): string {
  const others = store.db.pragma('data_version', { simple: true }) as number;
  const own = store.stmt('SELECT total_changes()').pluck().get() as number;
  return `${others}:${own}`;
}

/** Scans the tree, or reuses the last scan when nothing has been written since. */
function scan(store: TreeStore): Draft[] {
  const version = treeVersion(store);
  const cached = scans.get(store);
  if (cached?.version === version) return cached.drafts;
  const drafts = findIssues(store);
  scans.set(store, { version, drafts });
  return drafts;
}

/**
 * Runs `write`, which may only add or remove dismissals, and keeps the last
 * scan: dismissals are applied when the report is read, not by the scan.
 */
export function keepingScan<R>(store: TreeStore, write: () => R): R {
  const before = treeVersion(store);
  const result = write();
  const cached = scans.get(store);
  if (cached?.version === before) cached.version = treeVersion(store);
  return result;
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
  const drafts = scan(store);
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
  const draft = scan(store).find((d) => keyOf(d) === keys[0]);
  return draft ? `${verb} check: ${draft.message}` : `${verb} check`;
}
