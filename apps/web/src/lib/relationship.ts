import { chartPath, fromNeighborhood, kinshipGraph, relationship } from '@open-ancestry/core';
import type { RelationshipResult } from '@open-ancestry/core';
import type { Neighborhood } from '../api/types';
import { fullName } from './person';

/*
 * Relationship to the home person, from two ancestor slices (home's and the
 * person's), named by the core calculator. Spouses are recognized by the
 * caller from the person detail, since the slices hold ancestors only.
 */

export type ChartRole = 'person' | 'between' | 'common-ancestor' | 'home';

export interface PathCell {
  /** A person id, or a `family:` stand-in for a family with no recorded parents. */
  id: string;
  row: number;
  col: number;
  role: ChartRole;
  /** How this person relates to the previous one on the path (none for the first). */
  step?: 'parent' | 'child' | 'spouse';
}

export interface PathOption {
  /** e.g. `1st cousin through Silas Ashdown`, unique within the list. */
  label: string;
  cells: PathCell[];
}

export interface HomeRelationship {
  /**
   * Every relationship found, lowercase, ready for ` of <home name>`:
   * `1st cousin`, or `2nd cousin and also 3rd cousin 1x removed` with pedigree collapse.
   */
  name: string;
  /** One chart per connecting path, closest relationship first. */
  paths: PathOption[];
}

function compute(home: Neighborhood, person: Neighborhood): RelationshipResult {
  const graph = kinshipGraph(
    fromNeighborhood({
      people: [...home.people, ...person.people],
      families: [...home.families, ...person.families],
      children: [...home.children, ...person.children],
      moreUp: [],
      moreDown: [],
    }),
  );
  return relationship(graph, person.focusId, home.focusId);
}

/** Name of `person.focusId` relative to `home.focusId`, or null when no blood link is found. */
export function describeRelationship(home: Neighborhood, person: Neighborhood): string | null {
  const result = compute(home, person);
  return result.relationships.length ? result.name : null;
}

/** The relationships and their chart paths, or null for the home person or no blood link. */
export function relationshipPath(
  home: Neighborhood,
  person: Neighborhood,
): HomeRelationship | null {
  if (home.focusId === person.focusId) return null;
  const result = compute(home, person);
  if (!result.relationships.length) return null;
  const people = new Map([...home.people, ...person.people].map((p) => [p.id, p]));
  const nameOf = (id: string) => {
    const p = people.get(id);
    return p ? fullName(p) : 'unknown parents';
  };
  const paths = result.relationships.flatMap((found) =>
    found.paths.map((path, k): PathOption => {
      // The highest person on a blood path is where its two lines meet.
      const top = new Set(path.generations ? [path.ids[path.generations[0]]!] : []);
      const last = path.ids.length - 1;
      const cells = chartPath(path).map((cell, i): PathCell => {
        const role: ChartRole =
          i === 0
            ? 'person'
            : i === last
              ? 'home'
              : top.has(cell.id)
                ? 'common-ancestor'
                : 'between';
        const out: PathCell = { ...cell, role };
        if (i > 0) out.step = path.steps[i - 1]!.kind;
        return out;
      });
      const through = [...top].map(nameOf).join(' and ');
      const line = found.paths.length > 1 ? ` (line ${k + 1})` : '';
      return { label: `${found.name}${through ? ` through ${through}` : ''}${line}`, cells };
    }),
  );
  return { name: result.name, paths };
}
