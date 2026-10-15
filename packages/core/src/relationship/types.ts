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

/** A stretch of time as `ParsedDate.sortKey` values; a missing end is unknown. */
export interface Span {
  start?: number;
  end?: number;
}

export interface KinshipGraph {
  /** Undefined for an unknown id. */
  sex(id: string): Sex | undefined;
  parents(id: string): readonly ParentEdge[];
  /** `rel` is the child's relation to `id`. */
  children(id: string): readonly ParentEdge[];
  partners(id: string): readonly PartnerEdge[];
  /**
   * Optional dates. A parent's spouse is only a step-parent (and their
   * children step-siblings) when the union overlapped the child's life;
   * without dates every union counts.
   */
  lifespan?(id: string): Span | undefined;
  /** From the marriage to its end (divorce or a partner's death). */
  union?(familyId: string): Span | undefined;
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
  /** Blood paths: generations from A up to the common ancestor and down to B. */
  generations?: [number, number];
}

export interface Relationship {
  /** English name of what A is to B: "2nd cousin once removed", "sister-in-law". */
  name: string;
  kind: 'self' | 'blood' | 'marriage';
  /** Paths that give this name, at most `maxPaths` (more than one with pedigree collapse). */
  paths: RelationshipPath[];
  /** All paths found, before `maxPaths`. */
  pathCount: number;
  /** Blood only: the most recent common ancestors (a couple, or one person when half). */
  commonAncestors?: string[];
  /** Blood only: generations from A and from B up to the common ancestors. */
  generations?: [number, number];
  half?: boolean;
}

export interface RelationshipResult {
  a: string;
  b: string;
  /**
   * Closest first, at most `maxRelationships`; empty when unrelated. A one-line
   * label such as the person page header should use `relationships[0].name`.
   */
  relationships: Relationship[];
  /** All relationships found, before `maxRelationships`. */
  relationshipCount: number;
  /**
   * Names joined, e.g. "2nd cousin and also 3rd cousin 1x removed", ending
   * "and N more" past `maxRelationships`; "unrelated" when none.
   */
  name: string;
  /**
   * False when a search bound (`maxGenerations`, `maxNodes`) stopped the
   * walk or output was trimmed: "unrelated" then means "none found".
   */
  complete: boolean;
}

export interface RelationshipOptions {
  /** Generations searched above each person. Default 20. */
  maxGenerations?: number;
  /** People visited before giving up on a marriage path. Default 50,000. */
  maxNodes?: number;
  /** Marriages allowed on a non-blood path. Default 2 ("wife's brother's wife"). */
  maxMarriages?: number;
  /** Paths returned per relationship. Default 8. */
  maxPaths?: number;
  /** Relationships returned. Default 4. */
  maxRelationships?: number;
  /**
   * `ancestry` (default) matches Ancestry.com: "granduncle", "grandniece",
   * "1st cousin 1x removed", "half-sister". `formal`: "great-uncle",
   * "great-niece", "1st cousin once removed", "half-sister".
   */
  style?: 'ancestry' | 'formal';
}
