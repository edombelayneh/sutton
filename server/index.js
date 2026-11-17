import 'dotenv/config'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRows, CATEGORIES, UOMS, FIELDS } from '../shared/schema.js'
import { askJson } from './ai.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(__dirname, '..', 'data')
const STORE = path.join(DATA_DIR, 'items.json')
const PORT = process.env.API_PORT || 3001

const load = () => {
  try { return JSON.parse(fs.readFileSync(STORE, 'utf8')) } catch { return [] }
}
const save = (items) => {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(STORE, JSON.stringify(items, null, 2))
}

const app = express()
app.use(express.json({ limit: '20mb' }))

app.get('/api/health', (_req, res) => res.json({ ok: true, ai: Boolean(process.env.OPENROUTER_API_KEY) }))

// All items already in the system.
app.get('/api/items', (_req, res) => res.json(load()))

// Remove everything (handy for demos).
app.delete('/api/items', (_req, res) => { save([]); res.json({ ok: true }) })

// Import rows of raw strings. The server re-validates everything: it is the source of truth.
// Valid rows are saved; invalid rows are returned with reasons. Partial import is intentional.
app.post('/api/import', (req, res) => {
  const rows = req.body?.rows
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'Body must be { rows: [...] }' })
  const existing = load()
  const results = validateRows(rows, new Set(existing.map((i) => i.sku)))
  const imported = []
  const rejected = []
  results.forEach((r, i) => {
    if (r.valid) imported.push({ ...r.item, imported_at: new Date().toISOString() })
    else rejected.push({ index: i, sku: rows[i].sku, errors: r.errors })
  })
  save([...existing, ...imported])
  res.json({ imported: imported.map((i) => i.sku), rejected, total: rows.length })
})


// ---- AI suggestions for rows that still have errors ----
const AI_MODEL = process.env.AI_MODEL || 'openrouter/auto'
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
  const rows = req.body?.rows
  if (!Array.isArray(rows)) return res.status(400).json({ error: 'Body must be { rows: [{ index, row, errors }] }' })
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

app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`))
