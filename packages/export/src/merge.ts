import type { RawRecordRow, UnmappedLineRow } from '@open-ancestry/db';
import {
  parseGedcom,
  resnRestrictions,
  serializeNode,
  type GedcomNode,
} from '@open-ancestry/gedcom';
import { canonicalize, n, setLevels } from './canonical';

/** What merging needs from the export. */
export interface MergeContext {
  readonly v7: boolean;
  /** Output xref for a pointer in the imported text, or undefined when it has no record now. */
  pointer(raw: string): string | undefined;
  /** FILE value in the output's form (GEDCOM 7 percent-encodes local paths). */
  fileValue(raw: string): string;
  warn(message: string): void;
  /**
   * Whether warnings may quote the lines they are about. A privatized export
   * names only the record and the tag path: a dropped line may be about
   * someone withheld.
   */
  readonly quoteLines: boolean;
}

/** Tags the writer produces from domain columns: an unmapped copy would contradict the edited value. */
const GENERATED_TAGS = new Set([
  '_PHOTO',
  '_MTTAG',
  '_MTCAT',
  '_APID',
  '_FREL',
  '_MREL',
  '_STAT',
  '_OID',
  '_DATE',
  '_DSCR',
  '_TYPE',
  '_WDTH',
  '_HGHT',
  '_SIZE',
  '_LINK',
  '_HOME',
]);

/**
 * Standard tags a structure holds at most once. Repeatable ones (ASSO, NOTE,
 * SOUR, FILE, which an OBJE may hold several of in both versions, and EMAIL,
 * PHON, FAX, WWW, which 5.5.1 allows three of) may be added.
 */
const SINGLE_VALUED = new Set(
  `ABBR ADDR AGE AUTH CALN CAUS DATA DATE FORM GIVN LATI LONG MAP NICK NPFX NSFX PAGE
  PEDI PLAC PUBL QUAY RESN ROLE SEX SPFX SURN TEXT TIME TITL TYPE VERS`.split(/\s+/),
);

/** Every GEDCOM 7.0 standard tag; anything else must be an `_` extension in a 7 file. */
export const GEDCOM7_TAGS = new Set(
  `ABBR ADDR ADOP ADR1 ADR2 ADR3 AGE AGNC ALIA ANCI ANUL ASSO AUTH BAPL BAPM BARM BASM BIRT BLES
  BURI CALN CAST CAUS CENS CHAN CHIL CHR CHRA CITY CONF CONL CONT COPR CORP CREA CREM CROP CTRY
  DATA DATE DEAT DESI DEST DIV DIVF DSCR EDUC EMAIL EMIG ENDL ENGA EVEN EXID FACT FAM FAMC FAMS
  FAX FCOM FILE FORM GEDC GIVN GRAD HEAD HEIGHT HUSB IDNO IMMI INDI INIL LANG LATI LEFT LONG MAP
  MARB MARC MARL MARR MARS MEDI MIME NAME NATI NATU NCHI NICK NMR NO NOTE NPFX NSFX OBJE OCCU ORDN
  PAGE PEDI PHON PHRASE PLAC POST PROB PROP PUBL QUAY REFN RELI REPO RESI RESN RETI ROLE SCHMA
  SDATE SEX SLGC SLGS SNOTE SOUR SPFX SSN STAE STAT SUBM SURN TAG TEMP TEXT TIME TITL TOP TRAN
  TRLR TYPE UID VERS WIDTH WIFE WILL WWW`.split(/\s+/),
);

/** GEDCOM 7 ROLE values and the 5.5.1 RELA words that mean them. */
const ROLES: [string, string[]][] = [
  ['CHIL', ['child']],
  ['CLERGY', ['clergy']],
  ['FATH', ['father']],
  ['FRIEND', ['friend']],
  ['GODP', ['godparent', 'godfather', 'godmother']],
  ['HUSB', ['husband']],
  ['MOTH', ['mother']],
  ['MULTIPLE', ['multiple']],
  ['NGHBR', ['neighbor', 'neighbour']],
  ['OFFICIATOR', ['officiator']],
  ['PARENT', ['parent']],
  ['SPOU', ['spouse']],
  ['WIFE', ['wife']],
  ['WITN', ['witness']],
];

