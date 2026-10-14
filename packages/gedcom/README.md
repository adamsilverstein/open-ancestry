# @open-ancestry/gedcom

Reads GEDCOM 5.5.1 and 7 files into a record tree, re-emits it losslessly, and opens GEDZIP archives. Mapping records to the domain model is the importer's job (F5), not this package's.

```ts
import { parseGedcom, parseGedcomStream, serializeNode, readGedzip } from '@open-ancestry/gedcom';

const doc = parseGedcom(bytes); // Uint8Array or string; never throws
doc.header; // { version, majorVersion, charset, source, ancestry?, schema, ... }
doc.records; // level-0 nodes in source order, HEAD and TRLR included
doc.index.get('@I1@'); // record by xref (first one wins on duplicates)
doc.warnings; // [{ code, line, message }], capped by maxWarnings (default 1000)
doc.lines; // { total, nodes, continuations, blank, skipped, detached }

const streamed = await parseGedcomStream(fs.createReadStream(path));
const raw = serializeNode(doc.index.get('@I1@')!); // exact GEDCOM text of the subtree
const { gedcom, media } = readGedzip(zipBytes); // throws GedzipError on unsafe archives
```

A node is `{ level, tag, xref?, pointer?, value?, children, line, rawValue?, continuations?, source?, extra? }`. `value` has `@@` escapes resolved and CONC/CONT merged (CONT becomes `\n`). `rawValue`, `continuations`, `source` (original text of a non-canonical line) and `extra` (blank or unparseable lines that followed it) keep what is needed to write the original lines back.

## Encoding

Order of precedence: `encoding` option, byte order mark, `HEAD.CHAR`, then sniffing. Supported: UTF-8, UTF-16 LE/BE (BOM or `0\0` sniffing), ANSEL (combining diacritics reordered and NFC-composed), ASCII (read as UTF-8, falling back to CP1252 if invalid), ANSI/CP1252/ISO-8859-1/IBMPC (CP1252) and MACINTOSH. GEDCOM 7 is always UTF-8. A BOM that contradicts `HEAD.CHAR` wins, with a `charset-mismatch` warning; so does content that is valid multi-byte UTF-8 but labeled ANSEL, ANSI or ASCII. Text beyond V8's maximum string length becomes a `decode-failed` warning, not an exception. Invalid bytes become U+FFFD with an `invalid-bytes` warning plus a `replacement-char` warning on each affected line. The stream parser decides from the first 64 KiB, so a late invalid byte in an ASCII file is replaced rather than triggering the CP1252 fallback.

## Leniency

| Input                                                     | Result                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| CRLF, LF, CR, mixed                                       | All accepted                                                                          |
| Leading whitespace, tabs or repeated delimiters before the tag | Accepted                                                                         |
| Lines over 255 characters                                 | Accepted                                                                              |
| Bare text line with no level (Ancestry multi-line notes)  | CONT of the previous node, `broken-line` warning. Blank lines between such lines are kept as empty CONTs. Same fix as python-gedcom's "Ancestry.com stores multi-line text without CONT" quirk. Never continues a pointer (skipped instead). |
| Near-miss line such as `0 @I2@INDI`                       | Repaired into its own node, `malformed-line`                                          |
| Unrepairable structure (`0 @I2@`, `100 FOO x`, `1 NA:ME`) | Skipped, `skipped-line`; on level 0 the open record is closed so following lines become orphan records instead of joining it |
| CONC split mid-word or before a space                     | Merged verbatim: the parser never trims, so the space survives on whichever side it was written |
| Text that looks like a line (`1850 was ...`, `1 name x`)  | Treated as bare text: levels are 0-99 and tags with lowercase letters must start with `_` |
| CONC/CONT after other children                            | Kept as an ordinary child, `misplaced-continuation`                                   |
| Level jump (`1` then `3`)                                 | Attached to the deepest open node, `level-jump`                                       |
| Level-1+ line before any record                           | Kept as a record, `orphan-line`                                                       |
| Unparseable text before any record                        | Listed in `skipped`, `skipped-line`                                                   |
| Duplicate xref, missing HEAD/TRLR, records after TRLR     | Kept, with a warning                                                                  |
| 5.5.1 `@@` / lone `@`                                     | Every `@@` becomes `@`; a lone `@` (emails) is kept                                   |
| 7.0 `@@`                                                  | Only a leading `@@` becomes `@`                                                       |

## Line accounting

Every physical line is counted once: `nodes + continuations + blank + skipped === total` (`lineCount`). Blank and skipped lines are attached to the line they followed (`extra`), or to `preamble` before the first record (`detached`). `subtreeLines(node)` lists every line of a record including those, so summing it over all records plus `lines.detached` gives `total`, which lets the importer prove `mapped + preserved == total`.

## Round trip

Unedited, `serializeGedcom(parseGedcom(file))` reproduces the decoded file exactly (fuzz tested), apart from the BOM, the line terminator (`eol`, default `\n`) and a terminator added to an unterminated last line. `serializeNode(record)` is the exact source text of that record, including indentation, tabs, `01` levels, trailing spaces and blank lines inside it, so it is safe for `raw_record`. Non-canonical lines keep their `source` text, which is used only while the node still says the same thing.

Values edited after parsing are re-encoded: every line break (CR, LF, CRLF, U+2028, U+2029, NEL) becomes a CONT line, other C0 controls except tab are dropped, `@` is escaped for `version` (default 5, `serializeGedcom` uses the header's), and `maxLineLength` splits long lines with CONC away from spaces, never inside a surrogate pair or before an `@`. So an edited value can never start a new GEDCOM line. The level (0-99), tag, xref and pointer must match the grammar the tokenizer accepts, otherwise `serializeNode` throws `GedcomSerializeError` (`invalid-level`, `invalid-tag`, `invalid-xref`, `invalid-pointer`, `invalid-eol`, or `line-break-in-source` for hand-built extra or preamble lines containing CR or LF).

## GEDZIP

`readGedzip` wants `gedcom.ged` at the root (a single root `.ged` is accepted with a warning). It reads the central directory itself and checks, before inflating anything: `maxEntries` (10,000), `maxEntrySize` (256 MiB), `maxGedcomSize` (256 MiB, keeping the decoded text under V8's string limit), `maxTotalSize` (256 MiB held in memory) and `maxRatio` (200:1, for each entry over 1 MiB and for all entries read together). Inflation then counts the bytes it actually produces, 4 KiB of input at a time, and aborts as soon as an entry passes its declared size or the running total passes `maxTotalSize` or `maxRatio`. Absolute paths, drive letters, NUL and `..` segments, duplicate names (including case-only differences, which collide on macOS and Windows), encrypted entries and unknown compression methods are skipped with a warning; the first of a duplicate pair wins. ZIP64 archives are rejected; they would exceed the limits anyway.

## Performance

`npm run bench -- gedcom`: 100k lines (2.2 MB) decode + tokenize + parse in about 19 ms on an M-series laptop (budget 500 ms); the tree for that file retains about 12 MB of heap.
