import type { TreeStore } from '@open-ancestry/db';
import { HIGH_CONFIDENCE, type PersonMatch } from './match';
import {
  norm,
  type SnapCitation,
  type SnapEvent,
  type SnapPerson,
  type Snapshot,
} from './snapshot';

/*
 * What an updated export would change, person by person. Nothing here writes;
 * apply.ts applies the changes the user accepted.
 */

/** A fact as shown in the review: enough to render "Birth, 12 Mar 1842, Hollin Cross". */
export interface FactView {
  type: string;
  customType: string | null;
  date: string | null;
  place: string | null;
  value: string | null;
}

export type ReimportChange =
  | { kind: 'person.new'; incomingId: string }
  | { kind: 'sex'; before: string; after: string }
  | { kind: 'name.add'; incomingNameId: string; name: string; nameType: string }
  | {
      kind: 'fact.add';
      incomingEventId: string;
      fact: FactView;
      owner: 'person' | 'family';
      familyKey?: string;
    }
  | {
      kind: 'fact.change';
      existingEventId: string;
      incomingEventId: string;
      before: FactView;
      after: FactView;
    }
  | { kind: 'fact.missing'; existingEventId: string; fact: FactView }
  | {
      kind: 'citation.add';
      incomingCitationId: string;
      /** The existing event it attaches to, or null for the person record. */
      existingEventId: string | null;
      source: string;
      page: string | null;
      apid: string | null;
    }
  | { kind: 'tag.add'; incomingTagId: string; tag: string }
  | { kind: 'media.add'; incomingMediaId: string; title: string | null }
  | {
      kind: 'family.add';
      incomingFamilyId: string;
      /** Partners as incoming person ids. */
      partners: string[];
    }
  | {
      kind: 'child.add';
      incomingFamilyId: string;
      incomingChildId: string;
      partners: string[];
    }
  | { kind: 'person.missing' };

export type ReviewChange = ReimportChange & {
  id: string;
  /** Applied unless the user unticks it. */
  defaultAccept: boolean;
  /** False for information only (missing people and facts): never applied. */
  applicable: boolean;
  /** The tree's value was edited locally since it was imported; kept unless overridden. */
  conflict?: 'local-edit';
  /** Change ids that must also be accepted (a new person this one depends on). */
  requires?: string[];
};

export interface PersonReview {
  key: string;
  status: 'matched' | 'new' | 'missing';
  existingId: string | null;
  incomingId: string | null;
  name: string;
  lifespan: string;
  confidence: number | null;
  reasons: string[];
  changes: ReviewChange[];
}

export interface ReimportDiff {
  people: PersonReview[];
  counts: {
    incoming: number;
    matched: number;
    highConfidence: number;
    changedPeople: number;
    newPeople: number;
    missingPeople: number;
    changes: number;
  };
}

const SINGULAR = new Set(['BIRT', 'CHR', 'BAPM', 'DEAT', 'BURI', 'CREM']);

const factOf = (e: SnapEvent): FactView => ({
  type: e.row.type,
  customType: e.row.custom_type,
  date: e.row.date_text,
  place: e.place,
  value: e.row.value,
});

const sameText = (a: string | null, b: string | null) => norm(a) === norm(b);
const sameFact = (a: SnapEvent, b: SnapEvent) =>
  a.row.type === b.row.type &&
  sameText(a.row.custom_type, b.row.custom_type) &&
  sameText(a.row.date_text, b.row.date_text) &&
  sameText(a.place, b.place) &&
  sameText(a.row.value, b.row.value);

const citationKey = (c: SnapCitation) => `${c.sourceKey}|${norm(c.page)}|${c.apid ?? ''}`;

function displayName(p: SnapPerson): string {
  const name = p.names.find((n) => n.is_primary) ?? p.names[0];
  return [name?.given, name?.surname].filter(Boolean).join(' ') || 'Unnamed';
}

const lifespan = (p: SnapPerson) =>
  p.birthYear || p.deathYear ? `${p.birthYear ?? '?'}–${p.deathYear ?? ''}` : '';

