/**
 * Any-to-any relationship calculator.
 *
 * Blood first: walk the ancestors of A and of B generation by generation
 * (bounded, cycle-safe), and keep every common ancestor C whose two paths
 * meet only at C. Each such pair of lines is one relationship, named from
 * the generations up from A and down to B; partners reached by the same two
 * lines form the couple, one alone means "half". Pedigree collapse yields
 * several pairs, so several names ("2nd cousin and also 3rd cousin once
 * removed") or several paths for one name ("double 1st cousin").
 *
 *            C (common ancestor)
 *          /   \
 *   up 2  P     Q  down 2
 *        /       \
 *       A         B     A is B's 1st cousin (min - 1 = 1, removed |2 - 2| = 0)
 *
 * Without a blood relationship, a breadth-first search over parent, child
 * and partner links finds the shortest path with at least one marriage,
 * which is named as in-law, step, "by marriage" or a chain of relationships
 * ("husband’s sister’s husband").
 */
import {
  ancestorWord,
  bloodName,
  chain,
  descendantWord,
  isAncestor,
  isCousin,
  isDescendant,
  relativeOfSpouse,
  spouseOfRelative,
  spouseWord,
  stepSiblingWord,
} from './names';
import type { Modifier, NameStyle, Shape } from './names';
import type {
  KinshipGraph,
  PathStep,
  Relationship,
  RelationshipOptions,
  RelationshipPath,
  RelationshipResult,
  Span,
} from './types';
import { isVirtualParent } from './graph';
import { isBirthParent, lineQualifier, parentLink } from '../kin';

interface Arrival {
  id: string;
  depth: number;
  /** From the start person up to `id`. */
  path: string[];
  steps: PathStep[];
  /** Every link is biological (or unknown). */
  bio: boolean;
}

/** Alternative lines kept per ancestor, depth and child, for pedigree collapse. */
const LINES_PER_CHILD = 4;

/**
 * The name change for the first non-biological link: "adopted" when it is
 * on A's side of the common ancestor (A was adopted), "adoptive" on B's.
 */
function modifierOf(path: RelationshipPath, up: number): Modifier {
  const rels = path.steps.map((s) => s.rel);
  const adopted = rels.findIndex((rel) => parentLink(rel) === 'adoptive');
  return lineQualifier(rels, adopted < up ? 'adopted' : 'adoptive');
}

/**
 * Ancestors of `start` by depth. A person reached through the same child at
 * the same depth by several lines keeps a few of them, so a line that runs
 * into B's can be replaced by one that does not.
 */
function ancestors(g: KinshipGraph, start: string, maxGenerations: number, maxNodes: number) {
  const found = new Map<string, Arrival[]>();
  const first: Arrival = { id: start, depth: 0, path: [start], steps: [], bio: true };
  found.set(start, [first]);
  const parents: Arrival[] = [];
  let frontier = [first];
  let count = 1;
  let depth = 1;
  for (; depth <= maxGenerations && frontier.length && count < maxNodes; depth++) {
    const next: Arrival[] = [];
    for (const arrival of frontier) {
      for (const parent of g.parents(arrival.id)) {
        // A person can't be their own ancestor on one path (cyclic data).
        if (arrival.path.includes(parent.id)) continue;
        const list = found.get(parent.id) ?? [];
        const child = arrival.id;
        const same = list.filter((a) => a.depth === depth && a.path.at(-2) === child).length;
        if (same >= LINES_PER_CHILD) continue;
        const reached: Arrival = {
          id: parent.id,
          depth,
          path: [...arrival.path, parent.id],
          steps: [...arrival.steps, { kind: 'parent', rel: parent.rel }],
          bio: arrival.bio && isBirthParent(parent.rel),
        };
        list.push(reached);
        found.set(parent.id, list);
        if (depth === 1) parents.push(reached);
        next.push(reached);
        count++;
      }
    }
    frontier = next;
  }
  // Stopped early with people still to walk.
  const cut = frontier.length > 0 && (count >= maxNodes || depth > maxGenerations);
  return { found, parents, cut: cut && frontier.some((a) => g.parents(a.id).length > 0) };
}

interface Line {
  a: Arrival;
  b: Arrival;
}

