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
  PartnerRelationship,
} from './types';

export type Role =
  | 'focus'
  | 'spouse'
  | 'ancestor'
  | 'descendant'
  | 'descendant-spouse'
  | 'sibling'
  | 'sibling-spouse';

/** Where a direct-line person's siblings go: left of a father, right of a mother. */
export type Side = 'left' | 'right' | 'center';

export interface SiblingEntry {
  card: Card;
  rel: ChildRelation;
  half: boolean;
}

export interface Card {
  key: string;
  personId: string;
  role: Role;
  generation: number;
  dupOf?: string;
  parentsShown: boolean;
  childrenShown: boolean;
  siblingsShown: boolean;
  /** A middle spouse under another couple's lane: its parents are never shown. */
  upBlocked?: boolean;
  /** Shown siblings of a direct-line person, birth ordered. */
  siblings?: SiblingEntry[];
  half?: boolean;
  x: number;
  y: number;
}

export interface Unit extends TidyUnit {
  cards: Card[];
  /** Families hung from this block share it, so their connectors route together. */
  block: number;
  groups: { anchors: number[]; children: Unit[]; rootGap: number }[];
}

/** A family drawn once: its parent cards above its child cards. */
export interface FamilyLink {
  familyId: string;
  /** The block's own person first, then their partner. */
  parents: Card[];
  children: { card: Card; rel: ChildRelation; half?: boolean }[];
  /** Families of one block share a number so their connectors can be routed together. */
  block: number;
  relationship?: PartnerRelationship;
}

export interface Settings {
  ancestorsDepth: number;
  descendantsDepth: number;
  expandGenerations: number;
  siblingsDepth: number;
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
    | 'siblingsDepth'
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
    siblingsDepth: depth(opts.siblingsDepth, 2),
    expanded: new Set(opts.expanded ?? []),
    collapsed: new Set(opts.collapsed ?? []),
    selected: opts.selectedParentFamilies ?? {},
  };
}

interface Pending {
  unit: Unit;
  base: number;
  side: Side;
}

interface SiblingCandidate {
  id: string;
  rel: ChildRelation;
  half: boolean;
  self: boolean;
}

