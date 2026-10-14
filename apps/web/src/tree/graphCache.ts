import {
  fromNeighborhood,
  toTreeFamily,
  toTreePerson,
  type GraphIndex,
  type NeighborhoodInput,
  type TreeFamily,
  type TreeFamilyChild,
  type TreeGraph,
  type TreePerson,
} from '@open-ancestry/core';
import type { ApiNeighborhood, ApiPersonSummary } from './api';

type FamilyEdge = ApiNeighborhood['families'][number];
type ChildEdge = ApiNeighborhood['children'][number];

/**
 * Every neighborhood slice fetched for one tree, merged into one graph. The
 * main thread keeps one for person details and the layout worker keeps an
 * identical one, so each slice crosses to the worker once.
 *
 * `moreUp`/`moreDown` hints are dropped once a later slice has loaded the
 * relatives they point at.
 */
export class GraphCache {
  private readonly people = new Map<string, ApiPersonSummary>();
  private readonly families = new Map<string, FamilyEdge>();
  private readonly children = new Map<string, ChildEdge>();
  private readonly moreUp = new Set<string>();
  private readonly moreDown = new Set<string>();
  /** Child id to the families it is a child of. */
  private readonly parentFamilies = new Map<string, ChildEdge[]>();
  /** Family id to its loaded child links, in arrival order. */
  private readonly familyChildren = new Map<string, ChildEdge[]>();
  /** Family id to its arrival position ("graph order" for ties when sorting). */
  private readonly familySeq = new Map<string, number>();
  /** Person id to the families they are a partner in. */
  private readonly partnerFamilies = new Map<string, string[]>();
  private memo: { version: number; graph: TreeGraph } | null = null;
  private indexMemo: { version: number; index: GraphIndex } | null = null;
  private readonly displayed = new Map<string, unknown>();
  version = 0;

  /** Adds a slice; returns whether anything new arrived. */
  merge(slice: ApiNeighborhood): boolean {
    const before = this.version;
    for (const person of slice.people) {
      if (!this.people.has(person.id)) this.version++;
      this.people.set(person.id, person);
      this.displayed.delete(person.id);
    }
    for (const family of slice.families) {
      if (this.families.has(family.id)) continue;
      this.version++;
      this.familySeq.set(family.id, this.families.size);
      this.families.set(family.id, family);
      for (const partner of [family.partner1Id, family.partner2Id]) {
        if (!partner) continue;
        const list = this.partnerFamilies.get(partner);
        if (list) list.push(family.id);
        else this.partnerFamilies.set(partner, [family.id]);
      }
    }
    for (const child of slice.children) {
      const key = `${child.familyId}|${child.childId}`;
      if (this.children.has(key)) continue;
      this.version++;
      this.children.set(key, child);
      const siblings = this.familyChildren.get(child.familyId);
      if (siblings) siblings.push(child);
      else this.familyChildren.set(child.familyId, [child]);
      const list = this.parentFamilies.get(child.childId);
      if (list) list.push(child);
      else this.parentFamilies.set(child.childId, [child]);
    }
    for (const id of slice.moreUp) {
      if (!this.moreUp.has(id)) {
        this.moreUp.add(id);
        this.version++;
      }
    }
    for (const id of slice.moreDown) {
      if (!this.moreDown.has(id)) {
        this.moreDown.add(id);
        this.version++;
      }
    }
    return this.version !== before;
  }

  has(id: string): boolean {
    return this.people.has(id);
  }

  summary(id: string): ApiPersonSummary | undefined {
    return this.people.get(id);
  }

  /** A derived view of a person (e.g. for cards), built once per summary. */
  display<T>(id: string, make: (summary: ApiPersonSummary) => T): T | undefined {
    if (this.displayed.has(id)) return this.displayed.get(id) as T;
    const summary = this.people.get(id);
    if (!summary) return undefined;
    const value = make(summary);
    this.displayed.set(id, value);
    return value;
  }

  /** The database has parents for this person that no slice has loaded yet. */
  needsParents(id: string): boolean {
    return this.moreUp.has(id) && !this.parentFamilies.has(id);
  }

  /** The database has children for this person that no slice has loaded yet. */
  needsChildren(id: string): boolean {
    if (!this.moreDown.has(id)) return false;
    return !(this.partnerFamilies.get(id) ?? []).some((f) => this.familyChildren.has(f));
  }

  /** Partners of the person's preferred (else first) parent family. */
  parentsOf(id: string): string[] {
    const links = this.parentFamilies.get(id) ?? [];
    const link = links.find((l) => l.isPreferred) ?? links[0];
    const family = link && this.families.get(link.familyId);
    if (!family) return [];
    return [family.partner1Id, family.partner2Id].filter((p): p is string => p !== null);
  }