function joinPath(a: Arrival, b: Arrival): RelationshipPath {
  const down = b.steps.map((s): PathStep => ({ kind: 'child', rel: s.rel! })).reverse();
  return {
    ids: [...a.path, ...b.path.slice(0, -1).reverse()],
    steps: [...a.steps, ...down],
    generations: [a.depth, b.depth],
  };
}

/** Recorded parent ids of `child` (not parentless-family stand-ins), biological only when `bio`. */
function parentSet(g: KinshipGraph, child: string, bio: boolean): Set<string> {
  return new Set(
    g
      .parents(child)
      .filter((p) => (!bio || isBirthParent(p.rel)) && !isVirtualParent(p.id))
      .map((p) => p.id),
  );
}

/**
 * Half when the two children below the common ancestor have different
 * recorded parents. Compared by person, not family record, so duplicate
 * family records for one couple stay full, and a lone recorded parent is
 * full. A child with no recorded parents (only a parentless family) gives
 * nothing to compare, so the siblings count as full.
 */
function isHalf(g: KinshipGraph, childA: string, childB: string, bio: boolean): boolean {
  const pa = parentSet(g, childA, bio);
  const pb = parentSet(g, childB, bio);
  if (pa.size === 0 || pb.size === 0) return false;
  return pa.size !== pb.size || [...pa].some((p) => !pb.has(p));
}

/** The ancestors of one person: walked fresh, or from a calculator's cache. */
/** Ancestor walk of `id`, `generations` deep (default: the query's maxGenerations). */
type Walk = (id: string, generations?: number) => ReturnType<typeof ancestors>;

function bloodRelationships(
  g: KinshipGraph,
  a: string,
  b: string,
  walk: Walk,
  style: NameStyle,
): { relationships: Relationship[]; cut: boolean } {
  const fromA = walk(a);
  const fromB = walk(b);
  // Pairs of lines meeting only at their top, grouped by the lines below it:
  // the partners of one couple share both lines.
  const groups = new Map<string, Line[]>();
  for (const [id, arrivalsA] of fromA.found) {
    const arrivalsB = fromB.found.get(id);
    if (!arrivalsB) continue;
    for (const x of arrivalsA) {
      const below = new Set(x.path.slice(0, -1));
      for (const y of arrivalsB) {
        if (y.path.slice(0, -1).some((p) => below.has(p))) continue;
        const key = `${x.path.slice(0, -1).join(',')}|${y.path.slice(0, -1).join(',')}`;
        const lines = groups.get(key);
        if (!lines) groups.set(key, [{ a: x, b: y }]);
        else if (!lines.some((l) => l.a.id === id)) lines.push({ a: x, b: y });
      }
    }
  }

  const named = [...groups.values()].map((lines) => {
    const shape: Shape = { up: lines[0]!.a.depth, down: lines[0]!.b.depth };
    const bio = lines.filter((l) => l.a.bio && l.b.bio);
    const main = bio[0] ?? lines[0]!;
    const path = joinPath(main.a, main.b);
    const collateral = shape.up > 0 && shape.down > 0;
    const half = collateral && isHalf(g, main.a.path.at(-2)!, main.b.path.at(-2)!, bio.length > 0);
    const modifier = bio.length ? undefined : modifierOf(path, shape.up);
    return { lines, shape, half, name: bloodName(shape, g.sex(a), half, modifier, style), path };
  });
  named.sort(
    (x, y) => x.shape.up + x.shape.down - (y.shape.up + y.shape.down) || x.shape.up - y.shape.up,
  );

  const byName = new Map<string, Relationship>();
  for (const n of named) {
    const existing = byName.get(n.name);
    if (existing) {
      existing.paths.push(n.path);
      continue;
    }
    byName.set(n.name, {
      name: n.name,
      kind: n.shape.up === 0 && n.shape.down === 0 ? 'self' : 'blood',
      paths: [n.path],
      commonAncestors: n.lines.map((l) => l.a.id),
      generations: [n.shape.up, n.shape.down],
      half: n.half,
      pathCount: 1,
    });
  }
  // Two separate cousin relationships of the same shape are "double" cousins.
  for (const r of byName.values()) {
    const [up, down] = r.generations!;
    const same = r.paths.filter((p) => p.generations![0] === up && p.generations![1] === down);
    if (same.length === 2 && isCousin({ up, down })) r.name = `double ${r.name}`;
  }
  return { relationships: [...byName.values()], cut: fromA.cut || fromB.cut };
}

