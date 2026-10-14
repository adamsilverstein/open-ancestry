import { inferLiving, parseDate, parseName, phoneticKeys } from '@open-ancestry/core';
import type {
  ChildRelationship,
  InsertRow,
  MediaKind,
  NameType,
  Privacy,
  RelationshipType,
  Sex,
  TableName,
} from '@open-ancestry/db';
import { serializeNode, type GedcomNode, type ParseResult } from '@open-ancestry/gedcom';
import { createHash } from 'node:crypto';
import { classifyFile, kindFromType, mediaType, writeMediaFile, type MediaSource } from './media';
import { Places, coordinate, placeParts } from './places';
import {
  BIRTH_SUBSTITUTES,
  CUSTOM_EVENTS,
  DEATH_EVENTS,
  EVENT_HINT_TAGS,
  FAM_EVENTS,
  INDI_EVENTS,
  OTHER_DEATH_FACTS,
  SINGULAR_EVENTS,
  childRelationship,
  nameType,
  privacy,
  relationshipStatus,
} from './tags';
import type { ImportWarning, ImportWarningCode, MissingMedia, UnmappedTag } from './types';

/** Where mapped rows go (a counting wrapper around BulkWriter). */
export interface Sink {
  insert<T extends TableName>(table: T, row: InsertRow<T>): void;
}

export interface MapperOptions {
  batchId: string;
  newId: () => string;
  media: MediaSource;
  /** The tree's media folder; files are copied there when set. */
  mediaRoot: string | null;
  maxMediaBytes: number;
  maxWarnings: number;
  today: Date;
}

interface Owner {
  type: string;
  id: string;
}

interface PersonState {
  id: string;
  xref: string | undefined;
  line: number;
  sex: Sex;
  privacy: Privacy;
  primaryMedia: string | null;
  photo: string | null;
  given: string | null;
  surname: string | null;
  living: boolean;
  birth: string | undefined;
  birthSubstitute: string | undefined;
  death: string | undefined;
  deathFact: boolean;
  eventOrder: number;
  nameOrder: number;
  singular: Set<string>;
  fams: { familyId: string; node: GedcomNode }[];
  famcCount: number;
  marriages: GedcomNode[];
  adoptions: GedcomNode[];
  /** Later names without TYPE, typed once spouses are known. */
  untypedNames: InsertRow<'person_name'>[];
}

interface Marriage {
  eventId: string;
  date: string;
  place: string;
}

interface FamilyState {
  id: string;
  xref: string | undefined;
  line: number;
  partner1: string | null;
  partner2: string | null;
  partner1Order: number;
  partner2Order: number;
  status: RelationshipType | undefined;
  privacy: Privacy;
  childCount: number;
  eventOrder: number;
  marriages: Marriage[];
}

interface ChildLink {
  id: string;
  familyId: string;
  childId: string;
  chil: GedcomNode | undefined;
  famc: GedcomNode | undefined;
  sortOrder: number;
  childOrder: number;
  adopted1: boolean;
  adopted2: boolean;
}

const RECORD_OWNERS: Record<string, string> = {
  INDI: 'person',
  FAM: 'family',
  SOUR: 'source',
  REPO: 'repository',
  OBJE: 'media',
  NOTE: 'note',
  SNOTE: 'note',
  _MTTAG: 'tag',
};

/** Records kept only in raw_record (no submitter table in v1). */
export const RAW_ONLY = new Set(['HEAD', 'SUBM', 'TRLR']);

const NOTE_TAGS = new Set(['NOTE', 'SNOTE']);
const HOME_TAGS = new Set(['_HOME', '_ROOT', '_HOMEPERSON', '_HME']);
const ADDRESS_PARTS = ['ADR1', 'ADR2', 'ADR3', 'CITY', 'STAE', 'POST', 'CTRY'];

const text = (node: GedcomNode | undefined): string | undefined => {
  const value = node?.value;
  return value === undefined || value.trim() === '' ? undefined : value;
};

/**
 * Maps parsed GEDCOM records to rows. Records are mapped one at a time
 * (`mapRecord`), then `finalize` resolves everything that needs the whole
 * file: one-sided links, child relationships, INDI marriages, living status.
 * Every line it uses is marked; the rest become unmapped_line rows.
 */
export class Mapper {
  readonly warnings: ImportWarning[] = [];
  warningCount = 0;
  readonly missingMedia: MissingMedia[] = [];
  linkedMedia = 0;
  remoteMedia = 0;
  rejectedMedia = 0;
  readonly recordCounts: Record<string, number> = {};
  homePersonId: string | null = null;
  homePersonSource: 'header' | 'first-person' | null = null;
  living = { living: 0, deceased: 0 };

  private readonly mapped: Uint8Array;
  private readonly places: Places;
  private readonly targets = new Map<string, { tag: string; id: string }>();
  private readonly recordIds: (string | undefined)[];
  private readonly persons = new Map<string, PersonState>();
  private readonly families = new Map<string, FamilyState>();
  private readonly childLinks = new Map<string, ChildLink>();
  /** Families by partner, built at the start of finalize. */
  private readonly partnerFamilies = new Map<string, FamilyState[]>();
  private readonly linkKeys = new Set<string>();
  private readonly linkOrder = new Map<string, number>();
  private readonly citationKeys = new Map<string, string>();
  private readonly surnameKeys = new Map<string, string | null>();
  private readonly copiedMedia = new Set<string>();
  private readonly insertedTags = new Set<string>();
  private readonly unmappedByPath = new Map<string, UnmappedTag>();
  private firstPerson: string | null = null;
  private readonly major: number;

  private readonly doc: ParseResult;
  private readonly sink: Sink;
  private readonly options: MapperOptions;

  constructor(doc: ParseResult, sink: Sink, options: MapperOptions) {
    this.doc = doc;
    this.sink = sink;
    this.options = options;
    this.mapped = new Uint8Array(doc.lines.total + 2);
    this.places = new Places(options.newId);
    this.major = doc.header.majorVersion ?? 5;
    this.recordIds = new Array(doc.records.length);
    this.assignIds();
  }

  warn(code: ImportWarningCode, line: number, message: string): void {
    this.warningCount++;
    if (this.warnings.length < this.options.maxWarnings)
      this.warnings.push({ code, line, message });
  }

  // ------------------------------------------------------------ pass 1: ids

  private assignIds(): void {
    const tags = new Map<string, string>();
    this.doc.records.forEach((record, i) => {
      if (!RECORD_OWNERS[record.tag]) return;
      let id = this.options.newId();
      if (record.tag === '_MTTAG') {
        // Tags are unique by category and name; repeated tag records share one row.
        const key = `${text(this.child(record, '_MTCAT')) ?? ''}\u0000${text(this.child(record, 'NAME')) ?? ''}`;
        const existing = tags.get(key);
        if (existing) id = existing;
        else tags.set(key, id);
      }
      this.recordIds[i] = id;
      if (record.xref && !this.targets.has(record.xref)) {
        this.targets.set(record.xref, { tag: record.tag, id });
      }
    });
  }

