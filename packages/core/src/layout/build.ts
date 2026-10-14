/**
 * Turns a graph slice into tidy units: walks ancestors and descendants
 * breadth first from the focus person, applying depth limits and
 * expand/collapse, and records which families need edges. A person reached a
 * second time becomes a duplicate card that is never walked again, which
 * handles pedigree collapse and keeps cyclic data finite.
 */
import { chooseParentFamily, childRelation, coupleOrder, spouseOf } from './graph';
import type { GraphIndex } from './graph';
import type { TidyUnit } from './tidy';
import type {
  ChildRelation,
  ExpandDirection,
  ExpandKey,
  LayoutOptions,
  ParentFamilyChoice,
} from './types';

export type Role = 'focus' | 'spouse' | 'ancestor' | 'descendant' | 'descendant-spouse';

export interface Card {
  key: string;
  personId: string;
  role: Role;
  generation: number;
  dupOf?: string;
  parentsShown: boolean;
  childrenShown: boolean;
  x: number;
  y: number;
}

export interface Unit extends TidyUnit {
  cards: Card[];
  groups: { anchors: number[]; children: Unit[]; rootGap: number }[];
}

/** A family drawn once: its parent cards above its child cards. */
export interface FamilyLink {
  familyId: string;
  parents: Card[];
  children: { card: Card; rel: ChildRelation }[];
}

export interface Settings {
  ancestorsDepth: number;
  descendantsDepth: number;
  expandGenerations: number;
  expanded: ReadonlySet<string>;
  collapsed: ReadonlySet<string>;
  selected: Readonly<Record<string, string>>;
}

export function expandKey(personId: string, direction: ExpandDirection): ExpandKey {
  return `${personId}:${direction}`;
}

const depth = (n: number | undefined, fallback: number) =>
  n === undefined || Number.isNaN(n) ? fallback : Math.max(0, n);

export function settingsFrom(
  opts: Pick<
    LayoutOptions,
    | 'ancestorsDepth'
    | 'descendantsDepth'
    | 'expandGenerations'
    | 'expanded'
    | 'collapsed'
    | 'selectedParentFamilies'
  >,
  defaults: { ancestorsDepth: number; descendantsDepth: number },
): Settings {
  return {
    ancestorsDepth: depth(opts.ancestorsDepth, defaults.ancestorsDepth),
    descendantsDepth: depth(opts.descendantsDepth, defaults.descendantsDepth),
    expandGenerations: depth(opts.expandGenerations, 2),
    expanded: new Set(opts.expanded ?? []),
    collapsed: new Set(opts.collapsed ?? []),
    selected: opts.selectedParentFamilies ?? {},
  };
}

interface Pending {
  unit: Unit;
  base: number;
}

export class Builder {
  readonly cards: Card[] = [];
  readonly links: FamilyLink[] = [];
  readonly alternates: Record<string, ParentFamilyChoice> = {};
  private readonly primary = new Map<string, string>();
  private readonly dupCount = new Map<string, number>();

  readonly index: GraphIndex;
  readonly s: Settings;

  constructor(index: GraphIndex, settings: Settings) {
    this.index = index;
    this.s = settings;
  }

  /** Generations to show from `personId` in `direction`, after expand and collapse. */
  budget(personId: string, direction: ExpandDirection, base: number): number {
    const key = expandKey(personId, direction);
    if (this.s.collapsed.has(key)) return 0;
    if (this.s.expanded.has(key)) return Math.max(base, this.s.expandGenerations);
    return base;
  }

  card(personId: string, role: Role, generation: number): Card {
    const card: Card = {
      key: personId,
      personId,
      role,
      generation,
      parentsShown: false,
      childrenShown: false,
      x: 0,
      y: 0,
    };
    const first = this.primary.get(personId);
    if (first === undefined) {
      this.primary.set(personId, personId);
    } else {
      const n = (this.dupCount.get(personId) ?? 0) + 1;
      this.dupCount.set(personId, n);
      card.key = `${personId}~${n}`;
      card.dupOf = first;
    }
    this.cards.push(card);
    return card;
  }

  unit(cards: Card[], level: number): Unit {
    return { cards, size: cards.length, anchor: 0, level, groups: [], x: 0, rel: 0 };
  }

