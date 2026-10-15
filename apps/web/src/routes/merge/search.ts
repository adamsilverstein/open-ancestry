export interface MergeSearch {
  keep?: string;
  other?: string;
}

const ID = /^[0-9A-Za-z_-]{1,64}$/;

export function validateMergeSearch(search: Record<string, unknown>): MergeSearch {
  const pick = (value: unknown) =>
    typeof value === 'string' && ID.test(value) ? value : undefined;
  // Both set, undefined when invalid: TanStack Router merges this over the raw search.
  return { keep: pick(search.keep), other: pick(search.other) };
}
