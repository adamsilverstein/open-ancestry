/**
 * Adapter from the db package's `getNeighborhood` result to a `TreeGraph`.
 * core cannot depend on db, so the input is described structurally here; the
 * db `Neighborhood` type satisfies it.
 */
import { formatLifespan, lifeDate } from '../dates';
import type {
  ChildRelation,
  PartnerRelationship,
  Sex,
  TreeFamily,
  TreeGraph,
  TreePerson,
} from './types';

export interface NeighborhoodPerson {
  id: string;
  sex: Sex;
  /** db `LivingStatus`: 'dead' and 'inferred_dead' are deceased, anything else living. */
  living: string;
  given: string | null;
  surname: string | null;
  prefix?: string | null;
  suffix?: string | null;
  surnamePrefix?: string | null;
  birth: {
    dateSort: number | null;
    dateQualifier?: string | null;
    dateText?: string | null;
  } | null;
  death: {
    dateSort: number | null;
    dateQualifier?: string | null;
    dateText?: string | null;
  } | null;
}

export interface NeighborhoodInput {
  people: NeighborhoodPerson[];
  families: {
    id: string;
    partner1Id: string | null;
    partner2Id: string | null;
    relationshipType: PartnerRelationship;
    partner1Order: number;
    partner2Order: number;
  }[];
  children: {
    familyId: string;
    childId: string;
    partner1Rel: ChildRelation;
    partner2Rel: ChildRelation;
    sortOrder: number;
    childOrder: number;
    isPreferred: boolean;
  }[];
  moreUp: string[];
  moreDown: string[];
}

export function fromNeighborhood(result: NeighborhoodInput): TreeGraph {
  const up = new Set(result.moreUp);
  const down = new Set(result.moreDown);
  const people = new Map<string, TreePerson>();
  for (const p of result.people) {
    const living = p.living !== 'dead' && p.living !== 'inferred_dead';
    const name = [p.prefix, p.given, p.surnamePrefix, p.surname, p.suffix]
      .filter((part) => part)
      .join(' ');
    const person: TreePerson = { id: p.id, sex: p.sex, name, living };
    // The shared formatter, so cards keep qualifiers like every other view.
    const span = formatLifespan({
      birth: lifeDate(p.birth),
      death: lifeDate(p.death),
      living: living && !p.death?.dateSort,
    });
    if (span) person.lifespan = span;
    if (p.birth?.dateSort) person.birthSortKey = p.birth.dateSort;
    if (up.has(p.id)) person.hasMoreParents = true;
    if (down.has(p.id)) person.hasMoreChildren = true;
    people.set(p.id, person);
  }

  const children = new Map<string, NeighborhoodInput['children']>();
  for (const c of result.children) {
    const list = children.get(c.familyId);
    if (list) list.push(c);
    else children.set(c.familyId, [c]);
  }
  const families = result.families.map((f): TreeFamily => ({
    id: f.id,
    partners: [f.partner1Id, f.partner2Id],
    partnerOrder: [f.partner1Order, f.partner2Order],
    relationship: f.relationshipType,
    children: (children.get(f.id) ?? [])
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((c) => ({
        id: c.childId,
        rel1: c.partner1Rel,
        rel2: c.partner2Rel,
        preferred: c.isPreferred,
        order: c.childOrder,
      })),
  }));
  return { people, families };
}
