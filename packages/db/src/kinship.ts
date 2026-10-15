/*
 * The tree as a relationship graph, for "what is A to B" on the server.
 *
 * Nothing is loaded up front. Each person's families and each family's
 * members are read on first use with indexed queries and kept, so a lookup
 * costs only the part of the tree it walks, and later lookups reuse it.
 * Temporary triggers on this connection drop exactly the people and
 * families an edit touches; edits that cannot change a relationship (notes,
 * tags, media, the home person) drop nothing, and event edits only drop the
 * dates used for step checks. A write from another connection (PRAGMA
 * data_version) drops everything, which is just as cheap.
 */
import { isVirtualParent, relationshipCalculator, VIRTUAL_PARENT } from '@open-ancestry/core';
import type {
  ChildRelation,
  KinshipGraph,
  ParentEdge,
  PartnerEdge,
  PartnerRelationship,
  RelationshipOptions,
  RelationshipResult,
  Sex,
  Span,
} from '@open-ancestry/core';
import { BIRTH_TYPES, DEATH_TYPES, getPersonSummaries } from './queries';
import type { PersonSummary } from './queries';
import type { TreeStore } from './store';

const list = (types: readonly string[]) => types.map((t) => `'${t}'`).join(', ');

/** Generations searched above each person: lookups only read what they walk, so go deep. */
export const RELATIONSHIP_GENERATIONS = 40;

/**
 * People a marriage-path search may visit. In-law paths are short, so this
 * only bounds the search between people with no connection at all.
 */
export const RELATIONSHIP_MAX_NODES = 20_000;

interface Child {
  id: string;
  rel1: ChildRelation;
  rel2: ChildRelation;
}

interface Family {
  id: string;
  /** A partner listed twice counts once, as in core's graph index. */
  p1: string | null;
  p2: string | null;
  relationship: PartnerRelationship;
  /** In sort order. */
  children: Child[];
}

interface Person {
  sex: Sex;
  /** Families this person is a child of, and a partner in, by id. */
  asChild: string[];
  asPartner: string[];
}

/** Columns whose updates can change a relationship or a step check. */
const WATCHED: Record<string, string[]> = {
  person: ['sex'],
  family: ['partner1_id', 'partner2_id', 'relationship_type'],
  family_child: ['family_id', 'child_id', 'partner1_rel', 'partner2_rel', 'sort_order'],
  event: ['type', 'date_sort'],
  event_role: ['event_id', 'person_id', 'family_id', 'role'],
};

/** Full resets and per-row drops so far, for tests. Not exported from the package. */
export const kinshipStats = { resets: 0, touches: 0 };

/** The relationship graph of one open tree, read lazily and dropped row by row. */
class TreeKinship {
  private readonly store: TreeStore;
  private readonly people = new Map<string, Person | null>();
  private readonly families = new Map<string, Family | null>();
  private readonly parents = new Map<string, ParentEdge[]>();
  private readonly children = new Map<string, ParentEdge[]>();
  private readonly partners = new Map<string, PartnerEdge[]>();
  private readonly lives = new Map<string, Span>();
  private readonly unions = new Map<string, Span>();
  private dataVersion = -1;
  private calculator: ReturnType<typeof relationshipCalculator> | undefined;
  readonly graph: KinshipGraph;

  constructor(store: TreeStore) {
    this.store = store;
    this.graph = this.accessors();
  }

  /** Drops whatever an edited row could have changed. Called by the triggers. */
  touch(kind: unknown, id: unknown) {
    if (kind === 'e') {
      this.lives.clear();
      this.unions.clear();
      return;
    }
    if (id === null || id === undefined) return;
    const key = String(id);
    kinshipStats.touches++;
    this.calculator = undefined;
    if (kind === 'p') this.dropPerson(key);
    else if (kind === 'f') this.dropFamily(key);
  }

  private dropPerson(id: string) {
    this.people.delete(id);
    this.lives.delete(id);
    this.parents.delete(id);
    this.children.delete(id);
    this.partners.delete(id);
  }

  private dropFamily(id: string) {
    const family = this.families.get(id);
    this.families.delete(id);
    this.unions.delete(id);
    this.children.delete(VIRTUAL_PARENT + id);
    if (!family) return;
    for (const member of [family.p1, family.p2, ...family.children.map((c) => c.id)]) {
      if (!member) continue;
      this.parents.delete(member);
      this.children.delete(member);
      this.partners.delete(member);
    }
  }

