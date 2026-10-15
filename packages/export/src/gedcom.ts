import {
  type Privacy,
  isLiving,
  type MediaRow,
  type NoteRow,
  type RawRecordRow,
  type TreeStore,
  type UnmappedLineRow,
} from '@open-ancestry/db';
import {
  analyzeHeader,
  parseGedcom,
  resnRestrictions,
  serializeNode,
  tokenizeLine,
  type GedcomNode,
} from '@open-ancestry/gedcom';
import {
  RecordWriter,
  canonicalize,
  n,
  p,
  setLevels,
  v,
  type RecordKind,
  type WriterContext,
} from './canonical';
import { dirtyRecords, nameTextStates, type NameTextState } from './dirty';
import { mergeUnmapped, type MergeContext } from './merge';
import { TreeData, ownerKey } from './load';
import type { GedcomExport, GedcomExportOptions } from './types';

/** Where the extension tags this exporter writes are documented (HEAD.SCHMA URIs). */
export const EXTENSIONS_DOC =
  'https://github.com/adamsilverstein/open-ancestry/blob/main/docs/gedcom-extensions.md';

const PREFIX: Record<RecordKind, string> = {
  person: 'I',
  family: 'F',
  source: 'S',
  repository: 'R',
  media: 'O',
  note: 'N',
  tag: 'T',
};
const KIND_ORDER: RecordKind[] = [
  'person',
  'family',
  'source',
  'repository',
  'media',
  'note',
  'tag',
];
const KINDS = new Set<string>(KIND_ORDER);