interface SearchState {
  id: string;
  marriages: number;
  depth: number;
  /** Towards the side's start person. */
  prev?: SearchState;
  /** The link between this person and `prev`, read in the A-to-B direction. */
  step?: PathStep;
}

/**
 * Shortest path from `a` to `b` using at least one and at most
 * `maxMarriages` marriages: a bidirectional breadth-first search over
 * (person, marriages used) states, growing the smaller side a whole layer at
 * a time and stopping at the layer where the two sides first meet.
 */
function marriagePath(
  g: KinshipGraph,
  a: string,
  b: string,
  maxMarriages: number,
  maxDepth: number,
  maxNodes: number,
): { path?: RelationshipPath; cut: boolean } {
  type Side = Map<string, SearchState[]>;
  const forward: Side = new Map([[a, [{ id: a, marriages: 0, depth: 0 }]]]);
  const backward: Side = new Map([[b, [{ id: b, marriages: 0, depth: 0 }]]]);
  let frontF = forward.get(a)!;
  let frontB = backward.get(b)!;
  let visited = 2;

  const meet = (state: SearchState, other: Side, best: [SearchState, SearchState] | undefined) => {
    for (const o of other.get(state.id) ?? []) {
      const marriages = state.marriages + o.marriages;
      if (marriages < 1 || marriages > maxMarriages) continue;
      if (!best || state.depth + o.depth < best[0].depth + best[1].depth)
        return [state, o] as const;
    }
    return best;
  };
  // Both sides start at depth 0, so check the start (a === b is handled earlier).
  let found: readonly [SearchState, SearchState] | undefined;
  for (let depth = 0; depth < maxDepth && frontF.length && frontB.length; depth++) {
    const isForward = frontF.length <= frontB.length;
    const [side, other, front] = isForward
      ? [forward, backward, frontF]
      : [backward, forward, frontB];
    const next: SearchState[] = [];
    let best: [SearchState, SearchState] | undefined;
    const visit = (from: SearchState, id: string, step: PathStep, marriages: number) => {
      if (marriages > maxMarriages) return;
      const list = side.get(id) ?? [];
      if (list.some((x) => x.marriages === marriages)) return;
      const state: SearchState = { id, marriages, depth: from.depth + 1, prev: from, step };
      list.push(state);
      side.set(id, list);
      next.push(state);
      visited++;
      const m = meet(state, other, best);
      if (m) best = m as [SearchState, SearchState];
    };
    for (const state of front) {
      // Steps are recorded in the A-to-B direction: walking backward from B,
      // reaching a parent p means the path goes p -> child -> state.
      for (const p of g.parents(state.id)) {
        visit(state, p.id, { kind: isForward ? 'parent' : 'child', rel: p.rel }, state.marriages);
      }
      for (const c of g.children(state.id)) {
        visit(state, c.id, { kind: isForward ? 'child' : 'parent', rel: c.rel }, state.marriages);
      }
      for (const s of g.partners(state.id)) {
        visit(state, s.id, { kind: 'spouse' }, state.marriages + 1);
      }
    }
    if (best) {
      found = isForward ? best : [best[1], best[0]];
      break;
    }
    if (isForward) frontF = next;
    else frontB = next;
    if (visited >= maxNodes) break;
  }
  // Both sides still had people to visit: a bound stopped the search.
  if (!found) return { cut: frontF.length > 0 && frontB.length > 0 };

  const ids: string[] = [];
  const steps: PathStep[] = [];
  for (let s: SearchState | undefined = found[0]; s; s = s.prev) {
    ids.unshift(s.id);
    if (s.step) steps.unshift(s.step);
  }
  for (let s: SearchState | undefined = found[1]; s?.prev; s = s.prev) {
    ids.push(s.prev.id);
    steps.push(s.step!);
  }
  return { path: { ids, steps }, cut: false };
}

interface Segment {
  ids: string[];
  steps: PathStep[];
}

/** Splits a path at its marriages, then each part into up-then-down runs. */
function segments(path: RelationshipPath): { blood: Segment[][]; spouses: number[] } {
  const blood: Segment[][] = [];
  const spouses: number[] = [];
  let start = 0;
  for (let i = 0; i <= path.steps.length; i++) {
    if (i < path.steps.length && path.steps[i]!.kind !== 'spouse') continue;
    blood.push(peaks({ ids: path.ids.slice(start, i + 1), steps: path.steps.slice(start, i) }));
    if (i < path.steps.length) spouses.push(i);
    start = i + 1;
  }
  return { blood, spouses };
}