  /**
   * Hangs the parents of `unit.cards[cardIndex]` above it when `budget`
   * allows. Returns the new parent units to walk further.
   */
  addParents(unit: Unit, cardIndex: number, budget: number, rootGap: number): Pending[] {
    const card = unit.cards[cardIndex]!;
    if (card.dupOf !== undefined) return [];
    const family = chooseParentFamily(this.index, card.personId, this.s.selected);
    if (!family) return [];
    const all = this.index.parentFamilies(card.personId);
    if (all.length > 1) {
      this.alternates[card.personId] = { selected: family.id, families: all.map((f) => f.id) };
    }
    if (budget <= 0) return [];
    card.parentsShown = true;
    const parents = coupleOrder(this.index, family).map((id) =>
      this.card(id, 'ancestor', card.generation - 1),
    );
    const units = parents.map((p) => this.unit([p], unit.level + 1));
    unit.groups.push({ anchors: [cardIndex], children: units, rootGap });
    this.links.push({
      familyId: family.id,
      parents,
      children: [{ card, rel: childRelation(family, card.personId) }],
    });
    return units.map((u) => ({ unit: u, base: budget - 1 }));
  }

  /** Walks the ancestor units in `queue` breadth first, appending new ones. */
  growAncestors(queue: Pending[], rootGap: number): Unit[] {
    for (let i = 0; i < queue.length; i++) {
      const { unit, base } = queue[i]!;
      const card = unit.cards[0]!;
      queue.push(...this.addParents(unit, 0, this.budget(card.personId, 'up', base), rootGap));
    }
    return queue.map((p) => p.unit);
  }

  /**
   * Adds the spouses of `unit.cards[0]` to its block and their children as
   * groups below. Spouses are shown when children could be, or always for the
   * focus person. Returns the child units to walk further.
   */
  addFamilies(unit: Unit, budget: number, isFocus: boolean, rootGap: number): Pending[] {
    const person = unit.cards[0]!;
    if (person.dupOf !== undefined || (budget <= 0 && !isFocus)) return [];
    const families = this.index.partnerFamilies(person.personId);
    if (families.length === 0) return [];

    const spouseIds: string[] = [];
    for (const f of families) {
      const id = spouseOf(this.index, f, person.personId);
      if (id !== null && !spouseIds.includes(id)) spouseIds.push(id);
    }
    const spouseRole: Role = isFocus ? 'spouse' : 'descendant-spouse';
    const spouses = spouseIds.map((id) => this.card(id, spouseRole, person.generation));
    // One spouse goes on the husband's side; with more, the first is on the
    // left and the rest on the right so the first two couples stay adjacent.
    let cards: Card[];
    if (spouses.length === 1) {
      const wifeFirst =
        this.index.person(person.personId)!.sex === 'F' &&
        this.index.person(spouses[0]!.personId)!.sex === 'M';
      cards = wifeFirst ? [spouses[0]!, person] : [person, spouses[0]!];
    } else if (spouses.length > 1) {
      cards = [spouses[0]!, person, ...spouses.slice(1)];
    } else {
      cards = [person];
    }
    unit.cards = cards;
    unit.size = cards.length;
    unit.anchor = cards.indexOf(person);
    // The focus person's spouses show regardless, so only children count as shown.
    person.childrenShown =
      budget > 0 && (!isFocus || families.some((f) => this.index.children(f).length > 0));

    const pending: Pending[] = [];
    const groups: { mid: number; group: Unit['groups'][number] }[] = [];
    for (const family of families) {
      const spouseId = spouseOf(this.index, family, person.personId);
      const spouse = spouseId === null ? undefined : spouses[spouseIds.indexOf(spouseId)];
      const anchors = spouse ? [unit.anchor, cards.indexOf(spouse)] : [unit.anchor];
      const children =
        budget > 0
          ? this.index.children(family).map((id) => ({
              card: this.card(id, 'descendant', person.generation + 1),
              rel: childRelation(family, id),
            }))
          : [];
      this.links.push({
        familyId: family.id,
        parents: spouse ? [person, spouse] : [person],
        children,
      });
      if (children.length === 0) continue;
      const units = children.map((c) => this.unit([c.card], unit.level + 1));
      for (const u of units) pending.push({ unit: u, base: budget - 1 });
      const mid = anchors.reduce((a, b) => a + b, 0) / anchors.length;
      groups.push({ mid, group: { anchors, children: units, rootGap } });
    }
    // Order groups like their couples so connectors do not cross; stable for ties.
    groups.sort((a, b) => a.mid - b.mid);
    unit.groups = groups.map((g) => g.group);
    return pending;
  }

  /** Walks the descendant units in `queue` breadth first, appending new ones. */
  growDescendants(queue: Pending[], rootGap: number): Unit[] {
    for (let i = 0; i < queue.length; i++) {
      const { unit, base } = queue[i]!;
      const card = unit.cards[0]!;
      const budget = this.budget(card.personId, 'down', base);
      queue.push(...this.addFamilies(unit, budget, false, rootGap));
    }
    return queue.map((p) => p.unit);
  }
}
