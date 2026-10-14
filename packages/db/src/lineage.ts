import type { TreeStore } from './store';

/** Deepest ancestor walk; trees are far shallower, and a loop in an imported file stops here. */
const MAX_GENERATIONS = 200;

/**
 * Generations from `ancestorId` down to `descendantId` by the shortest line
 * (1 for a parent, 2 for a grandparent), or null when `ancestorId` is not an
 * ancestor. Every parent family counts, preferred or not.
 */
export function ancestorGenerations(
  store: TreeStore,
  ancestorId: string,
  descendantId: string,
): number | null {
  const depth = store
    .stmt(
      `WITH RECURSIVE up(id, depth) AS (
         SELECT @descendant, 0
         UNION
         SELECT CASE k.slot WHEN 1 THEN f.partner1_id ELSE f.partner2_id END, up.depth + 1
         FROM up
         JOIN family_child fc ON fc.child_id = up.id
         JOIN family f ON f.id = fc.family_id
         CROSS JOIN (SELECT 1 AS slot UNION ALL SELECT 2) k
         WHERE up.depth < @max AND up.id <> @ancestor
       )
       SELECT MIN(depth) FROM up WHERE id = @ancestor AND depth > 0`,
    )
    .pluck()
    .get({ ancestor: ancestorId, descendant: descendantId, max: MAX_GENERATIONS }) as number | null;
  return depth ?? null;
}

/**
 * Whether making `parentId` a parent of `childId` would make someone their
 * own ancestor (#95): the parent is the child, or one of the child's
 * descendants. Pedigree collapse (cousins marrying) is not a cycle.
 */
export function wouldCreateCycle(store: TreeStore, parentId: string, childId: string): boolean {
  return parentId === childId || ancestorGenerations(store, childId, parentId) !== null;
}
