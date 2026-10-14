# @open-ancestry/import

Imports a GEDCOM file or GEDZIP archive into a new tree: maps every record to the domain tables (with Ancestry's custom tags), keeps each record's exact text in `raw_record` and every line it did not map in `unmapped_line`. How each tag maps is in [docs/data-model.md](../../docs/data-model.md#how-gedcom-and-ancestry-map).

```ts
import { importGedcom, ImportError } from '@open-ancestry/import';

// A new tree folder (created, filled, closed) ...
const report = await importGedcom(
  { path: '/Users/me/Downloads/family.ged' }, // or { bytes }, { gedzip }
  { dir: '/Users/me/OpenAncestry/Vale.oatree', name: 'Vale family' },
  {
    mediaDir: '/Users/me/Downloads/family-media', // optional, for a plain GEDCOM
    onProgress: (phase, done, total) => console.log(phase, done, total),
    signal: controller.signal,
  },
);

// ... or an open, empty TreeStore (left open).
await importGedcom({ bytes }, openMemoryTree());
```

| Input | |
| --- | --- |
| `{ bytes: Uint8Array \| string, fileName? }` | GEDCOM bytes (any encoding the parser reads), or GEDZIP bytes (detected by the `PK` signature) |
| `{ path }` | A `.ged` or GEDZIP file on disk |
| `{ gedzip: Uint8Array, fileName? }` | A GEDZIP archive; its media files are linked and copied |

| Option | Default | |
| --- | --- | --- |
| `mediaDir` | none | Folder of media files for a plain GEDCOM. Walked without following symlinks. |
| `onProgress(phase, done, total)` | none | Phases: `read`, `parse`, `map` (records, every 500), `finalize`, `commit`, `done`. |
| `signal` | none | Aborting rolls back and removes a tree folder the import created. |
| `maxBytes` | 256 MiB | Largest GEDCOM or GEDZIP accepted. |
| `maxMediaBytes` | 256 MiB | Largest media file copied. |
| `maxWarnings` | 1000 | Warnings kept in the report (`warningCount` has the total). |
| `today` | now | Reference date for living inference. |

## The report

```ts
{
  batchId, treeDir, format: 'gedcom-5.5.1' | 'gedcom-7' | 'gedzip', encoding,
  file: { name, sha256, bytes },
  source: { system, name, version, corp, gedcomVersion, ancestry: { treeName, treeId, env } | null },
  records: { INDI: 26, FAM: 10, ... },           // top-level records by tag
  rows: { person: 26, event: 113, ... },         // rows written by table
  warnings: [{ code, line, message }], warningCount,
  unmapped: [{ path: 'INDI._SKYPEID', tag, count, example: { line, text } }],
  lines: { total, mapped, preserved },           // mapped + preserved === total
  media: { linked, remote, missing: [{ path, line, xref }], rejected },
  living: { living, deceased },
  homePersonId, homePersonSource: 'header' | 'first-person' | null,
  timings: { read, parse, map, commit, total },  // ms
}
```

The same summary is stored on the `import_batch` row (`counts_json`, `warnings_json`).

## Shared derived columns

Code that writes names or event dates outside an import (API edits) should use the same helpers so search and sorting agree:

- `surnameKey(surname)`: `person_name.surname_key`, `phoneticKeys(surname).join(' ')` or null.
- `dateColumns(text)`: `{ date_text, date_qualifier, date_sort, date_sort_end, calendar }` from `parseDate`; unparseable text gets qualifier `text` and null sort keys, and Gregorian is stored as a null calendar.

## Errors and warnings

A failed or cancelled import into a new tree folder removes what it created (database, media it copied), leaving anything already in the folder, so it can be retried.

Bad data never throws. Broken or wrong-type pointers, duplicate xrefs and links, one-sided links, people who are their own partner, child or ancestor, invalid `SEX`/`QUAY`/coordinates and media problems all become warnings with the line number; the affected lines stay in `unmapped_line`. Parser warnings (encoding, malformed lines) are included.

`ImportError` (with a `code`) means nothing was imported: `not-gedcom`, `too-large`, `invalid-gedzip`, `read-failed`, `tree-exists`, `tree-not-empty` (v1 imports create a new tree; re-import is F15) or `aborted`.

## Security

The file is untrusted. Size limits apply before parsing; GEDZIP archives go through `readGedzip`'s entry, size and ratio limits. Media paths are normalized to forward slashes and paths with `..` are refused, absolute paths are matched only by file name inside the chosen media source, and copies are checked to land inside the tree's `media/` folder. Remote URLs are stored, never fetched.

## Performance

`npm run bench -- import`: a generated 10k-person Ancestry-style file (225k lines) imports in about 0.8 s into an in-memory tree and 0.9 s into a new tree on disk on an M-series laptop (budget 3 s), 100k people in about 9 s (budget 30 s). Shared CI runners are about 2.5 times slower. Roughly two thirds of the time is SQLite inserts in `BulkWriter`.

## Re-import

`prepareReimport(store, input)` reads an updated export into a memory tree and compares it with `store` without writing; `applyReimport(store, session, acceptedIds, label)` applies the accepted changes as one unit of work (one undo step); `closeReimport(session)` frees it.

- **Matching.** Ancestry renumbers xrefs, so people are matched on evidence: shared Ancestry record ids (`_APID`) on citations, names (Jaro-Winkler, against every name the person has), birth and death years, birth place and sex, then a second pass in which relatives matched to each other confirm a pair. Candidates are blocked by name sounds (and surname sound with birth year), so a 10k tree compares in about a second. Each match has a `confidence` (0..1) and `reasons`; below 0.6 an incoming person is new, from 0.85 a match is offered for bulk acceptance.
- **Diff.** Per person: new and changed facts (singular facts like birth are compared as one), names, sex, citations, tags, media, new partners and children, new people (with the changes that depend on them), and people and facts missing from the export (listed, never removed).
- **Local edits win.** A row changed through the app since it was imported (it has `change_log` entries) makes the incoming change a conflict that is unticked by default.
- **Apply.** Only accepted changes are written; a change whose new person was rejected is skipped. Places, sources, repositories, tags and media already in the tree are reused. The export's text is kept whole in `raw_record` under its own import batch, and matched people's `external_id` moves to the new xrefs. Apply refuses (`ReimportStaleError`) when the tree changed after the comparison. Media files are not copied by a re-import.
