import type { TagColor } from './person';

/** The eight tag tokens (`--oa-tag-1..8`) with names for the color picker. */
export const TAG_COLORS: { color: TagColor; name: string }[] = [
  { color: 1, name: 'Teal' },
  { color: 2, name: 'Blue' },
  { color: 3, name: 'Violet' },
  { color: 4, name: 'Magenta' },
  { color: 5, name: 'Red' },
  { color: 6, name: 'Amber' },
  { color: 7, name: 'Green' },
  { color: 8, name: 'Slate' },
];

/**
 * A tag's palette color: its stored `tag-N`, else a stable pick from its id
 * (imported tags have none).
 */
export function tagColor(tag: { id: string; color: string | null }): TagColor {
  const match = /^tag-([1-8])$/.exec(tag.color ?? '');
  if (match) return Number(match[1]) as TagColor;
  let hash = 0;
  for (const ch of tag.id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return ((hash % 8) + 1) as TagColor;
}