  /** Watches this connection's writes through temporary triggers. */
  watch() {
    const db = this.store.db;
    db.function('oa_kinship_touch', { deterministic: false }, (kind: unknown, id: unknown) => {
      this.touch(kind, id);
      return null;
    });
    const touch = (kind: string, ...ids: string[]) =>
      ids.map((id) => `oa_kinship_touch('${kind}', ${id})`).join(', ');
    const trigger = (name: string, when: string, calls: string) =>
      db.exec(
        `CREATE TEMP TRIGGER IF NOT EXISTS oa_kinship_${name} ${when} BEGIN SELECT ${calls}; END`,
      );
    const ops = [
      ['ins', 'INSERT', ['NEW']],
      ['del', 'DELETE', ['OLD']],
      ['upd', 'UPDATE', ['OLD', 'NEW']],
    ] as const;
    for (const [op, event, rows] of ops) {
      // Updates only fire when a column the graph reads changed. (The edit layer
      // writes whole rows, so an OF column list would fire on every update.)
      const on = (table: string) => {
        const changed = WATCHED[table]!.map((c) => `OLD.${c} IS NOT NEW.${c}`).join(' OR ');
        return `AFTER ${event} ON main.${table}${op === 'upd' ? ` WHEN ${changed}` : ''}`;
      };
      trigger(`person_${op}`, on('person'), touch('p', ...rows.map((r) => `${r}.id`)));
      trigger(
        `family_${op}`,
        on('family'),
        [
          touch('f', ...rows.map((r) => `${r}.id`)),
          touch('p', ...rows.flatMap((r) => [`${r}.partner1_id`, `${r}.partner2_id`])),
        ].join(', '),
      );
      trigger(
        `child_${op}`,
        on('family_child'),
        [
          touch('f', ...rows.map((r) => `${r}.family_id`)),
          touch('p', ...rows.map((r) => `${r}.child_id`)),
        ].join(', '),
      );
      for (const table of ['event', 'event_role']) {
        trigger(`${table}_${op}`, on(table), "oa_kinship_touch('e', NULL)");
      }
    }
  }

  /** The calculator for the graph as it is now. */
  current(): ReturnType<typeof relationshipCalculator> {
    const version = this.store.db.pragma('data_version', { simple: true }) as number;
    if (version !== this.dataVersion) {
      // Another connection wrote: anything read before may be stale.
      this.dataVersion = version;
      kinshipStats.resets++;
      for (const map of [
        this.people,
        this.families,
        this.parents,
        this.children,
        this.partners,
        this.lives,
        this.unions,
      ]) {
        map.clear();
      }
      this.calculator = undefined;
    }
    this.calculator ??= relationshipCalculator(this.graph, {
      maxGenerations: RELATIONSHIP_GENERATIONS,
      maxNodes: RELATIONSHIP_MAX_NODES,
    });
    return this.calculator;
  }

  private person(id: string): Person | null {
    let person = this.people.get(id);
    if (person !== undefined) return person;
    const row = this.store.stmt('SELECT sex FROM person WHERE id = ?').get(id) as
      { sex: Sex } | undefined;
    person = row
      ? {
          sex: row.sex,
          asChild: (
            this.store
              .stmt('SELECT family_id FROM family_child WHERE child_id = ? ORDER BY family_id')
              .all(id) as { family_id: string }[]
          ).map((r) => r.family_id),
          asPartner: (
            this.store
              .stmt('SELECT id FROM family WHERE partner1_id = ? OR partner2_id = ? ORDER BY id')
              .all(id, id) as { id: string }[]
          ).map((r) => r.id),
        }
      : null;
    this.people.set(id, person);
    return person;
  }

  private family(id: string): Family | null {
    let family = this.families.get(id);
    if (family !== undefined) return family;
    const row = this.store
      .stmt('SELECT partner1_id, partner2_id, relationship_type FROM family WHERE id = ?')
      .get(id) as
      | {
          partner1_id: string | null;
          partner2_id: string | null;
          relationship_type: PartnerRelationship;
        }
      | undefined;
    family = row
      ? {
          id,
          p1: row.partner1_id,
          p2: row.partner2_id === row.partner1_id ? null : row.partner2_id,
          relationship: row.relationship_type,
          children: this.store
            .stmt(
              `SELECT child_id AS id, partner1_rel AS rel1, partner2_rel AS rel2
               FROM family_child WHERE family_id = ? ORDER BY sort_order, id`,
            )
            .all(id) as Child[],
        }
      : null;
    this.families.set(id, family);
    return family;
  }