/** Up-then-down runs: a down step followed by an up step starts a new run. */
function peaks(segment: Segment): Segment[] {
  const runs: Segment[] = [];
  let start = 0;
  for (let i = 1; i <= segment.steps.length; i++) {
    const turn =
      i < segment.steps.length &&
      segment.steps[i - 1]!.kind === 'child' &&
      segment.steps[i]!.kind === 'parent';
    if (!turn && i < segment.steps.length) continue;
    runs.push({ ids: segment.ids.slice(start, i + 1), steps: segment.steps.slice(start, i) });
    start = i;
  }
  return runs.length ? runs : [segment];
}

/** A single up-then-down run named as what its first person is to its last. */
function runName(g: KinshipGraph, run: Segment, style: NameStyle): { shape: Shape; name: string } {
  const up = run.steps.filter((s) => s.kind === 'parent').length;
  const shape: Shape = { up, down: run.steps.length - up };
  const bio = run.steps.every((s) => !s.rel || isBirthParent(s.rel));
  const half = shape.up > 0 && shape.down > 0 && isHalf(g, run.ids[up - 1]!, run.ids[up + 1]!, bio);
  const modifier = bio ? undefined : modifierOf(run, up);
  return { shape, name: bloodName(shape, g.sex(run.ids[0]!), half, modifier, style) };
}

/** The part of `path` from `ids[from]` to B. */
const slice = (path: RelationshipPath, from: number): RelationshipPath => ({
  ids: path.ids.slice(from),
  steps: path.steps.slice(from),
});

/** Whether a union and a life share any time; unknown dates count as overlapping. */
function overlaps(union: Span | undefined, life: Span | undefined): boolean {
  if (!union || !life) return true;
  if (union.end !== undefined && life.start !== undefined && union.end < life.start) return false;
  if (union.start !== undefined && life.end !== undefined && union.start > life.end) return false;
  return true;
}

function marriageName(g: KinshipGraph, path: RelationshipPath, style: NameStyle): string {
  const { blood, spouses } = segments(path);
  const edge = (i: number) => g.partners(path.ids[i]!).find((p) => p.id === path.ids[i + 1]);
  const partner = (i: number) => edge(i)?.relationship;
  /** Did the marriage at step `i` overlap the lives of all of `people`? */
  const during = (i: number, ...people: string[]) => {
    const familyId = edge(i)?.familyId;
    const union = familyId ? g.union?.(familyId) : undefined;
    return people.every((id) => overlaps(union, g.lifespan?.(id)));
  };
  const [first, last] = [path.ids[0]!, path.ids.at(-1)!];
  const single = (parts: Segment[]) => (parts.length === 1 ? parts[0]! : undefined);
  const empty = (parts: Segment[]) => parts.length === 1 && parts[0]!.steps.length === 0;

  if (spouses.length === 1) {
    const at = spouses[0]!;
    const [near, far] = [blood[0]!, blood[1]!];
    const nearRun = single(near);
    const farRun = single(far);
    // A is the spouse of B's relative.
    if (empty(near) && farRun) {
      const { shape, name } = runName(g, farRun, style);
      const step = during(at, last);
      return spouseOfRelative(shape, name, g.sex(path.ids[0]!), partner(at), style, step);
    }
    // A is a relative of B's spouse.
    if (empty(far) && nearRun) {
      const { shape, name } = runName(g, nearRun, style);
      const spouse = spouseWord(g.sex(path.ids[at]!), partner(at));
      const step = during(at, first);
      return relativeOfSpouse(shape, name, g.sex(path.ids[0]!), spouse, style, step);
    }
    if (nearRun && farRun) {
      const x = runName(g, nearRun, style).shape;
      const y = runName(g, farRun, style).shape;
      const sex = g.sex(path.ids[0]!);
      // A's parent married B's parent.
      if (
        isDescendant(x) &&
        x.up === 1 &&
        isAncestor(y) &&
        y.down === 1 &&
        during(at, first, last)
      ) {
        return stepSiblingWord(sex);
      }
      // A is an ancestor of B's step-parent: step-grandmother.
      if (isAncestor(x) && isAncestor(y) && y.down === 1) {
        return `step-${ancestorWord(x.down + 1, sex)}`;
      }
      // A's parent married a descendant of B: step-granddaughter.
      if (isDescendant(x) && x.up === 1 && isDescendant(y)) {
        return `step-${descendantWord(y.up + 1, sex)}`;
      }
    }
  }

  if (spouses.length >= 2) {
    // Name the path from the first marriage on, then A's link to it:
    // "stepmother’s husband", "sister-in-law’s husband".
    const at = spouses[0]!;
    const near = blood[0]!;
    const nearRun = single(near);
    if (empty(near)) {
      const rest = marriageName(g, slice(path, at + 1), style);
      return chain([rest, spouseWord(g.sex(path.ids[0]!), partner(at))], style);
    }
    if (nearRun) {
      const rest = marriageName(g, slice(path, at), style);
      return chain([rest, runName(g, nearRun, style).name], style);
    }
  }

  // A chain from B: "husband’s sister’s husband" / "husband of sister of husband".
  const words: string[] = [];
  for (let k = blood.length - 1; k >= 0; k--) {
    for (const run of [...blood[k]!].reverse()) {
      if (run.steps.length) words.push(runName(g, run, style).name);
    }
    if (k > 0) {
      const at = spouses[k - 1]!;
      words.push(spouseWord(g.sex(path.ids[at]!), partner(at)));
    }
  }
  return chain(words, style);
}

