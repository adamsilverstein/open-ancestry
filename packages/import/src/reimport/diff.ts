import type { FamilyRow, MediaRow, TableName, TreeStore } from '@open-ancestry/db';
import { HIGH_CONFIDENCE, POSSIBLE_MATCH, type NearMiss, type PersonMatch } from './match';
import {
  mediaKey,
  norm,
  sourceKey,
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
  | {
      kind: 'name.add';
      incomingNameId: string;
      name: string;
      /** Only when the export states it; otherwise null (the importer's default is not news). */
      nameType: string | null;
    }
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
      partnerNames: string[];
    }
  | {
      kind: 'child.add';
      incomingFamilyId: string;
      incomingChildId: string;
      partners: string[];
      parentNames: string[];
    }
  | { kind: 'person.missing' }
  /** A partnership from an earlier import that this export no longer has. */
  | { kind: 'family.missing'; existingFamilyId: string; partnerNames: string[] }
  /** A parent link from an earlier import that this export no longer has. */
  | { kind: 'child.missing'; existingFamilyId: string; parentNames: string[] }
  /** The record matches someone the user deleted from this tree. */
  | { kind: 'deleted-here' }
  /** Another exported record that was merged into this person here: folded in, never added. */
  | { kind: 'merged'; incomingId: string; incomingName: string }
  /** An unmatched record that shares a relative with someone merged here: likely the same person. */
  | { kind: 'possibly-merged'; existingId: string; existingName: string }
  /** A new person whose every link into the tree starts unticked: added alone, they'd have no family. */
  | { kind: 'unlinked-new' }
  /** An unmatched record that looks like someone already matched to another record. */
  | {
      kind: 'possible-match';
      existingId: string;
      existingName: string;
      /** How close, 0..1. */
      confidence: number;
      /** That tree person is matched to another record in this export. */
      taken: boolean;
    };

