import type { ChildRelationship, LivingStatus, Privacy, RelationshipType, Sex } from './enums';
import { NotFoundError, type TreeStore } from './store';
import type {
  CitationLinkRow,
  CitationRow,
  EventRoleRow,
  EventRow,
  FamilyChildRow,
  FamilyRow,
  MediaLinkRow,
  MediaRow,
  NoteLinkRow,
  NoteRow,
  PersonNameRow,
  PersonRow,
  PlaceRow,
  SourceRow,
  TagRow,
} from './types';

/*
 * Read models for the server. Summaries and graph slices are camelCase DTOs
 * (they go straight to the web app); detail views embed raw rows.
 */

const IDS = 'SELECT value FROM json_each(?)';

/** GEDCOM event types used for the birth / death line, best first. */
export const BIRTH_TYPES = ['BIRT', 'CHR', 'BAPM'] as const;
export const DEATH_TYPES = ['DEAT', 'BURI', 'CREM'] as const;

export interface EventBrief {
  eventId: string;
  type: string;
  dateText: string | null;
  dateQualifier: string | null;
  dateSort: number | null;
  place: string | null;
}

export interface PersonSummary {
  id: string;
  sex: Sex;
  living: LivingStatus;
  privacy: Privacy;
  primaryMediaId: string | null;
  /**
   * The primary photo has a local file (not only an Ancestry URL, and not a
   * file missing at import), so clients can request its thumbnail.
   */
  primaryPhotoLocal: boolean;
  /** The primary photo's bytes, shortened (sha256 prefix), so its URLs change with its file. */
  primaryPhotoVersion: string | null;
  given: string | null;
  surname: string | null;
  surnamePrefix: string | null;
  prefix: string | null;
  suffix: string | null;
  nickname: string | null;
  birth: EventBrief | null;
  death: EventBrief | null;
}

interface SummaryRow {
  id: string;
  sex: Sex;
  living: LivingStatus;
  privacy: Privacy;
  primary_media_id: string | null;
  primary_local: number;
  primary_version: string | null;
  given: string | null;
  surname: string | null;
  surname_prefix: string | null;
  prefix: string | null;
  suffix: string | null;
  nickname: string | null;
}

interface VitalRow {
  person_id: string;
  event_id: string;
  type: string;
  date_text: string | null;
  date_qualifier: string | null;
  date_sort: number | null;
  place: string | null;
  is_preferred: number;
  sort_order: number;
}

const VITAL_TYPES = [...BIRTH_TYPES, ...DEATH_TYPES].map((t) => `'${t}'`).join(', ');

/**
 * Summaries for many people in two queries, returned in request order (unknown
 * ids skipped). CROSS JOIN pins the join order so SQLite drives from the id list
 * instead of scanning every event of a vital type.
 */
export function getPersonSummaries(store: TreeStore, ids: readonly string[]): PersonSummary[] {
  if (ids.length === 0) return [];
  const json = JSON.stringify(ids);
  const rows = store
    .stmt(
      `SELECT p.id, p.sex, p.living, p.privacy, p.primary_media_id,
              m.local_path IS NOT NULL AS primary_local,
              substr(m.sha256, 1, 16) AS primary_version,
              n.given, n.surname, n.surname_prefix, n.prefix, n.suffix, n.nickname
       FROM person p LEFT JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1
       LEFT JOIN media m ON m.id = p.primary_media_id
       WHERE p.id IN (${IDS})`,
    )
    .all(json) as SummaryRow[];
  const vitals = store
    .stmt(
      `SELECT r.person_id, e.id AS event_id, e.type, e.date_text, e.date_qualifier, e.date_sort,
              pl.full_name AS place, r.is_preferred, r.sort_order
       FROM json_each(?) j
       CROSS JOIN event_role r ON r.person_id = j.value AND r.role = 'principal'
       CROSS JOIN event e ON e.id = r.event_id AND e.type IN (${VITAL_TYPES})
       LEFT JOIN place pl ON pl.id = e.place_id`,
    )
    .all(json) as VitalRow[];

  const byPerson = new Map<string, VitalRow[]>();
  for (const v of vitals) {
    const list = byPerson.get(v.person_id);
    if (list) list.push(v);
    else byPerson.set(v.person_id, [v]);
  }
  const summaries = new Map<string, PersonSummary>();
  for (const r of rows) {
    const mine = byPerson.get(r.id) ?? [];
    summaries.set(r.id, {
      id: r.id,
      sex: r.sex,
      living: r.living,
      privacy: r.privacy,
      primaryMediaId: r.primary_media_id,
      primaryPhotoLocal: r.primary_local === 1,
      primaryPhotoVersion: r.primary_version,
      given: r.given,
      surname: r.surname,
      surnamePrefix: r.surname_prefix,
      prefix: r.prefix,
      suffix: r.suffix,
      nickname: r.nickname,
      birth: pickVital(mine, BIRTH_TYPES),
      death: pickVital(mine, DEATH_TYPES),
    });
  }
  return ids.flatMap((id) => summaries.get(id) ?? []);
}