/**
 * Parent, child (a few generations) and sibling paths from x to y, found
 * cheaply from the two ancestor walks and shared parents.
 */
function nearPaths(g: KinshipGraph, x: string, y: string, walkX: Walk, walkY: Walk) {
  const self = (id: string): Arrival => ({ id, depth: 0, path: [id], steps: [], bio: true });
  const paths: RelationshipPath[] = [];
  const up = walkX(x).found.get(y)?.[0];
  if (up && up.depth > 0) paths.push(joinPath(up, self(y)));
  const down = walkY(y).found.get(x)?.[0];
  if (down && down.depth > 0) paths.push(joinPath(self(x), down));
  for (const px of walkX(x).parents) {
    const py = walkY(y).parents.find((p) => p.id === px.id);
    if (!py || x === y) continue;
    paths.push({
      ids: [x, px.id, y],
      steps: [
        { kind: 'parent', rel: px.steps[0]!.rel },
        { kind: 'child', rel: py.steps[0]!.rel },
      ],
      generations: [1, 1],
    });
    break;
  }
  return paths;
}

/** Generations searched above a partner for in-law names beside a blood tie. */
const IN_LAW_GENERATIONS = 3;

/**
 * In-law names beside a blood or spouse relationship ("niece and also
 * daughter-in-law", "aunt and also mother-in-law"): A a parent, child or
 * sibling of B's partner, or the partner of B's parent, child or sibling.
 * A step name that only restates a blood tie (a son is not also a stepson)
 * is left out.
 */
function inLaws(
  g: KinshipGraph,
  a: string,
  b: string,
  walk: Walk,
  style: NameStyle,
  known: Relationship[],
): Relationship[] {
  const out: Relationship[] = [];
  const near: Walk = (id) => walk(id, IN_LAW_GENERATIONS);
  // "stepson", "adopted son" and "son" are one tie, named once.
  const base = (name: string) => name.replace(/^(?:step-?|adopted |adoptive |foster |half-)/, '');
  const taken = new Set(known.map((r) => base(r.name)));
  const add = (path: RelationshipPath) => {
    const plain = { ids: path.ids, steps: path.steps };
    const name = marriageName(g, plain, style);
    if (taken.has(base(name))) return;
    taken.add(base(name));
    out.push({ name, kind: 'marriage', paths: [plain], pathCount: 1 });
  };
  for (const s of g.partners(b)) {
    if (s.id === a) continue;
    for (const p of nearPaths(g, a, s.id, walk, near)) {
      add({ ids: [...p.ids, b], steps: [...p.steps, { kind: 'spouse' }] });
    }
  }
  for (const s of g.partners(a)) {
    if (s.id === b) continue;
    for (const p of nearPaths(g, s.id, b, near, walk)) {
      add({ ids: [a, ...p.ids], steps: [{ kind: 'spouse' }, ...p.steps] });
    }
  }
  return out;
}

