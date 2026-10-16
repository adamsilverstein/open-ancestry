/**
 * Turns a graph slice into tidy units: walks ancestors and descendants
 * breadth first from the focus person, applying depth limits and
 * expand/collapse, and records which families need edges. A person reached a
 * second time becomes a duplicate card that is never walked again, which
 * handles pedigree collapse and keeps cyclic data finite.
 */
import {
  chooseParentFamily,
  childRelation,
  coupleOrder,
  partneredParentFamilies,
  spouseOf,
} from './graph';
import type { GraphIndex } from './graph';
import type { TidyUnit } from './tidy';
import type {
  ChildRelation,
  ExpandDirection,
  ExpandKey,
  LayoutOptions,
  ParentFamilyChoice,
  PartnerRelationship,
  TreeFamily,
} from './types';
import { pushAll } from './arrays';

export type Role =
  | 'focus'
  | 'spouse'
  | 'ancestor'
  | 'descendant'
  | 'descendant-spouse'
  | 'sibling'
  | 'sibling-spouse'
  /** Children of a parent's sibling, drawn in the focus row by the ancestor tree. */
  | 'cousin';

/** Where a direct-line person's siblings go: left of a father, right of a mother. */
export type Side = 'left' | 'right' | 'center';

export interface SiblingEntry {
  card: Card;
  rel: ChildRelation;
  half: boolean;
  /** The family the sibling is a child of, and for a half sibling the parent shared. */
  family: TreeFamily;
  via: string | null;
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
  /** In the focus row of the ancestor tree: nothing may be drawn below it. */
  downBlocked?: boolean;
  /** Shown siblings of a direct-line person, birth ordered. */
  siblings?: SiblingEntry[];
  half?: boolean;
  x: number;
  y: number;
}

export interface Unit extends TidyUnit {
  cards: Card[];
  groups: UnitGroup[];
  downGroups?: UnitGroup[];
  /** An ancestor block on the focus person's own line (not a spouse's). */
  focusLine?: boolean;
}

interface UnitGroup {
  anchors: number[];
  children: Unit[];
  rootGap: number;
}

/** A family drawn once: its parent cards above its child cards. */
export interface FamilyLink {
  familyId: string;
  /** The block's own person first, then their partner. */
  parents: Card[];
  children: {
    card: Card;
    rel: ChildRelation;
    half?: boolean;
    /** A half sibling's own family and shared parent, when it differs from the link's. */
    familyId?: string;
    sharedParentId?: string;
  }[];
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
  family: TreeFamily;
  /** The parent a half sibling shares with the person. */
  via: string | null;
}

