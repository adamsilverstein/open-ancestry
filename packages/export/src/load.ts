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
  RawRecordRow,
  RepositoryRow,
  SourceRow,
  TagLinkRow,
  TagRow,
  TreeStore,
  UnmappedLineRow,
} from '@open-ancestry/db';

/** Owner key of a polymorphic link: `person|01J...`. */
export const ownerKey = (type: string, id: string) => `${type}|${id}`;

function groupBy<T>(items: T[], key: (item: T) => string | null | undefined): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (k == null) continue;
    const list = map.get(k);
    if (list) list.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const byId = <T extends { id: string }>(items: T[]) => new Map(items.map((i) => [i.id, i]));

/**
 * The whole tree in memory, indexed the way the GEDCOM writer walks it. One
 * query per table keeps a 10k-person export well under a second.
 */
export class TreeData {
  readonly persons: PersonRow[];
  readonly person: Map<string, PersonRow>;
  readonly names: Map<string, PersonNameRow[]>;
  readonly nameOwner: Map<string, string>;
  readonly event: Map<string, EventRow>;
  readonly rolesByPerson: Map<string, EventRoleRow[]>;
  readonly rolesByFamily: Map<string, EventRoleRow[]>;
  readonly rolesByEvent: Map<string, EventRoleRow[]>;
  readonly eventsByPlace: Map<string, EventRow[]>;
  readonly place: Map<string, PlaceRow>;
  readonly families: FamilyRow[];
  readonly family: Map<string, FamilyRow>;
  readonly familiesByPartner: Map<string, FamilyRow[]>;
  readonly childrenByFamily: Map<string, FamilyChildRow[]>;
  readonly parentsByChild: Map<string, FamilyChildRow[]>;
  readonly familyChild: Map<string, FamilyChildRow>;
  readonly sources: SourceRow[];
  readonly source: Map<string, SourceRow>;
  readonly sourcesByRepository: Map<string, SourceRow[]>;
  readonly repositories: RepositoryRow[];
  readonly repository: Map<string, RepositoryRow>;
  readonly citation: Map<string, CitationRow>;
  readonly citationsBySource: Map<string, CitationRow[]>;
  readonly citationLinks: Map<string, CitationLinkRow[]>;
  readonly citationLinksByCitation: Map<string, CitationLinkRow[]>;
  readonly mediaRows: MediaRow[];
  readonly media: Map<string, MediaRow>;
  readonly mediaLinks: Map<string, MediaLinkRow[]>;
  readonly mediaLinksByMedia: Map<string, MediaLinkRow[]>;
  readonly primaryOf: Map<string, PersonRow[]>;
  readonly notes: NoteRow[];
  readonly note: Map<string, NoteRow>;
  readonly noteLinks: Map<string, NoteLinkRow[]>;
  readonly noteLinksByNote: Map<string, NoteLinkRow[]>;
  readonly tags: TagRow[];
  readonly tag: Map<string, TagRow>;
  readonly tagLinks: Map<string, TagLinkRow[]>;
  readonly tagLinksByTag: Map<string, TagLinkRow[]>;
  readonly unmapped: Map<string, UnmappedLineRow[]>;
  readonly rawRecords: RawRecordRow[];
  readonly treeName: string | null;
  readonly homePersonId: string | null;

