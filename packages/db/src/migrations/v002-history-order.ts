// Schema version 2. Frozen once released (see history/schema-v2.sql).
//
// change_batch.seq: undo, redo and the history panel used to order batches by
// their ULID, which follows the wall clock, so a later session with its clock
// behind sorted its edits before older ones (#100). seq is assigned max + 1
// inside each write transaction. Existing batches are numbered by when their
// first change_log row was written (AUTOINCREMENT, so true commit order),
// which also repairs histories already scrambled by a clock step back.
//
// change_log.schema_version: the version each before/after image was written
// under, so older images can be upgraded through later migrations (#101).
// Every image recorded before this migration was written under version 1.
export default /* sql */ `
ALTER TABLE change_batch ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
UPDATE change_batch SET seq = ordered.n
FROM (
  SELECT b.id, row_number() OVER (ORDER BY first.seq IS NULL, first.seq, b.id) AS n
  FROM change_batch b
  LEFT JOIN (SELECT batch_id, min(seq) AS seq FROM change_log GROUP BY batch_id) first
    ON first.batch_id = b.id
) AS ordered
WHERE ordered.id = change_batch.id;
CREATE UNIQUE INDEX change_batch_seq_uq ON change_batch (seq);
DROP INDEX change_batch_state_idx;
CREATE INDEX change_batch_state_idx ON change_batch (state, seq);

ALTER TABLE change_log ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
`;