  // ------------------------------------------------------------ helpers

  private child(node: GedcomNode, tag: string): GedcomNode | undefined {
    for (const c of node.children) if (c.tag === tag) return c;
    return undefined;
  }

  /** Marks a node's own line and its CONC/CONT lines as mapped. */
  private use(node: GedcomNode | undefined): void {
    if (!node) return;
    this.mapped[node.line] = 1;
    if (node.continuations) for (const c of node.continuations) this.mapped[c.line] = 1;
  }

  /**
   * Resolves a pointer to the id of a record with one of `tags`. Returns null
   * for GEDCOM 7 `@VOID@`, undefined (with a warning) when broken.
   */
  private resolve(node: GedcomNode, ...tags: string[]): string | null | undefined {
    const pointer = node.pointer;
    if (pointer === '@VOID@') return null;
    if (pointer === undefined) return undefined;
    const target = this.targets.get(pointer);
    if (!target) {
      this.warn('bad-pointer', node.line, `${node.tag} points to ${pointer}, which does not exist`);
      return undefined;
    }
    if (!tags.includes(target.tag)) {
      this.warn(
        'wrong-pointer-type',
        node.line,
        `${node.tag} points to ${pointer}, a ${target.tag} record, not ${tags.join(' or ')}`,
      );
      return undefined;
    }
    return target.id;
  }

  /** Inserts a link row unless the same link already exists; returns false for a duplicate. */
  private link(
    table: 'citation_link' | 'media_link' | 'note_link' | 'tag_link',
    targetColumn: string,
    targetId: string,
    owner: Owner,
  ): boolean {
    const key = `${table}|${targetId}|${owner.type}|${owner.id}`;
    if (this.linkKeys.has(key)) return false;
    this.linkKeys.add(key);
    const row: Record<string, unknown> = {
      [targetColumn]: targetId,
      owner_type: owner.type,
      owner_id: owner.id,
    };
    if (table !== 'tag_link') {
      const orderKey = `${table}|${owner.type}|${owner.id}`;
      const order = this.linkOrder.get(orderKey) ?? 0;
      this.linkOrder.set(orderKey, order + 1);
      row.sort_order = order;
    }
    this.sink.insert(table, row as never);
    return true;
  }

  private surnameKey(surname: string | null): string | null {
    if (!surname) return null;
    let key = this.surnameKeys.get(surname);
    if (key === undefined) {
      key = surnameKey(surname);
      this.surnameKeys.set(surname, key);
    }
    return key;
  }

  // ------------------------------------------------------------ records

  mapRecord(index: number): void {
    const record = this.doc.records[index]!;
    this.recordCounts[record.tag] = (this.recordCounts[record.tag] ?? 0) + 1;
    // Duplicate xrefs are warned about by the parser; pointers go to the first record.
    const id = this.recordIds[index];
    let ownerType: string | null = null;
    switch (record.tag) {
      case 'INDI':
        this.mapPerson(record, id!);
        ownerType = 'person';
        break;
      case 'FAM':
        this.mapFamily(record, id!);
        ownerType = 'family';
        break;
      case 'SOUR':
        this.mapSource(record, id!);
        ownerType = 'source';
        break;
      case 'REPO':
        this.mapRepository(record, id!);
        ownerType = 'repository';
        break;
      case 'OBJE':
        this.mapMedia(record, id!, record.xref);
        ownerType = 'media';
        break;
      case 'NOTE':
      case 'SNOTE':
        this.mapNoteRecord(record, id!);
        ownerType = 'note';
        break;
      case '_MTTAG':
        this.mapTag(record, id!);
        ownerType = 'tag';
        break;
    }
    const raw = serializeNode(record, { version: this.major });
    this.sink.insert('raw_record', {
      import_batch_id: this.options.batchId,
      seq: index,
      owner_type: ownerType,
      owner_id: ownerType ? id! : null,
      gedcom_tag: record.tag,
      xref: record.xref ?? null,
      raw_text: raw.slice(0, -1),
    });
  }

  private mapPerson(record: GedcomNode, id: string): void {
    this.use(record);
    this.firstPerson ??= id;
    const person: PersonState = {
      id,
      xref: record.xref,
      line: record.line,
      sex: 'U',
      privacy: 'public',
      primaryMedia: null,
      photo: null,
      given: null,
      surname: null,
      living: true,
      birth: undefined,
      birthSubstitute: undefined,
      death: undefined,
      deathFact: false,
      eventOrder: 0,
      nameOrder: 0,
      singular: new Set(),
      fams: [],
      famcCount: 0,
      marriages: [],
      adoptions: [],
      untypedNames: [],
    };
    this.persons.set(id, person);
    const owner = { type: 'person', id };
    for (const c of record.children) {
      switch (c.tag) {
        case 'NAME':
          this.mapName(c, person);
          break;
        case '_MARNM':
        case '_AKA':
        case '_AKAN':
          if (text(c)) {
            this.use(c);
            const value = c.value!.trim();
            // Usually just the surname ("_MARNM Fenn"), sometimes a whole name.
            const name = value.includes('/')
              ? parseName(value)
              : { given: person.given ?? undefined, surname: value };
            this.addName(person, name, value, c.tag === '_MARNM' ? 'married' : 'aka');
          }
          break;
        case 'SEX': {
          const sex = c.value?.trim().toUpperCase();
          if (sex === 'M' || sex === 'F' || sex === 'X' || sex === 'U') {
            person.sex = sex;
            this.use(c);
          } else if (sex) {
            this.warn('invalid-value', c.line, `Unknown SEX value "${c.value}"`);
          }
          break;
        }
        case 'FAMC': {
          const familyId = this.resolve(c, 'FAM');
          if (!familyId) break;
          const link = this.childLink(familyId, id);
          if (link.famc) {
            this.warn('duplicate-link', c.line, `FAMC ${c.pointer} is repeated`);
            break;
          }
          link.famc = c;
          link.childOrder = person.famcCount++;
          break;
        }
        case 'FAMS': {
          const familyId = this.resolve(c, 'FAM');
          if (!familyId) break;
          if (person.fams.some((f) => f.familyId === familyId)) {
            this.warn('duplicate-link', c.line, `FAMS ${c.pointer} is repeated`);
            break;
          }
          person.fams.push({ familyId, node: c });
          break;
        }
        case 'OBJE': {
          const mediaId = this.mapMediaLink(c, owner);
          const prim = this.child(c, '_PRIM');
          if (mediaId && prim) {
            this.use(prim);
            if (/^y/i.test(prim.value ?? '')) person.primaryMedia ??= mediaId;
          }
          break;
        }
        case '_PHOTO': {
          const mediaId = this.resolve(c, 'OBJE');
          if (!mediaId) break;
          this.use(c);
          person.photo ??= mediaId;
          this.link('media_link', 'media_id', mediaId, owner);
          break;
        }
        case 'NOTE':
        case 'SNOTE':
          this.mapNote(c, owner);
          break;
        case 'SOUR':
          this.mapCitation(c, owner);
          break;
        case '_MTTAG':
          this.mapTagLink(c, owner);
          break;
        case 'RESN': {
          const level = privacy(c.value);
          if (level) {
            person.privacy = level;
            this.use(c);
          }
          break;
        }
        case 'MARR':
          person.marriages.push(c);
          break;
        default:
          if (this.isEvent(c, INDI_EVENTS)) this.mapPersonEvent(c, person);
      }
    }
  }