/** Rows changed by the user (any applied change batch) since they were imported. */
export function locallyEdited(store: TreeStore): Set<string> {
  const rows = store.db
    .prepare(
      `SELECT DISTINCT l.entity, l.entity_id FROM change_log l
       JOIN change_batch b ON b.id = l.batch_id WHERE b.state = 'applied'`,
    )
    .all() as { entity: string; entity_id: string }[];
  return new Set(rows.map((r) => `${r.entity}|${r.entity_id}`));
}

/** Pairs the incoming person's events with the existing person's. */
function diffFacts(
  e: SnapPerson,
  i: SnapPerson,
  edited: Set<string>,
  add: (change: ReimportChange, extra?: Partial<ReviewChange>) => void,
) {
  const used = new Set<string>();
  const findSame = (ie: SnapEvent) =>
    e.events.find((ee) => !used.has(ee.row.id) && sameFact(ee, ie));
  const pending: SnapEvent[] = [];
  for (const ie of i.events) {
    const same = findSame(ie);
    if (same) {
      used.add(same.row.id);
      diffCitations(same, ie, add);
    } else {
      pending.push(ie);
    }
  }
  for (const ie of pending) {
    const counterpart = SINGULAR.has(ie.row.type)
      ? e.events.find(
          (ee) =>
            !used.has(ee.row.id) &&
            ee.row.type === ie.row.type &&
            ee.isPreferred === ie.isPreferred,
        )
      : e.events.find(
          (ee) =>
            !used.has(ee.row.id) &&
            ee.row.type === ie.row.type &&
            sameText(ee.row.custom_type, ie.row.custom_type) &&
            (sameText(ee.row.date_text, ie.row.date_text) ||
              (sameText(ee.place, ie.place) && sameText(ee.row.value, ie.row.value))),
        );
    if (counterpart) {
      used.add(counterpart.row.id);
      const conflict = edited.has(`event|${counterpart.row.id}`);
      add(
        {
          kind: 'fact.change',
          existingEventId: counterpart.row.id,
          incomingEventId: ie.row.id,
          before: factOf(counterpart),
          after: factOf(ie),
        },
        conflict ? { conflict: 'local-edit', defaultAccept: false } : {},
      );
      diffCitations(counterpart, ie, add);
    } else {
      add({ kind: 'fact.add', incomingEventId: ie.row.id, fact: factOf(ie), owner: 'person' });
    }
  }
  for (const ee of e.events) {
    // Facts the user added never came from an export, so they are not "missing" from it.
    if (used.has(ee.row.id) || !ee.row.import_batch_id) continue;
    add(
      { kind: 'fact.missing', existingEventId: ee.row.id, fact: factOf(ee) },
      { applicable: false, defaultAccept: false },
    );
  }
}

function diffCitations(
  existing: SnapEvent | null,
  incoming: SnapEvent | null,
  add: (change: ReimportChange, extra?: Partial<ReviewChange>) => void,
  personCitations?: { existing: SnapCitation[]; incoming: SnapCitation[] },
) {
  const have = new Set((existing?.citations ?? personCitations?.existing ?? []).map(citationKey));
  for (const c of incoming?.citations ?? personCitations?.incoming ?? []) {
    if (have.has(citationKey(c))) continue;
    have.add(citationKey(c));
    add({
      kind: 'citation.add',
      incomingCitationId: c.id,
      existingEventId: existing?.row.id ?? null,
      source: c.sourceTitle,
      page: c.page,
      apid: c.apid,
    });
  }
}

