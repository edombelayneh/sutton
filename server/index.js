import 'dotenv/config'
import express from 'express'
import { validateRows, parseRow, CATEGORIES, UOMS, FIELDS } from '../shared/schema.js'
import { askJson } from './ai.js'
import { pool, tx, migrate, fromRow, toValues, ITEM_COLUMNS } from './db.js'

const PORT = process.env.API_PORT || 3001

const app = express()
app.use(express.json({ limit: '20mb' }))

// Wrap async routes so a database error becomes a clear JSON response instead of a hung request.
const route = (fn) => (req, res) => fn(req, res).catch((e) => {
  if (e.code === '23505') return res.status(409).json({ errors: { sku: 'This SKU already exists in the system' } })
  if (e.code === '23514') return res.status(400).json({ error: `Rejected by the database (${e.constraint})` })
  console.error(e)
  res.status(500).json({ error: 'Database error: ' + String(e.message || e).slice(0, 200) })
})

// ---- Item writes. Every change goes through these, so the change log is always complete. ----
const COLS = [...ITEM_COLUMNS, 'batch_id', 'imported_at', 'updated_at']
const INSERT = `INSERT INTO items (${COLS.join(', ')}) VALUES (${COLS.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`
const insertRow = async (c, item, { batch_id = null, imported_at = new Date().toISOString(), updated_at = null } = {}) =>
  fromRow((await c.query(INSERT, [...toValues(item), batch_id, imported_at, updated_at])).rows[0])
const removeRow = async (c, sku) => {
  const { rows } = await c.query('DELETE FROM items WHERE sku = $1 RETURNING *', [sku])
  return rows[0] ? fromRow(rows[0]) : null
}
const logChange = (c, { batch_id = null, kind, sku, before, after }) =>
  c.query('INSERT INTO item_changes (batch_id, kind, sku, before, after) VALUES ($1, $2, $3, $4, $5)',
    [batch_id, kind, sku, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null])
// Writers wait for each other, so the change log order is the real order of changes.
const lockItems = (c) => c.query('LOCK TABLE items IN SHARE ROW EXCLUSIVE MODE')

app.get('/api/health', (_req, res) => res.json({ ok: true, ai: Boolean(process.env.GROQ_API_KEY) }))

// All items already in the system.
app.get('/api/items', route(async (_req, res) => {
  const { rows } = await pool.query('SELECT * FROM items ORDER BY imported_at, sku')
  res.json(rows.map(fromRow))
}))

// Remove everything (handy for demos). Also clears upload history.
app.delete('/api/items', route(async (_req, res) => {
  await pool.query('TRUNCATE items, item_changes, import_batches')
  res.json({ ok: true })
}))

// Edit one imported item. Body: { row } as raw strings (same encoding as the CSV). Re-validated here.
// The edit detaches the item from its import, so undoing only that import won't delete the edit.
app.put('/api/items/:sku', route(async (req, res) => {
  const { item, errors } = parseRow(req.body?.row || {})
  if (Object.keys(errors).length) return res.status(400).json({ errors })
  const out = await tx(async (c) => {
    await lockItems(c)
    const before = await removeRow(c, req.params.sku)
    if (!before) return null
    const after = await insertRow(c, item, { imported_at: before.imported_at, updated_at: new Date().toISOString() })
    if (item.sku === req.params.sku) await logChange(c, { kind: 'edit', sku: item.sku, before, after })
    else { // SKU renamed: the old SKU is gone and a new one exists
      await logChange(c, { kind: 'edit', sku: req.params.sku, before, after: null })
      await logChange(c, { kind: 'edit', sku: item.sku, before: null, after })
    }
    return after
  })
  if (!out) return res.status(404).json({ error: 'Item not found' })
  res.json(out)
}))

// Delete one imported item.
app.delete('/api/items/:sku', route(async (req, res) => {
  const ok = await tx(async (c) => {
    await lockItems(c)
    const before = await removeRow(c, req.params.sku)
    if (before) await logChange(c, { kind: 'delete', sku: before.sku, before, after: null })
    return Boolean(before)
  })
  if (!ok) return res.status(404).json({ error: 'Item not found' })
  res.json({ ok: true })
}))

