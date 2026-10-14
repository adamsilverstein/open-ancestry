import { chartPath, fromNeighborhood, kinshipGraph, relationship } from '@open-ancestry/core';
import type { Neighborhood } from '../api/types';

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
}

export interface HomeRelationship {
  /** Lowercase, e.g. `1st cousin 1x removed`, ready for ` of <home name>`. */
  name: string;
  /** The closest path, from the person to home, laid out for the mini chart. */
  cells: PathCell[];
}

function closest(home: Neighborhood, person: Neighborhood) {
  const graph = kinshipGraph(
    fromNeighborhood({
      people: [...home.people, ...person.people],
      families: [...home.families, ...person.families],
      children: [...home.children, ...person.children],
      moreUp: [],
      moreDown: [],
    }),
  );
  return relationship(graph, person.focusId, home.focusId).relationships[0];
}

/** Name of `person.focusId` relative to `home.focusId`, or null when no blood link is found. */
export function describeRelationship(home: Neighborhood, person: Neighborhood): string | null {
  return closest(home, person)?.name ?? null;
}

/** The relationship and its chart cells, or null for the home person or no blood link. */
export function relationshipPath(
  home: Neighborhood,
  person: Neighborhood,
): HomeRelationship | null {
  if (home.focusId === person.focusId) return null;
  const found = closest(home, person);
  const path = found?.paths[0];
  if (!found || !path) return null;
  const top = new Set(found.commonAncestors);
  const last = path.ids.length - 1;
  const cells = chartPath(path).map((cell, i): PathCell => {
    const role: ChartRole =
      i === 0 ? 'person' : i === last ? 'home' : top.has(cell.id) ? 'common-ancestor' : 'between';
    return { ...cell, role };
  });
  return { name: found.name, cells };
}
