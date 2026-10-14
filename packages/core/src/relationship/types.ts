/**
 * Input and output of the relationship calculator. The calculator only sees
 * a `KinshipGraph` accessor, so it runs over a `TreeGraph` slice in a worker
 * (`kinshipGraph`) or over database rows on the server.
 */
import type { ChildRelation, PartnerRelationship, Sex } from '../layout/types';

export interface KinEdge {
  id: string;
  familyId: string;
}

export interface ParentEdge extends KinEdge {
  /** How the child relates to this parent: biological, adopted, step, foster... */
  rel: ChildRelation;
}

export interface PartnerEdge extends KinEdge {
  relationship?: PartnerRelationship;
}

export interface KinshipGraph {
  /** Undefined for an unknown id. */
  sex(id: string): Sex | undefined;
  parents(id: string): readonly ParentEdge[];
  /** `rel` is the child's relation to `id`. */
  children(id: string): readonly ParentEdge[];
  partners(id: string): readonly PartnerEdge[];
}

export interface PathStep {
  /** `parent`: the next person is a parent of this one; `child`: a child; `spouse`: a partner. */
  kind: 'parent' | 'child' | 'spouse';
  /** For parent and child steps, the child's relation to the parent. */
  rel?: ChildRelation;
}

/** From A to B: `ids[0]` is A, `ids.at(-1)` is B, `steps[i]` joins ids[i] and ids[i + 1]. */
export interface RelationshipPath {
  ids: string[];
  steps: PathStep[];
}

export interface Relationship {
  /** English name of what A is to B: "2nd cousin once removed", "sister-in-law". */
  name: string;
  kind: 'self' | 'blood' | 'marriage';
  /** Every path that gives this name (more than one with pedigree collapse or double cousins). */
  paths: RelationshipPath[];
  /** Blood only: the most recent common ancestors (a couple, or one person when half). */
  commonAncestors?: string[];
  /** Blood only: generations from A and from B up to the common ancestors. */
  generations?: [number, number];
  half?: boolean;
}

export interface RelationshipResult {
  a: string;
  b: string;
  /** Shortest relationships first; empty when unrelated within the search bounds. */
  relationships: Relationship[];
  /** All names joined, e.g. "2nd cousin and also 3rd cousin once removed", or "unrelated". */
  name: string;
}

export interface RelationshipOptions {
  /** Generations searched above each person. Default 20. */
  maxGenerations?: number;
  /** People visited before giving up on a marriage path. Default 50,000. */
  maxNodes?: number;
  /** Marriages allowed on a non-blood path. Default 2 ("wife's brother's wife"). */
  maxMarriages?: number;
}
