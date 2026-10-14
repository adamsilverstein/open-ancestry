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
 * which is named as in-law, step, "by marriage" or a possessive chain
 * ("husband’s sister’s husband").
 */
import {
  APOSTROPHE,
  bloodName,
  isAncestor,
  isCousin,
  isDescendant,
  relativeOfSpouse,
  spouseOfRelative,
  spouseWord,
  stepSiblingWord,
} from './names';
import type { Modifier, Shape } from './names';
import type {
  KinshipGraph,
  PathStep,
  Relationship,
  RelationshipOptions,
  RelationshipPath,
  RelationshipResult,
} from './types';
import type { ChildRelation } from '../layout/types';

interface Arrival {
  id: string;
  depth: number;
  /** From the start person up to `id`. */
  path: string[];
  steps: PathStep[];
  /** Family of the last link, into `id`. */
  family?: string;
  /** Every link is biological (or unknown). */
  bio: boolean;
}

const BIO = new Set<ChildRelation>(['biological', 'unknown']);

const modifierOf = (rel: ChildRelation | undefined): Modifier =>
  rel === 'step' || rel === 'adopted' || rel === 'foster' ? rel : undefined;

/** Ancestors of `start` by depth, each reached once per depth and child. */
function ancestors(g: KinshipGraph, start: string, maxGenerations: number, maxNodes: number) {
  const found = new Map<string, Arrival[]>();
  const first: Arrival = { id: start, depth: 0, path: [start], steps: [], bio: true };
  found.set(start, [first]);
  let frontier = [first];
  let count = 1;
  for (let depth = 1; depth <= maxGenerations && frontier.length && count < maxNodes; depth++) {
    const next: Arrival[] = [];
    for (const arrival of frontier) {
      for (const parent of g.parents(arrival.id)) {
        // A person can't be their own ancestor on one path (cyclic data).
        if (arrival.path.includes(parent.id)) continue;
        const list = found.get(parent.id) ?? [];
        const child = arrival.id;
        if (list.some((a) => a.depth === depth && a.path.at(-2) === child)) continue;
        const reached: Arrival = {
          id: parent.id,
          depth,
          path: [...arrival.path, parent.id],
          steps: [...arrival.steps, { kind: 'parent', rel: parent.rel }],
          family: parent.familyId,
          bio: arrival.bio && BIO.has(parent.rel),
        };
        list.push(reached);
        found.set(parent.id, list);
        next.push(reached);
        count++;
      }
    }
    frontier = next;
  }
  return found;
}

interface Line {
  a: Arrival;
  b: Arrival;
}

function joinPath(a: Arrival, b: Arrival): RelationshipPath {
  const down = b.steps.map((s): PathStep => ({ kind: 'child', rel: s.rel! })).reverse();
  return { ids: [...a.path, ...b.path.slice(0, -1).reverse()], steps: [...a.steps, ...down] };
}

function bloodRelationships(
  g: KinshipGraph,
  a: string,
  b: string,
  maxGenerations: number,
  maxNodes: number,
): Relationship[] {
  const fromA = ancestors(g, a, maxGenerations, maxNodes);
  const fromB = ancestors(g, b, maxGenerations, maxNodes);
  // Pairs of lines meeting only at their top, grouped by the lines below it:
  // the partners of one couple share both lines.
  const groups = new Map<string, Line[]>();
  for (const [id, arrivalsA] of fromA) {
    const arrivalsB = fromB.get(id);
    if (!arrivalsB) continue;
    for (const x of arrivalsA) {
      const below = new Set(x.path.slice(0, -1));
      for (const y of arrivalsB) {
        if (y.path.slice(0, -1).some((p) => below.has(p))) continue;
        const key = `${x.path.slice(0, -1).join(',')}|${y.path.slice(0, -1).join(',')}`;
        const lines = groups.get(key);
        if (lines) lines.push({ a: x, b: y });
        else groups.set(key, [{ a: x, b: y }]);
      }
    }
  }

  const named = [...groups.values()].map((lines) => {
    const shape: Shape = { up: lines[0]!.a.depth, down: lines[0]!.b.depth };
    const bio = lines.filter((l) => l.a.bio && l.b.bio);
    const main = bio[0] ?? lines[0]!;
    let half = false;
    if (shape.up > 0 && shape.down > 0) {
      const sameFamily = main.a.family === main.b.family;
      // A family with one known parent still makes full siblings.
      const childA = main.a.path.at(-2)!;
      const parents = g.parents(childA).filter((p) => p.familyId === main.a.family).length;
      half = bio.length ? !(sameFamily && (bio.length >= 2 || parents === 1)) : !sameFamily;
    }
    const modifier = bio.length ? undefined : modifierOf(firstNonBio(joinPath(main.a, main.b)));
    return {
      lines,
      shape,
      half,
      name: bloodName(shape, g.sex(a), half, modifier),
      path: joinPath(main.a, main.b),
    };
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
    });
  }
  // Two separate cousin relationships of one degree are "double" cousins.
  for (const r of byName.values()) {
    const [up, down] = r.generations!;
    if (r.paths.length === 2 && isCousin({ up, down })) r.name = `double ${r.name}`;
  }
  return [...byName.values()];
}

