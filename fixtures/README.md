# Fixtures

Synthetic GEDCOM files for tests and benchmarks. **Every person, place and id here is invented.** Never add real family data; real exports go in `local-data/` (gitignored).

| File                            | What                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ancestry-sample.ged`           | Hand-written, 26 people over 5 generations, mimicking an Ancestry.com export and its quirks (below). |
| `generate.ts`                   | Deterministic generator: `generateGedcom({ people, seed })`. Same seed, same bytes.                  |
| `generated/synthetic-1000.ged`  | Committed output of `npm run fixtures` for 1,000 people (seed 1).                                    |
| `generated/synthetic-10000.ged` | Generated on demand by `npm run fixtures`; not committed.                                            |

```sh
npm run fixtures                                   # 1k and 10k into fixtures/generated/
npm run fixtures -- --people 100000 --seed 2       # any size
npm run fixtures -- --people 500 --out /tmp/x.ged  # custom path
```

`fixtures.test.ts` checks both: pointer integrity, level nesting, FAMS/FAMC agreeing with HUSB/WIFE/CHIL, determinism, and that each quirk below is present.

## The family in `ancestry-sample.ged`

```
Thaddeus Ashgrove = Mercy Bellweather         Ezra Corran = Lavinia Dunmore
        |                                             |
   +----+---------------+                   +---------+--------+
Josiah Ashgrove = Harriet Corran        Silas Corran = Clementine Ashgrove
        |                                       |
  +-----+-----+                                 |
Edith    Walter Ashgrove ================== Mabel Corran     (double first cousins)
 | = Arthur Eldermoor (F6) -> George                |
 | = Leopold Hollowell (F7) -> Iris, George (step)  |
                              Harold Ashgrove = Dorothy Ingleby
                                     |
                 +-------------------+--------------+
             Margaret        Thomas = Susan Larkspur    Peter (adopted)
                                    |
                          Emily = Ryan Mosswood, Daniel
                                |
                              Lily
```

Living (no death, born < 100 years ago): Margaret, Thomas, Peter, Susan, Emily, Daniel, Ryan, Lily.

## Quirks and where to find them

Line numbers count the BOM-prefixed `0 HEAD` as line 1.

| Quirk                                                                                            | Line(s)                   |
| ------------------------------------------------------------------------------------------------ | ------------------------- |
| UTF-8 BOM before `0 HEAD`                                                                        | 1                         |
| `1 CHAR UTF-8`                                                                                   | 2                         |
| `1 SOUR Ancestry.com Family Trees` with `2 DATA` tree name, `2 VERS 2024.12`, `2 NAME`, `2 CORP` | 3-7                       |
| `2 _TREE` with `3 RIN` and `3 _ENV` under `HEAD.SOUR`                                            | 8-10                      |
| `GEDC` 5.5.1 `LINEAGE-LINKED`                                                                    | 11-13                     |
| Free-text date `Abt. 1842` (mixed case, trailing period)                                         | 21                        |
| `EVEN` with `TYPE Arrival` (custom event)                                                        | 23-26                     |
| Citation `_APID` under `DEAT.SOUR`                                                               | 33                        |
| `OBJE` link with `2 _PRIM Y`, plus `1 _PHOTO @O1@` primary photo pointer                         | 35-37                     |
| `_MTTAG` pointer on an individual                                                                | 38, 159                   |
| `BEF`, `BET .. AND`, `AFT`, `CAL`, `EST` dates                                                   | 48, 82, 85, 94, 106       |
| Structured `NOTE` on `RESI` (`Marital Status: ...; Relation to Head of House: ...`)              | 62, 200                   |
| Citation with `_APID` and `DATA` / `WWW`                                                         | 63-67                     |
| `MARR` on `INDI` duplicating the `FAM` marriage                                                  | 73 (vs `@F3@` at 365-368) |
| `NOTE` split with `CONC` mid-word and `CONT` new line                                            | 112-114                   |
| `_MILT` event with note and citation                                                             | 147-152                   |
| Second `NAME` (married name)                                                                     | 177                       |
| Two spouses (Edith: `FAMS @F6@`, `FAMS @F7@`)                                                    | 171-172                   |
| Two parent sets; step-father via `_FREL Step` / `_MREL Natural`                                  | 237-240                   |
| ISO date `1925-09-05`                                                                            | 267                       |
| US-style date `05/28/1960`                                                                       | 287                       |
| `ADOP` event with `FAMC` / `ADOP BOTH`                                                           | 299-302                   |
| Adopted child via `_FREL Adopted` / `_MREL Adopted`                                              | 303-305                   |
| Decade range date `2010-2019`                                                                    | 347                       |
| Pedigree collapse: `@F5@` joins double first cousins Walter (`@I9@`) and Mabel (`@I11@`)         | 383-385                   |
| Source records with `_APID 1,<db>::0`, and the `REPO` they cite                                  | 425-456                   |
| Media `OBJE` with https `FILE` URL, `FORM`, `TITL`, `_OID`                                       | 457-466                   |
| `_MTTAG` records with `NAME` and `_MTCAT` category                                               | 467-472                   |
| `SUBM` record                                                                                    | 473-474                   |

## Parser edge cases (`gedcom/`)

Tiny files for encodings and malformed input, written by `npx tsx fixtures/gedcom/build.ts` (edit that script, then rerun it). Tested in `packages/gedcom/src/fixtures.test.ts`.

| File                  | What                                                                                                    |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `gedcom7.ged`         | GEDCOM 7.0.14, CRLF, no `CHAR`, `SCHMA` extension tag, `@VOID@`, leading `@@` escape                    |
| `ansel.ged`           | `CHAR ANSEL`, CR line endings, combining diacritics (including two stacked) and ANSEL spacing characters |
| `utf16le.ged`         | UTF-16 LE with BOM, CRLF, non-Latin text                                                                |
| `cp1252.ged`          | `CHAR ANSI` with Windows-1252 bytes (accents, curly quotes, euro)                                       |
| `ancestry-quirks.ged` | Ancestry bare-text note lines (one after a blank line), CONC mid-word and before a space, indentation, a 500+ character line |
| `malformed.ged`       | Text before `HEAD`, invalid UTF-8 bytes, a level jump, misplaced `CONC`, duplicate xref, no `TRLR`       |

## Generator output

`generateGedcom` builds a multi-generation tree from founding couples (1780-1820) to the present and includes, at scale: varied date formats (`ABT`, `BEF`, `AFT`, `BET .. AND`, `MM/DD/YYYY`, ISO, `MON YYYY`, year only, decade ranges like `1950-1959`), invented places, second marriages, adopted and step children (`_FREL`/`_MREL`), living people, `_MILT`, `RESI` with structured notes, citations with `_APID` and `DATA.WWW`, `MARR` repeated on `INDI`, `CONC`/`CONT` notes, `_MTTAG`/`_MTCAT` tags, and `OBJE` records with remote `FILE` URLs and `_OID`.
