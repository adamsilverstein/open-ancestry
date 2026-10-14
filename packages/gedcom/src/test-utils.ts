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

/**
 * CPU milliseconds `fn` takes in this worker. Budgets in tests use CPU, not
 * wall time, which swings with whatever else the machine is running.
 */
export function cpuMs(fn: () => unknown): number {
  const start = process.cpuUsage();
  fn();
  const { user, system } = process.cpuUsage(start);
  return (user + system) / 1000;
}