/** Xrefs we may reuse: GEDCOM 7 allows only upper-case letters, digits and `_`; 5.5.1 readers take anything the tokenizer does. */
const XREF_7 = /^@[A-Z0-9_]{1,20}@$/;
// eslint-disable-next-line no-control-regex
const XREF_5 = /^@[^@#\s\x00-\x1f\x7f][^@\s\x00-\x1f\x7f]*@$/;

/** Pointer payloads in raw GEDCOM lines (`1 FAMS @F1@`). */
const POINTER_LINE =
  /^[ \t]*\d+[ \t]+(?:@[^@\s]+@[ \t]+)?[A-Za-z0-9_]+[ \t]+(@[^@#\s][^@\s]*@)[ \t]*$/gm;
/** Extension tags in GEDCOM lines, for HEAD.SCHMA. */
const EXTENSION_TAG = /^[ \t]*\d+[ \t]+(?:@[^@\s]+@[ \t]+)?(_[A-Za-z0-9_]+)/gm;

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** The only lines a privatized person or family may have; anything else is a leak. */
const PRIVATE_LINES: Record<string, ReadonlySet<string>> = {
  INDI: new Set(['NAME', 'SEX', 'FAMC', 'FAMS']),
  FAM: new Set(['HUSB', 'WIFE', 'CHIL']),
};

/**
 * Cuts a privatized record down to its allowlist, as a last line of defence
 * after generation: the name is "Private" and no line carries anything below it.
 */
function allowlist(record: GedcomNode): void {
  const allowed = PRIVATE_LINES[record.tag]!;
  record.children = record.children
    .filter((c) => allowed.has(c.tag))
    .map((c) => ({ ...c, ...(c.tag === 'NAME' && { value: 'Private' }), children: [] }));
}

/** Privacy levels a privatized export withholds (not `locked`, which only guards edits). */
const withheldPrivacy = (privacy: Privacy) => privacy === 'private' || privacy === 'confidential';

/** Options only the GEDZIP writer uses. */
export interface InternalOptions extends GedcomExportOptions {
  /** FILE value for a media row; also tells the caller which media were written. */
  filePath?: (media: MediaRow) => string | undefined;
  /** False forces every record through the canonical writer. */
  verbatim?: boolean;
}

interface Slot {
  raw: RawRecordRow;
  /** More records mapped to the same row, e.g. both records of two merged people. */
  also?: RawRecordRow[];
  kind?: RecordKind;
  id?: string;
  /** verbatim: raw text; canonical: the domain row; raw: raw-only record re-parsed. */
  mode: 'verbatim' | 'canonical' | 'raw';
}

/**
 * Exports a tree as GEDCOM text. A record whose rows no applied change batch
 * has touched since import is copied from raw_record exactly, so every
 * Ancestry custom tag survives; anything edited or created in the app (or
 * exported to the other GEDCOM version, or privatized) is generated from the
 * domain tables. Xrefs from the import are kept, new records get the next
 * free `@I<n>@`, and every pointer written resolves.
 *
 * @throws GedcomSerializeError when a row cannot be written as valid GEDCOM (an invalid event tag).
 */
export function buildGedcomExport(store: TreeStore, options: InternalOptions = {}): GedcomExport {
  return new GedcomWriter(store, options).run();
}

export function exportGedcom(store: TreeStore, options: GedcomExportOptions = {}): string {
  return buildGedcomExport(store, options).text;
}

class GedcomWriter implements WriterContext, MergeContext {
  readonly data: TreeData;
  readonly v7: boolean;
  readonly includeMedia: boolean;
  private readonly store: TreeStore;
  private readonly options: InternalOptions;
  private readonly privatize: boolean;
  private readonly living = new Set<string>();
  private readonly privateFamilies = new Set<string>();
  private readonly withheld = new Set<string>();
  /** Imported FILE lines `filePath` wrote for media whose file was missing. */
  private readonly usedFileLines = new Set<UnmappedLineRow>();
  /** FILE lines of trees imported before they were kept with their media, by media id. */
  private readonly legacyFiles = new Map<string, UnmappedLineRow>();
  private readonly hiddenEvents = new Set<string>();
  private nameStates: Map<string, NameTextState> | undefined;
  private readonly xrefs = new Map<string, string>();
  private readonly used = new Set<string>();
  private readonly counters = new Map<string, number>();
  /** How each record is written, by `kind|id`. */
  private readonly planned = new Map<string, 'verbatim' | 'generate'>();
  private readonly queue: [RecordKind, string][] = [];
  private next = 0;
  private readonly warnings: string[] = [];
  /** Xrefs the output defines, once every record is planned. */
  private written: Set<string> | undefined;
  private importedXrefs: Map<string, { kind: RecordKind; id: string } | null> | undefined;
  /** Imported xrefs, upper-cased, for scrubbing text in privatized exports. */
  private importedIds: Set<string> | undefined;
  private readonly generated = new Map<string, GedcomNode>();
  private readonly slots: Slot[] = [];
  private readonly slotByKey = new Map<string, Slot>();
  private readonly writer: RecordWriter;
  private head: RawRecordRow | undefined;
  private verbatim = false;

  constructor(store: TreeStore, options: InternalOptions) {
    this.store = store;
    this.options = options;
    this.data = new TreeData(store);
    this.v7 = options.version === '7';
    this.includeMedia = options.includeMedia ?? true;
    this.privatize = options.privatizeLiving ?? false;
    if (this.privatize) {
      // Withheld like living people: anyone marked private or confidential (GEDCOM RESN
      // privacy/confidential), and families or events so marked. RESN locked means "do not
      // edit", not private, so a locked record is exported.
      for (const person of this.data.persons) {
        if (isLiving(person.living) || withheldPrivacy(person.privacy)) this.living.add(person.id);
      }
      this.findNestedRestrictions();
      for (const f of this.data.families) {
        if (
          withheldPrivacy(f.privacy) ||
          this.living.has(f.partner1_id!) ||
          this.living.has(f.partner2_id!)
        ) {
          this.privateFamilies.add(f.id);
        }
      }
      for (const [id, event] of this.data.event) {
        if (withheldPrivacy(event.privacy)) this.hiddenEvents.add(id);
      }
      this.findWithheld();
    }
    this.findMediaWithoutFile();
    this.writer = new RecordWriter(this);
  }

  // ------------------------------------------------------------ WriterContext

  ref(kind: RecordKind, id: string): string {
    const key = ownerKey(kind, id);
    if (!this.planned.has(key)) {
      this.planned.set(key, 'generate');
      this.queue.push([kind, id]);
    }
    return this.xrefOf(kind, id);
  }

  isPrivatePerson(id: string | null): boolean {
    return id !== null && this.living.has(id);
  }

  isPrivateFamily(id: string): boolean {
    return this.privateFamilies.has(id);
  }

  nameTextState(nameId: string): NameTextState | undefined {
    this.nameStates ??= nameTextStates(this.store);
    return this.nameStates.get(nameId);
  }

  isHiddenEvent(id: string): boolean {
    return this.hiddenEvents.has(id);
  }

  get quoteLines(): boolean {
    return !this.privatize;
  }

  get treeName(): string | null {
    return this.privatize ? null : this.data.treeName;
  }

  isWithheld(id: string): boolean {
    return this.withheld.has(id);
  }

  /**
   * RESN the importer does not map (under a name, a citation or a media link,
   * on a source, note or media record, or a second RESN line in an older
   * import) stays in unmapped_line. Its owner is withheld whole, failing
   * closed: anything but a plain `locked` counts as private.
   */
  private findNestedRestrictions(): void {
    for (const rows of this.data.unmapped.values()) {
      for (const [i, row] of rows.entries()) {
        if (!row.path.endsWith('.RESN')) continue;
        let text = row.line.replace(/^\s*\d+\s+(?:@[^@]+@\s+)?RESN/, '');
        for (const next of rows.slice(i + 1)) {
          if (!next.path.startsWith(`${row.path}.`)) break;
          text += ` ${next.line.replace(/^\s*\d+\s+CON[CT]\s?/, '')}`;
        }
        if (resnRestrictions(text).every((r) => r === 'LOCKED')) continue;
        const id = row.owner_id!;
        if (row.owner_type === 'person') this.living.add(id);
        else if (row.owner_type === 'family') this.privateFamilies.add(id);
        else if (row.owner_type === 'event') this.hiddenEvents.add(id);
        else this.withheld.add(id);
      }
    }
    // Before RESN lines combined, an import stored "locked, privacy" (or locked then
    // confidential) as locked: re-read those records' own RESN lines.
    const locked = new Set(
      [...this.data.persons, ...this.data.families]
        .filter((r) => r.privacy === 'locked')
        .map((r) => r.id),
    );
    if (!locked.size) return;
    for (const raw of this.data.rawRecords) {
      if (!raw.owner_id || !locked.has(raw.owner_id)) continue;
      const record = parseGedcom(raw.raw_text).records[0];
      const resn = record?.children.filter((c) => c.tag === 'RESN').map((c) => c.value);
      if (!resn || resnRestrictions(resn.join(',')).every((r) => r === 'LOCKED')) continue;
      if (raw.owner_type === 'person') this.living.add(raw.owner_id);
      else if (raw.owner_type === 'family') this.privateFamilies.add(raw.owner_id);
    }
  }

  /**
   * Notes and media are personal: one attached anywhere to a privatized
   * person or family (directly, or through their names, events, child links
   * or citations) is left out of the whole export, even where someone else
   * shares it, since its text or image is about them.
   */
  private findWithheld(): void {
    const d = this.data;
    const memo = new Map<string, boolean>();
    const owned = (type: string, id: string): boolean => {
      const key = ownerKey(type, id);
      const known = memo.get(key);
      if (known !== undefined) return known;
      memo.set(key, false);
      let result = false;
      switch (type) {
        case 'person':
          result = this.living.has(id);
          break;
        case 'person_name':
          result = this.living.has(d.nameOwner.get(id)!);
          break;
        case 'family':
          result = this.privateFamilies.has(id);
          break;
        case 'family_child': {
          const link = d.familyChild.get(id);
          result =
            !!link && (this.living.has(link.child_id) || this.privateFamilies.has(link.family_id));
          break;
        }
        case 'event':
          result =
            this.hiddenEvents.has(id) ||
            (d.rolesByEvent.get(id) ?? []).some(
              (r) =>
                (r.person_id && this.living.has(r.person_id)) ||
                (r.family_id && this.privateFamilies.has(r.family_id)),
            );
          break;
        case 'citation':
          result = (d.citationLinksByCitation.get(id) ?? []).some((l) =>
            owned(l.owner_type, l.owner_id),
          );
          break;
        case 'media':
          result = this.withheld.has(id);
          break;
      }
      memo.set(key, result);
      return result;
    };
    for (const m of d.mediaRows) {
      const users = d.mediaLinksByMedia.get(m.id) ?? [];
      const photoOf = d.primaryOf.get(m.id) ?? [];
      if (
        users.some((l) => owned(l.owner_type, l.owner_id)) ||
        photoOf.some((p) => this.living.has(p.id))
      ) {
        this.withheld.add(m.id);
      }
    }
    // The importer stores identical files once: a file shared with a withheld item is
    // withheld too, or its name (often the person's) would still be exported.
    const withheldPaths = new Set(
      d.mediaRows.filter((m) => this.withheld.has(m.id) && m.local_path).map((m) => m.local_path),
    );
    for (const m of d.mediaRows) {
      if (m.local_path && withheldPaths.has(m.local_path)) this.withheld.add(m.id);
    }
    memo.clear();
    for (const note of d.notes) {
      if ((d.noteLinksByNote.get(note.id) ?? []).some((l) => owned(l.owner_type, l.owner_id))) {
        this.withheld.add(note.id);
      }
    }
  }

  isNoteRecord(note: NoteRow): boolean {
    const links = this.data.noteLinksByNote.get(note.id)?.length ?? 0;
    return this.slotByKey.has(ownerKey('note', note.id)) || !!note.external_id || links !== 1;
  }

  filePath(media: MediaRow): string | undefined {
    const path = this.options.filePath ? this.options.filePath(media) : this.storedPath(media);
    if (path !== undefined) return path;
    // A file missing at import: its FILE line as written, so the reference is kept.
    const original = this.originalFile(media);
    if (!original) return undefined;
    this.usedFileLines.add(original.row);
    return this.fileValue(original.value);
  }

  private storedPath(media: MediaRow): string | undefined {
    if (media.remote_url) return media.remote_url;
    if (!media.local_path) return undefined;
    // GEDCOM 7 FILE values are URI references.
    return this.v7
      ? media.local_path.split('/').map(encodeURIComponent).join('/')
      : media.local_path;
  }

  /** The imported FILE line of media whose file was not found, kept in unmapped_line. */
  private originalFile(media: MediaRow): { row: UnmappedLineRow; value: string } | undefined {
    const rows = this.data.unmapped.get(ownerKey('media', media.id)) ?? [];
    const legacy = this.legacyFiles.get(media.id);
    for (const row of legacy ? [...rows, legacy] : rows) {
      if (!/(^|\.)FILE$/.test(row.path)) continue;
      const value = tokenizeLine(row.line)?.value?.trim();
      if (value) return { row, value };
    }
    return undefined;
  }

  /**
   * Trees imported before the FILE line was kept with its media have it among
   * the owner's lines instead. Each owner's pathless inline media pair with its
   * unmapped OBJE.FILE lines in order, but only when the counts agree, so a
   * photo never gets someone else's path.
   */
  private findLegacyFiles(): void {
    const d = this.data;
    for (const [key, links] of d.mediaLinks) {
      const lines = (d.unmapped.get(key) ?? []).filter((r) => /(^|\.)OBJE\.FILE$/.test(r.path));
      if (lines.length === 0) continue;
      const pathless = links
        .map((l) => d.media.get(l.media_id))
        .filter(
          (m): m is MediaRow =>
            !!m &&
            !m.external_id &&
            !m.local_path &&
            !m.remote_url &&
            d.mediaLinksByMedia.get(m.id)?.length === 1 &&
            !this.originalFile(m),
        );
      if (pathless.length !== lines.length) continue;
      const ordered = [...lines].sort((a, b) => a.line_no - b.line_no);
      pathless.forEach((m, i) => this.legacyFiles.set(m.id, ordered[i]!));
    }
  }

  /**
   * Media with no file and no imported path to name one (trees imported before
   * the FILE line was kept with its media) are left out of generated records:
   * an empty FILE is invalid in both GEDCOM versions.
   */
  private findMediaWithoutFile(): void {
    this.findLegacyFiles();
    for (const m of this.data.mediaRows) {
      if (this.withheld.has(m.id) || m.local_path || m.remote_url || this.originalFile(m)) continue;
      this.withheld.add(m.id);
      // A privatized export does not quote what it leaves out.
      const what = this.quoteLines && m.title ? `"${m.title}"` : 'A media item';
      this.warn(`${what} has no file path and was left out`);
    }
  }

  // ------------------------------------------------------------ export

  run(): GedcomExport {
    const verbatim = (this.verbatim = this.canCopyRaw());
    const dirty = verbatim ? dirtyRecords(this.store, this.data) : new Set<string>();
    this.planSlots(verbatim, dirty);
    this.reserveXrefs();
    this.planRecords();
    this.drain();
    this.repairVerbatimPointers();
    this.drain();
    this.written = this.writtenXrefs();

    const records: string[] = [];
    const placed = new Set<string>();
    let verbatimCount = 0;
    let submitter: string | undefined;
    for (const slot of this.slots) {
      const key = slot.kind && ownerKey(slot.kind, slot.id!);
      let text: string | undefined;
      if (slot.mode === 'verbatim') {
        text = slot.raw.raw_text;
        verbatimCount++;
      } else if (slot.mode === 'raw') {
        text = this.rawOnly(slot.raw);
      } else if (key && this.generated.has(key) && !placed.has(key)) {
        text = this.serialize(this.generated.get(key)!);
        placed.add(key);
      }
      if (text === undefined) continue;
      if (slot.raw.gedcom_tag === 'SUBM') submitter ??= slot.raw.xref ?? undefined;
      records.push(text);
    }
    const rest = [...this.generated].filter(([key]) => !placed.has(key));
    rest.sort(([a], [b]) => {
      const [ka, ia] = a.split('|') as [RecordKind, string];
      const [kb, ib] = b.split('|') as [RecordKind, string];
      return KIND_ORDER.indexOf(ka) - KIND_ORDER.indexOf(kb) || (ia < ib ? -1 : 1);
    });
    for (const [, node] of rest) records.push(this.serialize(node));
    // GEDCOM 5.5.1 requires a submitter; a copied HEAD keeps whatever the file had.
    if (!submitter && !this.v7 && !(this.head && this.verbatim)) {
      submitter = this.newXref('SUBM');
      records.push(
        this.serialize(
          setLevels(
            Object.assign(n('SUBM', undefined, [n('NAME', 'open-ancestry')]), { xref: submitter }),
          ),
        ),
      );
    }

    const head = this.headRecord(records, submitter);
    const text = [head, ...records, '0 TRLR'].join('\n') + '\n';
    return {
      text,
      xrefs: this.xrefs,
      stats: { verbatim: verbatimCount, generated: this.generated.size },
      warnings: this.warnings,
    };
  }

  /** Raw text can be copied when it is already in the target version and nothing must be hidden. */
  private canCopyRaw(): boolean {
    const raw = this.data.rawRecords;
    if (!raw.length || this.privatize || !this.includeMedia || this.options.verbatim === false) {
      return false;
    }
    this.head = raw.find((r) => r.gedcom_tag === 'HEAD');
    return this.sourceMajor() >= 7 === this.v7;
  }

  private sourceMajor(): number {
    const head = this.data.rawRecords.find((r) => r.gedcom_tag === 'HEAD');
    if (!head) return 5;
    return analyzeHeader(parseGedcom(head.raw_text).records[0]).majorVersion ?? 5;
  }

  /** One slot per raw record, in file order, so exported records keep the original order. */
  private planSlots(verbatim: boolean, dirty: Set<string>): void {
    for (const raw of this.data.rawRecords) {
      if (raw.gedcom_tag === 'TRLR') continue;
      if (raw.gedcom_tag === 'HEAD') {
        this.head ??= raw;
        continue;
      }
      if (raw.owner_type === null || raw.owner_id === null) {
        // HEAD, SUBM and records the importer does not map. A submitter is usually the
        // user (living), so privatized exports write a generic one.
        if (this.privatize) continue;
        if (verbatim) this.slots.push({ raw, mode: 'verbatim' });
        else if (raw.gedcom_tag === 'SUBM' || raw.gedcom_tag.startsWith('_')) {
          this.slots.push({ raw, mode: 'raw' });
        }
        continue;
      }
      if (!KINDS.has(raw.owner_type) || !this.exists(raw.owner_type as RecordKind, raw.owner_id)) {
        continue;
      }
      const kind = raw.owner_type as RecordKind;
      const key = ownerKey(kind, raw.owner_id);
      const copy = verbatim && !dirty.has(key);
      const first = this.slotByKey.get(key);
      if (first) {
        // A second record mapped to the same row (repeated tag records, or two merged
        // people): copied as is, or its unmapped lines placed in the regenerated record.
        if (copy) this.slots.push({ raw, mode: 'verbatim' });
        else (first.also ??= []).push(raw);
        continue;
      }
      const slot: Slot = { raw, kind, id: raw.owner_id, mode: copy ? 'verbatim' : 'canonical' };
      this.slots.push(slot);
      this.slotByKey.set(key, slot);
    }
  }

  private exists(kind: RecordKind, id: string): boolean {
    switch (kind) {
      case 'person':
        return this.data.person.has(id);
      case 'family':
        return this.data.family.has(id);
      case 'source':
        return this.data.source.has(id);
      case 'repository':
        return this.data.repository.has(id);
      case 'media':
        return this.includeMedia && this.data.media.has(id);
      case 'note':
        return this.data.note.has(id);
      case 'tag':
        return this.data.tag.has(id);
    }
  }

  private validXref(xref: string | null | undefined): xref is string {
    return !!xref && xref !== '@VOID@' && (this.v7 ? XREF_7 : XREF_5).test(xref);
  }

  /** Keeps every xref the import used: verbatim records still point at them. */
  private reserveXrefs(): void {
    // A privatized export numbers every record afresh: imported ids can spell names
    // (@ZELDAQUIXBY@), and keeping only some would show which records were withheld.
    if (this.privatize) return;
    const owner = new Map<string, string>();
    for (const slot of this.slots) {
      const xref = slot.raw.xref;
      if (!xref) continue;
      this.used.add(xref);
      if (!slot.id || this.xrefs.has(slot.id) || owner.has(xref)) continue;
      if (slot.mode === 'verbatim' || this.validXref(xref)) {
        this.xrefs.set(slot.id, xref);
        owner.set(xref, slot.id);
      }
    }
    const rows: [RecordKind, { id: string; external_id: string | null }[]][] = [
      ['person', this.data.persons],
      ['family', this.data.families],
      ['source', this.data.sources],
      ['repository', this.data.repositories],
      ['media', this.data.mediaRows],
      ['note', this.data.notes],
      ['tag', this.data.tags],
    ];
    for (const [, list] of rows) {
      for (const row of list) {
        const xref = row.external_id;
        if (this.xrefs.has(row.id) || !this.validXref(xref) || this.used.has(xref)) continue;
        this.used.add(xref);
        this.xrefs.set(row.id, xref);
      }
    }
  }

  private xrefOf(kind: RecordKind, id: string): string {
    let xref = this.xrefs.get(id);
    if (!xref) {
      xref = this.newXref(PREFIX[kind]);
      this.xrefs.set(id, xref);
    }
    return xref;
  }

  private newXref(prefix: string): string {
    let i = this.counters.get(prefix) ?? 0;
    let xref: string;
    do xref = `@${prefix}${++i}@`;
    while (this.used.has(xref));
    this.counters.set(prefix, i);
    this.used.add(xref);
    return xref;
  }

  /** Decides which records are written and how; generation of the rest happens on demand (`ref`). */
  private planRecords(): void {
    const plan = (kind: RecordKind, id: string, always: boolean) => {
      const key = ownerKey(kind, id);
      if (this.planned.has(key)) return;
      const slot = this.slotByKey.get(key);
      if (slot?.mode === 'verbatim') this.planned.set(key, 'verbatim');
      else if (this.withheld.has(id)) return;
      else if (always || (slot && !this.privatize)) this.ref(kind, id);
    };
    for (const person of this.data.persons) plan('person', person.id, true);
    for (const family of this.data.families) plan('family', family.id, true);
    for (const slot of this.slots) if (slot.kind) plan(slot.kind, slot.id!, false);
    // Records nothing refers to are written too, so no data is lost.
    const d = this.data;
    for (const s of d.sources) {
      const used = d.citationsBySource.get(s.id)?.some((c) => d.citationLinksByCitation.has(c.id));
      if (!used) plan('source', s.id, true);
    }
    for (const r of d.repositories)
      if (!d.sourcesByRepository.has(r.id)) plan('repository', r.id, true);
    if (this.includeMedia) {
      for (const m of d.mediaRows) {
        if (!d.mediaLinksByMedia.has(m.id) && !d.primaryOf.has(m.id)) plan('media', m.id, true);
      }
    }
    for (const note of d.notes) if (!d.noteLinksByNote.has(note.id)) plan('note', note.id, true);
    for (const tag of d.tags) if (!d.tagLinksByTag.has(tag.id)) plan('tag', tag.id, true);
  }

  /** Generates every record `ref` has promised. */
  private drain(): void {
    // An index instead of shift(): the queue holds every record of a large tree.
    for (; this.next < this.queue.length; this.next++) {
      const [kind, id] = this.queue[this.next]!;
      const xref = this.xrefOf(kind, id);
      const d = this.data;
      let node: GedcomNode;
      switch (kind) {
        case 'person':
          node = this.writer.person(d.person.get(id)!, xref);
          break;
        case 'family':
          node = this.writer.family(d.family.get(id)!, xref);
          break;
        case 'source':
          node = this.writer.source(d.source.get(id)!, xref);
          break;
        case 'repository':
          node = this.writer.repository(d.repository.get(id)!, xref);
          break;
        case 'media':
          node = this.writer.media(d.media.get(id)!, xref);
          break;
        case 'note':
          node = this.writer.note(d.note.get(id)!, xref);
          break;
        case 'tag':
          node = this.writer.tag(d.tag.get(id)!, xref);
          break;
      }
      const key = ownerKey(kind, id);
      const hidden =
        (kind === 'person' && this.isPrivatePerson(id)) ||
        (kind === 'family' && this.isPrivateFamily(id));
      if (hidden) allowlist(node);
      else {
        const slot = this.slotByKey.get(key);
        const raws = slot ? [slot.raw, ...(slot.also ?? [])] : [];
        // A FILE line already written from its imported text is not merged a second time.
        const rows = this.data.unmapped.get(key)?.filter((r) => !this.usedFileLines.has(r));
        mergeUnmapped(this, node, raws, rows, xref);
      }
      if (this.privatize && this.scrubXrefs(node)) {
        this.warn(`${xref}: an imported record id in its text was removed`);
      }
      this.generated.set(key, node);
    }
  }

  /**
   * Imported xrefs are renumbered when privatizing, and can spell a name
   * (`@ZELDAQUIXBY@`): text that mentions one (`See @@I12@@`, or a pointer a
   * strict reader took for text) loses it. Returns whether anything changed.
   */
  private scrubXrefs(node: GedcomNode): boolean {
    if (!this.importedIds) {
      this.importedIds = new Set();
      for (const r of this.data.rawRecords) if (r.xref) this.importedIds.add(r.xref.toUpperCase());
    }
    const ids = this.importedIds;
    let changed = false;
    if (node.value?.includes('@')) {
      const value = node.value.replace(/@+([^@\s]+)@+/g, (token, id: string) =>
        ids.has(`@${id.toUpperCase()}@`) ? '[reference removed]' : token,
      );
      if (value !== node.value) {
        node.value = value;
        delete node.rawValue;
        delete node.source;
        changed = true;
      }
    }
    for (const c of node.children) changed = this.scrubXrefs(c) || changed;
    return changed;
  }

  // ------------------------------------------------------------ MergeContext

  warn(message: string): void {
    this.warnings.push(message);
  }

  pointer(raw: string): string | undefined {
    if (!this.importedXrefs) {
      this.importedXrefs = new Map();
      for (const r of this.data.rawRecords) {
        if (!r.xref || this.importedXrefs.has(r.xref)) continue;
        const kind = r.owner_type as RecordKind | null;
        this.importedXrefs.set(
          r.xref,
          kind && r.owner_id && KINDS.has(kind) && this.exists(kind, r.owner_id)
            ? { kind, id: r.owner_id }
            : null,
        );
      }
    }
    const target = this.importedXrefs.get(raw);
    // Imported lines (an ASSO and its RELA) never point at someone withheld.
    if (
      target &&
      (this.withheld.has(target.id) ||
        (target.kind === 'person' && this.living.has(target.id)) ||
        (target.kind === 'family' && this.privateFamilies.has(target.id)))
    ) {
      return undefined;
    }
    if (target) return this.ref(target.kind, target.id);
    // A raw-only record (SUBM) keeps its xref when it is written.
    const kept = this.slots.some(
      (slot) => slot.raw.xref === raw && !slot.raw.owner_type && slot.mode !== 'canonical',
    );
    return kept ? raw : undefined;
  }

  fileValue(raw: string): string {
    const value = raw.trim();
    if (!this.v7 || /^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
    return value.split('/').map(encodeURIComponent).join('/');
  }

  /** Xrefs the output will define. */
  private writtenXrefs(): Set<string> {
    const written = new Set<string>();
    for (const slot of this.slots) {
      if (slot.mode !== 'canonical' && slot.raw.xref) written.add(slot.raw.xref);
    }
    for (const key of this.generated.keys()) written.add(this.xrefs.get(key.split('|')[1]!)!);
    return written;
  }

  /**
   * A verbatim record pointing at a record that is no longer written (deleted,
   * or regenerated under a new xref) is regenerated itself. Pointers that were
   * already broken in the imported file are left as they were.
   */
  private repairVerbatimPointers(): void {
    const written = this.writtenXrefs();
    const imported = new Set(this.data.rawRecords.flatMap((r) => (r.xref ? [r.xref] : [])));
    this.slots.forEach((slot) => {
      if (slot.mode !== 'verbatim') return;
      const broken = [...slot.raw.raw_text.matchAll(POINTER_LINE)].some(
        ([, pointer]) => !written.has(pointer!) && imported.has(pointer!),
      );
      if (!broken) return;
      if (!slot.id) {
        // A raw-only record loses the broken lines; a repeated record is dropped.
        slot.mode = slot.raw.owner_type === null ? 'raw' : 'canonical';
        return;
      }
      slot.mode = 'canonical';
      const key = ownerKey(slot.kind!, slot.id);
      this.planned.delete(key);
      this.ref(slot.kind!, slot.id);
    });
  }

  private serialize(node: GedcomNode): string {
    return serializeNode(node, {
      version: this.v7 ? 7 : 5,
      ...(!this.v7 && { maxLineLength: 255 }),
    }).slice(0, -1);
  }

  /** A raw-only record (SUBM, unknown extension records) written canonically, minus broken pointers. */
  private rawOnly(raw: RawRecordRow): string | undefined {
    const record = parseGedcom(raw.raw_text).records[0];
    if (!record) return undefined;
    const written = this.written!;
    const prune = (node: GedcomNode): GedcomNode => ({
      ...node,
      children: node.children
        .filter((c) => c.pointer === undefined || c.pointer === '@VOID@' || written.has(c.pointer))
        .map(prune),
    });
    return this.serialize(setLevels(prune(canonicalize(record))));
  }

  // ------------------------------------------------------------ HEAD

  private headRecord(records: string[], submitter: string | undefined): string {
    const sourceSchema = this.head
      ? analyzeHeader(parseGedcom(this.head.raw_text).records[0]).schema
      : {};
    const home =
      // A privatized home person (usually the user) is not singled out among the Private records.
      this.data.homePersonId &&
      this.data.person.has(this.data.homePersonId) &&
      !this.isPrivatePerson(this.data.homePersonId)
        ? this.xrefOf('person', this.data.homePersonId)
        : undefined;
    const extensions = new Set<string>();
    if (this.v7) {
      for (const text of records) {
        for (const [, tag] of text.matchAll(EXTENSION_TAG)) extensions.add(tag!);
      }
      if (home) extensions.add('_HOME');
    }
    const schemaTags = (have: Record<string, string>) =>
      [...extensions]
        .sort()
        .filter((tag) => !have[tag])
        .map((tag) =>
          n('TAG', `${tag} ${sourceSchema[tag] ?? `${EXTENSIONS_DOC}#${tag.toLowerCase()}`}`),
        );

    if (this.head && this.verbatim) {
      return this.patchedHead(this.head, schemaTags);
    }

    const now = this.options.now ?? new Date();
    const date = `${now.getUTCDate()} ${MONTHS[now.getUTCMonth()]} ${now.getUTCFullYear()}`;
    const time = now.toISOString().slice(11, 19);
    const gedc = this.v7
      ? n('GEDC', undefined, [n('VERS', '7.0')])
      : n('GEDC', undefined, [n('VERS', '5.5.1'), n('FORM', 'LINEAGE-LINKED')]);
    const schema = this.v7 ? schemaTags({}) : [];
    const head = n('HEAD', undefined, [
      gedc,
      schema.length > 0 && n('SCHMA', undefined, schema),
      n('SOUR', 'open-ancestry', [n('NAME', 'open-ancestry'), v('DATA', this.treeName)]),
      n('DATE', date, [n('TIME', time)]),
      submitter && p('SUBM', submitter),
      !this.v7 && n('CHAR', 'UTF-8'),
      home && p('_HOME', home),
    ]);
    return this.serialize(setLevels(head));
  }

  /**
   * The imported HEAD with only what an export must change: `CHAR UTF-8` and
   * `GEDC.VERS 5.5.1` / `FORM LINEAGE-LINKED` in 5.5.1, the SCHMA entries for
   * every extension tag in 7, and no pointer to a record that is gone.
   */
  private patchedHead(
    raw: RawRecordRow,
    schemaTags: (have: Record<string, string>) => GedcomNode[],
  ): string {
    const head = parseGedcom(raw.raw_text).records[0]!;
    const child = (node: GedcomNode, tag: string) => node.children.find((c) => c.tag === tag);
    const set = (parent: GedcomNode, tag: string, value: string) => {
      const node = child(parent, tag);
      if (!node) parent.children.push(setLevels(n(tag, value), parent.level + 1));
      else if (node.value !== value) node.value = value;
    };
    const written = this.written!;
    head.children = head.children.filter(
      (c) => c.pointer === undefined || c.pointer === '@VOID@' || written.has(c.pointer),
    );
    if (this.v7) {
      const schma = child(head, 'SCHMA');
      const have = analyzeHeader(head).schema;
      const tags = schemaTags(have);
      if (schma) schma.children.push(...tags.map((t) => setLevels(t, schma.level + 1)));
      else if (tags.length) {
        const at = head.children.findIndex((c) => c.tag === 'GEDC') + 1;
        head.children.splice(at, 0, setLevels(n('SCHMA', undefined, tags), 1));
      }
    } else {
      let gedc = child(head, 'GEDC');
      if (!gedc) {
        gedc = setLevels(n('GEDC'), 1);
        head.children.push(gedc);
      }
      set(gedc, 'VERS', '5.5.1');
      set(gedc, 'FORM', 'LINEAGE-LINKED');
      set(head, 'CHAR', 'UTF-8');
    }
    return this.serialize(head);
  }
}