  private isEvent(node: GedcomNode, standard: Set<string>): boolean {
    if (standard.has(node.tag) || CUSTOM_EVENTS.has(node.tag)) return true;
    return node.tag.startsWith('_') && node.children.some((c) => EVENT_HINT_TAGS.has(c.tag));
  }

  private mapPersonEvent(node: GedcomNode, person: PersonState): string {
    let preferred = true;
    if (SINGULAR_EVENTS.has(node.tag)) {
      preferred = !person.singular.has(node.tag);
      person.singular.add(node.tag);
    }
    const event = this.mapEvent(
      node,
      { type: 'person', id: person.id },
      person.eventOrder++,
      preferred,
    );
    if (preferred) {
      if (node.tag === 'BIRT') person.birth = event.date ?? person.birth;
      if (BIRTH_SUBSTITUTES.includes(node.tag)) person.birthSubstitute ??= event.date;
      if (node.tag === 'DEAT') person.death = event.date ?? '';
    }
    if (DEATH_EVENTS.has(node.tag) || OTHER_DEATH_FACTS.has(node.tag)) person.deathFact = true;
    if (node.tag === 'ADOP') {
      for (const c of node.children) if (c.tag === 'FAMC') person.adoptions.push(c);
    }
    return event.id;
  }

  // ------------------------------------------------------------ names

  private mapName(node: GedcomNode, person: PersonState): void {
    const parts: Record<string, string | undefined> = {};
    for (const c of node.children) {
      if (['GIVN', 'SURN', 'NPFX', 'NSFX', 'NICK', 'SPFX', 'TYPE'].includes(c.tag) && text(c)) {
        parts[c.tag] = c.value!.trim();
      }
    }
    const full = text(node);
    if (!full && !parts.GIVN && !parts.SURN) return;
    this.use(node);
    const parsed = parseName(full ?? '');
    let surname = parts.SURN ?? (parsed.surname || undefined);
    const surnamePrefix = parts.SPFX;
    if (surnamePrefix && !parts.SURN && surname?.startsWith(surnamePrefix + ' ')) {
      surname = surname.slice(surnamePrefix.length + 1);
    }
    const fields = {
      given: parts.GIVN ?? (parsed.given || undefined),
      surname,
      surname_prefix: surnamePrefix,
      prefix: parts.NPFX ?? (parsed.prefix || undefined),
      suffix: parts.NSFX ?? (parsed.suffix || undefined),
      nickname: parts.NICK ?? (parsed.nickname || undefined),
    };
    const type: NameType | undefined = parts.TYPE ? nameType(parts.TYPE) : undefined;
    const nameId = this.addName(person, fields, full ?? null, type);
    const owner = { type: 'person_name', id: nameId };
    const extra: GedcomNode[] = [];
    for (const c of node.children) {
      if (c.tag in parts) this.use(c);
      else if (NOTE_TAGS.has(c.tag)) this.mapNote(c, owner);
      else if (c.tag === 'SOUR') this.mapCitation(c, owner);
      else if (c.tag === '_MARNM' || c.tag === '_AKA') extra.push(c);
    }
    for (const c of extra) {
      if (!text(c)) continue;
      this.use(c);
      const name = { given: fields.given, surname: c.value!.trim() };
      this.addName(
        person,
        name,
        `${name.given ? name.given + ' ' : ''}/${name.surname}/`,
        c.tag === '_MARNM' ? 'married' : 'aka',
      );
    }
  }

  private addName(
    person: PersonState,
    fields: {
      given?: string;
      surname?: string;
      surname_prefix?: string;
      prefix?: string;
      suffix?: string;
      nickname?: string;
    },
    fullText: string | null,
    type: NameType | undefined,
  ): string {
    const first = person.nameOrder === 0;
    const surname = fields.surname || null;
    const row: InsertRow<'person_name'> & { id: string } = {
      id: this.options.newId(),
      person_id: person.id,
      type: type ?? 'birth',
      given: fields.given || null,
      surname,
      surname_prefix: fields.surname_prefix || null,
      prefix: fields.prefix || null,
      suffix: fields.suffix || null,
      nickname: fields.nickname || null,
      full_text: fullText,
      surname_key: this.surnameKey(surname),
      is_primary: first ? 1 : 0,
      sort_order: person.nameOrder++,
    };
    if (first) {
      person.given = fields.given || null;
      person.surname = surname;
    }
    if (!first && !type) person.untypedNames.push(row);
    else this.sink.insert('person_name', row);
    return row.id;
  }

  // ------------------------------------------------------------ events

  private mapEvent(
    node: GedcomNode,
    owner: Owner,
    order: number,
    preferred: boolean,
  ): { id: string; date: string | undefined; place: string } {
    this.use(node);
    const id = this.options.newId();
    const row: InsertRow<'event'> & { id: string } = {
      id,
      type: node.tag,
      value: node.value ?? null,
      import_batch_id: this.options.batchId,
    };
    const eventOwner = { type: 'event', id };
    let date: string | undefined;
    let place = '';
    for (const c of node.children) {
      switch (c.tag) {
        case 'TYPE':
          if (text(c)) {
            row.custom_type = c.value!;
            this.use(c);
          }
          break;
        case 'DATE':
          if (text(c)) {
            date = c.value!;
            Object.assign(row, dateColumns(date));
            this.use(c);
          }
          break;
        case 'PLAC': {
          const placeId = this.mapPlace(c);
          if (placeId) {
            row.place_id = placeId;
            place = placeParts(c.value!).join(', ');
          }
          break;
        }
        case 'AGE':
          if (text(c)) {
            row.age = c.value!;
            this.use(c);
          }
          break;
        case 'CAUS':
          if (text(c)) {
            row.cause = c.value!;
            this.use(c);
          }
          break;
        case 'ADDR': {
          const address = this.address(c);
          if (address && !row.description) row.description = address;
          break;
        }
        case 'RESN': {
          const level = privacy(c.value);
          if (level) {
            row.privacy = level;
            this.use(c);
          }
          break;
        }
        default:
          this.mapAttachment(c, eventOwner);
      }
    }
    this.sink.insert('event', row);
    this.sink.insert('event_role', {
      event_id: id,
      person_id: owner.type === 'person' ? owner.id : null,
      family_id: owner.type === 'family' ? owner.id : null,
      role: 'principal',
      is_preferred: preferred ? 1 : 0,
      sort_order: order,
    });
    return { id, date, place };
  }