// Import rows of raw strings. The server re-validates everything: it is the source of truth.
// Valid rows are saved; invalid rows are returned with reasons. Partial import is intentional.
// The whole import is one transaction: either every valid row is saved, or none is.
app.post('/api/import', route(async (req, res) => {
  if (!Array.isArray(req.body?.rows)) return res.status(400).json({ error: 'Body must be { rows: [...] }' })
  // Anything that isn't a plain object becomes an empty row, so it's rejected with reasons instead of crashing.
  const rows = req.body.rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : {}))
  const updates = new Set(Array.isArray(req.body?.updates) ? req.body.updates : []) // SKUs the user chose to update instead of reject
  const files = (Array.isArray(req.body?.files) ? req.body.files : []).filter((f) => typeof f === 'string').map((f) => f.slice(0, 200)).slice(0, 50)
  const out = await tx(async (c) => {
    await lockItems(c) // one import at a time, so two imports can't both claim the same new SKU
    const existing = new Set((await c.query('SELECT sku FROM items')).rows.map((r) => r.sku))
    const results = validateRows(rows, new Set([...existing].filter((k) => !updates.has(k))))
    const batch = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    const now = new Date().toISOString()
    const mark = (await c.query('SELECT coalesce(max(id), 0) AS m FROM item_changes')).rows[0].m
    await c.query('INSERT INTO import_batches (id, imported_at, files, after_change) VALUES ($1, $2, $3, $4)', [batch, now, files, mark])
    const imported = []
    const rejected = []
    let updated = 0
    for (const [i, r] of results.entries()) {
      if (!r.valid) { rejected.push({ index: i, sku: rows[i].sku, errors: r.errors }); continue }
      const before = existing.has(r.item.sku) ? await removeRow(c, r.item.sku) : null
      const after = await insertRow(c, r.item, { batch_id: batch, imported_at: now })
      await logChange(c, { batch_id: batch, kind: before ? 'update' : 'import', sku: r.item.sku, before, after })
      if (before) updated++
      imported.push(r.item.sku)
    }
    await c.query('UPDATE import_batches SET added = $2, updated = $3, rejected = $4 WHERE id = $1',
      [batch, imported.length - updated, updated, rejected.length])
    return { imported, updated, rejected, total: rows.length, batch }
  })
  res.json(out)
}))

