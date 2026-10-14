/** cmdk filter: case-insensitive substring match on the value and keywords. */
export function substringFilter(value: string, search: string, keywords?: string[]): number {
  const haystack = [value, ...(keywords ?? [])].join(' ').toLowerCase();
  return haystack.includes(search.trim().toLowerCase()) ? 1 : 0;
}