  /** NOTE, SOUR, OBJE and _MTTAG under any owner that accepts them. */
  private mapAttachment(node: GedcomNode, owner: Owner): void {
    if (NOTE_TAGS.has(node.tag)) this.mapNote(node, owner);
    else if (node.tag === 'SOUR') this.mapCitation(node, owner);
    else if (node.tag === 'OBJE') this.mapMediaLink(node, owner);
    else if (node.tag === '_MTTAG') this.mapTagLink(node, owner);
  }

  /** ADDR text (with CONT lines) plus any structured parts not already in it. */
  private address(node: GedcomNode): string | undefined {
    let result = node.value?.trim() ? node.value : '';
    for (const c of node.children) {
      if (!ADDRESS_PARTS.includes(c.tag) || !text(c)) continue;
      const part = c.value!.trim();
      if (!result.includes(part)) result = result ? `${result}\n${part}` : part;
      this.use(c);
    }
    if (!result) return undefined;
    this.use(node);
    return result;
  }

  private mapPlace(node: GedcomNode): string | undefined {
    if (!text(node)) return undefined;
    const id = this.places.resolve(node.value!);
    if (!id) return undefined;
    this.use(node);
    for (const c of node.children) {
      if (c.tag === 'MAP') {
        const latNode = this.child(c, 'LATI');
        const longNode = this.child(c, 'LONG');
        const lat = coordinate(latNode?.value, 'lat');
        const long = coordinate(longNode?.value, 'long');
        if (latNode && lat === undefined) {
          this.warn(
            'invalid-value',
            latNode.line,
            `Latitude "${latNode.value ?? ''}" is not valid`,
          );
        }
        if (longNode && long === undefined) {
          this.warn(
            'invalid-value',
            longNode.line,
            `Longitude "${longNode.value ?? ''}" is not valid`,
          );
        }
        if (lat !== undefined && long !== undefined && this.places.setCoordinates(id, lat, long)) {
          this.use(c);
          this.use(latNode);
          this.use(longNode);
        }
      } else if (NOTE_TAGS.has(c.tag)) {
        this.mapNote(c, { type: 'place', id });
      }
    }
    return id;
  }

  // ------------------------------------------------------------ notes, citations, tags, media links

  private mapNote(node: GedcomNode, owner: Owner): void {
    if (node.pointer !== undefined) {
      const noteId = this.resolve(node, 'NOTE', 'SNOTE');
      if (!noteId) return;
      this.use(node);
      this.link('note_link', 'note_id', noteId, owner);
      return;
    }
    const value = text(node);
    if (!value) return;
    this.use(node);
    if (owner.type === 'place') {
      // A place repeats on many events; keep its note once.
      const key = `note|${owner.id}|${value}`;
      if (this.linkKeys.has(key)) return;
      this.linkKeys.add(key);
    }
    const id = this.options.newId();
    this.sink.insert('note', { id, text: value, import_batch_id: this.options.batchId });
    this.link('note_link', 'note_id', id, owner);
    for (const c of node.children) {
      if (c.tag === 'SOUR') this.mapCitation(c, { type: 'note', id });
    }
  }

  private mapCitation(node: GedcomNode, owner: Owner): void {
    let sourceId: string | null | undefined;
    if (node.pointer !== undefined) {
      sourceId = this.resolve(node, 'SOUR');
    } else if (text(node)) {
      // GEDCOM 5.5 inline source: a source made of just this text.
      const value = node.value!;
      sourceId = this.options.newId();
      this.sink.insert('source', {
        id: sourceId,
        title: value.split('\n')[0]!.slice(0, 250),
        text: value,
        import_batch_id: this.options.batchId,
      });
    }
    if (!sourceId) return;
    this.use(node);
    const row: InsertRow<'citation'> = { source_id: sourceId };
    const attachments: GedcomNode[] = [];
    const texts: string[] = [];
    for (const c of node.children) {
      switch (c.tag) {
        case 'PAGE':
          if (text(c)) {
            row.page = c.value!;
            this.use(c);
          }
          break;
        case 'QUAY': {
          const quality = /^\s*[0-3]\s*$/.test(c.value ?? '') ? Number(c.value) : undefined;
          if (quality === undefined) {
            this.warn('invalid-value', c.line, `QUAY "${c.value ?? ''}" is not 0-3`);
          } else {
            row.quality = quality;
            this.use(c);
          }
          break;
        }
        case 'DATA':
          this.use(c);
          for (const d of c.children) {
            if (d.tag === 'DATE' && text(d)) {
              row.date_text = d.value!;
              this.use(d);
            } else if (d.tag === 'TEXT' && text(d)) {
              texts.push(d.value!);
              this.use(d);
            } else if ((d.tag === 'WWW' || d.tag === '_LINK') && text(d) && !row.url) {
              row.url = d.value!.trim();
              this.use(d);
            }
          }
          break;
        case 'TEXT':
          if (text(c)) {
            texts.push(c.value!);
            this.use(c);
          }
          break;
        case 'WWW':
        case '_LINK':
          if (text(c) && !row.url) {
            row.url = c.value!.trim();
            this.use(c);
          }
          break;
        case '_APID':
          if (text(c)) {
            row.apid = c.value!.trim();
            this.use(c);
          }
          break;
        case 'NOTE':
        case 'SNOTE':
        case 'OBJE':
          attachments.push(c);
          break;
      }
    }
    if (texts.length) row.text = texts.join('\n');
    // Ancestry repeats the same citation on many facts; share one row when nothing hangs off it.
    const key = attachments.length
      ? undefined
      : [sourceId, row.page, row.quality, row.date_text, row.text, row.url, row.apid].join(
          '\u0000',
        );
    let citationId = key ? this.citationKeys.get(key) : undefined;
    if (!citationId) {
      citationId = this.options.newId();
      this.sink.insert('citation', { ...row, id: citationId });
      if (key) this.citationKeys.set(key, citationId);
      const citationOwner = { type: 'citation', id: citationId };
      for (const c of attachments) {
        if (c.tag === 'OBJE') this.mapMediaLink(c, citationOwner);
        else this.mapNote(c, citationOwner);
      }
    }
    this.link('citation_link', 'citation_id', citationId, owner);
  }

  private mapTagLink(node: GedcomNode, owner: Owner): void {
    const tagId = this.resolve(node, '_MTTAG');
    if (!tagId) return;
    this.use(node);
    this.link('tag_link', 'tag_id', tagId, owner);
  }