function pickVital(rows: VitalRow[], types: readonly string[]): EventBrief | null {
  let best: VitalRow | undefined;
  let bestRank = Infinity;
  for (const r of rows) {
    const typeRank = types.indexOf(r.type);
    if (typeRank < 0) continue;
    // Type priority first, then preferred alternates, then role order.
    const rank = typeRank * 1e6 + (r.is_preferred ? 0 : 5e5) + r.sort_order;
    if (rank < bestRank || (rank === bestRank && best && r.event_id < best.event_id)) {
      best = r;
      bestRank = rank;
    }
  }
  return best
    ? {
        eventId: best.event_id,
        type: best.type,
        dateText: best.date_text,
        dateQualifier: best.date_qualifier,
        dateSort: best.date_sort,
        place: best.place,
      }
    : null;
}

export function getPersonSummary(store: TreeStore, id: string): PersonSummary | null {
  return getPersonSummaries(store, [id])[0] ?? null;
}

// ---------------------------------------------------------------- detail

export interface CitationDetail {
  link: CitationLinkRow;
  citation: CitationRow;
  source: SourceRow;
}

export interface EventDetail {
  event: EventRow;
  role: EventRoleRow;
  place: PlaceRow | null;
  citations: CitationDetail[];
  notes: NoteRow[];
}

export interface RelativeLink {
  person: PersonSummary;
  link: FamilyChildRow;
}

export interface ParentFamily {
  family: FamilyRow;
  /** How this person is a child of the family. */
  link: FamilyChildRow;
  partner1: PersonSummary | null;
  partner2: PersonSummary | null;
  siblings: RelativeLink[];
}

export interface PartnerFamily {
  family: FamilyRow;
  partner: PersonSummary | null;
  children: RelativeLink[];
  events: EventDetail[];
}

export interface PersonDetail {
  person: PersonRow;
  summary: PersonSummary;
  names: PersonNameRow[];
  /** Events the person has a role in, by date (undated last). */
  events: EventDetail[];
  /** Citations attached to the person record itself. */
  citations: CitationDetail[];
  parentFamilies: ParentFamily[];
  partnerFamilies: PartnerFamily[];
  media: { media: MediaRow; link: MediaLinkRow }[];
  notes: NoteRow[];
  tags: TagRow[];
}

function rows<R>(store: TreeStore, sql: string, ...params: unknown[]): R[] {
  return store.stmt(sql).all(...params) as R[];
}

/** Events with places, citations and notes for a set of roles. */
function eventDetails(store: TreeStore, roles: EventRoleRow[]): EventDetail[] {
  if (roles.length === 0) return [];
  const eventIds = JSON.stringify(roles.map((r) => r.event_id));
  const eventsById = new Map(
    rows<EventRow>(store, `SELECT * FROM event WHERE id IN (${IDS})`, eventIds).map((e) => [
      e.id,
      e,
    ]),
  );
  const placeIds = JSON.stringify([...eventsById.values()].map((e) => e.place_id).filter(Boolean));
  const placesById = new Map(
    rows<PlaceRow>(store, `SELECT * FROM place WHERE id IN (${IDS})`, placeIds).map((p) => [
      p.id,
      p,
    ]),
  );
  const citations = citationDetails(store, 'event', eventIds);
  const notes = noteDetails(store, 'event', eventIds);
  return roles
    .map((role) => {
      const event = eventsById.get(role.event_id) as EventRow;
      return {
        event,
        role,
        place: event.place_id ? (placesById.get(event.place_id) ?? null) : null,
        citations: citations.get(event.id) ?? [],
        notes: notes.get(event.id) ?? [],
      };
    })
    .sort(
      (a, b) =>
        (a.event.date_sort ?? Infinity) - (b.event.date_sort ?? Infinity) ||
        a.role.sort_order - b.role.sort_order ||
        (a.event.id < b.event.id ? -1 : 1),
    );
}

function byId<R extends { id: string }>(list: R[]): Map<string, R> {
  return new Map(list.map((r) => [r.id, r]));
}

function groupBy<R>(list: R[], key: (r: R) => string): Map<string, R[]> {
  const groups = new Map<string, R[]>();
  for (const r of list) {
    const k = key(r);
    const group = groups.get(k);
    if (group) group.push(r);
    else groups.set(k, [r]);
  }
  return groups;
}

