import 'dotenv/config'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRows, parseRow, CATEGORIES, UOMS, FIELDS } from '../shared/schema.js'
import { askJson } from './ai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
const STORE = path.join(DATA_DIR, 'items.json')
const PORT = process.env.API_PORT || 3001

// Missing file = empty store. A file that exists but can't be parsed is an error: never treat it
// as empty, or the next save would wipe every item.
const readJson = (file, empty) => {
  if (!fs.existsSync(file)) return empty
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}
// Atomic write: write a temp file, then rename over the real one, so a crash can't leave half a file.
const writeJson = (file, data) => {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, file)
}
const load = () => readJson(STORE, [])
const save = (items) => {
  writeJson(STORE, items)
}

const app = express()
app.use(express.json({ limit: '20mb' }))

app.get('/api/health', (_req, res) => res.json({ ok: true, ai: Boolean(process.env.OPENROUTER_API_KEY) }))

// All items already in the system.
app.get('/api/items', (_req, res) => res.json(load()))

// Remove everything (handy for demos).
app.delete('/api/items', (_req, res) => { save([]); saveBatches({}); res.json({ ok: true }) })

// Edit one imported item. Body: { row } as raw strings (same encoding as the CSV). Re-validated here.
app.put('/api/items/:sku', (req, res) => {
  const items = load()
  const idx = items.findIndex((i) => i.sku === req.params.sku)
  if (idx < 0) return res.status(404).json({ error: 'Item not found' })
  const { item, errors } = parseRow(req.body?.row || {})
  if (item.sku && item.sku !== req.params.sku && items.some((i) => i.sku === item.sku))
    errors.sku = 'This SKU already exists in the system'
  if (Object.keys(errors).length) return res.status(400).json({ errors })
  items[idx] = { ...item, imported_at: items[idx].imported_at, updated_at: new Date().toISOString() }
  save(items)
  res.json(items[idx])
})

// Delete one imported item.
app.delete('/api/items/:sku', (req, res) => {
  const items = load()
  const next = items.filter((i) => i.sku !== req.params.sku)
  if (next.length === items.length) return res.status(404).json({ error: 'Item not found' })
  save(next)
  res.json({ ok: true })
})

// Import rows of raw strings. The server re-validates everything: it is the source of truth.
// Valid rows are saved; invalid rows are returned with reasons. Partial import is intentional.
const BATCHES = path.join(DATA_DIR, 'batches.json')
const loadBatches = () => readJson(BATCHES, {})
const saveBatches = (b) => writeJson(BATCHES, b)

app.post('/api/import', (req, res) => {
  if (!Array.isArray(req.body?.rows)) return res.status(400).json({ error: 'Body must be { rows: [...] }' })
  // Anything that isn't a plain object becomes an empty row, so it's rejected with reasons instead of crashing.
  const rows = req.body.rows.map((r) => (r && typeof r === 'object' && !Array.isArray(r) ? r : {}))
  const updates = new Set(req.body?.updates || []) // SKUs the user chose to update instead of reject
  const existing = load()
  const results = validateRows(rows, new Set(existing.map((i) => i.sku).filter((k) => !updates.has(k))))
  const batch = Date.now().toString(36)
  const now = new Date().toISOString()
  const bySku = new Map(existing.map((i) => [i.sku, i]))
  const imported = []
  const previous = [] // versions replaced by updates, so undo can restore them
  const rejected = []
  results.forEach((r, i) => {
    if (!r.valid) return rejected.push({ index: i, sku: rows[i].sku, errors: r.errors })
    const old = bySku.get(r.item.sku)
    if (old) previous.push(old)
    bySku.set(r.item.sku, { ...r.item, imported_at: now, batch })
    imported.push(r.item.sku)
  })
  save([...bySku.values()])
  const batches = loadBatches()
  batches[batch] = { at: now, skus: imported, previous }
  saveBatches(batches)
  res.json({ imported, updated: previous.length, rejected, total: rows.length, batch })
})

// Undo an import: remove what it added and restore what it overwrote.
app.post('/api/import/:batch/undo', (req, res) => {
  const batches = loadBatches()
  const b = Object.hasOwn(batches, req.params.batch) ? batches[req.params.batch] : null
  if (!b) return res.status(404).json({ error: 'Import not found (already undone?)' })
  const skus = new Set(b.skus)
  const kept = load().filter((i) => !(skus.has(i.sku) && i.batch === req.params.batch))
  // Only restore an old version if nothing else now uses that SKU (a later edit/import may have).
  const present = new Set(kept.map((i) => i.sku))
  save([...kept, ...b.previous.filter((p) => !present.has(p.sku))])
  delete batches[req.params.batch]
  saveBatches(batches)
  res.json({ ok: true, removed: b.skus.length, restored: b.previous.length })
})


// ---- AI suggestions for rows that still have errors ----
const AI_MODEL = process.env.AI_MODEL || 'openrouter/auto'
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
  if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: 'AI is off: add OPENROUTER_API_KEY to .env and restart' })
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
  if (!process.env.OPENROUTER_API_KEY) return res.status(503).json({ error: 'AI is off' })
  const { unmapped, used = [] } = req.body || {}
  if (!Array.isArray(unmapped) || !unmapped.length) return res.json({ mappings: [] })
  const free = FIELDS.filter((f) => !used.includes(f.key))
  const prompt = `${RULES}

A warehouse admin uploaded a spreadsheet. These columns could not be matched automatically.
For each column, pick the ONE field it most likely holds, judging by its header AND its sample values, or null if it fits none
(e.g. internal notes, row ids, totals). Each field can be used at most once. Only choose from these unused fields:
${free.map((f) => `- ${f.key} (${f.label})`).join('\n')}

Columns:
${JSON.stringify(unmapped)}

Reply as {"mappings":[{"header":"<header>","field":"<field key or null>","why":"<under 10 words>"}]}`
  try {
    const out = await askJson(prompt, { model: AI_MODEL, temperature: 0 })
    const taken = new Set(used)
    const mappings = (out?.mappings || []).map((m) => {
      const ok = m.field && free.some((f) => f.key === m.field) && !taken.has(m.field)
      if (ok) taken.add(m.field)
      return { header: m.header, field: ok ? m.field : null, why: m.why || '' }
    })
    res.json({ mappings })
  } catch (e) {
    res.status(502).json({ error: String(e.message || e).slice(0, 300) })
  }
})

// Localhost only: no auth, so never expose the API (or the AI key's spend) to the network.
app.listen(PORT, '127.0.0.1', () => console.log(`API listening on http://127.0.0.1:${PORT}`))
