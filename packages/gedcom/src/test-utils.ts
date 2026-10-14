import type { GedcomNode } from './types';

export interface Projected {
  level: number;
  tag: string;
  xref?: string;
  pointer?: string;
  value?: string;
  children: Projected[];
}

/** The meaning of a tree without source positions or raw text, for round-trip comparisons. */
export function project(nodes: GedcomNode[]): Projected[] {
  return nodes.map((n) => ({
    level: n.level,
    tag: n.tag,
    ...(n.xref !== undefined && { xref: n.xref }),
    ...(n.pointer !== undefined && { pointer: n.pointer }),
    ...(n.value !== undefined && { value: n.value }),
    children: project(n.children),
  }));
}
