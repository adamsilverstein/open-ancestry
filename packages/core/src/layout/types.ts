/**
 * Input and output contract of the tree layout engines. The server builds a
 * `TreeGraph` slice from the database; the web app runs the layout in a Web
 * Worker, so every type here is plain data that survives structured clone.
 */

export type Sex = 'M' | 'F' | 'X' | 'U';

/** Parent-child relationship types, as stored in `family_child`. */
export type ChildRelation =
  'biological' | 'adopted' | 'step' | 'foster' | 'related' | 'guardian' | 'private' | 'unknown';

export interface TreePerson {
  id: string;
  sex: Sex;
  /** Display fields; the layout passes them through to the renderer untouched. */
  name: string;
  lifespan?: string;
  living: boolean;
  /** The slice stops here but the database has parents to lazy-load on expand. */
  hasMoreParents?: boolean;
  /** The slice stops here but the database has spouses or children to lazy-load. */
  hasMoreChildren?: boolean;
}

export interface TreeFamilyChild {
  id: string;
  /** Relationship to partners[0] and partners[1]; missing means 'unknown'. */
  rel1?: ChildRelation;
  rel2?: ChildRelation;
}

export interface TreeFamily {
  id: string;
  /** Either partner may be unknown. Ids missing from `people` are treated as unknown. */
  partners: readonly [string | null, string | null];
  /** In display order (the server sorts by birth). */
  children: readonly TreeFamilyChild[];
}

export interface TreeGraph {
  people: ReadonlyMap<string, TreePerson> | Readonly<Record<string, TreePerson>>;
  families: readonly TreeFamily[];
}

export type ExpandDirection = 'up' | 'down';

/** `${personId}:up` or `${personId}:down`; build with `expandKey`. */
export type ExpandKey = `${string}:${ExpandDirection}`;

export interface CardSize {
  width: number;
  height: number;
}

export interface LayoutGaps {
  /** Between cards of different couples or subtrees in one generation. */
  sibling: number;
  /** Between partners. */
  couple: number;
  /** Between generations; edges and sibling bars are drawn in this space. */
  generation: number;
}

export interface LayoutOptions {
  /** Generations shown above the focus person. Default 3. */
  ancestorsDepth?: number;
  /** Generations shown below the focus person. Default 2. */
  descendantsDepth?: number;
  /** Extra generations an `expanded` chevron reveals. Default 2. */
  expandGenerations?: number;
  expanded?: Iterable<ExpandKey>;
  /** Wins over `expanded` and the depth limits. */
  collapsed?: Iterable<ExpandKey>;
  /** Parent set to show per person, from the switcher; otherwise biological first. */
  selectedParentFamilies?: Readonly<Record<string, string>>;
  /** Default 120x150 (PersonCard `regular`). */
  cardSize?: CardSize;
  gaps?: Partial<LayoutGaps>;
}

export interface LayoutNode {
  /** Unique per layout. The person id for the first card of a person, `${id}~n` for duplicates. */
  key: string;
  personId: string;
  /** Top-left corner. The focus card is always at (0, 0). */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Relative to the focus person: -1 parents, 0 focus and spouses, 1 children. */
  generation: number;
  isFocus: boolean;
  /** Pedigree collapse: this person is already shown at `duplicateOf`. */
  isDuplicate: boolean;
  duplicateOf?: string;
  canExpandUp: boolean;
  canExpandDown: boolean;
  canCollapseUp: boolean;
  canCollapseDown: boolean;
}

export type Point = [number, number];

export type EdgeKind = 'couple' | 'parent-child' | 'sibling-bar';

export interface LayoutEdge {
  kind: EdgeKind;
  familyId: string;
  /** Edges drawn for one family occurrence share a group. */
  group: string;
  points: Point[];
  /** Partner keys of a couple edge or of the drop from the parents. */
  parents?: string[];
  /** Child key of the drop into a child card. */
  child?: string;
  rel?: ChildRelation;
}

export interface GenerationLabel {
  generation: number;
  text: string;
  x: number;
  y: number;
  /**
   * Which point of the text box sits at (x, y). Family and descendant views
   * use a left gutter (`right-middle`); the pedigree heads each column
   * (`bottom-left`).
   */
  anchor: 'right-middle' | 'bottom-left';
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

export interface ParentFamilyChoice {
  selected: string;
  /** Every parent family of the person, in graph order. */
  families: string[];
}

export interface TreeLayout {
  focusKey: string | null;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  labels: GenerationLabel[];
  /** Card bounds; labels sit outside them. */
  bounds: Bounds;
  /** Shown people with more than one parent set, for the switcher. */
  alternateParentFamilies: Record<string, ParentFamilyChoice>;
}

export interface FanOptions {
  /** Rings including the focus person. Default 6. */
  generations?: number;
  /** Radius of the focus disc. Default 60. */
  innerRadius?: number;
  /** Width of each ancestor ring. Default 70. */
  ringWidth?: number;
  /** Total angle in radians, centred on 12 o'clock. Default PI (half circle). */
  sweep?: number;
  collapsed?: Iterable<ExpandKey>;
  selectedParentFamilies?: Readonly<Record<string, string>>;
}

/**
 * One ring segment. Angles are radians in screen space (y down): 0 points
 * right and angles grow clockwise, so 3*PI/2 is straight up. The fan centre is
 * the origin.
 */
export interface FanSegment {
  key: string;
  personId: string;
  generation: number;
  /** Ahnentafel number: focus 1, father 2n, mother 2n+1. */
  ahnentafel: number;
  startAngle: number;
  endAngle: number;
  innerRadius: number;
  outerRadius: number;
  isFocus: boolean;
  isDuplicate: boolean;
  duplicateOf?: string;
}

export interface FanLayout {
  focusKey: string | null;
  segments: FanSegment[];
  bounds: Bounds;
  alternateParentFamilies: Record<string, ParentFamilyChoice>;
}
