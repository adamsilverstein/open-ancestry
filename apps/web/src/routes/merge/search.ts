export interface MergeSearch {
  keep?: string;
  other?: string;
}

const ID = /^[0-9A-Za-z_-]{1,64}$/;

export function validateMergeSearch(search: Record<string, unknown>): MergeSearch {
  const pick = (value: unknown) =>
    typeof value === 'string' && ID.test(value) ? value : undefined;
  const keep = pick(search.keep);
  const other = pick(search.other);
  return { ...(keep ? { keep } : {}), ...(other ? { other } : {}) };
}
