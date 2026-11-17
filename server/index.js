import 'dotenv/config'
import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRows } from '../shared/schema.js'

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

app.listen(PORT, () => console.log(`API listening on http://localhost:${PORT}`))
