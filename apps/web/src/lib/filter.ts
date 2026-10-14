/** cmdk filter: case-insensitive substring match on the value and keywords. */
export function substringFilter(value: string, search: string, keywords?: string[]): number {
  const haystack = [value, ...(keywords ?? [])].join(' ').toLowerCase();
  return haystack.includes(search.trim().toLowerCase()) ? 1 : 0;
}

/**
 * Command palette actions: the query must start the label ("swi" finds
 * "Switch to dark theme") or contain a whole keyword ("dark"), so typing a
 * name like "the" never lands on an action by accident. Returns 0.5 for a
 * match so people results (scored 1) rank above actions.
 */
export function actionFilter(label: string, search: string, keywords: string[] = []): number {
  const query = search.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!query) return 0.5;
  if (label.toLowerCase().startsWith(query)) return 0.5;
  const words = query.split(' ');
  const hit = keywords.some((keyword) => {
    const k = keyword.toLowerCase();
    return words.includes(k) || query.startsWith(`${k} `) || query === k;
  });
  return hit ? 0.5 : 0;
}