export function diffTrees(
  existing: Snapshot,
  incoming: Snapshot,
  matches: Map<string, PersonMatch>,
  edited: Set<string>,
): ReimportDiff {
  const people: PersonReview[] = [];
  const reviews = new Map<string, PersonReview>();
  const toExisting = new Map([...matches.values()].map((m) => [m.incomingId, m.existingId]));
  const matchedExisting = new Set(toExisting.values());
  let seq = 0;
  const newPersonChange = new Map<string, string>();

  const review = (key: string, init: () => PersonReview) => {
    let r = reviews.get(key);
    if (!r) {
      r = init();
      reviews.set(key, r);
      people.push(r);
    }
    return r;
  };
  const adder =
    (r: PersonReview, defaults: Partial<ReviewChange>) =>
    (change: ReimportChange, extra: Partial<ReviewChange> = {}) => {
      const item = {
        ...change,
        id: `c${++seq}`,
        defaultAccept: true,
        applicable: true,
        ...defaults,
        ...extra,
      } as ReviewChange;
      r.changes.push(item);
      return item;
    };

  // Matched people: facts, names, sex, citations, tags and media.
  for (const m of matches.values()) {
    const e = existing.people.get(m.existingId)!;
    const i = incoming.people.get(m.incomingId)!;
    const r: PersonReview = {
      key: `m:${e.row.id}`,
      status: 'matched',
      existingId: e.row.id,
      incomingId: i.row.id,
      name: displayName(e),
      lifespan: lifespan(e),
      confidence: m.confidence,
      reasons: m.reasons,
      changes: [],
    };
    // A low-confidence match is offered, never pre-accepted.
    const add = adder(r, m.confidence >= HIGH_CONFIDENCE ? {} : { defaultAccept: false });
    if (i.row.sex !== 'U' && i.row.sex !== e.row.sex) {
      add(
        { kind: 'sex', before: e.row.sex, after: i.row.sex },
        edited.has(`person|${e.row.id}`) ? { conflict: 'local-edit', defaultAccept: false } : {},
      );
    }
    const names = new Set(e.names.map((n) => `${norm(n.given)}|${norm(n.surname)}`));
    for (const n of i.names) {
      if (names.has(`${norm(n.given)}|${norm(n.surname)}`)) continue;
      add({
        kind: 'name.add',
        incomingNameId: n.id,
        name: [n.given, n.surname].filter(Boolean).join(' '),
        nameType: n.type,
      });
    }
    diffFacts(e, i, edited, add);
    diffCitations(null, null, add, { existing: e.citations, incoming: i.citations });
    const tags = new Set(e.tags.map((t) => t.key));
    for (const t of i.tags) {
      if (!tags.has(t.key))
        add({
          kind: 'tag.add',
          incomingTagId: t.id,
          tag: t.category ? `${t.category}: ${t.name}` : t.name,
        });
    }
    const media = new Set(e.media.map((x) => x.key));
    for (const x of i.media) {
      if (!media.has(x.key))
        add({ kind: 'media.add', incomingMediaId: x.row.id, title: x.row.title });
    }
    if (r.changes.length) {
      reviews.set(r.key, r);
      people.push(r);
    }
  }

  // New people.
  for (const i of incoming.people.values()) {
    if (toExisting.has(i.row.id)) continue;
    const r = review(`n:${i.row.id}`, () => ({
      key: `n:${i.row.id}`,
      status: 'new',
      existingId: null,
      incomingId: i.row.id,
      name: displayName(i),
      lifespan: lifespan(i),
      confidence: null,
      reasons: [],
      changes: [],
    }));
    newPersonChange.set(i.row.id, adder(r, {})({ kind: 'person.new', incomingId: i.row.id }).id);
  }

  // Relationships: incoming families mapped onto existing people and new people.
  const mapPerson = (id: string | null) => (id ? (toExisting.get(id) ?? `new:${id}`) : null);
  const familyKey = (a: string | null, b: string | null) => [a, b].filter(Boolean).sort().join('+');
  const existingFamilies = new Map<string, string>();
  for (const f of existing.families.values()) {
    existingFamilies.set(familyKey(f.partner1_id, f.partner2_id), f.id);
  }
  const existingChildren = new Set(
    existing.familyChildren.map((c) => `${c.family_id}|${c.child_id}`),
  );
  const incomingChildren = new Map<string, string[]>();
  for (const c of incoming.familyChildren) {
    const list = incomingChildren.get(c.family_id) ?? [];
    list.push(c.child_id);
    incomingChildren.set(c.family_id, list);
  }
  const reviewFor = (incomingId: string): PersonReview => {
    const existingId = toExisting.get(incomingId);
    if (!existingId) return reviews.get(`n:${incomingId}`)!;
    const e = existing.people.get(existingId)!;
    const m = matches.get(incomingId)!;
    return review(`m:${existingId}`, () => ({
      key: `m:${existingId}`,
      status: 'matched',
      existingId,
      incomingId,
      name: displayName(e),
      lifespan: lifespan(e),
      confidence: m.confidence,
      reasons: m.reasons,
      changes: [],
    }));
  };
  const requiresFor = (ids: string[]) =>
    ids.flatMap((id) => (toExisting.has(id) ? [] : [newPersonChange.get(id)!]));
  const lowConfidence = (ids: string[]) =>
    ids.some((id) => (matches.get(id)?.confidence ?? 1) < HIGH_CONFIDENCE);

  for (const f of incoming.families.values()) {
    const partners = [f.partner1_id, f.partner2_id].filter((p): p is string => !!p);
    const key = familyKey(mapPerson(f.partner1_id), mapPerson(f.partner2_id));
    const existingFamily = existingFamilies.get(key);
    const owner = partners[0] ?? incomingChildren.get(f.id)?.[0];
    if (!owner) continue;
    if (!existingFamily && partners.length === 2) {
      adder(reviewFor(owner), lowConfidence(partners) ? { defaultAccept: false } : {})(
        { kind: 'family.add', incomingFamilyId: f.id, partners },
        { requires: requiresFor(partners) },
      );
    }
    if (existingFamily) {
      // Family facts (marriage, divorce) new in the export.
      const have = new Set(
        existing.familyEvents.get(existingFamily)?.map((e) => `${e.type}|${norm(e.date_text)}`) ??
          [],
      );
      for (const fe of incoming.familyEvents.get(f.id) ?? []) {
        if (have.has(`${fe.type}|${norm(fe.date_text)}`)) continue;
        adder(
          reviewFor(owner),
          lowConfidence(partners) ? { defaultAccept: false } : {},
        )({
          kind: 'fact.add',
          incomingEventId: fe.id,
          fact: {
            type: fe.type,
            customType: fe.custom_type,
            date: fe.date_text,
            place: null,
            value: fe.value,
          },
          owner: 'family',
          familyKey: existingFamily,
        });
      }
    }
    for (const child of incomingChildren.get(f.id) ?? []) {
      const mappedChild = mapPerson(child)!;
      if (existingFamily && existingChildren.has(`${existingFamily}|${mappedChild}`)) continue;
      const involved = [child, ...partners];
      adder(reviewFor(child), lowConfidence(involved) ? { defaultAccept: false } : {})(
        { kind: 'child.add', incomingFamilyId: f.id, incomingChildId: child, partners },
        { requires: requiresFor(involved) },
      );
    }
  }

  // People in the tree (from an earlier import) that this export no longer has.
  for (const e of existing.people.values()) {
    if (matchedExisting.has(e.row.id) || !e.row.import_batch_id) continue;
    adder(
      review(`x:${e.row.id}`, () => ({
        key: `x:${e.row.id}`,
        status: 'missing',
        existingId: e.row.id,
        incomingId: null,
        name: displayName(e),
        lifespan: lifespan(e),
        confidence: null,
        reasons: [],
        changes: [],
      })),
      { applicable: false, defaultAccept: false },
    )({ kind: 'person.missing' });
  }

  const order = { new: 1, matched: 0, missing: 2 } as const;
  people.sort((a, b) => order[a.status] - order[b.status] || a.name.localeCompare(b.name));
  const matched = [...matches.values()];
  return {
    people,
    counts: {
      incoming: incoming.people.size,
      matched: matched.length,
      highConfidence: matched.filter((m) => m.confidence >= HIGH_CONFIDENCE).length,
      changedPeople: people.filter((p) => p.status === 'matched').length,
      newPeople: people.filter((p) => p.status === 'new').length,
      missingPeople: people.filter((p) => p.status === 'missing').length,
      changes: people.reduce((n, p) => n + p.changes.filter((c) => c.applicable).length, 0),
    },
  };
}
