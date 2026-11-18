// Export: canonical JSON and the brief's CSV encoding.
import { describe, it, expect } from 'vitest'
import Papa from 'papaparse'
import { FIELD_KEYS, validateRows, applyMapping, autoMapHeaders } from '../../shared/schema.js'
import { toCanonical, itemsToCsv, itemsToJson, EXPORT_COLUMNS, REQUIRED_KEYS } from '../../shared/export.js'
import { loadSample } from '../samples.js'

const items = validateRows(loadSample('items_clean.csv')).map((r) => r.item)
const stored = items.map((it) => ({ ...it, batch: 'b1', imported_at: '2026-01-01T00:00:00.000Z', imported_by: { id: 1, employee_id: 'E1001', name: 'Sean' }, updated_by: { id: 2, employee_id: 'E1003', name: 'Dan' }, updated_at: '2026-02-01T00:00:00.000Z' }))

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

describe('choosing columns', () => {
  it('CSV has only the chosen columns, in schema order whatever order they were picked', () => {
    const p = Papa.parse(itemsToCsv(stored, ['unit_cost', 'sku', 'name']), { header: true })
    expect(p.meta.fields).toEqual(['sku', 'name', 'unit_cost'])
    expect(p.data[0]).toEqual({ sku: items[0].sku, name: items[0].name, unit_cost: String(items[0].unit_cost) })
  })

  it('JSON has only the chosen keys; unknown keys are ignored', () => {
    const out = JSON.parse(itemsToJson(stored, ['tags', 'sku', 'password_hash']))
    expect(out.every((o) => Object.keys(o).every((k) => ['sku', 'tags'].includes(k)))).toBe(true)
    expect(out[0].sku).toBe(items[0].sku)
  })

  it('audit columns: who and when, as "Name (ID)" in CSV and { employee_id, name } in JSON', () => {
    const cols = ['sku', 'imported_by', 'imported_at', 'updated_by', 'updated_at']
    const row = Papa.parse(itemsToCsv(stored, cols), { header: true }).data[0]
    expect(row).toEqual({ sku: items[0].sku, imported_by: 'Sean (E1001)', imported_at: '2026-01-01T00:00:00.000Z', updated_by: 'Dan (E1003)', updated_at: '2026-02-01T00:00:00.000Z' })
    const obj = JSON.parse(itemsToJson(stored, cols))[0]
    expect(obj.imported_by).toEqual({ employee_id: 'E1001', name: 'Sean' })
    expect(obj).not.toHaveProperty('batch')
  })

  it('lists every schema field plus 4 audit columns; required = the brief\'s required fields', () => {
    expect(EXPORT_COLUMNS).toHaveLength(15 + 4)
    expect(REQUIRED_KEYS).toEqual(['sku', 'name', 'category', 'uom', 'unit_cost'])
  })
})