// Upload history, newest first. For each upload: what restoring to before it would also undo.
app.get('/api/batches', route(async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT b.id, b.seq, b.imported_at, b.files, b.added, b.updated, b.rejected,
      (SELECT count(*) FROM import_batches l WHERE l.seq > b.seq)::int AS later_uploads,
      -- one edit/delete = one transaction = one now(); a rename logs two rows but is one edit
      (SELECT count(DISTINCT ch.at) FROM item_changes ch WHERE ch.id > b.after_change AND ch.batch_id IS NULL)::int AS later_edits
    FROM import_batches b ORDER BY b.seq DESC`)
  res.json(rows.map((r) => ({ ...r, seq: Number(r.seq), imported_at: r.imported_at.toISOString() })))
}))

// Restore to before an upload: replay the change log backwards to just before it.
// That upload, every later upload, and every edit/delete made since are undone, in one transaction.
async function restoreBefore(id) {
  return tx(async (c) => {
    await lockItems(c)
    const b = (await c.query('SELECT seq, after_change FROM import_batches WHERE id = $1', [id])).rows[0]
    if (!b) return null
    const changes = (await c.query('SELECT sku, before FROM item_changes WHERE id > $1 ORDER BY id DESC', [b.after_change])).rows
    const keep = await c.query('SELECT id FROM import_batches WHERE seq < $1', [b.seq])
    const surviving = new Set(keep.rows.map((r) => r.id))
    for (const ch of changes) {
      await removeRow(c, ch.sku)
      if (ch.before) {
        const p = ch.before
        await insertRow(c, p, { batch_id: surviving.has(p.batch) ? p.batch : null, imported_at: p.imported_at, updated_at: p.updated_at ?? null })
      }
    }
    // Safety net: any item still pointing at an upload we're undoing goes too, even if the log has no
    // record of it (e.g. uploads made before the change log existed). Without this they'd be left behind.
    const orphans = await c.query('DELETE FROM items WHERE batch_id IN (SELECT id FROM import_batches WHERE seq >= $1)', [b.seq])
    await c.query('DELETE FROM item_changes WHERE id > $1', [b.after_change])
    const gone = await c.query('DELETE FROM import_batches WHERE seq >= $1', [b.seq])
    if (orphans.rowCount) console.warn(`Restore ${id}: removed ${orphans.rowCount} item(s) that had no change-log record`)
    return { ok: true, uploadsUndone: gone.rowCount, changesUndone: changes.length }
  })
}
app.post('/api/batches/:id/restore', route(async (req, res) => {
  const out = await restoreBefore(req.params.id)
  if (!out) return res.status(404).json({ error: 'Upload not found (already undone?)' })
  res.json(out)
}))
// "Undo this import" on the results page: the same thing, right after the import.
app.post('/api/import/:batch/undo', route(async (req, res) => {
  const out = await restoreBefore(req.params.batch)
  if (!out) return res.status(404).json({ error: 'Import not found (already undone?)' })
  res.json(out)
}))


// ---- AI suggestions for rows that still have errors ----
const AI_MODEL = process.env.AI_MODEL || 'openai/gpt-oss-120b'
const AI_MAX_ROWS = 200
const RULES = `Inventory item fields (CSV cell encoding, all values are strings):
- sku: ^[A-Z]{4}-[A-Z0-9]{3}$ (e.g. PACK-7Q2)
- name: 1-120 chars
- category: one of ${CATEGORIES.join(', ')} (RAW=raw material, COMP=component, FG=finished good, PKG=packaging, CONS=consumable)
- uom: one of ${UOMS.join(', ')}
- unit_cost: number >= 0, up to 4 decimals, USD (e.g. "12.5")
- quantity_on_hand, reorder_point: whole number >= 0
- is_active, lot_tracked: "true" or "false"
- tags: lowercase, unique, separated by ";"
- first_received_on, discontinued_on: YYYY-MM-DD real calendar date. If discontinued_on is set, is_active must be "false".
- dimensions: JSON object {"length":n,"width":n,"height":n,"unit":"cm"|"in"}, all three numbers > 0
- vendors: JSON array (max 3) of {"vendor_name":str,"vendor_sku":str?,"unit_cost":n,"lead_time_days":int?,"is_preferred":bool?}; at most ONE is_preferred true.`

async function suggestBatch(batch) {
  const prompt = `${RULES}

You help a warehouse admin fix rows that failed validation. For each row, propose a corrected value ONLY for the fields listed in "errors".
Use the other fields as evidence (e.g. infer category from the item name, a missing name from the description, a unit_cost from the preferred vendor's cost, repair truncated JSON).
If a value truly cannot be inferred, omit it rather than inventing data. Do NOT change sku duplicates.
Keep "why" short (under 12 words) and concrete. Set "confidence" to "high" or "low".

Rows:
${JSON.stringify(batch)}

Reply as {"suggestions":[{"index":<row index>,"field":"<field>","value":"<new cell string>","why":"...","confidence":"high"|"low"}]}`
  const out = await askJson(prompt, { model: AI_MODEL, temperature: 0 })
  return Array.isArray(out?.suggestions) ? out.suggestions : []
}

app.post('/api/ai/suggest', async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'AI is off: add GROQ_API_KEY to .env and restart' })
  if (!Array.isArray(req.body?.rows)) return res.status(400).json({ error: 'Body must be { rows: [{ index, row, errors }] }' })
  const rows = req.body.rows.filter((r) => r && typeof r === 'object').slice(0, AI_MAX_ROWS) // cap cost per request
  const batches = []
  for (let i = 0; i < rows.length; i += 15) batches.push(rows.slice(i, i + 15))
  try {
    const results = await Promise.allSettled(batches.map(suggestBatch))
    const suggestions = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed) console.error('AI batch errors:', results.filter((r) => r.status === 'rejected').map((r) => String(r.reason).slice(0, 200)))
    res.json({ suggestions, failedBatches: failed })
  } catch (e) {
    res.status(502).json({ error: String(e.message || e).slice(0, 300) })
  }
})

// ---- AI header mapping fallback: only for headers our alias matching couldn't place ----
app.post('/api/ai/map', async (req, res) => {
  if (!process.env.GROQ_API_KEY) return res.status(503).json({ error: 'AI is off' })
  const { unmapped, used = [], others = [] } = req.body || {}
  if (!Array.isArray(unmapped) || !unmapped.length) return res.json({ mappings: [] })
  const free = FIELDS.filter((f) => !used.includes(f.key))
  const all = [...unmapped, ...(Array.isArray(others) ? others : [])].slice(0, 100)
  const filesOf = (h) => all.find((c) => c.header === h)?.files || []
  const multi = new Set(all.flatMap((c) => c.files || [])).size > 1
  const prompt = `${RULES}

A warehouse admin uploaded ${multi ? 'several spreadsheets' : 'a spreadsheet'}. These columns could not be matched automatically.
For each column, pick the ONE field it most likely holds, judging by its header AND its sample values, or null if it fits none
(e.g. internal notes, row ids, totals). Each field can be used at most once. Only choose from these fields:
${free.map((f) => `- ${f.key} (${f.label})`).join('\n')}
${multi ? `
The files may name the same column differently (capitalization, abbreviations, synonyms: "Part #" vs "SKU", "Supplier" vs "Vendor").
Also set "same_as" to the header of a column from a DIFFERENT file that holds the same kind of data (compare the sample values,
not just the names), or null. Never pick a column that shares a file with this one.
A field already used by a column in another file is NOT used up: if this column holds the same data, give that field AND same_as
(e.g. "Item Description Short" with short product titles is name, same_as "Item Name").
If a column has no sample values, judge by its name alone (e.g. "Date Out" is discontinued_on).
Other columns:
${JSON.stringify(others)}
` : ''}
Columns to place:
${JSON.stringify(unmapped)}

Reply as {"mappings":[{"header":"<header>","field":"<field key or null>",${multi ? '"same_as":"<header or null>",' : ''}"why":"<under 10 words>"}]}`
  try {
    const out = await askJson(prompt, { model: AI_MODEL, temperature: 0 })
    const taken = new Set(used)
    const mappings = (out?.mappings || []).map((m) => {
      const ok = m.field && free.some((f) => f.key === m.field) && !taken.has(m.field)
      if (ok) taken.add(m.field)
      // same_as must be a real column that shares no file with this one.
      const mine = filesOf(m.header)
      const same = multi && m.same_as && m.same_as !== m.header && all.some((c) => c.header === m.same_as)
        && !filesOf(m.same_as).some((f) => mine.includes(f)) ? m.same_as : null
      return { header: m.header, field: ok ? m.field : null, same_as: same, why: m.why || '' }
    })
    res.json({ mappings })
  } catch (e) {
    res.status(502).json({ error: String(e.message || e).slice(0, 300) })
  }
})

// Localhost only: no auth, so never expose the API (or the AI key's spend) to the network.
try {
  await migrate()
} catch (e) {
  console.error(`\nCan't reach the database (${e.code || e.message}).`)
  console.error('Start Postgres with:  brew services start postgresql@18')
  console.error('Create the database:  createdb sutton   (or set DATABASE_URL in .env)\n')
  process.exit(1)
}
app.listen(PORT, '127.0.0.1', () => console.log(`API listening on http://127.0.0.1:${PORT}`))