export class Builder {
  readonly cards: Card[] = [];
  readonly links: FamilyLink[] = [];
  readonly alternates: Record<string, ParentFamilyChoice> = {};
  private readonly primary = new Map<string, string>();
  private readonly dupCount = new Map<string, number>();
  /** Cousin units hung below ancestor blocks, in creation order. */
  readonly downUnits: Unit[] = [];
  /** The side of the focus row taken by a spouse's parents: no cousins there. */
  spouseParentsSide?: Side;

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
    // Only sets the switcher can show: listing a partnerless family would
    // strand the sets after it (cycling falls back past it).
    const all = partneredParentFamilies(this.index, card.personId);
    if (all.length > 1) {
      this.alternates[card.personId] = { selected: family.id, families: all.map((f) => f.id) };
    }
    const siblings = card.siblings ?? [];
    const full = [
      { card, rel: childRelation(this.index, family, card.personId) },
      ...siblings.filter((e) => !e.half).map((e) => ({ card: e.card, rel: e.rel })),
    ];
    const halves = siblings.filter((e) => e.half);
    const link = (familyId: string, parents: Card[], children: FamilyLink['children']) =>
      this.links.push({
        familyId,
        parents,
        children,
        relationship: family.relationship,
      });
    if (budget <= 0) {
      // Siblings without their parents still share one bar; half siblings keep
      // their own family and shared parent on their edges.
      const all = [
        ...full,
        ...halves.map((e) => ({
          card: e.card,
          rel: e.rel,
          half: true,
          familyId: e.family.id,
          sharedParentId: e.via!,
        })),
      ];
      if (all.length > 1) link(family.id, [], all);
      return [];
    }
    card.parentsShown = true;
    const parents = coupleOrder(this.index, family).map((id) =>
      this.card(id, 'ancestor', card.generation - 1),
    );
    const units = parents.map((p) => this.unit([p], unit.level + 1));
    const line = card.role === 'focus' || (card.role !== 'spouse' && unit.focusLine === true);
    for (const u of units) u.focusLine = line;
    // The parents center over the full siblings; half siblings hang from the
    // shared parent alone, one family at a time.
    const anchors = full.map((k) => unit.cards.indexOf(k.card));
    unit.groups.push({ anchors, children: units, rootGap });
    link(family.id, parents, full);
    for (const [other, entries] of groupByFamily(halves)) {
      const shared = parents.find((p) => p.personId === entries[0]!.via)!;
      this.links.push({
        familyId: other.id,
        parents: [shared],
        children: entries.map((e) => ({
          card: e.card,
          rel: e.rel,
          half: true,
          sharedParentId: shared.personId,
        })),
        relationship: other.relationship,
      });
    }
    // A lone parent keeps all their siblings on one side too (a mother's on
    // the right), so their cousins never straddle the focus row.
    const lone: Side = this.index.person(parents[0]!.personId)!.sex === 'F' ? 'right' : 'left';
    const sides: Side[] = units.length === 2 ? ['left', 'right'] : [lone];
    return units.map((u, i) => ({ unit: u, base: budget - 1, side: sides[i]! }));
  }

  /** Walks the ancestor units in `queue` breadth first, appending new ones. */
  growAncestors(queue: Pending[], rootGap: number, siblingGap?: number): Unit[] {
    for (let i = 0; i < queue.length; i++) {
      const { unit, base, side } = queue[i]!;
      const card = unit.cards[0]!;
      if (siblingGap !== undefined) this.addSiblings(unit, side, 'down', siblingGap);
      const budget = this.budget(card.personId, 'up', base);
      pushAll(queue, this.addParents(unit, unit.anchor, budget, rootGap));
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
    const add = (f: TreeFamily, via: string | null) => {
      for (const id of this.index.children(f)) {
        if (seen.has(id)) continue;
        seen.add(id);
        const rel = childRelation(this.index, f, id);
        out.push({ id, rel, half: via !== null, self: id === personId, family: f, via });
      }
    };
    add(family, null);
    for (const parent of this.index.partners(family)) {
      if (parent === null) continue;
      for (const f of this.index.partnerFamilies(parent)) if (f !== family) add(f, parent);
    }
    return out;
  }

  /**
   * Puts the siblings of the block's anchor person (with their spouses) into
   * the block. Full siblings go left of a father, right of a mother, otherwise
   * in birth order around the person; half siblings go on their shared
   * parent's side, outside the full ones, grouped by family. On a side that
   * must stay next to a spouse, half siblings through the far parent are left
   * out, as their line would cross the parents'. Expanded siblings get their
   * children: as `groups` in the descendant tree for the focus row, as
   * `downGroups` (cousins, never below the focus row) in the ancestor tree.
   * Returns new descendant-tree units to walk.
   */
  addSiblings(unit: Unit, side: Side, kind: 'up' | 'down', rootGap: number): Pending[] {
    const card = unit.cards[unit.anchor]!;
    if (card.dupOf !== undefined || !this.showSiblings(card)) return [];
    const candidates = this.siblingCandidates(card.personId);
    if (candidates.length < 2) return [];
    const key = (c: SiblingCandidate) => this.index.person(c.id)!.birthSortKey;
    // Stable: undated siblings keep family order after the dated ones.
    const sorted = [...candidates].sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      if (ka === undefined || kb === undefined) {
        return ka === kb ? 0 : ka === undefined ? 1 : -1;
      }
      return ka - kb;
    });
    const [first, second] = coupleOrder(this.index, candidates[0]!.family);
    const leftParent =
      second !== undefined || this.index.person(first!)!.sex !== 'F' ? first : undefined;
    const halfOf = (left: boolean) =>
      [
        ...groupByFamily(sorted.filter((c) => c.half && (c.via === leftParent) === left)).values(),
      ].flat();
    const full = sorted.filter((c) => !c.half);
    const self = full.filter((c) => c.self);
    const fullOthers = full.filter((c) => !c.self);
    const order =
      side === 'left'
        ? [...halfOf(true), ...fullOthers, ...self]
        : side === 'right'
          ? [...self, ...fullOthers, ...halfOf(false)]
          : [...halfOf(true), ...full, ...halfOf(false)];
    if (order.length < 2) return [];

    card.siblingsShown = true;
    card.siblings = [];
    const before: Card[] = [];
    const after: Card[] = [];
    const own = new Map<Card, Card[]>();
    let target = before;
    for (const c of order) {
      if (c.self) {
        target = after;
        continue;
      }
      const sibling = this.card(c.id, 'sibling', card.generation);
      if (c.half) sibling.half = true;
      card.siblings.push({ card: sibling, rel: c.rel, half: c.half, family: c.family, via: c.via });
      const cards = this.coupleBlock(sibling, 'sibling-spouse');
      own.set(sibling, cards);
      pushAll(target, cards);
    }
    unit.cards = [...before, ...unit.cards, ...after];
    unit.size = unit.cards.length;
    unit.anchor += before.length;
    for (const group of unit.groups) group.anchors = group.anchors.map((a) => a + before.length);

    const pending: Pending[] = [];
    for (const [sibling, cards] of own) {
      // In the ancestor tree only the parents' siblings expand, one generation
      // (cousins in the focus row): deeper or a spouse's line could not be
      // drawn without crossing the direct line.
      const budget = this.budget(sibling.personId, 'down', 0);
      const cousins =
        unit.level === 1 && unit.focusLine === true && side !== this.spouseParentsSide;
      if (kind === 'down' && !cousins) sibling.downBlocked = true;
      const allowed = kind === 'up' ? budget : cousins ? Math.min(budget, 1) : 0;
      if (kind === 'down' && side !== 'center') unit.reserve = side;
      const role: Role = kind === 'up' ? 'descendant' : 'cousin';
      pushAll(pending, this.hangChildren(unit, sibling, cards, allowed, kind, role, rootGap));
    }
    if (kind === 'up') return pending;
    this.growDown(pending);
    return [];
  }

  /** Registers cousin units: they sit in the focus row, so nothing hangs below them. */
  growDown(queue: Pending[]): void {
    for (const { unit } of queue) {
      unit.cards[0]!.downBlocked = true;
      this.downUnits.push(unit);
    }
  }

  /**
   * Hangs the children of `person`'s families (with partners among `own`)
   * from `unit`, one group per family ordered by drop point, and records
   * every family for its couple connector. `kind` 'up' adds `groups` one
   * level further from the root, 'down' adds `downGroups` one level nearer.
   */
  hangChildren(
    unit: Unit,
    person: Card,
    own: Card[],
    budget: number,
    kind: 'up' | 'down',
    childRole: Role,
    rootGap: number,
  ): Pending[] {
    if (person.dupOf !== undefined) return [];
    const families = this.index.partnerFamilies(person.personId);
    const target = kind === 'up' ? unit.groups : (unit.downGroups ??= []);
    const p = unit.cards.indexOf(person);
    const pending: Pending[] = [];
    for (const family of families) {
      const spouseId = spouseOf(this.index, family, person.personId);
      const spouse = own.find((c) => c !== person && c.personId === spouseId);
      // Children hang from the couple's midpoint when the partners are side by
      // side, otherwise from the partner's own card (see family.ts edges).
      const s = spouse ? unit.cards.indexOf(spouse) : p;
      const anchors = Math.abs(s - p) === 1 ? [p, s] : [s];
      const children =
        budget > 0
          ? this.index.children(family).map((id) => ({
              card: this.card(id, childRole, person.generation + 1),
              rel: childRelation(this.index, family, id),
            }))
          : [];
      this.links.push({
        familyId: family.id,
        parents: spouse ? [person, spouse] : [person],
        children,
        relationship: family.relationship,
      });
      if (children.length === 0) continue;
      person.childrenShown = true;
      const level = unit.level + (kind === 'up' ? 1 : -1);
      const units = children.map((c) => this.unit([c.card], level));
      for (const u of units) pending.push({ unit: u, base: budget - 1, side: 'center' });
      target.push({ anchors, children: units, rootGap });
    }
    // Order groups like their drop points so connectors do not cross; stable for ties.
    const mid = (g: UnitGroup) => (g.anchors[0]! + g.anchors.at(-1)!) / 2;
    target.sort((a, b) => mid(a) - mid(b));
    return pending;
  }

  /**
   * The person and their spouses as block cards: one spouse on the husband's
   * side; with more, the first on the left and the rest on the right so the
   * first two couples stay adjacent.
   */
  coupleBlock(person: Card, spouseRole: Role): Card[] {
    if (person.dupOf !== undefined) return [person];
    const families = this.index.partnerFamilies(person.personId);
    const spouseIds: string[] = [];
    for (const f of families) {
      const id = spouseOf(this.index, f, person.personId);
      if (id !== null && !spouseIds.includes(id)) spouseIds.push(id);
    }
    const spouses = spouseIds.map((id) => this.card(id, spouseRole, person.generation));
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
   * groups. Spouses are shown when children could be, or always for the
   * focus person. Returns the child units to walk further.
   */
  addFamilies(unit: Unit, budget: number, isFocus: boolean, rootGap: number): Pending[] {
    const person = unit.cards[0]!;
    if (person.dupOf !== undefined || (budget <= 0 && !isFocus)) return [];
    const families = this.index.partnerFamilies(person.personId);
    if (families.length === 0) return [];

    const cards = this.coupleBlock(person, isFocus ? 'spouse' : 'descendant-spouse');
    unit.cards = cards;
    unit.size = cards.length;
    unit.anchor = cards.indexOf(person);
    const pending = this.hangChildren(unit, person, cards, budget, 'up', 'descendant', rootGap);
    // The focus person's spouses show regardless, so only children count as shown.
    person.childrenShown =
      budget > 0 && (!isFocus || families.some((f) => this.index.children(f).length > 0));
    return pending;
  }

  /** Walks the descendant units in `queue` breadth first, appending new ones. */
  growDescendants(queue: Pending[], rootGap: number): Unit[] {
    for (let i = 0; i < queue.length; i++) {
      const { unit, base } = queue[i]!;
      const card = unit.cards[0]!;
      const budget = this.budget(card.personId, 'down', base);
      pushAll(queue, this.addFamilies(unit, budget, false, rootGap));
    }
    return queue.map((p) => p.unit);
  }
}

/** Entries grouped by their family, in order of first appearance. */
function groupByFamily<T extends { family: TreeFamily }>(entries: T[]): Map<TreeFamily, T[]> {
  const groups = new Map<TreeFamily, T[]>();
  for (const e of entries) {
    const list = groups.get(e.family);
    if (list) list.push(e);
    else groups.set(e.family, [e]);
  }
  return groups;
}