function citationDetails(store: TreeStore, ownerType: string, ownerIdsJson: string) {
  const links = rows<CitationLinkRow>(
    store,
    `SELECT * FROM citation_link WHERE owner_type = ? AND owner_id IN (${IDS}) ORDER BY sort_order, id`,
    ownerType,
    ownerIdsJson,
  );
  if (links.length === 0) return new Map<string, CitationDetail[]>();
  const citations = byId(
    rows<CitationRow>(
      store,
      `SELECT * FROM citation WHERE id IN (${IDS})`,
      JSON.stringify(links.map((l) => l.citation_id)),
    ),
  );
  const sources = byId(
    rows<SourceRow>(
      store,
      `SELECT * FROM source WHERE id IN (${IDS})`,
      JSON.stringify([...citations.values()].map((c) => c.source_id)),
    ),
  );
  const details = links.map((link) => {
    const citation = citations.get(link.citation_id) as CitationRow;
    return { link, citation, source: sources.get(citation.source_id) as SourceRow };
  });
  return groupBy(details, (d) => d.link.owner_id);
}

function noteDetails(store: TreeStore, ownerType: string, ownerIdsJson: string) {
  const links = rows<NoteLinkRow>(
    store,
    `SELECT * FROM note_link WHERE owner_type = ? AND owner_id IN (${IDS}) ORDER BY sort_order, id`,
    ownerType,
    ownerIdsJson,
  );
  const notes = byId(
    rows<NoteRow>(
      store,
      `SELECT * FROM note WHERE id IN (${IDS})`,
      JSON.stringify(links.map((l) => l.note_id)),
    ),
  );
  return new Map(
    [...groupBy(links, (l) => l.owner_id)].map(([owner, list]) => [
      owner,
      list.map((l) => notes.get(l.note_id) as NoteRow),
    ]),
  );
}

/** Everything the person page needs, in a handful of indexed queries. */
export function getPersonDetail(store: TreeStore, id: string): PersonDetail | null {
  const person = store.getRow('person', id);
  if (!person) return null;
  const idJson = JSON.stringify([id]);

  const names = rows<PersonNameRow>(
    store,
    'SELECT * FROM person_name WHERE person_id = ? ORDER BY is_primary DESC, sort_order, id',
    id,
  );
  const roles = rows<EventRoleRow>(store, 'SELECT * FROM event_role WHERE person_id = ?', id);

  const childLinks = rows<FamilyChildRow>(
    store,
    'SELECT * FROM family_child WHERE child_id = ? ORDER BY child_order, id',
    id,
  );
  const parentFams = rows<FamilyRow>(
    store,
    `SELECT f.* FROM family_child fc JOIN family f ON f.id = fc.family_id
     WHERE fc.child_id = ? ORDER BY fc.child_order, fc.id`,
    id,
  );
  const partnerFams = rows<FamilyRow>(
    store,
    `SELECT * FROM family WHERE partner1_id = @id OR partner2_id = @id
     ORDER BY CASE WHEN partner1_id = @id THEN partner1_order ELSE partner2_order END, id`,
    { id },
  );
  const familyIds = JSON.stringify([...parentFams, ...partnerFams].map((f) => f.id));
  const kin = rows<FamilyChildRow>(
    store,
    `SELECT * FROM family_child WHERE family_id IN (${IDS}) ORDER BY family_id, sort_order, id`,
    familyIds,
  );
  const familyRoles = rows<EventRoleRow>(
    store,
    `SELECT * FROM event_role WHERE family_id IN (${IDS})`,
    JSON.stringify(partnerFams.map((f) => f.id)),
  );

  const relatedIds = new Set<string>([id]);
  for (const f of [...parentFams, ...partnerFams]) {
    if (f.partner1_id) relatedIds.add(f.partner1_id);
    if (f.partner2_id) relatedIds.add(f.partner2_id);
  }
  for (const k of kin) relatedIds.add(k.child_id);
  const summaries = new Map(getPersonSummaries(store, [...relatedIds]).map((s) => [s.id, s]));
  const summary = (pid: string | null) => (pid ? (summaries.get(pid) ?? null) : null);
  const relatives = (familyId: string, exclude: string | null) =>
    kin
      .filter((k) => k.family_id === familyId && k.child_id !== exclude)
      .map((link) => ({ person: summaries.get(link.child_id) as PersonSummary, link }));

  const familyEvents = eventDetails(store, familyRoles);

  return {
    person,
    summary: summaries.get(id) as PersonSummary,
    names,
    events: eventDetails(store, roles),
    citations: citationDetails(store, 'person', idJson).get(id) ?? [],
    parentFamilies: parentFams.map((family) => ({
      family,
      link: childLinks.find((l) => l.family_id === family.id) as FamilyChildRow,
      partner1: summary(family.partner1_id),
      partner2: summary(family.partner2_id),
      siblings: relatives(family.id, id),
    })),
    partnerFamilies: partnerFams.map((family) => ({
      family,
      partner: summary(family.partner1_id === id ? family.partner2_id : family.partner1_id),
      children: relatives(family.id, null),
      events: familyEvents.filter((e) => e.role.family_id === family.id),
    })),
    media: mediaFor(store, id),
    notes: noteDetails(store, 'person', idJson).get(id) ?? [],
    tags: rows<TagRow>(
      store,
      `SELECT t.* FROM tag_link l JOIN tag t ON t.id = l.tag_id
       WHERE l.owner_type = 'person' AND l.owner_id = ? ORDER BY t.category, t.name`,
      id,
    ),
  };
}