/**
 * 5.5.1 `ASSO.RELA` (free text) as GEDCOM 7 `ROLE`: the matching enumeration
 * value, else OTHER, with the text kept as PHRASE so it reads back exactly.
 */
function relaToRole(text: string | undefined): GedcomNode {
  const value = text?.trim();
  if (!value) return n('ROLE', 'OTHER');
  const role = ROLES.find(([, words]) => words.includes(value.toLowerCase()))?.[0] ?? 'OTHER';
  return n('ROLE', role, [n('PHRASE', value)]);
}

/** GEDCOM 7 `ASSO.ROLE` as 5.5.1 `RELA`: the PHRASE, else the role as a word; nothing for a bare OTHER. */
function roleToRela(role: GedcomNode): GedcomNode | undefined {
  const phrase = role.children.find((c) => c.tag === 'PHRASE')?.value?.trim();
  if (phrase) return n('RELA', phrase);
  const word = ROLES.find(([code]) => code === role.value?.trim().toUpperCase())?.[1][0];
  return word ? n('RELA', word[0]!.toUpperCase() + word.slice(1)) : undefined;
}

const sameLine = (a: GedcomNode, b: GedcomNode) =>
  a.tag === b.tag && a.value === b.value && a.pointer === b.pointer;

/**
 * Puts the lines the importer kept in unmapped_line back into a regenerated
 * record, under the structure they came from: `2 FAMC @F8@` under its ADOP
 * event, `2 _PRIM Y` under its OBJE link, `1 _SKYPEID` at the top. The
 * imported raw text gives each line's parent; the parent's counterpart in the
 * generated record is found by tag and content (pointer, value, DATE, PLAC,
 * PAGE), or by position when the record still has as many of that tag.
 *
 * A line is reported through `warn`, never dropped silently, when its parent
 * no longer exists, it points at a record that is gone, it would contradict a
 * regenerated value, or (in GEDCOM 7) its tag is not GEDCOM 7.
 */
export function mergeUnmapped(
  ctx: MergeContext,
  record: GedcomNode,
  raws: readonly RawRecordRow[],
  rows: UnmappedLineRow[] | undefined,
  label: string,
): void {
  if (!rows?.length) return;
  for (const row of rows) {
    if (row.path.endsWith('(unparsed)')) {
      ctx.warn(
        ctx.quoteLines
          ? `${label}: unparseable line "${row.line}" was not carried over`
          : `${label}: an unparseable line was not carried over`,
      );
    }
  }
  const lines = rows.filter((r) => !r.path.includes('('));
  if (!lines.length) return;
  const sources = raws.flatMap((raw) => parseGedcom(raw.raw_text).records.slice(0, 1));
  if (!sources.length) {
    // No imported text to say where nested lines belong; only top-level extension lines can be placed.
    fallback(ctx, record, lines, label);
    setLevels(record);
    return;
  }
  const pending = new Map<string, number>();
  for (const r of lines) {
    const key = `${r.path}\u0000${r.line}`;
    pending.set(key, (pending.get(key) ?? 0) + 1);
  }
  // Each imported record says where its own lines belong (a merged person has several).
  for (const source of sources) {
    const text = serializeNode(source).split('\n');
    const isUnmapped = (node: GedcomNode, path: string) => {
      const key = `${path}\u0000${text[node.line - source.line] ?? ''}`;
      const n = pending.get(key);
      if (!n) return false;
      pending.set(key, n - 1);
      return true;
    };
    new Merger(ctx, label, isUnmapped).walk(source, record, source.tag);
  }
  setLevels(record);
}

