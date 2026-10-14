# HTTP API

`apps/server` serves the web app and a JSON API under `/api` on `127.0.0.1` (port 4317 by default). Trees live in a library folder (`--library`, `OA_LIBRARY`, default `~/OpenAncestry`); a tree's id in URLs is its folder name without `.oatree`.

## Conventions

- **Errors** are always `{ "error": { "code": "...", "message": "..." } }`. Codes: `bad_request`, `validation_failed`, `forbidden`, `forbidden_host`, `not_found`, `conflict`, `payload_too_large`, `unsupported_media_type`, `range_not_satisfiable`, `too_many_jobs`, `not_implemented`, `internal_error`.
- **Validation:** params, query strings and bodies are checked against TypeBox schemas (`apps/server/src/schemas.ts`). Unknown body properties are rejected.
- **Reads** return database DTOs from `packages/db` (`PersonSummary`, `PersonDetail`, `Neighborhood`, ...). **Write bodies** use the database column names (`date_text`, `relationship_type`, ...); derived columns (date sort keys, surname phonetic keys) are computed by the server.
- **Edits:** each mutation is one undoable change batch and returns `batchId` (null when nothing changed).
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
| Mutations need a same-origin `Origin` and the per-process token, else 403 `forbidden` | Defeats CSRF; other origins cannot read the token because there is no CORS. |
| `Sec-Fetch-Site: cross-site` is refused on `/api` | Defense in depth. |
| No CORS headers, ever | |
| CSP `default-src 'self'; img-src 'self' data: blob:; frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: no-referrer`, COOP `same-origin` on every response | |
| JSON bodies up to 1 MiB; import uploads up to 1 GiB (streamed to a temp file); one import at a time, four queued | Bounded memory and disk. |
| Media paths are resolved (following symlinks) inside the tree's `media/` folder; media responses add `CSP: sandbox` | Path traversal and stored-XSS defense. |

The SPA fetches the token once at startup and sends it with every mutation; browsers add `Origin` themselves.

## Routes

`:tree` is a tree id, `:id` a record id (ULID).

| Method and path | Purpose |
|---|---|
| `GET /api/health` | Liveness. |
| `GET /api/session` | Mutation token. |
| `GET /api/trees` | `{ trees: [{ id, name, modifiedAt }] }` |
| `POST /api/trees` `{ name }` | Create a tree (201). Names cannot contain path separators or start with a dot. |
| `GET /api/trees/:tree` | Tree info with `peopleCount`, `homePersonId`, `schemaVersion`. |
| `PATCH /api/trees/:tree` `{ name }` | Rename (folder and display name). |
| `DELETE /api/trees/:tree` | Move to `<library>/.trash/` (204). |
| `GET /api/trees/:tree/people?sort&dir&sex&living&tag&limit&offset` | People list `{ total, items }`; `sort` = surname, given, birth, death; `living` is comma-separated. |
| `GET /api/trees/:tree/people/:id` | `PersonDetail` (names, timeline events, families, media, notes, tags). |
| `GET /api/trees/:tree/people/:id/summary` | `PersonSummary`. |
| `GET /api/trees/:tree/families/:id` | Family with partners, children and events. |
| `GET /api/trees/:tree/neighborhood?focus&up&down&siblings` | Graph slice for the tree views (focus defaults to the home person; up/down 0-10). |
| `GET /api/trees/:tree/search?q&limit` | Ranked search; the last word also matches by surname sound. |
| `GET`, `PUT /api/trees/:tree/home` `{ personId }` | Home person. |
| `GET /api/trees/:tree/tags` | Tags with person counts. |
| `GET /api/trees/:tree/history?limit` | Change batches, `canUndo`, `canRedo`. |
| `POST /api/trees/:tree/undo`, `/redo` | Undo or redo the latest batch; `{ batch }` (null if none). |
| `GET /api/trees/:tree/export.json` | Full open-ancestry JSON download. |
| `POST /api/trees/:tree/import` (multipart `file`: .ged, .gedcom, .zip, .gdz) | Starts an import job (202 `{ jobId, job }`). |
| `GET /api/jobs/:id` | Job state, progress, result or error. |
| `GET /api/jobs/:id/events` | Server-sent events: `state` (whole job) and `progress`; ends when the job finishes. |
| `GET /api/trees/:tree/media/:id` | Original media file with `Range` support. |
| `GET /api/trees/:tree/media/:id/thumb/:size` | 404 until thumbnails exist. |
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

## Import jobs

The import route streams the upload to a private temp folder, then runs an injected `Importer` (`apps/server/src/jobs.ts`), the `importGedcom(filePath, store, { mediaDir, onProgress, signal })` function from the import package. Without one the route answers 501. The temp file is deleted when the job ends, and rename or delete of a tree is refused while it is importing.
