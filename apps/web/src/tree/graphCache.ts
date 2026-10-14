import { fromNeighborhood, type NeighborhoodInput, type TreeGraph } from '@open-ancestry/core';
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
  /** Families that have any child loaded. */
  private readonly familiesWithChildren = new Set<string>();
  /** Person id to the families they are a partner in. */
  private readonly partnerFamilies = new Map<string, string[]>();
  private memo: { version: number; graph: TreeGraph } | null = null;
  version = 0;

  /** Adds a slice; returns whether anything new arrived. */
  merge(slice: ApiNeighborhood): boolean {
    const before = this.version;
    for (const person of slice.people) {
      if (!this.people.has(person.id)) this.version++;
      this.people.set(person.id, person);
    }
    for (const family of slice.families) {
      if (this.families.has(family.id)) continue;
      this.version++;
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
      this.familiesWithChildren.add(child.familyId);
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

  /** The database has parents for this person that no slice has loaded yet. */
  needsParents(id: string): boolean {
    return this.moreUp.has(id) && !this.parentFamilies.has(id);
  }

  /** The database has children for this person that no slice has loaded yet. */
  needsChildren(id: string): boolean {
    if (!this.moreDown.has(id)) return false;
    return !(this.partnerFamilies.get(id) ?? []).some((f) => this.familiesWithChildren.has(f));
  }

  /** Partners of the person's preferred (else first) parent family. */
  parentsOf(id: string): string[] {
    const links = this.parentFamilies.get(id) ?? [];
    const link = links.find((l) => l.isPreferred) ?? links[0];
    const family = link && this.families.get(link.familyId);
    if (!family) return [];
    return [family.partner1Id, family.partner2Id].filter((p): p is string => p !== null);
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

  /** The merged layout input, rebuilt only when something new arrived. */
  graph(): TreeGraph {
    if (this.memo?.version !== this.version) {
      this.memo = { version: this.version, graph: fromNeighborhood(this.input()) };
    }
    return this.memo.graph;
  }
}