  /** An OBJE pointer or inline OBJE under an owner; returns the media id. */
  private mapMediaLink(node: GedcomNode, owner: Owner): string | undefined {
    let mediaId: string | null | undefined;
    if (node.pointer !== undefined) {
      mediaId = this.resolve(node, 'OBJE');
      if (!mediaId) return undefined;
    } else {
      if (!this.child(node, 'FILE')) return undefined;
      mediaId = this.options.newId();
      this.mapMedia(node, mediaId, undefined);
    }
    this.use(node);
    this.link('media_link', 'media_id', mediaId, owner);
    return mediaId;
  }

  // ------------------------------------------------------------ media

  private mapMedia(node: GedcomNode, id: string, xref: string | undefined): void {
    this.use(node);
    const row: InsertRow<'media'> & { id: string } = {
      id,
      external_id: xref ?? null,
      import_batch_id: this.options.batchId,
    };
    let kind: MediaKind | undefined;
    let fileSeen = false;
    const owner = { type: 'media', id };
    const form = (n: GedcomNode) => {
      const type = mediaType(n.value);
      if (type) {
        row.mime ??= type.mime;
        kind ??= type.kind;
        this.use(n);
      }
      for (const t of n.children) {
        if ((t.tag === 'TYPE' || t.tag === 'MEDI') && text(t)) {
          kind = kindFromType(t.value);
          this.use(t);
        }
      }
    };
    for (const c of node.children) {
      switch (c.tag) {
        case 'FILE': {
          if (fileSeen || !text(c)) break;
          fileSeen = true;
          this.mapFile(c, row, xref);
          const type = mediaType(row.local_path ?? row.remote_url ?? undefined);
          for (const f of c.children) {
            if (f.tag === 'FORM') form(f);
            else if (f.tag === 'TITL' && text(f)) {
              row.title = f.value!;
              this.use(f);
            }
          }
          if (type) {
            row.mime ??= type.mime;
            kind ??= type.kind;
          }
          break;
        }
        case 'FORM':
          form(c);
          break;
        case 'TITL':
          if (text(c) && !row.title) {
            row.title = c.value!;
            this.use(c);
          }
          break;
        case '_OID':
          if (text(c)) {
            row.ancestry_oid = c.value!.trim();
            this.use(c);
          }
          break;
        case 'DATE':
        case '_DATE':
          if (text(c) && !row.date_text) {
            row.date_text = c.value!;
            this.use(c);
          }
          break;
        case '_DSCR':
        case '_DESC':
          if (text(c) && !row.description) {
            row.description = c.value!;
            this.use(c);
          }
          break;
        case '_TYPE':
        case '_MTYPE':
          if (text(c)) {
            kind = kindFromType(c.value);
            this.use(c);
          }
          break;
        case '_WDTH':
        case '_HGHT':
        case '_SIZE': {
          const n = /^\s*\d+\s*$/.test(c.value ?? '') ? Number(c.value) : undefined;
          if (n === undefined) break;
          if (c.tag === '_WDTH') row.width = n;
          else if (c.tag === '_HGHT') row.height = n;
          else row.byte_size ??= n;
          this.use(c);
          break;
        }
        default:
          this.mapAttachment(c, owner);
      }
    }
    if (kind) row.kind = kind;
    this.sink.insert('media', row);
  }

  private mapFile(node: GedcomNode, row: InsertRow<'media'>, xref: string | undefined): void {
    const value = node.value!.trim();
    const ref = classifyFile(value);
    if (ref.type === 'remote') {
      row.remote_url = ref.url;
      this.remoteMedia++;
      this.use(node);
      return;
    }
    if (ref.type === 'unsafe') {
      this.rejectedMedia++;
      this.warn(
        'media-unsafe-path',
        node.line,
        `Media path "${value}" leaves the media folder; not linked`,
      );
      return;
    }
    const file = this.options.media.find(ref);
    const missing = () =>
      this.missingMedia.push({
        path: ref.type === 'local' ? ref.path : value,
        line: node.line,
        ...(xref && { xref }),
      });
    if (!file) {
      missing();
      if (this.options.media.available) {
        this.warn('media-missing', node.line, `Media file "${value}" was not found`);
      }
      if (ref.type === 'local') {
        row.local_path = ref.path;
        this.use(node);
      }
      return;
    }
    row.local_path = file.path;
    this.use(node);
    if (file.size > this.options.maxMediaBytes) {
      this.warn('media-too-large', node.line, `Media file "${file.path}" is too large to copy`);
      return;
    }
    try {
      const bytes = file.read();
      if (this.options.mediaRoot && !this.copiedMedia.has(file.path)) {
        writeMediaFile(this.options.mediaRoot, file.path, bytes);
        this.copiedMedia.add(file.path);
      }
      row.byte_size = bytes.length;
      row.sha256 = sha256(bytes);
      this.linkedMedia++;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.warn(
        'media-copy-failed',
        node.line,
        `Media file "${file.path}" could not be copied: ${reason}`,
      );
    }
  }

  // ------------------------------------------------------------ other records

  private mapFamily(record: GedcomNode, id: string): void {
    this.use(record);
    const family: FamilyState = {
      id,
      xref: record.xref,
      line: record.line,
      partner1: null,
      partner2: null,
      partner1Order: 0,
      partner2Order: 0,
      status: undefined,
      privacy: 'public',
      childCount: 0,
      eventOrder: 0,
      marriages: [],
    };
    this.families.set(id, family);
    const owner = { type: 'family', id };
    for (const c of record.children) {
      switch (c.tag) {
        case 'HUSB':
        case 'WIFE': {
          const personId = this.resolve(c, 'INDI');
          if (personId === null) {
            this.use(c);
            break;
          }
          if (!personId) break;
          const slot = c.tag === 'HUSB' ? 'partner1' : 'partner2';
          const other = c.tag === 'HUSB' ? 'partner2' : 'partner1';
          if (family[slot]) {
            this.warn(
              'duplicate-link',
              c.line,
              `Family ${record.xref ?? ''} already has a ${c.tag}`,
            );
          } else if (family[other] === personId) {
            this.warn('self-relationship', c.line, `${c.pointer} cannot be their own partner`);
          } else {
            family[slot] = personId;
            this.use(c);
          }
          break;
        }
        case 'CHIL': {
          const childId = this.resolve(c, 'INDI');
          if (childId === null) this.use(c);
          if (!childId) break;
          const link = this.childLink(id, childId);
          if (link.chil) {
            this.warn('duplicate-link', c.line, `CHIL ${c.pointer} is repeated`);
            break;
          }
          link.chil = c;
          link.sortOrder = family.childCount++;
          break;
        }
        case '_STAT': {
          const status = relationshipStatus(c.value);
          if (status) {
            family.status = status;
            this.use(c);
          }
          break;
        }
        case 'RESN': {
          const level = privacy(c.value);
          if (level) {
            family.privacy = level;
            this.use(c);
          }
          break;
        }
        default:
          if (this.isEvent(c, FAM_EVENTS)) {
            const event = this.mapEvent(c, owner, family.eventOrder++, true);
            if (c.tag === 'MARR') family.marriages.push(marriage(event));
          } else {
            this.mapAttachment(c, owner);
          }
      }
    }
  }

