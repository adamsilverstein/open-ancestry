# @open-ancestry/gedcom

Reads GEDCOM 5.5.1 and 7 files into a record tree, re-emits it losslessly, and opens GEDZIP archives. Mapping records to the domain model is the importer's job (F5), not this package's.

```ts
import { parseGedcom, parseGedcomStream, serializeNode, readGedzip } from '@open-ancestry/gedcom';

const doc = parseGedcom(bytes); // Uint8Array or string; never throws
doc.header; // { version, majorVersion, charset, source, ancestry?, schema, ... }
doc.records; // level-0 nodes in source order, HEAD and TRLR included
doc.index.get('@I1@'); // record by xref (first one wins on duplicates)
doc.warnings; // [{ code, line, message }], capped by maxWarnings (default 1000)
doc.lines; // { total, nodes, continuations, blank, skipped }

const streamed = await parseGedcomStream(fs.createReadStream(path));
const raw = serializeNode(doc.index.get('@I1@')!); // exact GEDCOM text of the subtree
const { gedcom, media } = readGedzip(zipBytes); // throws GedzipError on unsafe archives
```

A node is `{ level, tag, xref?, pointer?, value?, children, line, rawValue?, continuations? }`. `value` has `@@` escapes resolved and CONC/CONT merged (CONT becomes `\n`). `continuations` and `rawValue` keep what is needed to write the original lines back.

## Encoding

Order of precedence: `encoding` option, byte order mark, `HEAD.CHAR`, then sniffing. Supported: UTF-8, UTF-16 LE/BE (BOM or `0\0` sniffing), ANSEL (combining diacritics reordered and NFC-composed), ASCII (read as UTF-8, falling back to CP1252 if invalid), ANSI/CP1252/ISO-8859-1/IBMPC (CP1252) and MACINTOSH. GEDCOM 7 is always UTF-8. A BOM that contradicts `HEAD.CHAR` wins, with a `charset-mismatch` warning. Invalid bytes become U+FFFD with an `invalid-bytes` warning plus a `replacement-char` warning on each affected line. The stream parser decides from the first 64 KiB, so a late invalid byte in an ASCII file is replaced rather than triggering the CP1252 fallback.

## Leniency

| Input                                                     | Result                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| CRLF, LF, CR, mixed                                       | All accepted                                                                          |
| Leading whitespace, tabs or repeated delimiters before the tag | Accepted                                                                         |
| Lines over 255 characters                                 | Accepted                                                                              |
| Bare text line with no level (Ancestry multi-line notes)  | CONT of the previous node, `broken-line` warning. Blank lines between such lines are kept as empty CONTs. Same fix as python-gedcom's "Ancestry.com stores multi-line text without CONT" quirk. |
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

Every physical line is counted once: `nodes + continuations + blank + skipped === total` (`lineCount`). `node.line` and `continuation.line` map back to the source; `subtreeLines(node)` lists all lines of a record, so the importer can prove `mapped + preserved == total`.

## Round trip

`parse -> serialize -> parse` yields the same tree (fuzz tested). `serializeGedcom(parseGedcom(file))` equals the decoded file except:

- no BOM; line endings are `eol` (default `\n`); the last line gets a terminator
- whitespace before a level is removed, and repeated delimiters before the tag become one space
- leading zeros in levels are dropped (`01` -> `1`)
- blank lines are dropped, except between Ancestry bare-text lines
- an empty CONC/CONT written with a trailing space loses the space
- skipped lines (unparseable text before the first record) are dropped

Values edited after parsing are re-encoded: `\n` becomes CONT, `@` is escaped for `version` (default 5, `serializeGedcom` uses the header's), and `maxLineLength` splits long lines with CONC away from spaces.

## GEDZIP

`readGedzip` wants `gedcom.ged` at the root (a single root `.ged` is accepted with a warning). Limits are checked against the central directory before anything inflates, and inflation is bounded by the declared size: `maxEntries` (10,000), `maxEntrySize` (512 MiB), `maxTotalSize` (2 GiB), `maxRatio` (200:1 for entries over 1 MiB). Absolute paths, drive letters, NUL and `..` segments are skipped with a warning.

## Performance

`npm run bench -- gedcom`: 100k lines (2.2 MB) decode + tokenize + parse in about 17 ms on an M-series laptop (budget 500 ms); the tree for that file retains about 12 MB of heap.
