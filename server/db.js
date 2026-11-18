// PostgreSQL access: connection pool, migrations, and item <-> row conversion.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const MIGRATIONS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations')

// Return values in the same shape the app used with JSON files:
// numeric -> number (not string), date -> 'YYYY-MM-DD' (not a Date shifted by timezone).
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)))
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v)

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL || 'postgres://localhost/sutton' })

/** Run fn(client) inside one transaction: everything is saved, or nothing is. */
export async function tx(fn) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Apply any migrations/*.sql not yet applied, in filename order. Safe to run on every start. */
export async function migrate() {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())')
  const done = new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name))
  const files = fs.readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (done.has(f)) continue
    await tx(async (c) => {
      // Only one server can migrate at a time.
      await c.query('SELECT pg_advisory_xact_lock(4242)')
      if ((await c.query('SELECT 1 FROM schema_migrations WHERE name = $1', [f])).rowCount) return
      await c.query(fs.readFileSync(path.join(MIGRATIONS, f), 'utf8'))
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f])
      console.log(`Applied migration ${f}`)
    })
  }
}

export const ITEM_COLUMNS = [
  'sku', 'name', 'description', 'category', 'uom', 'unit_cost', 'quantity_on_hand', 'reorder_point',
  'is_active', 'lot_tracked', 'tags', 'first_received_on', 'discontinued_on', 'dimensions', 'vendors',
]
const JSON_COLUMNS = new Set(['dimensions', 'vendors'])

/** DB row -> item, in the app's shape: empty fields are left out, batch_id is "batch". */
export function fromRow(row) {
  const item = {}
  for (const [k, v] of Object.entries(row)) {
    if (v === null || v === undefined) continue
    if (k === 'batch_id') item.batch = v
    else item[k] = v instanceof Date ? v.toISOString() : v
  }
  return item
}

/** Item -> query values for ITEM_COLUMNS (jsonb columns are sent as JSON text). */
export const toValues = (item) =>
  ITEM_COLUMNS.map((k) => (item[k] === undefined ? null : JSON_COLUMNS.has(k) ? JSON.stringify(item[k]) : item[k]))