  constructor(store: TreeStore) {
    const all = <T>(sql: string) => store.db.prepare(sql).all() as T[];
    const meta = new Map(
      all<{ key: string; value: string }>('SELECT key, value FROM meta').map((m) => [
        m.key,
        m.value,
      ]),
    );
    this.treeName = meta.get('tree_name') ?? null;
    this.homePersonId = meta.get('home_person_id') ?? null;

    this.persons = all<PersonRow>('SELECT * FROM person ORDER BY id');
    this.person = byId(this.persons);
    this.names = groupBy(
      all<PersonNameRow>(
        'SELECT * FROM person_name ORDER BY person_id, is_primary DESC, sort_order, id',
      ),
      (n) => n.person_id,
    );
    this.nameOwner = new Map();
    for (const list of this.names.values())
      for (const n of list) this.nameOwner.set(n.id, n.person_id);
    const events = all<EventRow>('SELECT * FROM event ORDER BY id');
    this.event = byId(events);
    this.eventsByPlace = groupBy(events, (e) => e.place_id);
    const roles = all<EventRoleRow>('SELECT * FROM event_role ORDER BY sort_order, id');
    this.rolesByPerson = groupBy(roles, (r) => r.person_id);
    this.rolesByFamily = groupBy(roles, (r) => r.family_id);
    this.rolesByEvent = groupBy(roles, (r) => r.event_id);
    this.place = byId(all<PlaceRow>('SELECT * FROM place'));

    this.families = all<FamilyRow>('SELECT * FROM family ORDER BY id');
    this.family = byId(this.families);
    this.familiesByPartner = new Map();
    for (const f of this.families) {
      for (const partner of [f.partner1_id, f.partner2_id]) {
        if (!partner) continue;
        const list = this.familiesByPartner.get(partner);
        if (list) list.push(f);
        else this.familiesByPartner.set(partner, [f]);
      }
    }
    for (const [personId, list] of this.familiesByPartner) {
      const order = (f: FamilyRow) =>
        f.partner1_id === personId ? f.partner1_order : f.partner2_order;
      list.sort((a, b) => order(a) - order(b) || (a.id < b.id ? -1 : 1));
    }
    const children = all<FamilyChildRow>('SELECT * FROM family_child ORDER BY id');
    this.familyChild = byId(children);
    this.childrenByFamily = groupBy(
      [...children].sort((a, b) => a.sort_order - b.sort_order || (a.id < b.id ? -1 : 1)),
      (c) => c.family_id,
    );
    // The preferred parent family first, as the importer makes the first one preferred.
    this.parentsByChild = groupBy(
      [...children].sort(
        (a, b) =>
          b.is_preferred - a.is_preferred ||
          a.child_order - b.child_order ||
          (a.id < b.id ? -1 : 1),
      ),
      (c) => c.child_id,
    );

    this.repositories = all<RepositoryRow>('SELECT * FROM repository ORDER BY id');
    this.repository = byId(this.repositories);
    this.sources = all<SourceRow>('SELECT * FROM source ORDER BY id');
    this.source = byId(this.sources);
    this.sourcesByRepository = groupBy(this.sources, (s) => s.repository_id);
    const citations = all<CitationRow>('SELECT * FROM citation ORDER BY id');
    this.citation = byId(citations);
    this.citationsBySource = groupBy(citations, (c) => c.source_id);
    const citationLinks = all<CitationLinkRow>(
      'SELECT * FROM citation_link ORDER BY sort_order, id',
    );
    this.citationLinks = groupBy(citationLinks, (l) => ownerKey(l.owner_type, l.owner_id));
    this.citationLinksByCitation = groupBy(citationLinks, (l) => l.citation_id);

    this.mediaRows = all<MediaRow>('SELECT * FROM media ORDER BY id');
    this.media = byId(this.mediaRows);
    const mediaLinks = all<MediaLinkRow>('SELECT * FROM media_link ORDER BY sort_order, id');
    this.mediaLinks = groupBy(mediaLinks, (l) => ownerKey(l.owner_type, l.owner_id));
    this.mediaLinksByMedia = groupBy(mediaLinks, (l) => l.media_id);
    this.primaryOf = groupBy(this.persons, (p) => p.primary_media_id);

    this.notes = all<NoteRow>('SELECT * FROM note ORDER BY id');
    this.note = byId(this.notes);
    const noteLinks = all<NoteLinkRow>('SELECT * FROM note_link ORDER BY sort_order, id');
    this.noteLinks = groupBy(noteLinks, (l) => ownerKey(l.owner_type, l.owner_id));
    this.noteLinksByNote = groupBy(noteLinks, (l) => l.note_id);

    this.tags = all<TagRow>('SELECT * FROM tag ORDER BY id');
    this.tag = byId(this.tags);
    const tagLinks = all<TagLinkRow>('SELECT * FROM tag_link ORDER BY id');
    this.tagLinks = groupBy(tagLinks, (l) => ownerKey(l.owner_type, l.owner_id));
    this.tagLinksByTag = groupBy(tagLinks, (l) => l.tag_id);

    this.unmapped = groupBy(
      all<UnmappedLineRow>(
        'SELECT * FROM unmapped_line WHERE owner_id IS NOT NULL ORDER BY line_no',
      ),
      (u) => ownerKey(u.owner_type!, u.owner_id!),
    );
    // Only the latest GEDCOM import is copied verbatim; v1 trees have at most one.
    const batch = store.db
      .prepare(
        `SELECT b.id FROM import_batch b WHERE EXISTS (SELECT 1 FROM raw_record r WHERE r.import_batch_id = b.id)
         ORDER BY b.started_at DESC, b.id DESC LIMIT 1`,
      )
      .pluck()
      .get() as string | undefined;
    this.rawRecords = batch
      ? (store.db
          .prepare('SELECT * FROM raw_record WHERE import_batch_id = ? ORDER BY seq')
          .all(batch) as RawRecordRow[])
      : [];
  }
}