class Merger {
  private readonly ctx: MergeContext;
  private readonly label: string;
  private readonly isUnmapped: (node: GedcomNode, path: string) => boolean;
  /** Lines this merge inserted, as opposed to lines the generator wrote. */
  private readonly merged = new WeakSet<GedcomNode>();

  constructor(
    ctx: MergeContext,
    label: string,
    isUnmapped: (node: GedcomNode, path: string) => boolean,
  ) {
    this.ctx = ctx;
    this.label = label;
    this.isUnmapped = isUnmapped;
  }

  private lost(node: GedcomNode, path: string, why: string) {
    if (!this.ctx.quoteLines) {
      this.ctx.warn(`${this.label}: an imported ${node.tag} line (${path}) was not carried over`);
      return;
    }
    const line = `${node.tag}${node.pointer ? ` ${node.pointer}` : node.value ? ` ${node.value.split('\n')[0]}` : ''}`;
    this.ctx.warn(`${this.label}: "${line}" (${path}) was not carried over: ${why}`);
  }

  /** Adds a whole subtree at the end of `target` (top-level lines without imported text). */
  append(node: GedcomNode, target: GedcomNode, path: string): void {
    this.place(node, target, path, target.children.length);
  }

  /** Walks the imported structure beside its generated counterpart, placing unmapped lines. */
  walk(source: GedcomNode, target: GedcomNode | undefined, path: string): void {
    const used = new Set<GedcomNode>();
    let at = 0;
    const rawCount = new Map<string, number>();
    for (const c of source.children) {
      const childPath = `${path}.${c.tag}`;
      const ordinal = rawCount.get(c.tag) ?? 0;
      rawCount.set(c.tag, ordinal + 1);
      if (this.isUnmapped(c, childPath)) {
        if (!target) {
          this.lost(c, childPath, 'the structure it belonged to is gone');
          this.walk(c, undefined, childPath);
          continue;
        }
        const placed = this.place(c, target, childPath, at);
        if (placed) {
          used.add(placed);
          at = target.children.indexOf(placed) + 1;
        }
        continue;
      }
      const match = target && this.counterpart(c, target, used, source, ordinal);
      if (match) {
        used.add(match);
        at = target!.children.indexOf(match) + 1;
      }
      this.walk(c, match, childPath);
    }
  }

  /** Inserts an unmapped subtree at `at`, or fills an empty generated line with its value. */
  private place(
    node: GedcomNode,
    target: GedcomNode,
    path: string,
    at: number,
  ): GedcomNode | undefined {
    const existing = target.children.find((c) => c.tag === node.tag);
    const empty = existing && existing.value === undefined && existing.pointer === undefined;
    if (empty && node.value !== undefined && node.pointer === undefined) {
      // e.g. a FILE whose path did not resolve: the generated record left it blank.
      existing.value = node.tag === 'FILE' ? this.ctx.fileValue(node.value) : node.value;
      this.walk(node, existing, path);
      return existing;
    }
    if (existing) {
      // The generator already wrote this very line (only lines it wrote count: a repeated
      // imported line is kept, as it was in the file); a second value of a one-value tag
      // would contradict the current one.
      const written = (c: GedcomNode) =>
        !this.merged.has(c) && sameLine(c, node) && c.children.length === 0;
      if (target.children.some(written)) return undefined;
      if (SINGLE_VALUED.has(node.tag) || GENERATED_TAGS.has(node.tag)) {
        this.lost(node, path, 'it conflicts with the current value');
        return undefined;
      }
    }
    const copy = this.prepare(node, path);
    if (copy) {
      this.merged.add(copy);
      target.children.splice(at, 0, copy);
    }
    return copy;
  }