  private childLink(familyId: string, childId: string): ChildLink {
    const key = `${familyId}|${childId}`;
    let link = this.childLinks.get(key);
    if (!link) {
      link = {
        id: this.options.newId(),
        familyId,
        childId,
        chil: undefined,
        famc: undefined,
        sortOrder: -1,
        childOrder: -1,
        adopted1: false,
        adopted2: false,
      };
      this.childLinks.set(key, link);
    }
    return link;
  }

  private mapSource(record: GedcomNode, id: string): void {
    this.use(record);
    const row: InsertRow<'source'> & { id: string } = {
      id,
      title: '',
      external_id: record.xref ?? null,
      import_batch_id: this.options.batchId,
    };
    const owner = { type: 'source', id };
    const fields: Record<
      string,
      'title' | 'author' | 'publication' | 'abbreviation' | 'text' | 'apid'
    > = {
      TITL: 'title',
      AUTH: 'author',
      PUBL: 'publication',
      ABBR: 'abbreviation',
      TEXT: 'text',
      _APID: 'apid',
    };
    for (const c of record.children) {
      const field = fields[c.tag];
      if (field) {
        if (text(c) && !row[field]) {
          row[field] = field === 'apid' ? c.value!.trim() : c.value!;
          this.use(c);
        }
      } else if (c.tag === 'REPO') {
        if (row.repository_id) continue;
        let repoId: string | null | undefined;
        if (c.pointer !== undefined) repoId = this.resolve(c, 'REPO');
        else if (text(c)) {
          repoId = this.options.newId();
          this.sink.insert('repository', {
            id: repoId,
            name: c.value!,
            import_batch_id: this.options.batchId,
          });
        }
        if (!repoId) continue;
        row.repository_id = repoId;
        this.use(c);
        const caln = this.child(c, 'CALN');
        if (text(caln)) {
          row.call_number = caln!.value!;
          this.use(caln);
        }
      } else {
        this.mapAttachment(c, owner);
      }
    }
    if (!row.title && row.abbreviation) row.title = row.abbreviation;
    this.sink.insert('source', row);
  }

  private mapRepository(record: GedcomNode, id: string): void {
    this.use(record);
    const row: InsertRow<'repository'> & { id: string } = {
      id,
      name: '',
      external_id: record.xref ?? null,
      import_batch_id: this.options.batchId,
    };
    const fields: Record<string, 'name' | 'url' | 'email' | 'phone'> = {
      NAME: 'name',
      WWW: 'url',
      EMAIL: 'email',
      PHON: 'phone',
    };
    for (const c of record.children) {
      const field = fields[c.tag];
      if (field) {
        if (text(c) && !row[field]) {
          row[field] = c.value!.trim();
          this.use(c);
        }
      } else if (c.tag === 'ADDR') {
        const address = this.address(c);
        if (address) row.address ??= address;
      } else if (NOTE_TAGS.has(c.tag)) {
        this.mapNote(c, { type: 'repository', id });
      }
    }
    this.sink.insert('repository', row);
  }

  private mapNoteRecord(record: GedcomNode, id: string): void {
    this.use(record);
    this.sink.insert('note', {
      id,
      text: record.value ?? '',
      external_id: record.xref ?? null,
      import_batch_id: this.options.batchId,
    });
    for (const c of record.children) {
      if (c.tag === 'SOUR') this.mapCitation(c, { type: 'note', id });
    }
  }

  private mapTag(record: GedcomNode, id: string): void {
    this.use(record);
    const name = this.child(record, 'NAME');
    const category = this.child(record, '_MTCAT');
    if (text(name)) this.use(name);
    if (text(category)) this.use(category);
    // Repeated tag records (same category and name) share the first one's row.
    if (this.insertedTags.has(id)) return;
    this.insertedTags.add(id);
    this.sink.insert('tag', {
      id,
      name: text(name) ? name!.value!.trim() : '',
      category: text(category) ? category!.value!.trim() : '',
      external_id: record.xref ?? null,
      import_batch_id: this.options.batchId,
    });
  }

  // ------------------------------------------------------------ finalize

  /** Resolves cross-record structure and writes buffered rows. Call once, after every mapRecord. */
  finalize(): void {
    this.linkPartners();
    for (const family of this.families.values()) {
      for (const partner of [family.partner1, family.partner2]) {
        if (!partner) continue;
        const list = this.partnerFamilies.get(partner);
        if (list) list.push(family);
        else this.partnerFamilies.set(partner, [family]);
      }
    }
    this.resolveChildLinks();
    this.resolveMarriages();
    this.writeFamilies();
    this.writeChildLinks();
    this.typeLaterNames();
    const relatives = this.relatives();
    this.inferLiving(relatives);
    this.checkCycles(relatives.parents);
    this.writePersons();
    for (const place of this.places.rows()) this.sink.insert('place', place);
    this.chooseHomePerson();
  }

  private linkPartners(): void {
    for (const person of this.persons.values()) {
      person.fams.forEach(({ familyId, node }, order) => {
        const family = this.families.get(familyId)!;
        if (family.partner1 !== person.id && family.partner2 !== person.id) {
          const order: ('partner1' | 'partner2')[] =
            person.sex === 'F' ? ['partner2', 'partner1'] : ['partner1', 'partner2'];
          const slot = order.find((s) => family[s] === null);
          if (!slot) {
            this.warn(
              'one-sided-link',
              node.line,
              `FAMS ${node.pointer} names a family with two other partners`,
            );
            return;
          }
          family[slot] = person.id;
          this.warn(
            'one-sided-link',
            node.line,
            `FAMS ${node.pointer} is missing from the family; added`,
          );
        }
        if (family.partner1 === person.id) family.partner1Order = order;
        else family.partner2Order = order;
        this.use(node);
      });
    }
  }

  private resolveChildLinks(): void {
    for (const link of this.childLinks.values()) {
      const family = this.families.get(link.familyId)!;
      if (link.childId === family.partner1 || link.childId === family.partner2) {
        const node = (link.chil ?? link.famc)!;
        this.warn(
          'self-relationship',
          node.line,
          `${node.pointer} cannot be a child in their own family`,
        );
        this.childLinks.delete(`${link.familyId}|${link.childId}`);
        continue;
      }
      const person = this.persons.get(link.childId)!;
      if (!link.chil) {
        this.warn(
          'one-sided-link',
          link.famc!.line,
          `FAMC ${link.famc!.pointer} is missing from the family's CHIL list; added`,
        );
        link.sortOrder = family.childCount++;
      }
      if (!link.famc) link.childOrder = person.famcCount++;
    }
    for (const person of this.persons.values()) {
      for (const famc of person.adoptions) {
        const familyId = this.resolve(famc, 'FAM');
        const link = familyId ? this.childLinks.get(`${familyId}|${person.id}`) : undefined;
        if (!link) continue;
        this.use(famc);
        const adop = this.child(famc, 'ADOP');
        const who = adop?.value?.trim().toUpperCase() ?? 'BOTH';
        if (adop && ['HUSB', 'WIFE', 'BOTH'].includes(who)) this.use(adop);
        link.adopted1 ||= who !== 'WIFE';
        link.adopted2 ||= who !== 'HUSB';
      }
    }
  }

