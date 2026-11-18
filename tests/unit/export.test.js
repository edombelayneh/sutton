// Export: canonical JSON and the brief's CSV encoding.
import { describe, it, expect } from 'vitest'
import Papa from 'papaparse'
import { FIELD_KEYS, validateRows, applyMapping, autoMapHeaders } from '../../shared/schema.js'
import { toCanonical, itemsToCsv, itemsToJson } from '../../shared/export.js'
import { loadSample } from '../samples.js'

const items = validateRows(loadSample('items_clean.csv')).map((r) => r.item)
const stored = items.map((it) => ({ ...it, batch: 'b1', imported_at: '2026-01-01T00:00:00.000Z', imported_by: { id: 1, name: 'X' } }))

describe('JSON export', () => {
  it('is the canonical shape: schema fields only, nested objects and arrays', () => {
    const out = JSON.parse(itemsToJson(stored))
    expect(out).toHaveLength(25)
    expect(out.every((o) => Object.keys(o).every((k) => FIELD_KEYS.includes(k)))).toBe(true)
    const full = out.find((o) => o.vendors && o.dimensions && o.tags)
    expect(Array.isArray(full.vendors) && Array.isArray(full.tags) && typeof full.dimensions === 'object').toBe(true)
    expect(typeof full.unit_cost).toBe('number')
  })
})

describe('CSV export', () => {
  it('uses the brief\'s encoding: schema columns, ";" tags, true/false, JSON cells', () => {
    const p = Papa.parse(itemsToCsv(stored), { header: true })
    expect(p.meta.fields).toEqual(FIELD_KEYS)
    const row = p.data.find((r) => r.tags.includes(';'))
    expect(row.is_active).toMatch(/^(true|false)$/)
    expect(() => JSON.parse(p.data.find((r) => r.vendors).vendors)).not.toThrow()
  })

  it('round-trips: re-importing the exported CSV gives back exactly the same items', () => {
    const p = Papa.parse(itemsToCsv(stored), { header: true, skipEmptyLines: 'greedy' })
    const mapping = autoMapHeaders(p.meta.fields)
    const again = validateRows(p.data.map((r) => applyMapping(r, mapping)))
    expect(again.every((r) => r.valid)).toBe(true)
    expect(again.map((r) => r.item)).toEqual(items.map(toCanonical))
  })

  it('neutralizes spreadsheet formulas in text cells', () => {
    const csv = itemsToCsv([{ ...items[0], name: '=HYPERLINK("x")', description: '@SUM(1)' }])
    const row = Papa.parse(csv, { header: true }).data[0]
    expect(row.name).toBe(`'=HYPERLINK("x")`)
    expect(row.description).toBe(`'@SUM(1)`)
  })
})
