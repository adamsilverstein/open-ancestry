import { toGedcom } from '@open-ancestry/core';
import type {
  ChildRelationship,
  CitationRow,
  EventRow,
  FamilyChildRow,
  FamilyRow,
  MediaRow,
  NameType,
  NoteRow,
  PersonNameRow,
  PersonRow,
  Privacy,
  RelationshipType,
  RepositoryRow,
  SourceRow,
  TagRow,
} from '@open-ancestry/db';
import type { GedcomNode } from '@open-ancestry/gedcom';
import { ownerKey, type TreeData } from './load';

/** Kinds of top-level record the writer can point at. */
export type RecordKind = 'person' | 'family' | 'source' | 'repository' | 'media' | 'note' | 'tag';

/** What record generation needs from the export as a whole. */
export interface WriterContext {
  readonly data: TreeData;
  readonly v7: boolean;
  readonly includeMedia: boolean;
  /** The xref of a record, which the export promises to write. */
  ref(kind: RecordKind, id: string): string;
  isPrivatePerson(id: string | null): boolean;
  isPrivateFamily(id: string): boolean;
  /** Whether a note is written as its own record (shared) rather than inline. */
  isNoteRecord(note: NoteRow): boolean;
  /** The name's parts were edited after its imported text, so the text is out of date. */
  isStaleNameText(nameId: string): boolean;
  /** A note or media item attached anywhere to a privatized person or family: never written. */
  isWithheld(id: string): boolean;
  /** FILE value for a media row. */
  filePath(media: MediaRow): string | undefined;
}

type Child = GedcomNode | null | undefined | false | '';

/** A node with a value; levels are assigned when the record is finished. */
export function n(tag: string, value?: string | null, children: Child[] = []): GedcomNode {
  return {
    level: 0,
    tag,
    ...(value != null && value !== '' && { value }),
    children: children.filter(Boolean) as GedcomNode[],
    line: 0,
  };
}

/** An optional value line: nothing when the value is empty. */
export function v(tag: string, value: string | null | undefined): GedcomNode | null {
  return value == null || value === '' ? null : n(tag, value);
}

/** A pointer node (`1 FAMS @F1@`). */
export function p(tag: string, pointer: string, children: Child[] = []): GedcomNode {
  return { level: 0, tag, pointer, children: children.filter(Boolean) as GedcomNode[], line: 0 };
}

/** Sets levels from `level` down, so builders can nest nodes without counting. */
export function setLevels(node: GedcomNode, level = 0): GedcomNode {
  node.level = level;
  for (const c of node.children) setLevels(c, level + 1);
  return node;
}

/** A parsed node stripped of its source text, so it is written canonically. */
export function canonicalize(node: GedcomNode): GedcomNode {
  return {
    level: node.level,
    tag: node.tag,
    ...(node.xref !== undefined && { xref: node.xref }),
    ...(node.pointer !== undefined && { pointer: node.pointer }),
    ...(node.value !== undefined && { value: node.value }),
    children: node.children.map(canonicalize),
    line: node.line,
  };
}

const words = (list: string) => new Set(list.trim().split(/\s+/));

/** Standard individual events and attributes (GEDCOM 5.5.1 and 7, LDS ordinances); matches the importer. */
export const INDI_EVENTS = words(`
  ADOP BAPL BAPM BARM BASM BIRT BLES BURI CAST CENS CHR CHRA CONF CONL CREM DEAT DSCR EDUC
  EMIG ENDL EVEN FACT FCOM GRAD IDNO IMMI INIL NATI NATU NCHI NMR OCCU ORDN PROB PROP RELI
  RESI RETI SLGC SSN TITL WILL
`);

/** Standard family events and attributes. */
export const FAM_EVENTS = words(`
  ANUL CENS DIV DIVF ENGA EVEN FACT MARB MARC MARL MARR MARS NCHI RESI SLGS
`);

/** Either owner may carry either kind: Ancestry writes MARR on individuals too. */
const STANDARD_EVENTS = new Set([...INDI_EVENTS, ...FAM_EVENTS]);

const EXTENSION_TAG = /^_[A-Za-z0-9_]+$/;

const SINGULAR_EVENTS = new Set(['BIRT', 'CHR', 'BAPM', 'DEAT', 'BURI', 'CREM']);

const ANCESTRY_REL: Record<ChildRelationship, string> = {
  biological: 'Natural',
  adopted: 'Adopted',
  step: 'Step',
  foster: 'Foster',
  related: 'Related',
  guardian: 'Guardian',
  private: 'Private',
  unknown: 'Unknown',
};