function mediaFor(store: TreeStore, personId: string) {
  const links = rows<MediaLinkRow>(
    store,
    "SELECT * FROM media_link WHERE owner_type = 'person' AND owner_id = ? ORDER BY sort_order, id",
    personId,
  );
  const items = byId(
    rows<MediaRow>(
      store,
      `SELECT * FROM media WHERE id IN (${IDS})`,
      JSON.stringify(links.map((l) => l.media_id)),
    ),
  );
  return links.map((link) => ({ media: items.get(link.media_id) as MediaRow, link }));
}

// ---------------------------------------------------------------- neighborhood

export interface FamilyEdge {
  id: string;
  partner1Id: string | null;
  partner2Id: string | null;
  relationshipType: RelationshipType;
  partner1Order: number;
  partner2Order: number;
}

export interface ChildEdge {
  familyId: string;
  childId: string;
  partner1Rel: ChildRelationship;
  partner2Rel: ChildRelationship;
  /** Birth order within the family. */
  sortOrder: number;
  /** Position among the child's parent families (GEDCOM `FAMC` order). */
  childOrder: number;
  /** The child's preferred parent family: the default parent set to draw. */
  isPreferred: boolean;
}

export interface Neighborhood {
  focusId: string;
  /** Focus first, then breadth-first; each person once even with pedigree collapse. */
  people: PersonSummary[];
  /** Partner edges. */
  families: FamilyEdge[];
  /** Parent-child edges (child to family). */
  children: ChildEdge[];
  /** People at the top edge who have parents not included. */
  moreUp: string[];
  /** People at the bottom edge who have children not included. */
  moreDown: string[];
  /**
   * People whose children (in every partner family) are all included: the
   * focus and descendants above the bottom edge, and ancestors whose
   * siblings were fetched. A person missing here may have more children
   * than the slice shows, even if some are in it.
   */
  childrenLoaded: string[];
  /**
   * Line ancestors past `siblingsDepth` who have siblings (or half siblings)
   * the slice left out: the tree offers to show them.
   */
  moreSiblings: string[];
  /** People whose siblings, half siblings included, are all in the slice. */
  siblingsLoaded: string[];
  /** True when the slice hit `maxPeople` and stopped early. */
  truncated: boolean;
}

export interface NeighborhoodOptions {
  /** Generations of ancestors (default 4). */
  up?: number;
  /** Generations of descendants (default 3). */
  down?: number;
  /**
   * Ancestor generations whose siblings to include: 0 none, 1 the focus
   * person's siblings (default), 2 also aunts and uncles, and so on, up to
   * `up`. Half siblings (through a parent's other partner families, with the
   * step-parent) count too. Siblings come with their partner families but
   * not their descendants; those with children are listed in `moreDown`.
   */
  siblingsDepth?: number;
  /** `false` is the same as `siblingsDepth: 0` (kept for older callers). */
  siblings?: boolean;
  /** Stop expanding past this many people (default and maximum 5000). */
  maxPeople?: number;
}

/** Most generations a single neighborhood request walks in each direction. */
export const MAX_NEIGHBORHOOD_GENERATIONS = 10;
export const MAX_NEIGHBORHOOD_PEOPLE = 5000;

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : min;

/**
 * A compact graph slice around a person for the tree views: ancestors `up`
 * generations, descendants `down` generations with their partners, and the
 * siblings of the focus person and of ancestors `siblingsDepth` generations
 * up. One batched query per generation and direction.
 */
