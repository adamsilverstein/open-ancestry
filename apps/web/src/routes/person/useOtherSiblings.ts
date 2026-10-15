import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { personQuery } from '../../api/queries';
import type { PersonDetail } from '../../api/types';
import type { Sibling } from '../../lib/kin';
import { otherSiblings, parentIds } from '../../lib/otherSiblings';

const NONE: Sibling[] = [];

/** All parent details, or null until every one has loaded. Module level so the result is memoized. */
const allDetails = (results: { data?: PersonDetail | undefined }[]) =>
  results.every((r) => r.data) ? results.map((r) => r.data as PersonDetail) : null;

/**
 * Siblings from the parents' other partnerships, which only the parents' own
 * details carry; they load after the page renders.
 */
export function useOtherSiblings(tree: string, detail: PersonDetail): Sibling[] {
  const parents = useQueries({
    queries: parentIds(detail).map((id) => personQuery(tree, id)),
    combine: allDetails,
  });
  return useMemo(() => (parents ? otherSiblings(detail, parents) : NONE), [detail, parents]);
}