const STATUS: Record<RelationshipType, string> = {
  married: 'Married',
  civil_union: 'Civil union',
  partners: 'Partners',
  unknown: 'Unknown',
};

const RESN: Record<Privacy, string | undefined> = {
  public: undefined,
  private: 'privacy',
  confidential: 'confidential',
  locked: 'locked',
};

const NAME_TYPE_7: Record<NameType, [string, string?]> = {
  birth: ['BIRTH'],
  married: ['MARRIED'],
  maiden: ['MAIDEN'],
  aka: ['AKA'],
  immigrant: ['IMMIGRANT'],
  professional: ['PROFESSIONAL'],
  religious: ['OTHER', 'Religious'],
  other: ['OTHER'],
};

/** File extension (GEDCOM 5.5.1 FORM) and kind for the MIME types the importer knows. */
const MIME: Record<string, [string, MediaRow['kind']]> = {
  'image/jpeg': ['jpg', 'photo'],
  'image/png': ['png', 'photo'],
  'image/gif': ['gif', 'photo'],
  'image/bmp': ['bmp', 'photo'],
  'image/webp': ['webp', 'photo'],
  'image/heic': ['heic', 'photo'],
  'image/tiff': ['tif', 'photo'],
  'image/svg+xml': ['svg', 'photo'],
  'application/pdf': ['pdf', 'document'],
  'text/plain': ['txt', 'document'],
  'application/rtf': ['rtf', 'document'],
  'application/msword': ['doc', 'document'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx', 'document'],
  'audio/mpeg': ['mp3', 'audio'],
  'audio/wav': ['wav', 'audio'],
  'audio/mp4': ['m4a', 'audio'],
  'audio/ogg': ['ogg', 'audio'],
  'video/mp4': ['mp4', 'video'],
  'video/quicktime': ['mov', 'video'],
  'video/x-msvideo': ['avi', 'video'],
  'video/webm': ['webm', 'video'],
};
const MIME_BY_EXT = new Map(Object.entries(MIME).map(([mime, [ext]]) => [ext, mime]));
MIME_BY_EXT.set('jpeg', 'image/jpeg').set('tiff', 'image/tiff');

const mimeOfPath = (path: string | null | undefined) =>
  path ? MIME_BY_EXT.get(path.split('?')[0]!.split('.').pop()!.toLowerCase()) : undefined;

/** GEDCOM 7 AGE grammar: `> 25y 3m`, `8w`, `< 1d`. */
const AGE_7 =
  /^(?:[<>] )?(?:\d+y(?: \d+m)?(?: \d+w)?(?: \d+d)?|\d+m(?: \d+w)?(?: \d+d)?|\d+w(?: \d+d)?|\d+d)$/;

const coordinate = (value: number, positive: string, negative: string) =>
  value < 0 ? `${negative}${-value}` : `${positive}${value}`;

/**
 * Builds GEDCOM records from the domain tables: the "canonical" form of a
 * record, used for anything edited since import, created in the app, or
 * exported to another GEDCOM version. Ancestry's custom tags are written the
 * way Ancestry writes them, so a re-import maps them back.
 */
export class RecordWriter {
  private readonly ctx: WriterContext;
  private readonly data: TreeData;
  private readonly v7: boolean;

  constructor(ctx: WriterContext) {
    this.ctx = ctx;
    this.data = ctx.data;
    this.v7 = ctx.v7;
  }

  // ------------------------------------------------------------ records

  person(person: PersonRow, xref: string): GedcomNode {
    const record = n('INDI');
    record.xref = xref;
    const { children } = record;
    const isPrivate = this.ctx.isPrivatePerson(person.id);
    if (isPrivate) {
      children.push(n('NAME', 'Private'));
      if (person.sex !== 'U') children.push(n('SEX', person.sex));
    } else {
      const names = this.data.names.get(person.id) ?? [];
      names.forEach((name, i) => children.push(this.name(name, i === 0)));
      if (person.sex !== 'U') children.push(n('SEX', person.sex));
      children.push(...[this.resn(person.privacy)].filter((c) => c !== null));
      const events = this.events(this.data.rolesByPerson.get(person.id) ?? [], STANDARD_EVENTS);
      this.adoptions(person.id, events);
      children.push(...events);
    }
    for (const link of this.data.parentsByChild.get(person.id) ?? []) {
      children.push(this.famc(link, isPrivate));
    }
    for (const family of this.data.familiesByPartner.get(person.id) ?? []) {
      children.push(p('FAMS', this.ctx.ref('family', family.id)));
    }
    if (!isPrivate) {
      children.push(...this.citations('person', person.id));
      children.push(...this.notes('person', person.id));
      const links = this.mediaLinks('person', person.id);
      // Ancestry marks the profile photo's link with _PRIM Y as well as _PHOTO.
      const primary =
        person.primary_media_id &&
        this.ctx.includeMedia &&
        !this.ctx.isWithheld(person.primary_media_id)
          ? this.ctx.ref('media', person.primary_media_id)
          : undefined;
      for (const link of links) if (link.pointer === primary) link.children.push(n('_PRIM', 'Y'));
      children.push(...links);
      const photo = person.primary_media_id && this.data.media.get(person.primary_media_id);
      if (photo && primary) children.push(p('_PHOTO', primary));
      children.push(...this.tagLinks('person', person.id));
    }
    return setLevels(record);
  }

  family(family: FamilyRow, xref: string): GedcomNode {
    const record = n('FAM');
    record.xref = xref;
    const { children } = record;
    if (family.partner1_id) children.push(p('HUSB', this.ctx.ref('person', family.partner1_id)));
    if (family.partner2_id) children.push(p('WIFE', this.ctx.ref('person', family.partner2_id)));
    const isPrivate = this.ctx.isPrivateFamily(family.id);
    const roles = isPrivate ? [] : (this.data.rolesByFamily.get(family.id) ?? []);
    if (!isPrivate) {
      // The importer infers married from a marriage event and unknown otherwise.
      const married = roles.some((r) => this.data.event.get(r.event_id)?.type === 'MARR');
      if (family.relationship_type !== (married ? 'married' : 'unknown')) {
        children.push(n('_STAT', STATUS[family.relationship_type]));
      }
      children.push(...[this.resn(family.privacy)].filter((c) => c !== null));
      children.push(...this.events(roles, STANDARD_EVENTS));
    }
    for (const link of this.data.childrenByFamily.get(family.id) ?? []) {
      children.push(p('CHIL', this.ctx.ref('person', link.child_id)));
    }
    if (!isPrivate) {
      children.push(...this.attachments('family', family.id));
    }
    return setLevels(record);
  }

  source(source: SourceRow, xref: string): GedcomNode {
    const repo = source.repository_id
      ? p('REPO', this.ctx.ref('repository', source.repository_id), [v('CALN', source.call_number)])
      : null;
    const record = n('SOUR', undefined, [
      v('TITL', source.title),
      v('AUTH', source.author),
      v('PUBL', source.publication),
      v('ABBR', source.abbreviation),
      v('TEXT', source.text),
      repo,
      v('_APID', source.apid),
      ...this.attachments('source', source.id),
    ]);
    record.xref = xref;
    return setLevels(record);
  }

  repository(repo: RepositoryRow, xref: string): GedcomNode {
    const record = n('REPO', undefined, [
      v('NAME', repo.name),
      v('ADDR', repo.address),
      v('PHON', repo.phone),
      v('EMAIL', repo.email),
      v('WWW', repo.url),
      ...this.notes('repository', repo.id),
    ]);
    record.xref = xref;
    return setLevels(record);
  }

  media(media: MediaRow, xref: string): GedcomNode {
    const file = this.ctx.filePath(media);
    const mime = media.mime ?? mimeOfPath(media.local_path ?? media.remote_url);
    const form = this.v7
      ? (mime ?? 'application/octet-stream')
      : mime
        ? MIME[mime]?.[0]
        : undefined;
    const expectedKind = (mime && MIME[mime]?.[1]) ?? 'photo';
    const record = n('OBJE', undefined, [
      n('FILE', file, [v('FORM', form), v('TITL', media.title)]),
      v('_OID', media.ancestry_oid),
      v('_DATE', media.date_text),
      v('_DSCR', media.description),
      media.kind !== expectedKind && n('_TYPE', media.kind),
      media.width != null && n('_WDTH', String(media.width)),
      media.height != null && n('_HGHT', String(media.height)),
      media.byte_size != null && n('_SIZE', String(media.byte_size)),
      ...this.attachments('media', media.id, { media: false }),
    ]);
    record.xref = xref;
    return setLevels(record);
  }

  note(note: NoteRow, xref: string): GedcomNode {
    const record = n(this.v7 ? 'SNOTE' : 'NOTE', note.text, this.citations('note', note.id));
    record.xref = xref;
    return setLevels(record);
  }

  tag(tag: TagRow, xref: string): GedcomNode {
    const record = n('_MTTAG', undefined, [v('NAME', tag.name), v('_MTCAT', tag.category)]);
    record.xref = xref;
    return setLevels(record);
  }

  // ------------------------------------------------------------ parts

  private name(name: PersonNameRow, first: boolean): GedcomNode {
    const text = this.ctx.isStaleNameText(name.id) ? null : name.full_text;
    const value =
      text ??
      ([
        name.prefix,
        name.given,
        name.surname || name.surname_prefix
          ? `/${[name.surname_prefix, name.surname].filter(Boolean).join(' ')}/`
          : null,
        name.suffix,
      ]
        .filter(Boolean)
        .join(' ') ||
        undefined);
    let type: GedcomNode | null = null;
    if (!first || name.type !== 'birth') {
      if (this.v7) {
        const [tag, phrase] = NAME_TYPE_7[name.type];
        type = n('TYPE', tag, [phrase !== undefined && n('PHRASE', phrase)]);
      } else {
        type = n('TYPE', name.type);
      }
    }
    return n('NAME', value, [
      v('NPFX', name.prefix),
      v('GIVN', name.given),
      v('NICK', name.nickname),
      v('SPFX', name.surname_prefix),
      v('SURN', name.surname),
      v('NSFX', name.suffix),
      type,
      ...this.citations('person_name', name.id),
      ...this.notes('person_name', name.id),
    ]);
  }

  private resn(privacy: Privacy): GedcomNode | null {
    const value = RESN[privacy];
    return value ? n('RESN', this.v7 ? value.toUpperCase() : value) : null;
  }

  /** Principal events in order, each alternate fact after the preferred one of its type. */
  private events(
    roles: { event_id: string; role: string; is_preferred: number }[],
    standard: ReadonlySet<string>,
  ): GedcomNode[] {
    const list = roles.filter((r) => r.role === 'principal' && this.data.event.has(r.event_id));
    const firstOfType = new Map<string, number>();
    list.forEach((r, i) => {
      const type = this.data.event.get(r.event_id)!.type;
      if (!SINGULAR_EVENTS.has(type)) return;
      const first = firstOfType.get(type);
      if (first === undefined) firstOfType.set(type, i);
      else if (r.is_preferred && !list[first]!.is_preferred) {
        [list[first], list[i]] = [list[i]!, list[first]!];
      }
    });
    return list.map((r) => this.event(this.data.event.get(r.event_id)!, standard));
  }

  /**
   * `ADOP.FAMC` with `ADOP HUSB|WIFE|BOTH` under the person's first adoption
   * event, for each parent family they are adopted into: the importer reads
   * it into the child relationships, and other software reads it as the
   * standard way to say who adopted.
   */
  private adoptions(personId: string, events: GedcomNode[]): void {
    const adop = events.find((e) => e.tag === 'ADOP');
    if (!adop) return;
    for (const link of this.data.parentsByChild.get(personId) ?? []) {
      const p1 = link.partner1_rel === 'adopted';
      const p2 = link.partner2_rel === 'adopted';
      if (!p1 && !p2) continue;
      adop.children.push(
        p('FAMC', this.ctx.ref('family', link.family_id), [
          n('ADOP', p1 && p2 ? 'BOTH' : p1 ? 'HUSB' : 'WIFE'),
        ]),
      );
    }
  }

  /**
   * A standard event or attribute keeps its tag (upper-cased: the edit API
   * accepts `grad`), an Ancestry/FTM fact keeps its `_` tag, and any other
   * type becomes `EVEN` with the type as TYPE, rather than a made-up tag.
   */
  private event(event: EventRow, standard: ReadonlySet<string>): GedcomNode {
    const upper = event.type.toUpperCase();
    let tag = event.type;
    let type = event.custom_type;
    if (!event.type.startsWith('_') && standard.has(upper)) tag = upper;
    else if (!EXTENSION_TAG.test(event.type)) {
      tag = 'EVEN';
      type = event.custom_type ?? event.type;
    }
    return n(tag, event.value, [
      v('TYPE', type),
      this.date(event.date_text),
      this.place(event.place_id),
      v('ADDR', event.description),
      this.age(event.age),
      v('CAUS', event.cause),
      this.resn(event.privacy),
      ...this.attachments('event', event.id),
    ]);
  }

  /** DATE as written; in GEDCOM 7 the standard form with the original as PHRASE when they differ. */
  private date(text: string | null): GedcomNode | null {
    if (!text) return null;
    if (!this.v7) return n('DATE', text);
    const standard = toGedcom(text, '7');
    return standard === text ? n('DATE', text) : n('DATE', standard, [n('PHRASE', text)]);
  }

  private age(text: string | null): GedcomNode | null {
    if (!text) return null;
    if (!this.v7 || AGE_7.test(text)) return n('AGE', text);
    const years = /^\s*(\d+)\s*$/.exec(text);
    return n('AGE', years ? `${years[1]}y` : undefined, [n('PHRASE', text)]);
  }

  private place(id: string | null): GedcomNode | null {
    const place = id ? this.data.place.get(id) : undefined;
    if (!place) return null;
    const map =
      place.latitude != null && place.longitude != null
        ? n('MAP', undefined, [
            n('LATI', coordinate(place.latitude, 'N', 'S')),
            n('LONG', coordinate(place.longitude, 'E', 'W')),
          ])
        : null;
    return n('PLAC', place.full_name, [map, ...this.notes('place', place.id)]);
  }

  private famc(link: FamilyChildRow, childIsPrivate: boolean): GedcomNode {
    const pointer = this.ctx.ref('family', link.family_id);
    if (childIsPrivate) return p('FAMC', pointer);
    const rels: GedcomNode[] = [];
    if (link.partner1_rel !== 'biological' || link.partner2_rel !== 'biological') {
      const same = link.partner1_rel === link.partner2_rel;
      if (this.v7 && same && (link.partner1_rel === 'adopted' || link.partner1_rel === 'foster')) {
        rels.push(n('PEDI', link.partner1_rel.toUpperCase()));
      }
      rels.push(n('_FREL', ANCESTRY_REL[link.partner1_rel]));
      rels.push(n('_MREL', ANCESTRY_REL[link.partner2_rel]));
    }
    const attachments = this.ctx.isPrivateFamily(link.family_id)
      ? []
      : [...this.citations('family_child', link.id), ...this.notes('family_child', link.id)];
    return p('FAMC', pointer, [...rels, ...attachments]);
  }

  // ------------------------------------------------------------ attachments

  private attachments(type: string, id: string, { media = true } = {}): GedcomNode[] {
    return [
      ...this.citations(type, id),
      ...this.notes(type, id),
      ...(media ? this.mediaLinks(type, id) : []),
      ...this.tagLinks(type, id),
    ];
  }

  private citations(type: string, id: string): GedcomNode[] {
    const links = this.data.citationLinks.get(ownerKey(type, id)) ?? [];
    return links.flatMap((l) => {
      const citation = this.data.citation.get(l.citation_id);
      return citation && this.data.source.has(citation.source_id) ? [this.citation(citation)] : [];
    });
  }

  private citation(c: CitationRow): GedcomNode {
    const data =
      c.date_text || c.text || (c.url && !this.v7)
        ? n('DATA', undefined, [
            this.date(c.date_text),
            v('TEXT', c.text),
            !this.v7 && v('WWW', c.url),
          ])
        : null;
    return p('SOUR', this.ctx.ref('source', c.source_id), [
      v('PAGE', c.page),
      v('_APID', c.apid),
      c.quality != null && n('QUAY', String(c.quality)),
      data,
      // GEDCOM 7 citations have no WWW; Ancestry's _LINK carries the record URL.
      this.v7 && v('_LINK', c.url),
      ...this.notes('citation', c.id),
      ...this.mediaLinks('citation', c.id),
    ]);
  }

  private notes(type: string, id: string): GedcomNode[] {
    const links = this.data.noteLinks.get(ownerKey(type, id)) ?? [];
    return links.flatMap((l) => {
      const note = this.data.note.get(l.note_id);
      if (!note || this.ctx.isWithheld(note.id)) return [];
      if (this.ctx.isNoteRecord(note)) {
        return [p(this.v7 ? 'SNOTE' : 'NOTE', this.ctx.ref('note', note.id))];
      }
      return [n('NOTE', note.text, this.citations('note', note.id))];
    });
  }

  private mediaLinks(type: string, id: string): GedcomNode[] {
    if (!this.ctx.includeMedia) return [];
    const links = this.data.mediaLinks.get(ownerKey(type, id)) ?? [];
    return links.flatMap((l) =>
      this.data.media.has(l.media_id) && !this.ctx.isWithheld(l.media_id)
        ? [p('OBJE', this.ctx.ref('media', l.media_id))]
        : [],
    );
  }

  private tagLinks(type: string, id: string): GedcomNode[] {
    const links = this.data.tagLinks.get(ownerKey(type, id)) ?? [];
    return links.flatMap((l) =>
      this.data.tag.has(l.tag_id) ? [p('_MTTAG', this.ctx.ref('tag', l.tag_id))] : [],
    );
  }
}