export function getNeighborhood(
  store: TreeStore,
  focusId: string,
  options: NeighborhoodOptions = {},
): Neighborhood {
  if (!store.getRow('person', focusId)) throw new NotFoundError('person', focusId);
  // Clamp here too, not only in the API, so no caller can walk a whole tree.
  const up = clamp(options.up ?? 4, 0, MAX_NEIGHBORHOOD_GENERATIONS);
  const down = clamp(options.down ?? 3, 0, MAX_NEIGHBORHOOD_GENERATIONS);
  const maxPeople = clamp(options.maxPeople ?? MAX_NEIGHBORHOOD_PEOPLE, 1, MAX_NEIGHBORHOOD_PEOPLE);
  const siblingsDepth = clamp(
    options.siblingsDepth ?? (options.siblings === false ? 0 : 1),
    0,
    MAX_NEIGHBORHOOD_GENERATIONS,
  );
  // Siblings of ancestors who are themselves on the line are not siblings here.
  const siblingIds = new Set<string>();
  let truncated = false;
  const full = () => {
    if (people.size >= maxPeople) truncated = true;
    return truncated;
  };
  const people = new Set<string>([focusId]);
  const families = new Map<string, FamilyEdge>();
  const children = new Map<string, ChildEdge>();

  const addFamily = (f: FamilyRow) => {
    if (families.has(f.id)) return;
    families.set(f.id, {
      id: f.id,
      partner1Id: f.partner1_id,
      partner2Id: f.partner2_id,
      relationshipType: f.relationship_type,
      partner1Order: f.partner1_order,
      partner2Order: f.partner2_order,
    });
  };
  const addChild = (c: FamilyChildRow) => {
    children.set(c.id, {
      familyId: c.family_id,
      childId: c.child_id,
      partner1Rel: c.partner1_rel,
      partner2Rel: c.partner2_rel,
      sortOrder: c.sort_order,
      childOrder: c.child_order,
      isPreferred: c.is_preferred === 1,
    });
    people.add(c.child_id);
  };
  type ParentRow = FamilyRow & {
    link_id: string;
    child_id: string;
    partner1_rel: ChildRelationship;
    partner2_rel: ChildRelationship;
    sort_order: number;
    child_order: number;
    is_preferred: 0 | 1;
  };
  const parentFamilies = (ids: string[]) =>
    rows<ParentRow>(
      store,
      `SELECT f.*, fc.id AS link_id, fc.child_id, fc.partner1_rel, fc.partner2_rel, fc.sort_order,
              fc.child_order, fc.is_preferred
       FROM family_child fc JOIN family f ON f.id = fc.family_id
       WHERE fc.child_id IN (${IDS}) ORDER BY fc.child_id, fc.child_order, fc.id`,
      JSON.stringify(ids),
    );
  const partnerFamilies = (ids: string[]) =>
    rows<FamilyRow>(
      store,
      `SELECT * FROM family WHERE partner1_id IN (${IDS})
       UNION SELECT * FROM family WHERE partner2_id IN (${IDS}) ORDER BY id`,
      JSON.stringify(ids),
      JSON.stringify(ids),
    );
  const childrenOf = (familyIds: string[]) =>
    rows<FamilyChildRow>(
      store,
      `SELECT * FROM family_child WHERE family_id IN (${IDS}) ORDER BY family_id, sort_order, id`,
      JSON.stringify(familyIds),
    );

  const childrenLoaded = new Set<string>();
  const siblingsLoaded = new Set<string>();
  /** Line ancestors past siblingsDepth, to their siblings in the database. */
  const siblingsOf = new Map<string, string[]>();

  // Ancestors.
  let frontier = [focusId];
  const seenUp = new Set(frontier);
  for (let generation = 0; generation < up && frontier.length > 0 && !full(); generation++) {
    const next: string[] = [];
    const found = parentFamilies(frontier);
    for (const f of found) {
      addFamily(f);
      addChild({ ...f, id: f.link_id, family_id: f.id });
      for (const parent of [f.partner1_id, f.partner2_id]) {
        if (parent && !seenUp.has(parent)) {
          seenUp.add(parent);
          people.add(parent);
          next.push(parent);
        }
      }
    }
    if (generation < siblingsDepth && found.length > 0) {
      const line = new Set(frontier);
      // Half siblings: the parents' other partner families (with the step-parent).
      const parentIds = [
        ...new Set(found.flatMap((f) => [f.partner1_id, f.partner2_id]).filter((p) => p !== null)),
      ] as string[];
      const foundIds = new Set(found.map((f) => f.id));
      const others = partnerFamilies(parentIds).filter((f) => !foundIds.has(f.id));
      for (const f of others) {
        addFamily(f);
        if (f.partner1_id) people.add(f.partner1_id);
        if (f.partner2_id) people.add(f.partner2_id);
      }
      for (const c of childrenOf([...foundIds, ...others.map((f) => f.id)])) {
        addChild(c);
        if (!line.has(c.child_id)) siblingIds.add(c.child_id);
      }
      // Every partner family of these parents came with all its children.
      for (const id of parentIds) childrenLoaded.add(id);
      for (const id of frontier) siblingsLoaded.add(id);
    } else if (found.length > 0) {
      // Past siblingsDepth: say who has siblings (through either parent) left out.
      for (const { id, sib } of rows<{ id: string; sib: string }>(
        store,
        `SELECT DISTINCT me.child_id AS id, sib.child_id AS sib FROM family_child me
         JOIN family pf ON pf.id = me.family_id
         JOIN family f ON f.id = pf.id
           OR f.partner1_id IN (pf.partner1_id, pf.partner2_id)
           OR f.partner2_id IN (pf.partner1_id, pf.partner2_id)
         JOIN family_child sib ON sib.family_id = f.id AND sib.child_id <> me.child_id
         WHERE me.child_id IN (${IDS})`,
        JSON.stringify(frontier),
      )) {
        const list = siblingsOf.get(id);
        if (list) list.push(sib);
        else siblingsOf.set(id, [sib]);
      }
    }
    frontier = next;
  }
  let moreUp =
    frontier.length === 0
      ? []
      : rows<{ child_id: string }>(
          store,
          `SELECT DISTINCT child_id FROM family_child WHERE child_id IN (${IDS}) ORDER BY child_id`,
          JSON.stringify(frontier),
        ).map((r) => r.child_id);

  // Descendants, with each generation's partners.
  frontier = [focusId];
  const seenDown = new Set(frontier);
  let moreDown: string[] = [];
  for (let generation = 0; frontier.length > 0; generation++) {
    const fams = partnerFamilies(frontier);
    for (const f of fams) {
      addFamily(f);
      if (f.partner1_id) people.add(f.partner1_id);
      if (f.partner2_id) people.add(f.partner2_id);
    }
    const kids = fams.length > 0 ? childrenOf(fams.map((f) => f.id)) : [];
    if (generation === down || full()) {
      const frontierSet = new Set(frontier);
      const withKids = new Set(kids.map((k) => k.family_id));
      moreDown = [
        ...new Set(
          fams
            .filter((f) => withKids.has(f.id))
            .flatMap((f) => [f.partner1_id, f.partner2_id])
            .filter((p): p is string => p !== null && frontierSet.has(p)),
        ),
      ].sort();
      break;
    }
    // All the partner families of this generation, with all their children.
    for (const id of frontier) childrenLoaded.add(id);
    const next: string[] = [];
    for (const k of kids) {
      addChild(k);
      if (!seenDown.has(k.child_id)) {
        seenDown.add(k.child_id);
        next.push(k.child_id);
      }
    }
    frontier = next;
  }

  // Siblings come with their partners (to draw couples) but not their
  // children; flag the ones whose children were not fetched.
  const leafSiblings = [...siblingIds].filter((id) => !seenDown.has(id) && !seenUp.has(id));
  if (leafSiblings.length > 0) {
    for (const f of partnerFamilies(leafSiblings)) {
      addFamily(f);
      if (f.partner1_id) people.add(f.partner1_id);
      if (f.partner2_id) people.add(f.partner2_id);
    }
    const json = JSON.stringify(leafSiblings);
    const withChildren = rows<{ id: string }>(
      store,
      `SELECT f.partner1_id AS id FROM family f WHERE f.partner1_id IN (${IDS})
         AND EXISTS (SELECT 1 FROM family_child fc WHERE fc.family_id = f.id)
       UNION SELECT f.partner2_id FROM family f WHERE f.partner2_id IN (${IDS})
         AND EXISTS (SELECT 1 FROM family_child fc WHERE fc.family_id = f.id)`,
      json,
      json,
    ).map((r) => r.id);
    moreDown = [...new Set([...moreDown, ...withChildren])].sort();
  }

  // One generation can overshoot the cap: keep the first maxPeople (focus
  // first, then breadth-first) and only the edges between kept people.
  let kept = [...people];
  let familyEdges = [...families.values()];
  let childEdges = [...children.values()];
  if (kept.length > maxPeople) {
    truncated = true;
    kept = kept.slice(0, maxPeople);
    const keep = new Set(kept);
    familyEdges = familyEdges.filter(
      (f) => (!f.partner1Id || keep.has(f.partner1Id)) && (!f.partner2Id || keep.has(f.partner2Id)),
    );
    const keptFamilies = new Set(familyEdges.map((f) => f.id));
    childEdges = childEdges.filter((c) => keep.has(c.childId) && keptFamilies.has(c.familyId));
    moreUp = moreUp.filter((id) => keep.has(id));
    moreDown = moreDown.filter((id) => keep.has(id));
  }
  // Cut short (even exactly at the cap), the slice may have dropped anyone's
  // children: claim nothing.
  if (truncated) {
    childrenLoaded.clear();
    siblingsLoaded.clear();
  }

  const keptSet = new Set(kept);
  return {
    focusId,
    people: getPersonSummaries(store, kept),
    families: familyEdges,
    children: childEdges,
    moreUp,
    moreDown,
    childrenLoaded: [...childrenLoaded].filter((id) => people.has(id)).sort(),
    // Only siblings the slice does not already hold (with a partner, say).
    moreSiblings: [...siblingsOf]
      .filter(([id, sibs]) => keptSet.has(id) && sibs.some((sib) => !keptSet.has(sib)))
      .map(([id]) => id)
      .sort(),
    siblingsLoaded: [...siblingsLoaded].filter((id) => keptSet.has(id)).sort(),
    truncated,
  };
}