export type ReviewChange = ReimportChange & {
  id: string;
  /** Applied unless the user unticks it. */
  defaultAccept: boolean;
  /** False for information only (missing people and facts): never applied. */
  applicable: boolean;
  /** The tree's value was edited locally since it was imported; kept unless overridden. */
  conflict?: 'local-edit' | 'local-delete';
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
  /** Incoming family id to the tree's family it describes (apply adds to these, never a copy). */
  familyMatches: Record<string, string>;
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

type FamilyChildRef = Snapshot['familyChildren'][number];

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

/** What the user did to the tree since it was imported. */
export interface LocalHistory {
  /** Rows changed by the user, as `entity|id`. */
  edited: Set<string>;
  /** People whose names the user changed or removed (adding a name is not a rename). */
  renamed: Set<string>;
  /**
   * The value each locally changed row had when the export last wrote it
   * (`entity|id` to its row image): the base of the three-way diff (#185).
   */
  base: Map<string, Record<string, unknown>>;
  /** Names (normalized) a person had before the user changed or removed them. */
  formerNames: Map<string, Set<string>>;
  /** People the user deleted: their names (normalized) and birth year. */
  deletedPeople: { names: Set<string>; birthYear: number | null }[];
  /** Things the user removed from people and families still in the tree. */
  removed: {
    /** Facts by owner (person or family id). */
    facts: Map<string, { type: string; date: string }[]>;
    /** Names (normalized) by person. */
    names: Map<string, Set<string>>;
    /** `owner id|source key|page` for person and event citations. */
    citations: Set<string>;
    /** `person id|media key`. */
    media: Set<string>;
    /** Partnerships, by partner key (sorted partner ids joined with "+"). */
    families: Set<string>;
    /** `partner key|child id`. */
    childLinks: Set<string>;
  };
}

const fullName = (n: { given: string | null; surname: string | null }) =>
  [n.given, n.surname].filter(Boolean).join(' ');

/** Partner key of a family: the same in the tree and for incoming families mapped onto it. */
export const partnerKey = (a: string | null, b: string | null) =>
  [a, b].filter(Boolean).sort().join('+');

const nfc = (v: unknown) => (typeof v === 'string' ? v.normalize('NFC') : v);

/** An update that changes nothing but the Unicode normal form of its text (#99). */
function onlyNormalizes(before: Record<string, unknown>, after: Record<string, unknown>) {
  return Object.keys(after).every((k) => k === 'updated_at' || nfc(before[k]) === nfc(after[k]));
}

type Image = Record<string, unknown>;

/** Reads the applied change batches for edits, renames and deletions. */
export function localHistory(store: TreeStore): LocalHistory {
  // A batch that wrote an import_batch row is a re-import's own apply: what it
  // writes is the export's value (the new base), not the user's edit (#185).
  const rows = store.db
    .prepare(
      `SELECT l.entity, l.entity_id, l.op, l.before_json, l.after_json,
              EXISTS (SELECT 1 FROM change_log i
                       WHERE i.batch_id = l.batch_id AND i.entity = 'import_batch') AS reimport
         FROM change_log l JOIN change_batch b ON b.id = l.batch_id
        WHERE b.state = 'applied' AND l.entity NOT IN ('raw_record', 'unmapped_line', 'meta')
        ORDER BY l.seq`,
    )
    .all() as {
    entity: string;
    entity_id: string;
    op: string;
    before_json: string | null;
    after_json: string | null;
    reimport: number;
  }[];
  const edited = new Set<string>();
  const renamed = new Set<string>();
  const base = new Map<string, Image>();
  const formerNames = new Map<string, Set<string>>();
  /** Deleted rows as they were, by `entity|id`. */
  const gone = new Map<string, Image>();
  const deletes: { entity: string; id: string; row: Image }[] = [];
  const former = (row: Image) => {
    const person = row.person_id as string;
    renamed.add(person);
    const set = formerNames.get(person) ?? new Set<string>();
    set.add(norm(fullName(row as { given: string | null; surname: string | null })));
    formerNames.set(person, set);
  };
  for (const r of rows) {
    const key = `${r.entity}|${r.entity_id}`;
    if (r.reimport) {
      // The export's value now: earlier local edits to this row are settled.
      edited.delete(key);
      base.delete(key);
      continue;
    }
    if (r.op === 'update' && r.before_json && r.after_json) {
      const before = JSON.parse(r.before_json) as Image;
      const after = JSON.parse(r.after_json) as Image;
      if (onlyNormalizes(before, after)) continue;
      if (!base.has(key)) base.set(key, before);
      if (r.entity === 'person_name') former(before);
    } else if (r.op === 'delete' && r.before_json) {
      const row = JSON.parse(r.before_json) as Image;
      if (!base.has(key)) base.set(key, row);
      gone.set(key, row);
      deletes.push({ entity: r.entity, id: r.entity_id, row });
      if (r.entity === 'person_name') former(row);
    }
    edited.add(key);
  }
  /** A row as it is, or as it was when deleted. */
  const rowOf = (entity: TableName, id: unknown): Image | undefined =>
    typeof id === 'string'
      ? (gone.get(`${entity}|${id}`) ?? (store.getRow(entity, id) as Image | undefined))
      : undefined;
  // Facts are compared by place name, as the export names them.
  for (const [key, row] of base) {
    if (key.startsWith('event|') && row.place_id) {
      base.set(key, { ...row, place_name: rowOf('place', row.place_id)?.full_name ?? null });
    }
  }
  const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => {
    const list = map.get(key);
    if (list) list.push(value);
    else map.set(key, [value]);
  };

  // A merge (#70) also deletes a person, but first re-points its imported records at the survivor.
  const mergedAway = new Set(
    store.db
      .prepare(
        `SELECT DISTINCT json_extract(l.before_json, '$.owner_id') FROM change_log l
           JOIN change_batch b ON b.id = l.batch_id
          WHERE b.state = 'applied' AND l.entity = 'raw_record' AND l.op = 'update'
            AND json_extract(l.before_json, '$.owner_type') = 'person'
            AND json_extract(l.after_json, '$.owner_id') IS NOT json_extract(l.before_json, '$.owner_id')`,
      )
      .pluck()
      .all() as string[],
  );
  const deletedPersons = new Set(
    deletes.filter((d) => d.entity === 'person' && !mergedAway.has(d.id)).map((d) => d.id),
  );

  const facts = new Map<string, { type: string; date: string }[]>();
  const names = new Map<string, Set<string>>();
  const citations = new Set<string>();
  const media = new Set<string>();
  const families = new Set<string>();
  const childLinks = new Set<string>();
  const birthYears = new Map<string, number>();
  for (const d of deletes) {
    switch (d.entity) {
      case 'event_role': {
        const event = rowOf('event', d.row.event_id);
        const owner = (d.row.person_id ?? d.row.family_id) as string | null;
        if (!event || !owner) break;
        push(facts, owner, { type: event.type as string, date: norm(event.date_text as string) });
        if (event.type === 'BIRT' && typeof event.date_sort === 'number' && event.date_sort) {
          birthYears.set(owner, Math.floor(event.date_sort / 10000));
        }
        break;
      }
      case 'person_name': {
        const person = d.row.person_id as string;
        const set = names.get(person) ?? new Set<string>();
        set.add(norm(fullName(d.row as { given: string | null; surname: string | null })));
        names.set(person, set);
        break;
      }
      case 'citation_link': {
        if (d.row.owner_type !== 'person' && d.row.owner_type !== 'event') break;
        const citation = rowOf('citation', d.row.citation_id);
        const source = rowOf('source', citation?.source_id);
        if (!citation || !source) break;
        citations.add(
          `${d.row.owner_id as string}|${sourceKey(source.title as string, source.apid as string | null)}|${norm(citation.page as string | null)}`,
        );
        break;
      }
      case 'media_link': {
        if (d.row.owner_type !== 'person') break;
        const m = rowOf('media', d.row.media_id);
        if (m) media.add(`${d.row.owner_id as string}|${mediaKey(m as unknown as MediaRow)}`);
        break;
      }
      case 'family_child': {
        const f = rowOf('family', d.row.family_id);
        if (f) {
          childLinks.add(
            `${partnerKey(f.partner1_id as string | null, f.partner2_id as string | null)}|${d.row.child_id as string}`,
          );
        }
        break;
      }
      case 'family':
        families.add(
          partnerKey(d.row.partner1_id as string | null, d.row.partner2_id as string | null),
        );
        break;
    }
  }
  const deletedPeople = [...deletedPersons].map((id) => ({
    names: names.get(id) ?? new Set<string>(),
    birthYear: birthYears.get(id) ?? null,
  }));
  return {
    edited,
    renamed,
    base,
    formerNames,
    deletedPeople,
    removed: { facts, names, citations, media, families, childLinks },
  };
}

/**
 * A second exported record matched to a person merged in this tree: list it,
 * and offer only what it adds (facts, names, sources, tags, media the person
 * lacks). Its conflicting values (another birth, another sex) are not offered
 * as changes, since the user already chose when merging.
 */
function foldMerged(
  r: PersonReview,
  e: SnapPerson,
  i: SnapPerson,
  m: PersonMatch,
  adder: (
    r: PersonReview,
    defaults: Partial<ReviewChange>,
  ) => (change: ReimportChange, extra?: Partial<ReviewChange>) => ReviewChange,
  typedNames: Set<string>,
) {
  const confident = m.confidence >= HIGH_CONFIDENCE;
  const add = adder(r, confident ? {} : { defaultAccept: false });
  add(
    { kind: 'merged', incomingId: i.row.id, incomingName: displayName(i) },
    { applicable: false, defaultAccept: false },
  );
  const offered = new Set(
    r.changes.flatMap((c) =>
      c.kind === 'fact.add'
        ? [factKey(c.fact)]
        : c.kind === 'name.add'
          ? [`name|${norm(c.name)}`]
          : [],
    ),
  );
  const names = new Set(
    e.names.map((n) => `name|${norm([n.given, n.surname].filter(Boolean).join(' '))}`),
  );
  for (const n of i.names) {
    const full = [n.given, n.surname].filter(Boolean).join(' ');
    const key = `name|${norm(full)}`;
    if (names.has(key) || offered.has(key)) continue;
    offered.add(key);
    add({
      kind: 'name.add',
      incomingNameId: n.id,
      name: full,
      nameType: typedNames.has(n.id) ? n.type : null,
    });
  }
  for (const ie of i.events) {
    const same = e.events.find((ee) => sameFact(ee, ie));
    if (same) {
      diffCitations(same, ie, add);
      continue;
    }
    const key = factKey(factOf(ie));
    if (offered.has(key)) continue;
    offered.add(key);
    // A second birth or death from the duplicate is an alternate at most: not pre-ticked.
    add(
      { kind: 'fact.add', incomingEventId: ie.row.id, fact: factOf(ie), owner: 'person' },
      SINGULAR.has(ie.row.type) ? { defaultAccept: false } : {},
    );
  }
  diffCitations(null, null, add, {
    existing: e.citations,
    incoming: i.citations,
    personId: e.row.id,
  });
  const tags = new Set(e.tags.map((t) => t.key));
  for (const t of i.tags) {
    if (tags.has(t.key)) continue;
    tags.add(t.key);
    add({
      kind: 'tag.add',
      incomingTagId: t.id,
      tag: t.category ? `${t.category}: ${t.name}` : t.name,
    });
  }
  const media = new Set(e.media.map((x) => x.key));
  for (const x of i.media) {
    if (media.has(x.key)) continue;
    media.add(x.key);
    add({ kind: 'media.add', incomingMediaId: x.row.id, title: x.row.title });
  }
}

/** Whether the user removed something like this here: such changes are offered unticked. */
interface Removed {
  /**
   * Whether the user deleted a fact like this: 'same' when the export still
   * has it as it was (nothing to offer), 'changed' when the export changed it.
   */
  fact(ownerId: string, type: string, date: string | null): 'same' | 'changed' | false;
  citation(ownerId: string, c: SnapCitation): boolean;
  /** The user edited this event, but the export still has the value it had then (#185). */
  baseUnchanged(eventId: string, incoming: SnapEvent): boolean;
}

const DELETED: Partial<ReviewChange> = { conflict: 'local-delete', defaultAccept: false };

const factKey = (f: FactView) =>
  `fact|${f.type}|${norm(f.customType)}|${norm(f.date)}|${norm(f.place)}|${norm(f.value)}`;

/** Pairs the incoming person's events with the existing person's. */
function diffFacts(
  e: SnapPerson,
  i: SnapPerson,
  edited: Set<string>,
  add: (change: ReimportChange, extra?: Partial<ReviewChange>) => void,
  removed: Removed,
) {
  const used = new Set<string>();
  const findSame = (ie: SnapEvent) =>
    e.events.find((ee) => !used.has(ee.row.id) && sameFact(ee, ie));
  const pending: SnapEvent[] = [];
  for (const ie of i.events) {
    const same = findSame(ie);
    if (same) {
      used.add(same.row.id);
      diffCitations(same, ie, add, undefined, removed);
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
      // Only the user changed it: their edit stands and there is nothing to offer.
      if (conflict && removed.baseUnchanged(counterpart.row.id, ie)) continue;
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
      diffCitations(counterpart, ie, add, undefined, removed);
    } else {
      const deleted = removed.fact(e.row.id, ie.row.type, ie.row.date_text);
      if (deleted === 'same') continue;
      add(
        { kind: 'fact.add', incomingEventId: ie.row.id, fact: factOf(ie), owner: 'person' },
        deleted ? DELETED : {},
      );
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
  personCitations?: { existing: SnapCitation[]; incoming: SnapCitation[]; personId: string },
  removed?: Removed,
) {
  const have = new Set((existing?.citations ?? personCitations?.existing ?? []).map(citationKey));
  const owner = existing?.row.id ?? personCitations?.personId;
  for (const c of incoming?.citations ?? personCitations?.incoming ?? []) {
    if (have.has(citationKey(c))) continue;
    have.add(citationKey(c));
    // The user removed this citation and the export still has it: their removal stands.
    if (owner && removed?.citation(owner, c)) continue;
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
  local: LocalHistory,
  nearMisses: Map<string, NearMiss> = new Map(),
  typedNames: Set<string> = new Set(),
): ReimportDiff {
  const { edited } = local;
  const gone = local.removed;
  const removed: Removed = {
    fact: (owner, type, date) => {
      const like = (gone.facts.get(owner) ?? []).filter((f) => f.type === type);
      if (like.some((f) => f.date === norm(date))) return 'same';
      return SINGULAR.has(type) && like.length ? 'changed' : false;
    },
    citation: (owner, c) => gone.citations.has(`${owner}|${c.sourceKey}|${norm(c.page)}`),
    baseUnchanged: (eventId, ie) => {
      const was = local.base.get(`event|${eventId}`);
      return (
        !!was &&
        was.type === ie.row.type &&
        sameText(was.custom_type as string | null, ie.row.custom_type) &&
        sameText(was.date_text as string | null, ie.row.date_text) &&
        sameText((was.place_name as string | null) ?? null, ie.place) &&
        sameText(was.value as string | null, ie.row.value)
      );
    },
  };
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

  // Matched people: facts, names, sex, citations, tags and media. When several
  // exported records match one person (merged in this tree), the best match
  // is compared; the others are folded into it, not added again.
  const compared = new Map<string, PersonReview>();
  const ordered = [...matches.values()].sort((a, b) => b.confidence - a.confidence);
  for (const m of ordered) {
    const folded = compared.get(m.existingId);
    if (folded) {
      foldMerged(
        folded,
        existing.people.get(m.existingId)!,
        incoming.people.get(m.incomingId)!,
        m,
        adder,
        typedNames,
      );
      if (folded.changes.length && !reviews.has(folded.key)) {
        reviews.set(folded.key, folded);
        people.push(folded);
      }
      continue;
    }
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
    compared.set(m.existingId, r);
    // A low-confidence match is offered, never pre-accepted.
    const add = adder(r, m.confidence >= HIGH_CONFIDENCE ? {} : { defaultAccept: false });
    const sexBase = local.base.get(`person|${e.row.id}`)?.sex;
    // Three-way (#185): if only the user changed it, there is nothing to offer.
    if (i.row.sex !== 'U' && i.row.sex !== e.row.sex && sexBase !== i.row.sex) {
      add(
        { kind: 'sex', before: e.row.sex, after: i.row.sex },
        edited.has(`person|${e.row.id}`) ? { conflict: 'local-edit', defaultAccept: false } : {},
      );
    }
    const names = new Set(e.names.map((n) => `${norm(n.given)}|${norm(n.surname)}`));
    // A name the export has but the tree lacks may be one the user changed: keep their edit.
    const renamed = local.renamed.has(e.row.id);
    const removedNames = gone.names.get(e.row.id);
    const formerNames = local.formerNames.get(e.row.id);
    for (const n of i.names) {
      if (names.has(`${norm(n.given)}|${norm(n.surname)}`)) continue;
      // A name the user changed or removed, still in the export as it was: their edit stands.
      if (formerNames?.has(norm(fullName(n))) || removedNames?.has(norm(fullName(n)))) continue;
      add(
        {
          kind: 'name.add',
          incomingNameId: n.id,
          name: fullName(n),
          nameType: typedNames.has(n.id) ? n.type : null,
        },
        renamed ? { conflict: 'local-edit', defaultAccept: false } : {},
      );
    }
    diffFacts(e, i, edited, add, removed);
    diffCitations(
      null,
      null,
      add,
      { existing: e.citations, incoming: i.citations, personId: e.row.id },
      removed,
    );
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
      // A photo the user unlinked and the export still has: their removal stands.
      if (!media.has(x.key) && !gone.media.has(`${e.row.id}|${x.key}`))
        add({ kind: 'media.add', incomingMediaId: x.row.id, title: x.row.title });
    }
    if (r.changes.length) {
      reviews.set(r.key, r);
      people.push(r);
    }
  }

  // People merged here who absorbed fewer exported records than were merged into them.
  const spare = new Map<string, number>();
  for (const owner of existing.importXrefs.values()) spare.set(owner, (spare.get(owner) ?? 0) + 1);
  for (const m of matches.values()) spare.set(m.existingId, (spare.get(m.existingId) ?? 1) - 1);
  // Almost everyone has exactly the records they matched: keep only those with room left.
  for (const [id, left] of spare) if (left <= 0) spare.delete(id);
  const relativesOf = (p: SnapPerson) => [...p.parents, ...p.spouses, ...p.children];
  /** A merged person with room left who shares a parent, partner or child with `i`. */
  const possiblyMerged = (i: SnapPerson): SnapPerson | undefined => {
    const mapped = new Set(relativesOf(i).flatMap((r) => toExisting.get(r) ?? []));
    if (!mapped.size) return undefined;
    for (const [id, left] of spare) {
      if (left <= 0) continue;
      const e = existing.people.get(id);
      if (e && relativesOf(e).some((r) => mapped.has(r))) return e;
    }
    return undefined;
  };

  // New people.
  for (const i of incoming.people.values()) {
    if (toExisting.has(i.row.id)) continue;
    const suspect = possiblyMerged(i);
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
    // Someone deleted here: same name, and the same birth year when both are known.
    const deletedHere = local.deletedPeople.some(
      (d) =>
        i.names.some((n) => d.names.has(norm(fullName(n)))) &&
        (d.birthYear === null || i.birthYear === null || Math.abs(d.birthYear - i.birthYear) <= 1),
    );
    if (deletedHere) {
      adder(r, { applicable: false, defaultAccept: false })({ kind: 'deleted-here' });
    }
    // Why there is no match: the closest tree person, if any. A close one may be a duplicate.
    const near = nearMisses.get(i.row.id);
    const nearName = near && displayName(existing.people.get(near.existingId)!);
    r.reasons = near
      ? [`closest: ${nearName}, ${Math.round(near.score * 100)}%`]
      : ['no one with a similar name in your tree'];
    const lookalike = !suspect && near && near.score >= POSSIBLE_MATCH ? near : undefined;
    if (lookalike) {
      adder(r, { applicable: false, defaultAccept: false })({
        kind: 'possible-match',
        existingId: lookalike.existingId,
        existingName: nearName!,
        confidence: lookalike.score,
        taken: lookalike.taken,
      });
    }
    if (suspect) {
      // Until merges are recorded as aliases (#70), a shared relative is the hint: never pre-ticked.
      adder(r, { applicable: false, defaultAccept: false })({
        kind: 'possibly-merged',
        existingId: suspect.row.id,
        existingName: displayName(suspect),
      });
      spare.set(suspect.row.id, (spare.get(suspect.row.id) ?? 1) - 1);
    }
    newPersonChange.set(
      i.row.id,
      adder(
        r,
        suspect || deletedHere || lookalike ? { defaultAccept: false } : {},
      )({ kind: 'person.new', incomingId: i.row.id }).id,
    );
  }

  // Relationships: incoming families mapped onto existing people and new people.
  const mapPerson = (id: string | null) => (id ? (toExisting.get(id) ?? `new:${id}`) : null);
  const familyKey = (a: string | null, b: string | null) => [a, b].filter(Boolean).sort().join('+');
  const existingFamilies = new Map<string, string>();
  const familiesOf = new Map<string, FamilyRow[]>();
  for (const f of existing.families.values()) {
    existingFamilies.set(familyKey(f.partner1_id, f.partner2_id), f.id);
    for (const p of [f.partner1_id, f.partner2_id]) {
      if (p) familiesOf.set(p, [...(familiesOf.get(p) ?? []), f]);
    }
  }
  const keyOfFamily = (id: string) => {
    const f = existing.families.get(id)!;
    return familyKey(f.partner1_id, f.partner2_id);
  };
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
  const nameOf = (incomingId: string) => {
    const existingId = toExisting.get(incomingId);
    return displayName(
      existingId ? existing.people.get(existingId)! : incoming.people.get(incomingId)!,
    );
  };
  const requiresFor = (ids: string[]) =>
    ids.flatMap((id) => (toExisting.has(id) ? [] : [newPersonChange.get(id)!]));
  const lowConfidence = (ids: string[]) =>
    ids.some((id) => (matches.get(id)?.confidence ?? 1) < HIGH_CONFIDENCE);

  /**
   * A tree family the export now lists with a partner missing (Ancestry
   * dropped one): the one holding the most of its children, if that is clear.
   */
  const partnerDropped = (f: FamilyRow, partners: string[]): string | undefined => {
    const mapped = partners.map((p) => toExisting.get(p));
    if (!mapped.length || mapped.some((p) => !p)) return undefined;
    const kids = new Set((incomingChildren.get(f.id) ?? []).map((c) => mapPerson(c)));
    const candidates = (familiesOf.get(mapped[0]!) ?? [])
      .filter((ef) => {
        const has = [ef.partner1_id, ef.partner2_id].filter(Boolean);
        return has.length > mapped.length && mapped.every((p) => has.includes(p!));
      })
      .map((ef) => ({
        id: ef.id,
        shared: (childrenOf.get(ef.id) ?? []).filter((c) => kids.has(c.child_id)).length,
      }))
      .sort((a, b) => b.shared - a.shared);
    if (candidates.length === 1) return candidates[0]!.id;
    if (candidates.length > 1 && candidates[0]!.shared > candidates[1]!.shared) {
      return candidates[0]!.id;
    }
    return undefined;
  };
  const childrenOf = new Map<string, FamilyChildRef[]>();
  for (const c of existing.familyChildren) {
    childrenOf.set(c.family_id, [...(childrenOf.get(c.family_id) ?? []), c]);
  }
  const familyMatches: Record<string, string> = {};
  /** Tree families the export lists with a partner dropped, and the partners it still has. */
  const dropped = new Map<string, string[]>();

  for (const f of incoming.families.values()) {
    const partners = [f.partner1_id, f.partner2_id].filter((p): p is string => !!p);
    const key = familyKey(mapPerson(f.partner1_id), mapPerson(f.partner2_id));
    const exact = existingFamilies.get(key);
    const partial = exact ? undefined : partnerDropped(f, partners);
    const existingFamily = exact ?? partial;
    if (existingFamily) familyMatches[f.id] = existingFamily;
    if (partial)
      dropped.set(
        partial,
        partners.map((p) => toExisting.get(p)!),
      );
    const owner = partners[0] ?? incomingChildren.get(f.id)?.[0];
    if (!owner) continue;
    if (!existingFamily && partners.length === 2 && !gone.families.has(key)) {
      adder(reviewFor(owner), lowConfidence(partners) ? { defaultAccept: false } : {})(
        {
          kind: 'family.add',
          incomingFamilyId: f.id,
          partners,
          partnerNames: partners.map(nameOf),
        },
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
        const deleted = removed.fact(existingFamily, fe.type, fe.date_text);
        if (deleted === 'same') continue;
        adder(reviewFor(owner), lowConfidence(partners) ? { defaultAccept: false } : {})(
          {
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
          },
          deleted ? DELETED : {},
        );
      }
    }
    for (const child of incomingChildren.get(f.id) ?? []) {
      const mappedChild = mapPerson(child)!;
      if (existingFamily && existingChildren.has(`${existingFamily}|${mappedChild}`)) continue;
      // A parent link the user removed, still in the export: their removal stands.
      if (
        gone.childLinks.has(`${existingFamily ? keyOfFamily(existingFamily) : key}|${mappedChild}`)
      ) {
        continue;
      }
      const involved = [child, ...partners];
      // Joining a family the export lists with a partner dropped: the user's call.
      adder(reviewFor(child), lowConfidence(involved) || partial ? { defaultAccept: false } : {})(
        {
          kind: 'child.add',
          incomingFamilyId: f.id,
          incomingChildId: child,
          partners,
          parentNames: partners.map(nameOf),
        },
        { requires: requiresFor(involved) },
      );
    }
  }

  // A new person is added by default only if one of their links is too: a new
  // child of a partnership the tree doesn't have would otherwise end up with no parents.
  const links = new Map<string, ReviewChange[]>();
  for (const p of people) {
    for (const c of p.changes) {
      const ids =
        c.kind === 'child.add' ? [c.incomingChildId] : c.kind === 'family.add' ? c.partners : [];
      for (const id of ids) links.set(id, [...(links.get(id) ?? []), c]);
    }
  }
  for (const [incomingId, changeId] of newPersonChange) {
    const own = links.get(incomingId);
    if (!own?.length || own.some((c) => c.defaultAccept)) continue;
    const r = reviews.get(`n:${incomingId}`)!;
    const added = r.changes.find((c) => c.id === changeId)!;
    if (!added.defaultAccept) continue;
    added.defaultAccept = false;
    adder(r, { applicable: false, defaultAccept: false })({ kind: 'unlinked-new' });
  }

  // Partnerships and parent links from an earlier import that the export dropped.
  // Only between people still in the export: anyone missing is listed below.
  const incomingFamilies = new Map<string, Set<string>>();
  for (const f of incoming.families.values()) {
    const matched = familyMatches[f.id];
    incomingFamilies.set(
      matched
        ? keyOfFamily(matched)
        : familyKey(mapPerson(f.partner1_id), mapPerson(f.partner2_id)),
      new Set((incomingChildren.get(f.id) ?? []).map((c) => mapPerson(c)!)),
    );
  }
  const existingName = (id: string) => displayName(existing.people.get(id)!);
  const matchedReview = (existingId: string) =>
    reviews.get(`m:${existingId}`) ??
    review(`m:${existingId}`, () => {
      const e = existing.people.get(existingId)!;
      const m = [...matches.values()].find((x) => x.existingId === existingId)!;
      return {
        key: `m:${existingId}`,
        status: 'matched',
        existingId,
        incomingId: m.incomingId,
        name: displayName(e),
        lifespan: lifespan(e),
        confidence: m.confidence,
        reasons: m.reasons,
        changes: [],
      };
    });
  const info = { applicable: false, defaultAccept: false };
  for (const f of existing.families.values()) {
    if (!f.import_batch_id) continue;
    const partners = [f.partner1_id, f.partner2_id].filter((p): p is string => !!p);
    if (!partners.every((p) => matchedExisting.has(p))) continue;
    const kids = incomingFamilies.get(familyKey(f.partner1_id, f.partner2_id));
    const partnerNames = partners.map(existingName);
    // Listed once per couple: on a partner the export still has with them, else the first.
    const kept = dropped.get(f.id);
    if ((!kids || kept) && partners.length === 2) {
      adder(
        matchedReview(kept?.[0] ?? partners[0]!),
        info,
      )({
        kind: 'family.missing',
        existingFamilyId: f.id,
        partnerNames,
      });
    }
    for (const c of childrenOf.get(f.id) ?? []) {
      if (!matchedExisting.has(c.child_id) || kids?.has(c.child_id)) continue;
      // A child the user linked here never came from an export.
      if (edited.has(`family_child|${c.id}`)) continue;
      adder(
        matchedReview(c.child_id),
        info,
      )({
        kind: 'child.missing',
        existingFamilyId: f.id,
        parentNames: partnerNames,
      });
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
    familyMatches,
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