  /** Everything merged so far as one slice, to seed a new worker. */
  snapshot(): ApiNeighborhood {
    return {
      focusId: '',
      people: [...this.people.values()],
      families: [...this.families.values()],
      children: [...this.children.values()],
      moreUp: [...this.moreUp],
      moreDown: [...this.moreDown],
      truncated: false,
    };
  }

  input(): NeighborhoodInput {
    return {
      people: [...this.people.values()],
      families: [...this.families.values()],
      children: [...this.children.values()],
      moreUp: [...this.moreUp].filter((id) => this.needsParents(id)),
      moreDown: [...this.moreDown].filter((id) => this.needsChildren(id)),
    };
  }

  /**
   * The merged layout input as one graph, rebuilt only when something new
   * arrived. The worker lays out from `index()` instead; this is the reference
   * the index is tested against.
   */
  graph(): TreeGraph {
    if (this.memo?.version !== this.version) {
      this.memo = { version: this.version, graph: fromNeighborhood(this.input()) };
    }
    return this.memo.graph;
  }

  /**
   * The layouts' view of everything merged, answering exactly as
   * `indexGraph(this.graph())` would, but built lazily from the maps kept on
   * merge: a layout costs what it looks at, not everything browsed so far.
   * A new version starts a fresh (empty) memo.
   */
  index(): GraphIndex {
    if (this.indexMemo?.version !== this.version) {
      this.indexMemo = { version: this.version, index: this.lazyIndex() };
    }
    return this.indexMemo.index;
  }

  private lazyIndex(): GraphIndex {
    const NONE: readonly TreeFamily[] = [];
    const persons = new Map<string, TreePerson>();
    const families = new Map<string, TreeFamily>();
    const indexed = new Map<
      string,
      {
        partners: [string | null, string | null];
        children: string[];
        entries: Map<string, TreeFamilyChild>;
      }
    >();
    const parentsOf = new Map<string, readonly TreeFamily[]>();
    const partnerOf = new Map<string, readonly TreeFamily[]>();

    const person = (id: string): TreePerson | undefined => {
      let value = persons.get(id);
      if (!value) {
        const summary = this.people.get(id);
        if (!summary) return undefined;
        value = toTreePerson(summary, this.needsParents(id), this.needsChildren(id));
        persons.set(id, value);
      }
      return value;
    };
    const family = (id: string): TreeFamily | undefined => {
      let value = families.get(id);
      if (!value) {
        const edge = this.families.get(id);
        if (!edge) return undefined;
        value = toTreeFamily(edge, this.familyChildren.get(id) ?? []);
        families.set(id, value);
      }
      return value;
    };
    // Same rules as indexGraph: absent partners (or one repeated) are null,
    // and only children present in the graph count, each once.
    const ix = (f: TreeFamily) => {
      let value = indexed.get(f.id);
      if (!value) {
        const [a, b] = f.partners;
        const p1 = a != null && this.people.has(a) ? a : null;
        const p2 = b != null && b !== p1 && this.people.has(b) ? b : null;
        const entries = new Map<string, TreeFamilyChild>();
        for (const child of family(f.id)?.children ?? f.children) {
          if (this.people.has(child.id) && !entries.has(child.id)) entries.set(child.id, child);
        }
        value = { partners: [p1, p2], children: [...entries.keys()], entries };
        indexed.set(f.id, value);
      }
      return value;
    };
    const sorted = (list: { family: TreeFamily; order: number }[]) =>
      list
        .sort(
          (x, y) =>
            x.order - y.order ||
            this.familySeq.get(x.family.id)! - this.familySeq.get(y.family.id)!,
        )
        .map((x) => x.family);

    return {
      person,
      parentFamilies: (id) => {
        let value = parentsOf.get(id);
        if (!value) {
          const list: { family: TreeFamily; order: number }[] = [];
          if (this.people.has(id)) {
            for (const link of this.parentFamilies.get(id) ?? []) {
              const f = family(link.familyId);
              if (f) list.push({ family: f, order: ix(f).entries.get(id)?.order ?? 0 });
            }
          }
          value = list.length > 0 ? sorted(list) : NONE;
          parentsOf.set(id, value);
        }
        return value;
      },
      partnerFamilies: (id) => {
        let value = partnerOf.get(id);
        if (!value) {
          const list: { family: TreeFamily; order: number }[] = [];
          for (const familyId of new Set(this.partnerFamilies.get(id))) {
            const f = family(familyId)!;
            const {
              partners: [p1, p2],
              children,
            } = ix(f);
            const [o1, o2] = f.partnerOrder ?? [0, 0];
            if (p1 === id && (p2 || children.length)) list.push({ family: f, order: o1 });
            if (p2 === id && (p1 || children.length)) list.push({ family: f, order: o2 });
          }
          value = list.length > 0 ? sorted(list) : NONE;
          partnerOf.set(id, value);
        }
        return value;
      },
      partners: (f) => ix(f).partners,
      children: (f) => ix(f).children,
      entry: (f, childId) => ix(f).entries.get(childId),
    };
  }
}