// ---------------------------------------------------------------- list

export type PeopleSort = 'surname' | 'given' | 'birth' | 'death';

export interface ListPeopleOptions {
  sort?: PeopleSort;
  direction?: 'asc' | 'desc';
  sex?: Sex;
  living?: LivingStatus[];
  tagId?: string;
  limit?: number;
  offset?: number;
}

/** The people list order computed from the tables themselves, as person_sort indexes it. */
function sortFromTables(
  store: TreeStore,
  sort: PeopleSort,
  dir: 'ASC' | 'DESC',
  where: string[],
  params: unknown[],
): string[] {
  const vital = (types: readonly string[]) =>
    `LEFT JOIN (SELECT r.person_id, min(e.date_sort) AS k FROM event_role r
      CROSS JOIN event e ON e.id = r.event_id
      WHERE r.role = 'principal' AND e.type IN (${types.map((t) => `'${t}'`).join(', ')})
        AND e.date_sort IS NOT NULL
      GROUP BY r.person_id) v ON v.person_id = p.id`;
  const keys: Record<PeopleSort, string> = {
    surname: `n.surname IS NULL, n.surname COLLATE NOCASE ${dir}, n.given COLLATE NOCASE ${dir}`,
    given: `n.given IS NULL, n.given COLLATE NOCASE ${dir}, n.surname COLLATE NOCASE ${dir}`,
    birth: `v.k IS NULL, v.k ${dir}`,
    death: `v.k IS NULL, v.k ${dir}`,
  };
  const join = sort === 'birth' ? vital(BIRTH_TYPES) : sort === 'death' ? vital(DEATH_TYPES) : '';
  return store
    .stmt(
      `SELECT p.id FROM person p LEFT JOIN person_name n ON n.person_id = p.id AND n.is_primary = 1
       ${join} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY ${keys[sort]}, p.id`,
    )
    .pluck()
    .all(...params) as string[];
}

