# HTTP API

`apps/server` serves the web app and a JSON API under `/api` on `127.0.0.1` (port 4317 by default). Trees live in a library folder (`--library`, `OA_LIBRARY`, default `~/OpenAncestry`); a tree's id in URLs is its folder name without `.oatree`.

## Conventions

- **Errors** are always `{ "error": { "code": "...", "message": "..." } }`. Codes: `bad_request`, `validation_failed`, `forbidden`, `forbidden_host`, `not_found`, `conflict`, `stale`, `payload_too_large`, `unsupported_media_type`, `range_not_satisfiable`, `too_many_jobs`, `not_implemented`, `internal_error`.
- **Validation:** params, query strings and bodies are checked against JSON Schemas written with TypeBox in `apps/server/src/schemas.source.ts` and loaded at runtime from the generated `schemas.generated.json` (no TypeBox at startup). After editing the source run `npm run generate:schemas -w @open-ancestry/server`; a test fails until you do. Each route's validator is compiled on its first request. Unknown body properties are rejected.
- **Reads** return database DTOs from `packages/db` (`PersonSummary`, `PersonDetail`, `Neighborhood`, ...). **Write bodies** use the database column names (`date_text`, `relationship_type`, ...); derived columns are computed by the server exactly as the importer computes them: date sort keys and qualifiers, surname phonetic keys, the GEDCOM-form `person_name.full_text`, and inferred living status (person, event and relationship edits re-run living inference for the people involved and their parents, spouses and children; an explicit `living` or `dead` is never overridden, and `living: "unknown"` asks for inference again).
- **Busy trees:** while a tree has an import queued or running, every write to it (edits, batch, undo, redo, home, tags, notes, media, another import, rename, delete) answers 409 `conflict`; reads still work.
- **Edits:** each mutation is one undoable change batch and returns `batchId` (null when nothing changed).
- **Downloads** (`export.*`) send `Content-Disposition: attachment` named after the tree: an ASCII `filename` (other characters become `_`) and the exact name in `filename*`.
- **Caching:** GET responses carry a weak `ETag` (send `If-None-Match` for a 304). JSON over 1 KB is compressed with Brotli or gzip.

## Security contract for clients

```
GET /api/session                  -> { token, tokenHeader: "x-oa-token" }
POST/PUT/PATCH/DELETE /api/...    needs  Origin: <this server>  and  x-oa-token: <token>
```

| Rule | Why |
|---|---|
| Binds `127.0.0.1` unless `--host` is given (the CLI warns loudly otherwise) | Private data never reaches the network by default. |
| `Host` must be `localhost`, `127.0.0.1` or `[::1]` (any port), else 403 `forbidden_host` | Defeats DNS rebinding. |
| Every method except GET, HEAD and OPTIONS needs the per-process token and an `Origin` that exactly equals this server's serialized origin (no `null`, userinfo, path, case or duplicate variations), else 403 `forbidden` | Defeats CSRF; other origins cannot read the token because there is no CORS. |
| `Sec-Fetch-Site: cross-site` is refused for everything except a top-level GET navigation | Defense in depth; links to the app from elsewhere still open it. |
| Paths with percent-encoded unreserved characters, `/`, `\` or `%`, malformed escapes, dot segments or empty segments get 400 before routing; the mutation guard applies to every non-safe method whatever the path | The router decodes paths, so `/%61pi/...` must never dodge the guard. |
| No CORS headers, ever | |
| CSP `default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, COOP `same-origin` on every response | |
| JSON bodies up to 1 MiB; import uploads up to 1 GiB (streamed to a temp file); one import at a time, four queued | Bounded memory and disk. |
| Media paths are resolved (following symlinks) inside the tree's `media/` folder. The content type is sniffed from magic bytes against an allowlist (JPEG, PNG, GIF, WebP, AVIF, MP3, WAV, Ogg, FLAC, MP4/M4A, WebM, PDF); `media.mime` and extensions are ignored, anything else is an `application/octet-stream` attachment, and every media response carries `CSP: default-src 'none'; style-src 'unsafe-inline'; sandbox` and `nosniff` | Path traversal and stored-XSS defense; GEDCOM media is untrusted. |
| Thumbnails decode only real raster images (by magic bytes) with sharp, capped at 100 megapixels, one image at a time in a background queue | Decompression bombs and odd files never reach the decoder or tie up the server. |

The SPA fetches the token once at startup and sends it with every mutation; browsers add `Origin` themselves.

## Routes