/** What A is to B, with every connecting path. */
export function relationship(
  g: KinshipGraph,
  a: string,
  b: string,
  options: RelationshipOptions = {},
): RelationshipResult {
  const maxGenerations = options.maxGenerations ?? 20;
  const maxNodes = options.maxNodes ?? 50_000;
  return compute(g, a, b, options, (id, generations = maxGenerations) =>
    ancestors(g, id, generations, maxNodes),
  );
}

export interface CalculatorOptions extends RelationshipOptions {
  /** People whose ancestor walks are kept, least recently used dropped first. Default 512. */
  cacheSize?: number;
}

/**
 * `relationship()` for many queries over one unchanging graph, such as "what
 * is everyone to the home person": each person's ancestor walk is cached,
 * so repeated people cost only the comparison. Make a new calculator when
 * the graph changes.
 */
export function relationshipCalculator(g: KinshipGraph, defaults: CalculatorOptions = {}) {
  const cacheSize = defaults.cacheSize ?? 512;
  const cache = new Map<string, ReturnType<typeof ancestors>>();
  return (a: string, b: string, options: RelationshipOptions = {}): RelationshipResult => {
    const merged = { ...defaults, ...options };
    const maxGenerations = merged.maxGenerations ?? 20;
    const maxNodes = merged.maxNodes ?? 50_000;
    const walk: Walk = (id, generations = maxGenerations) => {
      const key = `${id}|${generations}|${maxNodes}`;
      let found = cache.get(key);
      if (found) {
        cache.delete(key);
      } else {
        found = ancestors(g, id, generations, maxNodes);
        if (cache.size >= cacheSize) cache.delete(cache.keys().next().value!);
      }
      cache.set(key, found);
      return found;
    };
    return compute(g, a, b, merged, walk);
  };
}

function compute(
  g: KinshipGraph,
  a: string,
  b: string,
  options: RelationshipOptions,
  walk: Walk,
): RelationshipResult {
  const maxGenerations = options.maxGenerations ?? 20;
  const maxNodes = options.maxNodes ?? 50_000;
  const maxMarriages = options.maxMarriages ?? 2;
  const maxPaths = options.maxPaths ?? 8;
  const maxRelationships = options.maxRelationships ?? 4;
  const style = options.style ?? 'ancestry';
  const result = (all: Relationship[], cut: boolean): RelationshipResult => {
    const relationships = all.slice(0, maxRelationships).map((r) => ({
      ...r,
      pathCount: r.paths.length,
      paths: r.paths.slice(0, maxPaths),
    }));
    let name = relationships.length
      ? relationships.map((r) => r.name).join(' and also ')
      : 'unrelated';
    const more = all.length - relationships.length;
    if (more > 0) name += ` and ${more} more`;
    const trimmed = more > 0 || relationships.some((r) => r.pathCount > r.paths.length);
    return {
      a,
      b,
      relationships,
      relationshipCount: all.length,
      name,
      complete: !cut && !trimmed,
    };
  };
  if (g.sex(a) === undefined || g.sex(b) === undefined) return result([], false);

  const found: Relationship[] = [];
  const spouse = g.partners(a).find((p) => p.id === b);
  if (spouse) {
    found.push({
      name: spouseWord(g.sex(a), spouse.relationship),
      kind: 'marriage',
      paths: [{ ids: [a, b], steps: [{ kind: 'spouse' }] }],
      pathCount: 1,
    });
  }
  const walks = new Map<string, ReturnType<Walk>>();
  const once: Walk = (id, generations) => {
    const key = `${id}|${generations ?? ''}`;
    let w = walks.get(key);
    if (!w) walks.set(key, (w = walk(id, generations)));
    return w;
  };
  const blood = bloodRelationships(g, a, b, once, style);
  found.push(...blood.relationships);
  if (found.length) {
    return result([...found, ...inLaws(g, a, b, once, style, found)], blood.cut);
  }

  const search = marriagePath(g, a, b, maxMarriages, 2 * maxGenerations + maxMarriages, maxNodes);
  if (!search.path) return result([], blood.cut || search.cut);
  const named: Relationship = {
    name: marriageName(g, search.path, style),
    kind: 'marriage',
    paths: [search.path],
    pathCount: 1,
  };
  return result([named], blood.cut);
}
