import type { Neighborhood } from '../api/types';

/*
 * TODO(#15): switch to the packages/core relationship calculator once it lands
 * and delete this file; the header only needs a label from two ancestor slices.
 *
 * Relationship to the home person from two ancestor slices (home's and the
 * person's), by their nearest common ancestors. Blood relationships only;
 * spouses are recognized by the caller from the person detail.
 */

type Sex = string;

export function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

const word = (sex: Sex, male: string, female: string, other: string) =>
  sex === 'M' ? male : sex === 'F' ? female : other;

/** `great-` prefixes for `extra` extra generations: great-, 2nd great-, ... */
function greats(extra: number): string {
  if (extra <= 0) return '';
  return extra === 1 ? 'great-' : `${ordinal(extra)} great-`;
}

/**
 * Name of the person relative to home, where the nearest common ancestor is
 * `up` generations above home and `down` generations above the person.
 */
export function relationshipName(up: number, down: number, sex: Sex, half = false): string {
  const h = half ? 'half ' : '';
  if (up === 0 && down === 0) return 'self';
  if (down === 0) {
    const base = word(sex, 'father', 'mother', 'parent');
    if (up === 1) return base;
    return `${greats(up - 2)}grand${base}`;
  }
  if (up === 0) {
    const base = word(sex, 'son', 'daughter', 'child');
    if (down === 1) return base;
    return `${greats(down - 2)}grand${base}`;
  }
  if (up === 1 && down === 1) return h + word(sex, 'brother', 'sister', 'sibling');
  if (up === 1) {
    const base = word(sex, 'nephew', 'niece', 'sibling’s child');
    if (down === 2) return h + base;
    return `${h}${greats(down - 3)}grand${base}`;
  }
  if (down === 1) {
    // Ancestry wording: a grandparent's sibling is a granduncle, not a great-uncle.
    const base = word(sex, 'uncle', 'aunt', 'parent’s sibling');
    if (up === 2) return h + base;
    return `${h}${greats(up - 3)}grand${base}`;
  }
  const degree = Math.min(up, down) - 1;
  const removed = Math.abs(up - down);
  return `${h}${ordinal(degree)} cousin${removed ? ` ${removed}x removed` : ''}`;
}

interface Ancestor {
  /** Generations above the slice focus. */
  depth: number;
  /** Family through which the ancestor was first reached (its child's parent family). */
  via: string | null;
}

/** Each ancestor of the slice focus (focus included at depth 0), nearest path first. */
export function ancestors(slice: Neighborhood): Map<string, Ancestor> {
  const parentFamilies = new Map<string, string[]>();
  const families = new Map(slice.families.map((f) => [f.id, f]));
  for (const edge of slice.children) {
    parentFamilies.set(edge.childId, [...(parentFamilies.get(edge.childId) ?? []), edge.familyId]);
  }
  const found = new Map<string, Ancestor>([[slice.focusId, { depth: 0, via: null }]]);
  let frontier = [slice.focusId];
  for (let depth = 1; frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const familyId of parentFamilies.get(id) ?? []) {
        const family = families.get(familyId);
        for (const parent of [family?.partner1Id, family?.partner2Id]) {
          if (!parent || found.has(parent)) continue;
          found.set(parent, { depth, via: familyId });
          next.push(parent);
        }
      }
    }
    frontier = next;
  }
  return found;
}

/**
 * Relationship of `person.focusId` to `home.focusId`, given each one's
 * ancestor slice, or null when they share no ancestor in the slices.
 */
export function describeRelationship(home: Neighborhood, person: Neighborhood): string | null {
  const homeAncestors = ancestors(home);
  const personAncestors = ancestors(person);
  let best: { up: number; down: number; half: boolean } | null = null;
  for (const [id, fromHome] of homeAncestors) {
    const fromPerson = personAncestors.get(id);
    if (!fromPerson) continue;
    if (best && fromHome.depth + fromPerson.depth >= best.up + best.down) continue;
    best = {
      up: fromHome.depth,
      down: fromPerson.depth,
      // Lines that meet through different families of the ancestor are half relations.
      half: fromHome.via !== null && fromPerson.via !== null && fromHome.via !== fromPerson.via,
    };
  }
  if (!best) return null;
  const sex = person.people.find((p) => p.id === person.focusId)?.sex ?? 'U';
  return relationshipName(best.up, best.down, sex, best.half);
}