/*
 * Sorting a whole tree (and OFFSET deep into it) costs far more than reading
 * one page, and the list asks for page after page of the same order while the
 * user scrolls. So the full sorted id list is computed once per (filters,
 * sort, database version) and pages are slices of it. The version combines
 * this connection's total_changes() with PRAGMA data_version (writes from
 * other connections), so any write anywhere invalidates it.
 */
const ORDER_CACHE_SIZE = 4;
const orderCache = new WeakMap<TreeStore, Map<string, string[]>>();

export function databaseVersion(store: TreeStore): string {
  const { changes } = store.stmt('SELECT total_changes() AS changes').get() as { changes: number };
  return `${changes}:${store.db.pragma('data_version', { simple: true }) as number}`;
}

/** The people list: sorted, filtered and paginated, with the total match count. */
export function listPeople(
  store: TreeStore,
  {
    sort = 'surname',
    direction = 'asc',
    sex,
    living,
    tagId,
    limit = 100,
    offset = 0,
  }: ListPeopleOptions = {},
): { total: number; items: PersonSummary[] } {
  const ids = sortedPeople(store, { sort, direction, sex, living, tagId });
  const page = ids.slice(Math.max(0, offset), Math.max(0, offset) + Math.max(0, limit));
  return { total: ids.length, items: getPersonSummaries(store, page) };
}