export class Builder {
  readonly cards: Card[] = [];
  readonly links: FamilyLink[] = [];
  private blocks = 0;
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
      siblingsShown: false,
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
    return {
      cards,
      size: cards.length,
      anchor: 0,
      level,
      groups: [],
      x: 0,
      rel: 0,
      block: this.blocks++,
    };
  }

  /**
   * Hangs the parents of `unit.cards[cardIndex]` above it and its shown
   * siblings when `budget` allows, and records the family so the sibling bar
   * is drawn even without parents. Returns the new parent units to walk.
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
    const kids = [
      { card, rel: childRelation(this.index, family, card.personId), half: false },
      ...(card.siblings ?? []),
    ];
    let parents: Card[] = [];
    let pending: Pending[] = [];
    if (budget > 0) {
      card.parentsShown = true;
      parents = coupleOrder(this.index, family).map((id) =>
        this.card(id, 'ancestor', card.generation - 1),
      );
      const units = parents.map((p) => this.unit([p], unit.level + 1));
      const anchors = kids.map((k) => unit.cards.indexOf(k.card));
      unit.groups.push({ anchors, children: units, rootGap });
      const sides: Side[] = units.length === 2 ? ['left', 'right'] : ['center'];
      pending = units.map((u, i) => ({ unit: u, base: budget - 1, side: sides[i]! }));
    }
    if (parents.length > 0 || kids.length > 1) {
      this.links.push({
        familyId: family.id,
        parents,
        children: kids,
        block: unit.block,
        relationship: family.relationship,
      });
    }
    return pending;
  }

  /** Walks the ancestor units in `queue` breadth first, appending new ones. */
  growAncestors(queue: Pending[], rootGap: number, withSiblings: boolean): Unit[] {
    for (let i = 0; i < queue.length; i++) {
      const { unit, base, side } = queue[i]!;
      const card = unit.cards[0]!;
      if (withSiblings) this.addSiblings(unit, side);
      const budget = this.budget(card.personId, 'up', base);
      queue.push(...this.addParents(unit, unit.anchor, budget, rootGap));
    }
    return queue.map((p) => p.unit);
  }

  showSiblings(card: Card): boolean {
    const key = expandKey(card.personId, 'siblings');
    if (this.s.collapsed.has(key)) return false;
    return this.s.expanded.has(key) || -card.generation < this.s.siblingsDepth;
  }

  /**
   * Full siblings in family order with the person themselves (`self`), then
   * half siblings: other children of either parent with someone else.
   */
  siblingCandidates(personId: string): SiblingCandidate[] {
    const family = chooseParentFamily(this.index, personId, this.s.selected);
    if (!family) return [];
    const seen = new Set<string>();
    const out: SiblingCandidate[] = [];
    const add = (f: typeof family, half: boolean) => {
      for (const id of this.index.children(f)) {
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, rel: childRelation(this.index, f, id), half, self: id === personId });
      }
    };
    add(family, false);
    for (const parent of this.index.partners(family)) {
      if (parent === null) continue;
      for (const f of this.index.partnerFamilies(parent)) if (f !== family) add(f, true);
    }
    return out;
  }

  /**
   * Puts the siblings of the block's anchor person (with their spouses) into
   * the block: left of a father, right of a mother, otherwise in birth order
   * around the person. Shifts existing group anchors to match.
   */
  addSiblings(unit: Unit, side: Side): void {
    const card = unit.cards[unit.anchor]!;
    if (card.dupOf !== undefined || !this.showSiblings(card)) return;
    let order = this.siblingCandidates(card.personId);
    if (order.length < 2) return;
    const key = (c: SiblingCandidate) => this.index.person(c.id)!.birthSortKey;
    // Stable: undated siblings keep family order after the dated ones.
    order = [...order].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka === undefined || kb === undefined) {
        return ka === kb ? 0 : ka === undefined ? 1 : -1;
      }
      return ka - kb;
    });
    if (side !== 'center') {
      const self = order.filter((c) => c.self);
      const others = order.filter((c) => !c.self);
      order = side === 'left' ? [...others, ...self] : [...self, ...others];
    }

    card.siblingsShown = true;
    card.siblings = [];
    const before: Card[] = [];
    const after: Card[] = [];
    let target = before;
    for (const c of order) {
      if (c.self) {
        target = after;
        continue;
      }
      const sibling = this.card(c.id, 'sibling', card.generation);
      if (c.half) sibling.half = true;
      card.siblings.push({ card: sibling, rel: c.rel, half: c.half });
      target.push(...this.coupleBlock(sibling, 'sibling-spouse', true));
    }
    unit.cards = [...before, ...unit.cards, ...after];
    unit.size = unit.cards.length;
    unit.anchor += before.length;
    for (const group of unit.groups) group.anchors = group.anchors.map((a) => a + before.length);
  }

  /**
   * The person and their spouses as block cards: one spouse on the husband's
   * side; with more, the first on the left and the rest on the right so the
   * first two couples stay adjacent. With `links`, records couple edges.
   */
  coupleBlock(person: Card, spouseRole: Role, links: boolean): Card[] {
    if (person.dupOf !== undefined) return [person];
    const families = this.index.partnerFamilies(person.personId);
    const spouseIds: string[] = [];
    for (const f of families) {
      const id = spouseOf(this.index, f, person.personId);
      if (id !== null && !spouseIds.includes(id)) spouseIds.push(id);
    }
    const spouses = spouseIds.map((id) => this.card(id, spouseRole, person.generation));
    if (links) {
      for (const f of families) {
        const id = spouseOf(this.index, f, person.personId);
        if (id === null) continue;
        const spouse = spouses[spouseIds.indexOf(id)]!;
        this.links.push({
          familyId: f.id,
          parents: [person, spouse],
          children: [],
          block: this.blocks++,
          relationship: f.relationship,
        });
      }
    }
    if (spouses.length === 1) {
      const wifeFirst =
        this.index.person(person.personId)!.sex === 'F' &&
        this.index.person(spouses[0]!.personId)!.sex === 'M';
      return wifeFirst ? [spouses[0]!, person] : [person, spouses[0]!];
    }
    if (spouses.length > 1) return [spouses[0]!, person, ...spouses.slice(1)];
    return [person];
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

    const cards = this.coupleBlock(person, isFocus ? 'spouse' : 'descendant-spouse', false);
    unit.cards = cards;
    unit.size = cards.length;
    unit.anchor = cards.indexOf(person);
    // The focus person's spouses show regardless, so only children count as shown.
    person.childrenShown =
      budget > 0 && (!isFocus || families.some((f) => this.index.children(f).length > 0));

    const pending: Pending[] = [];
    const groups: { mid: number; group: Unit['groups'][number] }[] = [];
    const { block } = unit;
    for (const family of families) {
      const spouseId = spouseOf(this.index, family, person.personId);
      const spouse = cards.find((c) => c !== person && c.personId === spouseId);
      // Children hang from the couple's midpoint when the partners are side by
      // side, otherwise from the partner's own card (see family.ts edges).
      const s = spouse ? cards.indexOf(spouse) : unit.anchor;
      const anchors = Math.abs(s - unit.anchor) === 1 ? [unit.anchor, s] : [s];
      const children =
        budget > 0
          ? this.index.children(family).map((id) => ({
              card: this.card(id, 'descendant', person.generation + 1),
              rel: childRelation(this.index, family, id),
            }))
          : [];
      this.links.push({
        familyId: family.id,
        parents: spouse ? [person, spouse] : [person],
        children,
        block,
        relationship: family.relationship,
      });
      if (children.length === 0) continue;
      const units = children.map((c) => this.unit([c.card], unit.level + 1));
      for (const u of units) pending.push({ unit: u, base: budget - 1, side: 'center' });
      const mid = (anchors[0]! + anchors.at(-1)!) / 2;
      groups.push({ mid, group: { anchors, children: units, rootGap } });
    }
    // Order groups like their drop points so connectors do not cross; stable for ties.
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