  private accessors(): KinshipGraph {
    const families = (ids: string[] | undefined) =>
      (ids ?? []).map((id) => this.family(id)).filter((f): f is Family => f !== null);
    const memo =
      <T>(map: Map<string, T>, build: (id: string) => T) =>
      (id: string): T => {
        let value = map.get(id);
        if (value === undefined) map.set(id, (value = build(id)));
        return value;
      };
    // Partners only count in families with a spouse or children, as in core's graph index.
    const partnerFamilies = (id: string) =>
      families(this.person(id)?.asPartner).filter(
        (f) => (f.p1 === id ? f.p2 : f.p1) !== null || f.children.length > 0,
      );
    const vitals = () =>
      this.store.stmt(
        `SELECT e.type IN (${list(DEATH_TYPES)}) AS death, min(e.date_sort) AS k
         FROM event_role r JOIN event e ON e.id = r.event_id
         WHERE r.person_id = ? AND r.role = 'principal' AND e.date_sort IS NOT NULL
           AND e.type IN (${list([...BIRTH_TYPES, ...DEATH_TYPES])})
         GROUP BY death`,
      );
    const familyDates = () =>
      this.store.stmt(
        `SELECT e.type = 'DIV' AS divorce, min(e.date_sort) AS k
         FROM event_role r JOIN event e ON e.id = r.event_id
         WHERE r.family_id = ? AND e.date_sort IS NOT NULL AND e.type IN ('MARR', 'DIV')
         GROUP BY divorce`,
      );
    const lifespan = (id: string): Span => {
      let span = this.lives.get(id);
      if (!span) {
        span = {};
        for (const v of vitals().all(id) as { death: number; k: number }[]) {
          if (v.death) span.end = v.k;
          else span.start = v.k;
        }
        this.lives.set(id, span);
      }
      return span;
    };
    return {
      sex: (id) => this.person(id)?.sex,
      parents: memo(this.parents, (id): ParentEdge[] =>
        families(this.person(id)?.asChild).flatMap((family) => {
          const entry = family.children.find((c) => c.id === id);
          const edges: ParentEdge[] = [];
          const { p1, p2 } = family;
          if (p1) edges.push({ id: p1, familyId: family.id, rel: entry?.rel1 ?? 'unknown' });
          if (p2) edges.push({ id: p2, familyId: family.id, rel: entry?.rel2 ?? 'unknown' });
          if (!p1 && !p2) {
            edges.push({ id: VIRTUAL_PARENT + family.id, familyId: family.id, rel: 'unknown' });
          }
          return edges;
        }),
      ),
      children: memo(this.children, (id): ParentEdge[] => {
        if (isVirtualParent(id)) {
          const family = this.family(id.slice(VIRTUAL_PARENT.length));
          return (family?.children ?? []).map((c) => ({
            id: c.id,
            familyId: family!.id,
            rel: 'unknown',
          }));
        }
        return partnerFamilies(id).flatMap((family) => {
          const first = family.p1 === id;
          return family.children.map((c) => ({
            id: c.id,
            familyId: family.id,
            rel: first ? c.rel1 : c.rel2,
          }));
        });
      }),
      partners: memo(this.partners, (id): PartnerEdge[] =>
        partnerFamilies(id).flatMap((family) => {
          const spouse = family.p1 === id ? family.p2 : family.p1;
          return spouse
            ? [{ id: spouse, familyId: family.id, relationship: family.relationship }]
            : [];
        }),
      ),
      lifespan,
      union: (familyId) => {
        let span = this.unions.get(familyId);
        if (span) return span;
        const family = this.family(familyId);
        if (!family) return undefined;
        span = {};
        for (const e of familyDates().all(familyId) as { divorce: number; k: number }[]) {
          if (e.divorce) span.end = e.k;
          else span.start = e.k;
        }
        // A union also ends when either partner dies.
        const ends = [
          span.end,
          ...[family.p1, family.p2].map((p) => (p ? lifespan(p).end : undefined)),
        ];
        const known = ends.filter((k): k is number => k !== undefined);
        if (known.length) span.end = Math.min(...known);
        this.unions.set(familyId, span);
        return span;
      },
    };
  }
}

const graphs = new WeakMap<TreeStore, TreeKinship>();

/** Drops the cached graph, so the next lookup starts from nothing (benches and tests). */
export function forgetKinship(store: TreeStore): void {
  graphs.delete(store);
}

function kinship(store: TreeStore): ReturnType<typeof relationshipCalculator> {
  // Inside a transaction the rows may still roll back: answer from a throwaway graph.
  if (store.db.inTransaction) return new TreeKinship(store).current();
  let graph = graphs.get(store);
  if (!graph) {
    graph = new TreeKinship(store);
    graph.watch();
    graphs.set(store, graph);
  }
  return graph.current();
}

export interface RelationshipView extends RelationshipResult {
  /** Everyone on a returned path, for names and the mini charts. */
  people: PersonSummary[];
}

/**
 * What `a` is to `b` across the whole tree, with the people on every path.
 * Searches `RELATIONSHIP_GENERATIONS` generations up unless told otherwise.
 */
export function getRelationship(
  store: TreeStore,
  a: string,
  b: string,
  options: RelationshipOptions = {},
): RelationshipView {
  const result = kinship(store)(a, b, options);
  const ids = new Set<string>([a, b]);
  for (const r of result.relationships) {
    for (const path of r.paths) for (const id of path.ids) if (!isVirtualParent(id)) ids.add(id);
  }
  return { ...result, people: getPersonSummaries(store, [...ids]) };
}