function firstNonBio(path: RelationshipPath): ChildRelation | undefined {
  return path.steps.find((s) => s.rel !== undefined && !BIO.has(s.rel))?.rel;
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
): RelationshipPath | undefined {
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
  if (!found) return undefined;

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
  return { ids, steps };
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
function runName(g: KinshipGraph, run: Segment): { shape: Shape; name: string } {
  const up = run.steps.filter((s) => s.kind === 'parent').length;
  const shape: Shape = { up, down: run.steps.length - up };
  let half = false;
  if (shape.up > 0 && shape.down > 0) {
    const top = run.ids[up]!;
    const familyInto = (child: string) => g.parents(child).find((p) => p.id === top)?.familyId;
    half = familyInto(run.ids[up - 1]!) !== familyInto(run.ids[up + 1]!);
  }
  const modifier = modifierOf(run.steps.find((s) => s.rel && !BIO.has(s.rel))?.rel);
  return { shape, name: bloodName(shape, g.sex(run.ids[0]!), half, modifier) };
}

function marriageName(g: KinshipGraph, path: RelationshipPath): string {
  const { blood, spouses } = segments(path);
  const partner = (i: number) =>
    g.partners(path.ids[i]!).find((p) => p.id === path.ids[i + 1])?.relationship;
  const single = (parts: Segment[]) => (parts.length === 1 ? parts[0]! : undefined);
  const empty = (parts: Segment[]) => parts.length === 1 && parts[0]!.steps.length === 0;

  if (spouses.length === 1) {
    const at = spouses[0]!;
    const [near, far] = [blood[0]!, blood[1]!];
    const nearRun = single(near);
    const farRun = single(far);
    // A is the spouse of B's relative.
    if (empty(near) && farRun) {
      const { shape, name } = runName(g, farRun);
      return spouseOfRelative(shape, name, g.sex(path.ids[0]!), partner(at));
    }
    // A is a relative of B's spouse.
    if (empty(far) && nearRun) {
      const { shape, name } = runName(g, nearRun);
      const spouse = spouseWord(g.sex(path.ids[at]!), partner(at));
      return relativeOfSpouse(shape, name, g.sex(path.ids[0]!), spouse);
    }
    // A's parent married B's parent.
    if (nearRun && farRun) {
      const x = runName(g, nearRun).shape;
      const y = runName(g, farRun).shape;
      if (isDescendant(x) && x.up === 1 && isAncestor(y) && y.down === 1) {
        return stepSiblingWord(g.sex(path.ids[0]!));
      }
    }
  }

  // Possessive chain from B: "husband’s sister’s husband".
  const words: string[] = [];
  for (let k = blood.length - 1; k >= 0; k--) {
    for (const run of [...blood[k]!].reverse()) {
      if (run.steps.length) words.push(runName(g, run).name);
    }
    if (k > 0) {
      const at = spouses[k - 1]!;
      words.push(spouseWord(g.sex(path.ids[at]!), partner(at)));
    }
  }
  return words.join(APOSTROPHE);
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
  const maxMarriages = options.maxMarriages ?? 2;
  const result = (relationships: Relationship[]): RelationshipResult => ({
    a,
    b,
    relationships,
    name: relationships.length ? relationships.map((r) => r.name).join(' and also ') : 'unrelated',
  });
  if (g.sex(a) === undefined || g.sex(b) === undefined) return result([]);

  const found: Relationship[] = [];
  const spouse = g.partners(a).find((p) => p.id === b);
  if (spouse) {
    found.push({
      name: spouseWord(g.sex(a), spouse.relationship),
      kind: 'marriage',
      paths: [{ ids: [a, b], steps: [{ kind: 'spouse' }] }],
    });
  }
  found.push(...bloodRelationships(g, a, b, maxGenerations, maxNodes));
  if (found.length) return result(found);

  const path = marriagePath(g, a, b, maxMarriages, 2 * maxGenerations + maxMarriages, maxNodes);
  if (!path) return result([]);
  return result([{ name: marriageName(g, path), kind: 'marriage', paths: [path] }]);
}
