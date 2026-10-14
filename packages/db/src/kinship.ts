/*
 * The whole tree as a relationship graph, for "what is A to B" on the server.
 * Loading every person and family is three flat queries (tens of
 * milliseconds on a 10k tree); the graph and its calculator are then reused
 * until the database changes, so most lookups cost about a millisecond.
 */
import { kinshipGraph, relationshipCalculator, isVirtualParent } from '@open-ancestry/core';
import type {
  ChildRelation,
  KinshipGraph,
  PartnerRelationship,
  RelationshipOptions,
  RelationshipResult,
  Span,
  TreeFamily,
  TreeFamilyChild,
  TreePerson,
} from '@open-ancestry/core';
import { BIRTH_TYPES, DEATH_TYPES, databaseVersion, getPersonSummaries } from './queries';
import type { PersonSummary } from './queries';
import type { TreeStore } from './store';

const list = (types: readonly string[]) => types.map((t) => `'${t}'`).join(', ');

interface Kinship {
  version: string;
  graph: KinshipGraph;
  calculate: (a: string, b: string, options?: RelationshipOptions) => RelationshipResult;
}

const cache = new WeakMap<TreeStore, Kinship>();

function load(store: TreeStore): KinshipGraph {
  const people = new Map<string, TreePerson>();
  for (const p of store.stmt('SELECT id, sex FROM person').all() as TreePerson[]) {
    people.set(p.id, { id: p.id, sex: p.sex, name: '', living: false });
  }
  const families = new Map<string, TreeFamily & { children: TreeFamilyChild[] }>();
  const rows = store
    .stmt('SELECT id, partner1_id, partner2_id, relationship_type FROM family')
    .all() as {
    id: string;
    partner1_id: string | null;
    partner2_id: string | null;
    relationship_type: PartnerRelationship;
  }[];
  for (const f of rows) {
    families.set(f.id, {
      id: f.id,
      partners: [f.partner1_id, f.partner2_id],
      relationship: f.relationship_type,
      children: [],
    });
  }
  const links = store
    .stmt(
      'SELECT family_id, child_id, partner1_rel, partner2_rel FROM family_child ORDER BY sort_order, id',
    )
    .all() as {
    family_id: string;
    child_id: string;
    partner1_rel: ChildRelation;
    partner2_rel: ChildRelation;
  }[];
  for (const c of links) {
    families
      .get(c.family_id)
      ?.children.push({ id: c.child_id, rel1: c.partner1_rel, rel2: c.partner2_rel });
  }

  // Dates are only needed for the occasional step check, so they are read
  // per person or family on demand rather than for the whole tree.
  const vitals = store.stmt(
    `SELECT e.type IN (${list(DEATH_TYPES)}) AS death, min(e.date_sort) AS k
     FROM event_role r JOIN event e ON e.id = r.event_id
     WHERE r.person_id = ? AND r.role = 'principal' AND e.date_sort IS NOT NULL
       AND e.type IN (${list([...BIRTH_TYPES, ...DEATH_TYPES])})
     GROUP BY death`,
  );
  const familyDates = store.stmt(
    `SELECT e.type = 'DIV' AS divorce, min(e.date_sort) AS k
     FROM event_role r JOIN event e ON e.id = r.event_id
     WHERE r.family_id = ? AND e.date_sort IS NOT NULL AND e.type IN ('MARR', 'DIV')
     GROUP BY divorce`,
  );
  const lives = new Map<string, Span>();
  const lifespan = (id: string): Span => {
    let span = lives.get(id);
    if (!span) {
      span = {};
      for (const v of vitals.all(id) as { death: number; k: number }[]) {
        if (v.death) span.end = v.k;
        else span.start = v.k;
      }
      lives.set(id, span);
    }
    return span;
  };
  const unions = new Map<string, Span>();
  const union = (familyId: string): Span | undefined => {
    let span = unions.get(familyId);
    if (span) return span;
    const family = families.get(familyId);
    if (!family) return undefined;
    span = {};
    for (const e of familyDates.all(familyId) as { divorce: number; k: number }[]) {
      if (e.divorce) span.end = e.k;
      else span.start = e.k;
    }
    // A union also ends when either partner dies.
    const ends = [span.end, ...family.partners.map((p) => (p ? lifespan(p).end : undefined))];
    const known = ends.filter((k): k is number => k !== undefined);
    if (known.length) span.end = Math.min(...known);
    unions.set(familyId, span);
    return span;
  };

  return {
    ...kinshipGraph({ people, families: [...families.values()] }),
    lifespan,
    union,
  };
}

function kinship(store: TreeStore): Kinship {
  // Inside a transaction the data may roll back; build a graph but do not keep it.
  const version = databaseVersion(store);
  const hit = cache.get(store);
  if (hit?.version === version) return hit;
  const graph = load(store);
  const fresh: Kinship = { version, graph, calculate: relationshipCalculator(graph) };
  if (!store.db.inTransaction) cache.set(store, fresh);
  return fresh;
}

export interface RelationshipView extends RelationshipResult {
  /** Everyone on a returned path, for names and the mini charts. */
  people: PersonSummary[];
}

/** What `a` is to `b` across the whole tree, with the people on every path. */
export function getRelationship(
  store: TreeStore,
  a: string,
  b: string,
  options: RelationshipOptions = {},
): RelationshipView {
  const result = kinship(store).calculate(a, b, options);
  const ids = new Set<string>([a, b]);
  for (const r of result.relationships) {
    for (const path of r.paths) for (const id of path.ids) if (!isVirtualParent(id)) ids.add(id);
  }
  return { ...result, people: getPersonSummaries(store, [...ids]) };
}