  /** The subtree as it will be written, minus lines that cannot be (reported). */
  private prepare(node: GedcomNode, path: string): GedcomNode | undefined {
    if (path.endsWith('ASSO.RELA') && this.ctx.v7) return relaToRole(node.value);
    if (path.endsWith('ASSO.ROLE') && !this.ctx.v7) return roleToRela(node);
    if (this.ctx.v7 && !node.tag.startsWith('_') && !GEDCOM7_TAGS.has(node.tag)) {
      this.lost(node, path, `${node.tag} is not a GEDCOM 7 tag`);
      return undefined;
    }
    let pointer: string | undefined;
    if (node.pointer !== undefined && node.pointer !== '@VOID@') {
      pointer = this.ctx.pointer(node.pointer);
      if (!pointer) {
        this.lost(node, path, `${node.pointer} is not in the export`);
        return undefined;
      }
    }
    const copy = canonicalize({ ...node, children: [] });
    if (pointer) copy.pointer = pointer;
    if (node.tag === 'RESN' && this.ctx.v7) {
      // GEDCOM 7 RESN is an upper-case, comma-separated enumeration.
      const restrictions = resnRestrictions(node.value);
      if (!restrictions.length) {
        this.lost(node, path, 'it restricts nothing');
        return undefined;
      }
      copy.value = restrictions.join(', ');
    }
    for (const c of node.children) {
      const child = this.prepare(c, `${path}.${c.tag}`);
      if (child) copy.children.push(child);
    }
    // GEDCOM 7 requires a ROLE on every association.
    if (node.tag === 'ASSO' && this.ctx.v7 && !copy.children.some((c) => c.tag === 'ROLE')) {
      copy.children.push(n('ROLE', 'OTHER'));
    }
    return copy;
  }

  /** The generated line that stands for an imported, mapped one. */
  private counterpart(
    node: GedcomNode,
    target: GedcomNode,
    used: Set<GedcomNode>,
    parent: GedcomNode,
    ordinal: number,
  ): GedcomNode | undefined {
    const same = target.children.filter(
      (g) => g.tag === node.tag && (g.pointer === undefined) === (node.pointer === undefined),
    );
    const wanted = this.signature(node, true);
    const exact = same.find((g) => !used.has(g) && this.signature(g, false) === wanted);
    if (exact) return exact;
    const rawSame = parent.children.filter(
      (c) => c.tag === node.tag && (c.pointer === undefined) === (node.pointer === undefined),
    );
    return rawSame.length === same.length && !used.has(same[ordinal]!) ? same[ordinal] : undefined;
  }

  private signature(node: GedcomNode, imported: boolean): string {
    const child = (tag: string) => {
      const c = node.children.find((x) => x.tag === tag);
      // Generated GEDCOM 7 dates keep the text as written in PHRASE.
      return c?.children.find((x) => x.tag === 'PHRASE')?.value ?? c?.value ?? '';
    };
    const pointer = node.pointer && (imported ? this.ctx.pointer(node.pointer) : node.pointer);
    return [pointer ?? '', node.value ?? '', child('DATE'), child('PLAC'), child('PAGE')].join(
      '\u0000',
    );
  }
}

/** Top-level extension subtrees only, rebuilt from the unmapped lines themselves. */
function fallback(ctx: MergeContext, record: GedcomNode, lines: UnmappedLineRow[], label: string) {
  const kept: string[] = [];
  let base: string | null = null;
  for (const line of lines) {
    const parts = line.path.split('.');
    if (parts.length === 2 && parts[1]!.startsWith('_') && !GENERATED_TAGS.has(parts[1]!)) {
      base = line.path;
      kept.push(line.line);
    } else if (base && line.path.startsWith(base + '.')) {
      kept.push(line.line);
    } else {
      base = null;
      ctx.warn(
        ctx.quoteLines
          ? `${label}: "${line.line.trim()}" (${line.path}) was not carried over: no imported text to place it by`
          : `${label}: an imported line (${line.path}) was not carried over`,
      );
    }
  }
  if (!kept.length) return;
  const doc = parseGedcom(`0 _UNMAPPED\n${kept.join('\n')}\n`);
  const merger = new Merger(ctx, label, () => true);
  for (const c of doc.records[0]!.children) merger.append(c, record, `${record.tag}.${c.tag}`);
}
