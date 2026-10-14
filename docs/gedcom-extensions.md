# GEDCOM extension tags

GEDCOM 7 exports declare every extension tag they use in `HEAD.SCHMA`. The URI for a tag is this page with the tag, lower case, as the fragment (`https://github.com/adamsilverstein/open-ancestry/blob/main/docs/gedcom-extensions.md#_apid`). Tags declared by the file a tree was imported from keep that file's URI.

Most of these tags come from Ancestry and Family Tree Maker. The importer maps them as described in [data-model.md](data-model.md#how-gedcom-and-ancestry-map); the exporter writes them the same way, so GEDCOM 5.5.1 output reads back into Ancestry and both versions read back into open-ancestry.

## \_APID

Ancestry record id, `database,dbid::record` (`1,7602::50000123`). Under a source citation it names the Ancestry record the citation points at; under a `SOUR` record, the Ancestry database (`1,7602::0`).

## \_LINK

URL of the record a citation points at. GEDCOM 7 citations have no `WWW`; GEDCOM 5.5.1 exports write Ancestry's `DATA.WWW` instead.

## \_FREL

Under `INDI.FAMC`: the child's relationship to the family's first partner (`HUSB`): `Natural`, `Adopted`, `Step`, `Foster`, `Related`, `Guardian`, `Private` or `Unknown`. Written when either relationship is not `Natural`.

## \_MREL

Like `_FREL`, for the family's second partner (`WIFE`).

## \_STAT

Family relationship status (Family Tree Maker): `Married`, `Civil union`, `Partners` or `Unknown`. Written only when it differs from what a reader would infer (married when the family has a `MARR` event, otherwise unknown).

## \_PHOTO

Pointer from an individual to the `OBJE` record that is their profile photo.

## \_MTTAG

Ancestry MyTreeTags. As a record (`0 @T1@ _MTTAG`) it defines a tag with `NAME` and `_MTCAT`; as a pointer under an individual, family, event, source or media record it applies the tag.

## \_MTCAT

The category of a `_MTTAG` record (`Research Status`, `Custom`).

## \_OID

Ancestry media id of an `OBJE` record.

## \_DATE

Date of a media item, as written.

## \_DSCR

Description or caption of a media item.

## \_TYPE

Media kind (`photo`, `document`, `audio`, `video`, `other`) when it differs from what the file type implies.

## \_WDTH

Image width in pixels.

## \_HGHT

Image height in pixels.

## \_SIZE

File size in bytes.

## \_HOME

Under `HEAD`: pointer to the home person, the individual relationships are described from.

## Other extension tags

Ancestry and Family Tree Maker custom facts (`_MILT`, `_DNA`, `_FUN`, `_DEG`, ...) are written as events with that tag, with the standard event substructures (`DATE`, `PLAC`, `NOTE`, `SOUR`). Extension lines the importer did not map are kept and written back unchanged under the record they came from. Both get a URI of the same form, which identifies the tag even where this page has no section for it.
