-- Who did what. Always set by the server from the signed-in session, never from the browser.
-- Employees are deactivated, not deleted, so these references keep pointing at a real person.

ALTER TABLE import_batches ADD COLUMN imported_by integer REFERENCES employees (id);
ALTER TABLE items
  ADD COLUMN imported_by integer REFERENCES employees (id),
  ADD COLUMN updated_by  integer REFERENCES employees (id);
ALTER TABLE item_changes ADD COLUMN changed_by integer REFERENCES employees (id);

CREATE INDEX items_imported_by ON items (imported_by);
CREATE INDEX import_batches_imported_by ON import_batches (imported_by);
