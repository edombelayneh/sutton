-- Inventory items, import batches, and what each import replaced (so undo can restore it).
-- The database enforces the same rules as shared/schema.js, as a last line of defense.

CREATE TABLE import_batches (
  id          text PRIMARY KEY,
  imported_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE items (
  sku               text PRIMARY KEY CHECK (sku ~ '^[A-Z]{4}-[A-Z0-9]{3}$'),
  name              text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  description       text,
  category          text NOT NULL CHECK (category IN ('RAW', 'COMP', 'FG', 'PKG', 'CONS')),
  uom               text NOT NULL CHECK (uom IN ('EA', 'BX', 'KG', 'M', 'L')),
  unit_cost         numeric(14, 4) NOT NULL CHECK (unit_cost >= 0),
  quantity_on_hand  integer NOT NULL DEFAULT 0 CHECK (quantity_on_hand >= 0),
  reorder_point     integer CHECK (reorder_point >= 0),
  is_active         boolean NOT NULL DEFAULT true,
  lot_tracked       boolean NOT NULL DEFAULT false,
  tags              text[],
  first_received_on date,
  discontinued_on   date,
  dimensions        jsonb,
  vendors           jsonb,
  batch_id          text REFERENCES import_batches (id) ON DELETE SET NULL,
  imported_at       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz,
  CONSTRAINT discontinued_means_inactive CHECK (discontinued_on IS NULL OR is_active = false)
);
CREATE INDEX items_batch_id ON items (batch_id);

-- The version of an item that an import overwrote. Undo puts it back.
CREATE TABLE batch_previous (
  batch_id text NOT NULL REFERENCES import_batches (id) ON DELETE CASCADE,
  sku      text NOT NULL,
  item     jsonb NOT NULL,
  PRIMARY KEY (batch_id, sku)
);