function sortedPeople(
  store: TreeStore,
  { sort, direction, sex, living, tagId }: Omit<ListPeopleOptions, 'limit' | 'offset'>,
): string[] {
  // Inside an open transaction the order may include writes that roll back,
  // which total_changes() never forgets: compute it, but never cache it.
  const cacheable = !store.db.inTransaction;
  const cacheKey = JSON.stringify([sort, direction, sex, living, tagId, databaseVersion(store)]);
  let cache = orderCache.get(store);
  const hit = cacheable ? cache?.get(cacheKey) : undefined;
  if (hit) {
    // Refresh recency.
    cache!.delete(cacheKey);
    cache!.set(cacheKey, hit);
    return hit;
  }

  // person_sort holds each person's keys (sort-keys.ts), with an index per order and
  // direction, so this reads an index instead of sorting the tree (#114). The order is
  // `key IS NULL, key, [second key,] id` with the direction on the keys; NULL keys are
  // read as a second range so each range is one index scan.
  const desc = direction === 'desc';
  const dir = desc ? 'DESC' : 'ASC';
  // Filters on `alias` (person_sort or person), with the person id in `id`.
  const params: unknown[] = [];
  if (sex) params.push(sex);
  if (living) params.push(JSON.stringify(living));
  if (tagId) params.push(tagId);
  const filters = (alias: string, id: string) => [
    ...(sex ? [`${alias}.sex = ?`] : []),
    ...(living ? [`${alias}.living IN (${IDS})`] : []),
    ...(tagId
      ? [
          `EXISTS (SELECT 1 FROM tag_link t WHERE t.tag_id = ? AND t.owner_type = 'person' AND t.owner_id = ${id})`,
        ]
      : []),
  ];
  const where = filters('s', 's.person_id');
  const orders: Record<PeopleSort, [string, string | null]> = {
    surname: ['surname', 'given'],
    given: ['given', 'surname'],
    birth: ['birth_key', null],
    death: ['death_key', null],
  };
  const name = (sort && Object.hasOwn(orders, sort) ? sort : 'surname') as PeopleSort;
  const [key, second] = orders[name];
  const text = second !== null;
  const index = `person_sort_${name}${desc ? '_desc' : ''}_idx`;
  const by = (column: string) => `s.${column}${text ? ' COLLATE NOCASE' : ''} ${dir}`;
  const range = (isNull: boolean) =>
    store
      .stmt(
        `SELECT s.person_id FROM person_sort s INDEXED BY ${index}
         WHERE s.${key} IS ${isNull ? '' : 'NOT '}NULL${where.map((w) => ` AND ${w}`).join('')}
         ORDER BY ${[...(isNull ? [] : [by(key)]), ...(second ? [by(second)] : []), 's.person_id'].join(', ')}`,
      )
      .pluck()
      .all(...params) as string[];
  // Inside an open transaction person_sort may not have caught up with this unit of
  // work's writes yet (it is refreshed when the work flushes): sort from the tables.
  const ids = store.db.inTransaction
    ? sortFromTables(store, name, dir, filters('p', 'p.id'), params)
    : [...range(false), ...range(true)];

  if (!cacheable) return ids;
  if (!cache) {
    cache = new Map();
    orderCache.set(store, cache);
  }
  cache.set(cacheKey, ids);
  for (const old of [...cache.keys()].slice(0, Math.max(0, cache.size - ORDER_CACHE_SIZE)))
    cache.delete(old);
  return ids;
}

export interface PlaceSuggestion {
  id: string;
  full_name: string;
}

/**
 * Places for suggestions while typing (#280): each full name once, those
 * starting with `query` first (a range on the NOCASE index, so no scan),
 * then names containing it to fill `limit`. LIKE wildcards in the text are
 * literal.
 */
export function suggestPlaces(store: TreeStore, query: string, limit = 10): PlaceSuggestion[] {
  const text = query.trim();
  if (!text || limit < 1) return [];
  const prefix = store
    .stmt(
      `SELECT min(id) AS id, full_name FROM place
       WHERE full_name >= @text COLLATE NOCASE AND full_name < @text || char(1114111) COLLATE NOCASE
       GROUP BY full_name COLLATE NOCASE ORDER BY full_name COLLATE NOCASE LIMIT @limit`,
    )
    .all({ text, limit }) as PlaceSuggestion[];
  if (prefix.length >= limit) return prefix;
  const like = text.replace(/[\\%_]/g, (c) => `\\${c}`);
  const contains = store
    .stmt(
      `SELECT min(id) AS id, full_name FROM place
       WHERE full_name LIKE '%' || @like || '%' ESCAPE '\\'
         AND NOT (full_name >= @text COLLATE NOCASE AND full_name < @text || char(1114111) COLLATE NOCASE)
       GROUP BY full_name COLLATE NOCASE ORDER BY full_name COLLATE NOCASE LIMIT @rest`,
    )
    .all({ like, text, rest: limit - prefix.length }) as PlaceSuggestion[];
  return [...prefix, ...contains];
}