  private resolveMarriages(): void {
    for (const person of this.persons.values()) {
      if (!person.marriages.length) continue;
      const families = this.partnerFamilies.get(person.id) ?? [];
      for (const node of person.marriages) {
        const date = normalizeDate(text(this.child(node, 'DATE')));
        const placeNode = this.child(node, 'PLAC');
        const place = text(placeNode) ? placeParts(placeNode!.value!).join(', ') : '';
        const match = families
          .flatMap((f) => f.marriages)
          .find((m) => (!date || normalizeDate(m.date) === date) && (!place || m.place === place));
        if (match) {
          // Same marriage as the family's: keep one event, moving any citations and notes onto it.
          this.use(node);
          if (date) this.use(this.child(node, 'DATE'));
          if (place) this.use(placeNode);
          for (const c of node.children)
            this.mapAttachment(c, { type: 'event', id: match.eventId });
          continue;
        }
        const unmarried = families.filter((f) => !f.marriages.length);
        if (unmarried.length === 1) {
          const family = unmarried[0]!;
          const event = this.mapEvent(
            node,
            { type: 'family', id: family.id },
            family.eventOrder++,
            true,
          );
          family.marriages.push(marriage(event));
        } else {
          this.mapPersonEvent(node, person);
        }
      }
    }
  }

  private writeFamilies(): void {
    for (const family of this.families.values()) {
      this.sink.insert('family', {
        id: family.id,
        partner1_id: family.partner1,
        partner2_id: family.partner2,
        relationship_type: family.status ?? (family.marriages.length ? 'married' : 'unknown'),
        partner1_order: family.partner1Order,
        partner2_order: family.partner2Order,
        privacy: family.privacy,
        external_id: family.xref ?? null,
        import_batch_id: this.options.batchId,
      });
    }
  }

  private writeChildLinks(): void {
    for (const link of this.childLinks.values()) {
      const rel = (partner: '_FREL' | '_MREL', adopted: boolean): ChildRelationship => {
        for (const node of [link.famc, link.chil]) {
          if (!node) continue;
          const specific = this.child(node, partner);
          const value = childRelationship(specific?.value);
          if (value) return value;
          const pedi = childRelationship(this.child(node, 'PEDI')?.value);
          if (pedi) return pedi;
        }
        return adopted ? 'adopted' : 'biological';
      };
      const owner = { type: 'family_child', id: link.id };
      for (const node of [link.chil, link.famc]) {
        if (!node) continue;
        this.use(node);
        for (const c of node.children) {
          if (
            (c.tag === '_FREL' || c.tag === '_MREL' || c.tag === 'PEDI') &&
            childRelationship(c.value)
          ) {
            this.use(c);
          } else if (NOTE_TAGS.has(c.tag) || c.tag === 'SOUR') {
            this.mapAttachment(c, owner);
          }
        }
      }
      this.sink.insert('family_child', {
        id: link.id,
        family_id: link.familyId,
        child_id: link.childId,
        partner1_rel: rel('_FREL', link.adopted1),
        partner2_rel: rel('_MREL', link.adopted2),
        sort_order: link.sortOrder,
        child_order: link.childOrder,
        is_preferred: 0,
      });
    }
  }

  /** Later names without TYPE: a spouse's surname makes it a married name (Ancestry writes no TYPE). */
  private typeLaterNames(): void {
    for (const person of this.persons.values()) {
      if (!person.untypedNames.length) continue;
      const spouseSurnames = new Set<string>();
      for (const family of this.partnerFamilies.get(person.id) ?? []) {
        const spouse =
          family.partner1 === person.id
            ? family.partner2
            : family.partner2 === person.id
              ? family.partner1
              : null;
        const surname = spouse ? this.persons.get(spouse)?.surname : null;
        if (surname) spouseSurnames.add(surname.toLowerCase());
      }
      for (const row of person.untypedNames) {
        const surname = row.surname?.toLowerCase();
        row.type =
          surname && surname !== person.surname?.toLowerCase() && spouseSurnames.has(surname)
            ? 'married'
            : 'aka';
        this.sink.insert('person_name', row);
      }
    }
  }

  private relatives() {
    const parents = new Map<string, string[]>();
    const children = new Map<string, string[]>();
    const spouses = new Map<string, string[]>();
    const push = (map: Map<string, string[]>, key: string, value: string) => {
      const list = map.get(key);
      if (list) list.push(value);
      else map.set(key, [value]);
    };
    for (const family of this.families.values()) {
      if (family.partner1 && family.partner2) {
        push(spouses, family.partner1, family.partner2);
        push(spouses, family.partner2, family.partner1);
      }
    }
    for (const link of this.childLinks.values()) {
      const family = this.families.get(link.familyId)!;
      for (const parent of [family.partner1, family.partner2]) {
        if (!parent) continue;
        push(parents, link.childId, parent);
        push(children, parent, link.childId);
      }
    }
    return { parents, children, spouses };
  }

  private inferLiving({ parents, children, spouses }: ReturnType<Mapper['relatives']>): void {
    const births = (ids: string[] | undefined) =>
      (ids ?? []).flatMap((id) => {
        const p = this.persons.get(id)!;
        const birth = p.birth ?? p.birthSubstitute;
        return birth === undefined ? [] : [birth];
      });
    for (const person of this.persons.values()) {
      const result = inferLiving(
        {
          birth: person.birth ?? person.birthSubstitute,
          death: person.death,
          hasDeathFacts: person.deathFact,
          parentBirths: births(parents.get(person.id)),
          spouseBirths: births(spouses.get(person.id)),
          childBirths: births(children.get(person.id)),
        },
        this.options.today,
      );
      person.living = result.living;
      if (result.living) this.living.living++;
      else this.living.deceased++;
    }
  }

