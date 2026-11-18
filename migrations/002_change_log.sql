-- Every change to an item (import, update, edit, delete) is logged with its before and after values,
-- so "restore to before an upload" can replay the log backwards and put everything back exactly.

CREATE TABLE item_changes (
  id       bigserial PRIMARY KEY,
  at       timestamptz NOT NULL DEFAULT now(),
  batch_id text REFERENCES import_batches (id) ON DELETE SET NULL, -- null for manual edits/deletes
  kind     text NOT NULL CHECK (kind IN ('import', 'update', 'edit', 'delete')),
  sku      text NOT NULL,
  before   jsonb, -- null: the item didn't exist
  after    jsonb  -- null: the item was removed
);

-- Upload order, what was uploaded, and where in the change log it starts.
ALTER TABLE import_batches
  ADD COLUMN seq          bigserial,
  ADD COLUMN files        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN added        integer NOT NULL DEFAULT 0,
  ADD COLUMN updated      integer NOT NULL DEFAULT 0,
  ADD COLUMN rejected     integer NOT NULL DEFAULT 0,
  ADD COLUMN after_change bigint NOT NULL DEFAULT 0; -- last item_changes.id before this upload

CREATE UNIQUE INDEX import_batches_seq ON import_batches (seq);

-- The change log replaces this: undo now replays item_changes.
DROP TABLE batch_previous;