`:tree` is a tree id, `:id` a record id (ULID).

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Liveness. |
| `GET /api/session` | Mutation token. |
| `GET /api/trees` | `{ trees: [{ id, name, modifiedAt }] }` |
| `POST /api/trees` `{ name }` | Create a tree (201). Names cannot contain path separators or `%`, start or end with a dot, or be a Windows device name (`CON`, `NUL`, `COM1`, ...). |
| `GET /api/trees/:tree` | Tree info with `peopleCount`, `livingCount` and `privateCount` (who a privatized export hides: people who may be living, and others marked private or confidential), `homePersonId`, `schemaVersion`. |
| `PATCH /api/trees/:tree` `{ name }` | Rename (folder and display name). |
| `DELETE /api/trees/:tree` | Move to `<library>/.trash/` (204). |
| `GET /api/trees/:tree/people?sort&dir&sex&living&tag&limit&offset` | People list `{ total, items }`; `sort` = surname, given, birth, death; `living` is comma-separated. |
| `GET /api/trees/:tree/people/:id` | `PersonDetail` (names, timeline events, families, media, notes, tags). |
| `GET /api/trees/:tree/people/:id/summary` | `PersonSummary`. |
| `GET /api/trees/:tree/families/:id` | Family with partners, children and events. |
| `GET /api/trees/:tree/neighborhood?focus&up&down&siblingsDepth` | Graph slice for the tree views (focus defaults to the home person; up/down 0-10). `siblingsDepth` 0-10 adds siblings of the focus person (1, the default), parents (2, aunts and uncles) and so on up to `up`; siblings with unfetched children are in `moreDown`. `siblings=false` equals `siblingsDepth=0`. |
| `GET /api/trees/:tree/search?q&limit` | Ranked search `{ items: [{ person, match, score }] }`: exact words, then prefixes (years within two), then surnames by sound (`match` says which). Every word is required (`or`/`and` are ordinary words); input is NFC-normalized, only its first 100 characters and 8 distinct words are used, and a one-character word matches only as a whole word (an initial). Responses carry `Server-Timing: app;dur=<ms>`. |
| `GET`, `PUT /api/trees/:tree/home` `{ personId }` | Home person. |
| `GET /api/trees/:tree/tags` | Tags with person counts. |
| `GET /api/trees/:tree/history?limit` | Change batches, newest first in commit order (`seq`, not the ULID, so clock changes cannot reorder them), `canUndo`, `canRedo`. |
| `POST /api/trees/:tree/undo`, `/redo` | Undo or redo the latest batch; `{ batch, skipped }`. `batch` is null if there was none. `skipped` lists newer batches undo stepped over because the NFC upgrade made them impossible to undo (always empty for redo). |
| `GET /api/trees/:tree/export.json` | Full open-ancestry JSON download. |
| `GET /api/trees/:tree/export.ged?version&privatize` | GEDCOM download (`text/vnd.familysearch.gedcom`); `version` is `5.5.1` (default, Ancestry-compatible) or `7`; `privatize=true` writes living people, and anyone marked private or confidential, as "Private" with only their family links, and names the download `private-tree.ged` instead of after the tree. |
| `GET /api/trees/:tree/export.gdz?privatize` | GEDZIP download (GEDCOM 7 plus the tree's media files). |
| `POST /api/import` (multipart `file`: .ged, .gedcom, .zip, .gdz) | Imports into a new tree named after the file (" 2", " 3", ... when taken); 202 `{ jobId, job }` with `job.tree` and `job.createdTree: true`. The server owns that tree: if the import fails or is cancelled it removes it, but only while it is still the empty tree it created. |
| `POST /api/trees/:tree/import` (multipart `file`) | Starts an import into an existing, empty tree (202 `{ jobId, job }`); that tree is never removed. |
| `POST /api/trees/:tree/reimport` (multipart `file`) | Compares an updated export with the tree as a job (`kind: 'reimport'`); its `result` is `{ reimportId, counts }`. Nothing is written. |
| `GET /api/reimports/:id` | The review: `source`, `lines`, and `diff` (`people`: matched, new and missing people, each with `confidence`, `reasons` and `changes`; `counts`). Sessions live in memory for an hour, at most four at a time. |
| `POST /api/reimports/:id/apply` `{ accept: [changeId] }` | Applies the accepted changes as one change batch labelled `Re-import <file>` (undo reverts all of it). 409 when the tree changed since the comparison. Returns `{ batchId, applied, skipped, blocked }`. |
| `DELETE /api/reimports/:id` | Discards a review (204). |
| `GET /api/jobs/:id` | Job state, progress, result or error. |
| `DELETE /api/jobs/:id` | Cancel (202 `{ job }`): a queued job never runs, a running one is aborted. Cleanup removes the upload and any empty tree the import created. 409 once finished. Stopping the server (Ctrl-C or SIGTERM on `open-ancestry serve`) cancels every job the same way. |
| `GET /api/jobs/:id/events` | Server-sent events: `state` (whole job) and `progress`; ends when the job finishes. |
| `GET /api/trees/:tree/media/:id` | Original media file with `Range` support. |
| `GET /api/trees/:tree/media/:id/thumb/:size` | WebP thumbnail, `size` = `sm` (160 px longest edge), `md` (480) or `lg` (1280). Made on demand if missing and cached in the tree's `thumbs/` folder; 404 when the media has no decodable local image (documents, Ancestry placeholders). |
| `GET /api/trees/:tree/people/:id/media` | `{ items: [{ media, owners }] }`: media on the person and on their events, each once; `owners` lists where it is attached (`{ type: 'person' }` or `{ type: 'event', event: { type, custom_type, date_text, date_sort } }`). |
| `POST /api/trees/:tree/media` (multipart `owner_type` = `person` or `event`, `owner_id`, then `file`) | Attach a file from disk (201 `{ media, batchId }`). Bytes identical to media already in the tree link that media instead of a copy; new files go to `media/attached/<sha256 prefix>-<name>`. The type comes from the file's bytes; unknown types are stored as `other` and served as attachments. |
| `POST /api/trees/:tree/people` | Create a person with `names` and `events`. |
| `PATCH`, `DELETE /api/trees/:tree/people/:id` | Edit sex, living, privacy, primary photo; delete (cascades). |
| `POST /api/trees/:tree/people/:id/names`; `PATCH`, `DELETE /api/trees/:tree/names/:id` | Names (the last name cannot be deleted). |
| `POST /api/trees/:tree/people/:id/events`, `POST /api/trees/:tree/families/:id/events`; `PATCH`, `DELETE /api/trees/:tree/events/:id` | Events; `date_text` is parsed, `place` is a full place name. |
| `POST /api/trees/:tree/people/:id/parents` `{ personId \| person, familyId?, rel? }` | Add a parent: into `familyId`, else the preferred parent family if it has room, else a new family. |
| `POST /api/trees/:tree/people/:id/spouses` `{ personId \| person, relationship_type? }` | New partner family. |
| `POST /api/trees/:tree/people/:id/children` `{ personId \| person, familyId?, partner1_rel?, partner2_rel? }` | Add a child to `familyId` or a new single-parent family. |
| `POST /api/trees/:tree/people/:id/siblings` `{ personId \| person }` | Add to the preferred parent family (created without parents if needed). |
| `PATCH`, `DELETE /api/trees/:tree/families/:id` | Relationship type, partners; delete family. |
| `PATCH`, `DELETE /api/trees/:tree/family-children/:id` | Child relationship (`partner1_rel`, `partner2_rel`, `sort_order`, `is_preferred: true`); remove the child from the family. |
| `POST /api/trees/:tree/notes` `{ text, owner_type, owner_id }`; `PATCH`, `DELETE /api/trees/:tree/notes/:id` | Notes. |
| `POST /api/trees/:tree/tags`; `PATCH`, `DELETE /api/trees/:tree/tags/:id` | Tags. |
| `POST /api/trees/:tree/people/:id/tags` `{ tagId }`; `DELETE /api/trees/:tree/people/:id/tags/:tagId` | Tag or untag a person. |
| `POST /api/trees/:tree/people/:id/merge` `{ otherId, choices? }` | Merge `otherId` into `:id` in one undoable batch, then delete it. `choices`: `name`, `sex`, `living`, `privacy` (`keep` or `other`) and `preferred` (`{ "BIRT": "other" }`) for conflicting single facts, which become alternates. Names, events, families, sources, media, notes and tags move; identical facts and families with the same partners are combined. Without a `privacy` choice the kept person takes the stricter visibility; an explicit `choices.privacy` wins even when it names the less private side. 409 when the two are partners, when one is an ancestor of the other, or when one is `locked` (an edit lock) and the other `private` or `confidential` and no `privacy` choice says which to keep. |
| `POST /api/trees/:tree/batch` `{ label, operations }` | Several edits as one change batch (one undo step, labelled `label`), all or nothing. Operations: `person.update` `{ id, patch }`, `name.add` `{ personId, name }`, `name.update` `{ id, name }`, `name.delete` `{ id }`, `familyChild.update` `{ id, patch }`, `tag.create` `{ tag, attachTo? }`, `person.tag` / `person.untag` `{ personId, tagId }`, each with the body of its single route. `person.update`, `name.update`, `name.delete` and `familyChild.update` take an optional `expect`: columns of the row as the client last saw it: `{ updated_at }` for a person; for a name (no timestamp) any of its columns, such as the whole row from the person detail; for a link (no timestamp) the columns it changes, e.g. `{ partner1_rel }`. Every `expect` is checked against the rows as they were before the batch's first operation. If a row no longer matches (another tab, an undo), the whole batch is refused with 409 `stale`. Returns `{ batchId, results }`. |

Both GEDCOM downloads send `x-oa-export-warning-count` and `x-oa-export-warnings` (the first 20 warnings as percent-encoded JSON): imported lines the export could not carry over, and media files it could not add. A tree that cannot be written as GEDCOM gets a 409 `conflict` naming the problem.

## Import jobs

The import route streams the upload to a private temp folder, then runs an injected `Importer` (`apps/server/src/jobs.ts`). The CLI and the dev server inject `importFile` from `@open-ancestry/import`, which imports the upload into the empty tree and reports progress as `{ phase, done, total }` (`phase` is `read`, `parse`, `map`, `finalize`, `commit` or `done`; `done`/`total` count records during `map`). The completed job's `result` is the import report (see `packages/import/README.md`). Without an importer the route answers 501. The temp file is deleted when the job ends, and rename or delete of a tree is refused while it is importing. On startup the server removes upload folders (`oa-upload-*` in the temp folder) older than six hours and empty trees left by imports that were interrupted over an hour earlier (trees still marked `import_pending`). Clients only display a failed import; they never delete trees.