  /** Warns (without changing anything) when someone is their own ancestor. */
  private checkCycles(parents: Map<string, string[]>): void {
    const state = new Map<string, 1 | 2>();
    let reported = 0;
    for (const start of this.persons.keys()) {
      if (state.has(start)) continue;
      const stack: { id: string; next: number }[] = [{ id: start, next: 0 }];
      state.set(start, 1);
      while (stack.length) {
        const top = stack[stack.length - 1]!;
        const list = parents.get(top.id) ?? [];
        if (top.next < list.length) {
          const parent = list[top.next++]!;
          const seen = state.get(parent);
          if (seen === 1) {
            if (reported++ < 100) {
              const person = this.persons.get(parent)!;
              this.warn(
                'relationship-cycle',
                person.line,
                `${person.xref ?? 'A person'} is their own ancestor`,
              );
            }
          } else if (!seen) {
            state.set(parent, 1);
            stack.push({ id: parent, next: 0 });
          }
        } else {
          state.set(top.id, 2);
          stack.pop();
        }
      }
    }
  }

  private writePersons(): void {
    for (const person of this.persons.values()) {
      this.sink.insert('person', {
        id: person.id,
        sex: person.sex,
        living: person.living ? 'inferred_living' : 'inferred_dead',
        privacy: person.privacy,
        primary_media_id: person.photo ?? person.primaryMedia,
        external_id: person.xref ?? null,
        import_batch_id: this.options.batchId,
      });
    }
  }

  private chooseHomePerson(): void {
    const head = this.doc.records.find((r) => r.tag === 'HEAD');
    const tree = head && this.child(this.child(head, 'SOUR') ?? head, '_TREE');
    const pointer = [...(head?.children ?? []), ...(tree?.children ?? [])].find(
      (c) => HOME_TAGS.has(c.tag) && c.pointer,
    );
    if (pointer) {
      const target = this.targets.get(pointer.pointer!);
      if (target?.tag === 'INDI') {
        this.homePersonId = target.id;
        this.homePersonSource = 'header';
      } else {
        this.warn(
          'home-person',
          pointer.line,
          `Home person ${pointer.pointer} is not an individual in this file`,
        );
      }
    }
    if (!this.homePersonId && this.firstPerson) {
      this.homePersonId = this.firstPerson;
      this.homePersonSource = 'first-person';
    }
    if (this.homePersonId)
      this.sink.insert('meta', { key: 'home_person_id', value: this.homePersonId });
  }

  // ------------------------------------------------------------ accounting

  /**
   * Writes an unmapped_line row for every line that was not mapped (outside
   * HEAD, SUBM and TRLR, which are kept whole in raw_record) and returns the
   * line accounting.
   */
  accountLines(): { total: number; mapped: number; preserved: number; unmapped: UnmappedTag[] } {
    let preserved = 0;
    const add = (
      owner: Owner | null,
      path: string,
      tag: string,
      line: number,
      lineText: string,
    ) => {
      preserved++;
      this.sink.insert('unmapped_line', {
        import_batch_id: this.options.batchId,
        owner_type: owner?.type ?? null,
        owner_id: owner?.id ?? null,
        path,
        line_no: line,
        line: lineText,
      });
      const entry = this.unmappedByPath.get(path);
      if (entry) entry.count++;
      else
        this.unmappedByPath.set(path, { path, tag, count: 1, example: { line, text: lineText } });
    };
    for (const line of this.doc.preamble)
      add(null, '(preamble)', '(preamble)', line.line, line.text);

    this.doc.records.forEach((record, i) => {
      if (RAW_ONLY.has(record.tag)) {
        preserved += countLines(record);
        return;
      }
      const ownerType = RECORD_OWNERS[record.tag];
      const owner = ownerType ? { type: ownerType, id: this.recordIds[i]! } : null;
      let lines: string[] | undefined;
      const lineText = (n: number) => {
        lines ??= serializeNode(record, { version: this.major }).split('\n');
        return lines[n - record.line] ?? '';
      };
      const visit = (node: GedcomNode, path: string) => {
        if (!this.mapped[node.line]) {
          add(owner, path, node.tag, node.line, lineText(node.line));
          for (const c of node.continuations ?? []) {
            add(owner, `${path}.${c.tag}`, c.tag, c.line, lineText(c.line));
          }
        }
        for (const e of node.extra ?? []) {
          const kind = e.text.trim() ? '(unparsed)' : '(blank)';
          add(owner, `${path}.${kind}`, kind, e.line, e.text);
        }
        for (const c of node.continuations ?? []) {
          for (const e of c.extra ?? []) {
            const kind = e.text.trim() ? '(unparsed)' : '(blank)';
            add(owner, `${path}.${kind}`, kind, e.line, e.text);
          }
        }
        for (const child of node.children) visit(child, `${path}.${child.tag}`);
      };
      visit(record, record.tag);
    });

    let mapped = 0;
    for (let i = 0; i < this.mapped.length; i++) mapped += this.mapped[i]!;
    const total = this.doc.lines.total;
    if (mapped + preserved !== total) {
      this.warn(
        'line-accounting',
        0,
        `Line accounting is off: ${mapped} mapped + ${preserved} preserved != ${total}`,
      );
    }
    const unmapped = [...this.unmappedByPath.values()].sort(
      (a, b) => b.count - a.count || a.path.localeCompare(b.path),
    );
    return { total, mapped, preserved, unmapped };
  }
}

function countLines(node: GedcomNode): number {
  let n = 1 + (node.extra?.length ?? 0);
  for (const c of node.continuations ?? []) n += 1 + (c.extra?.length ?? 0);
  for (const child of node.children) n += countLines(child);
  return n;
}

function marriage(event: { id: string; date: string | undefined; place: string }): Marriage {
  return { eventId: event.id, date: event.date ?? '', place: event.place };
}

function normalizeDate(date: string | undefined): string {
  return (date ?? '').trim().replace(/\s+/g, ' ').toUpperCase();
}

const DATE_CACHE = new Map<
  string,
  Pick<
    InsertRow<'event'>,
    'date_text' | 'date_qualifier' | 'date_sort' | 'date_sort_end' | 'calendar'
  >
>();

/** `person_name.surname_key`: Soundex and Double Metaphone keys, space separated. */
export function surnameKey(surname: string | null | undefined): string | null {
  return surname ? phoneticKeys(surname).join(' ') || null : null;
}

/** Event date columns from the date as written (parsed by packages/core). */
export function dateColumns(dateText: string) {
  let columns = DATE_CACHE.get(dateText);
  if (!columns) {
    const parsed = parseDate(dateText);
    columns = parsed.valid
      ? {
          date_text: dateText,
          date_qualifier: parsed.qualifier,
          date_sort: parsed.sortKey,
          date_sort_end: parsed.sortKeyEnd ?? null,
          calendar:
            parsed.calendar === 'gregorian' || parsed.calendar === 'unknown'
              ? null
              : parsed.calendar,
        }
      : {
          date_text: dateText,
          date_qualifier: 'text',
          date_sort: null,
          date_sort_end: null,
          calendar: null,
        };
    if (DATE_CACHE.size > 50_000) DATE_CACHE.clear();
    DATE_CACHE.set(dateText, columns);
  }
  return columns;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
