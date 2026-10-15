import { chartPath } from '@open-ancestry/core';
import type { ChildRelation, Relationship, RelationshipPath } from '@open-ancestry/core';
import type { ApiPersonSummary, RelationshipView } from '../api/types';
import type {
  RelationshipChartCell,
  RelationshipChartPath,
} from '../components/RelationshipChart/RelationshipChart';
import { fullName, toPersonSummary } from './person';

/*
 * Charts and labels for a server relationship result
 * (`GET /api/trees/:tree/relationship`): one mini chart per connecting path.
 */

export interface RelationshipCharts {
  /**
   * Every relationship found, lowercase, ready for ` of <name>`:
   * `1st cousin`, `aunt and also mother-in-law`. Null when unrelated.
   */
  name: string | null;
  /** One chart per connecting path, closest relationship first. */
  charts: RelationshipChartPath[];
}

/** The highest person on a blood path, where its two lines meet. */
const top = (path: RelationshipPath) =>
  path.generations ? path.ids[path.generations[0]] : undefined;

/** The first person below the common ancestor on A's side and on B's side. */
function sides(path: RelationshipPath): [string | undefined, string | undefined] {
  if (!path.generations) return [undefined, undefined];
  const [up, down] = path.generations;
  return [up > 0 ? path.ids[up - 1] : undefined, down > 0 ? path.ids[up + 1] : undefined];
}

/**
 * Labels for the paths of one relationship. With several paths (pedigree
 * collapse) each names the line it takes: the child of the common ancestor
 * on the side where the paths differ ("through Josiah Ashgrove"). A single
 * blood path names its common ancestor unless that is one of the two people.
 */
function labels(found: Relationship, nameOf: (id: string) => string): string[] {
  const { paths } = found;
  const [a, b] = [paths[0]!.ids[0]!, paths[0]!.ids.at(-1)!];
  const through = (id: string | undefined) =>
    id && id !== a && id !== b ? `${found.name} through ${nameOf(id)}` : found.name;
  if (paths.length === 1) return [through(top(paths[0]!))];
  const differ = (pick: (p: RelationshipPath) => string | undefined) =>
    new Set(paths.map(pick)).size === paths.length;
  const pick = [
    (p: RelationshipPath) => sides(p)[0],
    (p: RelationshipPath) => sides(p)[1],
    top,
  ].find(differ);
  const out = paths.map((p) => through(pick?.(p)));
  // Still the same (no single side tells them apart): number them.
  return new Set(out).size === out.length ? out : out.map((l, i) => `${l} (path ${i + 1})`);
}

export function relationshipCharts(view: RelationshipView): RelationshipCharts {
  if (!view.relationships.length) return { name: null, charts: [] };
  const people = new Map(view.people.map((p: ApiPersonSummary) => [p.id, p]));
  const nameOf = (id: string) => {
    const p = people.get(id);
    return p ? fullName(p) : 'unknown parents';
  };
  const charts = view.relationships.flatMap((found) => {
    const names = labels(found, nameOf);
    return found.paths.map((path, k): RelationshipChartPath => {
      const peak = top(path);
      const last = path.ids.length - 1;
      const cells = chartPath(path).map((cell, i): RelationshipChartCell => {
        const person = people.get(cell.id);
        const out: RelationshipChartCell = {
          row: cell.row,
          col: cell.col,
          person: person ? toPersonSummary(person) : null,
          role:
            i === 0
              ? 'person'
              : i === last
                ? 'home'
                : cell.id === peak
                  ? 'common-ancestor'
                  : 'between',
        };
        const step = i > 0 ? path.steps[i - 1] : undefined;
        if (step) {
          out.step = step.kind;
          if (step.rel) out.rel = step.rel as ChildRelation;
        }
        return out;
      });
      return { label: names[k]!, cells };
    });
  });
  return { name: view.name, charts };
}
