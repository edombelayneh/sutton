// Import, update, edit, delete, clear: the core item API against a real (test) PostgreSQL.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { startServer, signedIn, resetData, loadSample, pool } from '../helpers.js'
import Papa from 'papaparse'
import { autoMapHeaders, applyMapping } from '../../shared/schema.js'
import { itemsToCsv, toCanonical } from '../../shared/export.js'

let server, api
const messy = loadSample('items_messy.csv')
const clean = loadSample('items_clean.csv')
const items = async () => (await api('GET', '/items')).data
const bySku = (sku) => messy.find((r) => r.sku.trim() === sku)

beforeAll(async () => { server = await startServer(); api = await signedIn(server.base) })
beforeEach(resetData)
afterAll(async () => { await server.close(); await pool.end() })

describe('import', () => {
  it('imports valid rows and rejects invalid ones with reasons (partial import)', async () => {
    const { status, data } = await api('POST', '/import', { rows: messy })
    expect(status).toBe(200)
    expect(data.total).toBe(200)
    expect(data.imported).toHaveLength(165)
    expect(data.rejected).toHaveLength(35)
    expect(data.rejected[0].errors).toBeTypeOf('object')
    expect(await items()).toHaveLength(165)
  })

  it('returns items in the app\'s shape: numbers, YYYY-MM-DD dates, arrays, no nulls', async () => {
    const { data } = await api('POST', '/import', { rows: messy })
    const list = await items()
    const full = list.find((i) => i.tags && i.vendors && i.first_received_on)
    expect(full.unit_cost).toBeTypeOf('number')
    expect(full.first_received_on).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Array.isArray(full.tags) && Array.isArray(full.vendors)).toBe(true)
    expect(full.batch).toBe(data.batch)
    expect(list.every((i) => Object.values(i).every((v) => v !== null))).toBe(true)
    expect(list.some((i) => !('description' in i))).toBe(true)
  })

  it('rejects malformed bodies and non-object rows without crashing', async () => {
    expect((await api('POST', '/import', { nope: 1 })).status).toBe(400)
    const { data } = await api('POST', '/import', { rows: [null, 'x', [1]] })
    expect(data.imported).toHaveLength(0)
    expect(data.rejected).toHaveLength(3)
  })

  it('rejects an existing SKU unless the user chose to update it', async () => {
    await api('POST', '/import', { rows: clean.slice(0, 3) })
    const again = await api('POST', '/import', { rows: [{ ...clean[0], quantity_on_hand: '999' }] })
    expect(again.data.imported).toHaveLength(0)
    expect(again.data.rejected).toHaveLength(1)
    const upd = await api('POST', '/import', { rows: [{ ...clean[0], quantity_on_hand: '999' }], updates: [clean[0].sku] })
    expect(upd.data.updated).toBe(1)
    expect((await items()).find((i) => i.sku === clean[0].sku).quantity_on_hand).toBe(999)
  })

  it('only one of two simultaneous imports of the same new SKU gets in', async () => {
    const [a, b] = await Promise.all([api('POST', '/import', { rows: [clean[0]] }), api('POST', '/import', { rows: [clean[0]] })])
    expect(a.data.imported.length + b.data.imported.length).toBe(1)
    expect(await items()).toHaveLength(1)
  })
})

describe('edit and delete', () => {
  let a, b
  beforeEach(async () => {
    await api('POST', '/import', { rows: messy })
    ;[a, b] = await items()
  })

  it('edit is re-validated, sets updated_at and detaches from its import', async () => {
    const ed = await api('PUT', `/items/${a.sku}`, { row: { ...bySku(a.sku), name: 'Renamed by test' } })
    expect(ed.status).toBe(200)
    expect(ed.data).toMatchObject({ name: 'Renamed by test' })
    expect(ed.data.updated_at).toBeTruthy()
    expect(ed.data.batch).toBeUndefined()
  })

  it('invalid edit -> 400 with field errors; renaming onto an existing SKU -> 409', async () => {
    const bad = await api('PUT', `/items/${a.sku}`, { row: { ...bySku(a.sku), unit_cost: 'abc' } })
    expect(bad.status).toBe(400)
    expect(bad.data.errors.unit_cost).toBeTruthy()
    expect((await api('PUT', `/items/${a.sku}`, { row: { ...bySku(a.sku), sku: b.sku } })).status).toBe(409)
  })

  it('delete removes one item; deleting again -> 404; editing a missing item -> 404', async () => {
    expect((await api('DELETE', `/items/${b.sku}`)).status).toBe(200)
    expect((await api('DELETE', `/items/${b.sku}`)).status).toBe(404)
    expect((await api('PUT', '/items/ZZZZ-000', { row: { ...bySku(a.sku), sku: 'ZZZZ-000' } })).status).toBe(404)
  })

  it('clear all empties items and upload history', async () => {
    await api('DELETE', '/items')
    expect(await items()).toHaveLength(0)
    expect((await api('GET', '/batches')).data).toHaveLength(0)
  })
})

describe('export what got in', () => {
  it('exported CSV of the stored items re-imports into an empty system as identical items', async () => {
    await api('POST', '/import', { rows: clean })
    const first = await items()
    const csv = itemsToCsv(first)
    await api('DELETE', '/items')
    const p = Papa.parse(csv, { header: true, skipEmptyLines: 'greedy' })
    const mapping = autoMapHeaders(p.meta.fields)
    const again = await api('POST', '/import', { rows: p.data.map((r) => applyMapping(r, mapping)) })
    expect(again.data.imported).toHaveLength(25)
    expect((await items()).map(toCanonical)).toEqual(first.map(toCanonical))
  })
})

describe('the database enforces the rules too', () => {
  it.each([
    ['bad SKU format', "('bad', 'X', 'RAW', 'EA', 1)"],
    ['unknown category', "('ABCD-123', 'X', 'NOPE', 'EA', 1)"],
    ['negative cost', "('ABCD-123', 'X', 'RAW', 'EA', -1)"],
  ])('rejects %s', async (_label, values) => {
    await expect(pool.query(`INSERT INTO items (sku, name, category, uom, unit_cost) VALUES ${values}`)).rejects.toThrow(/check constraint/)
  })
  it('rejects discontinued-but-active', async () => {
    await expect(pool.query("INSERT INTO items (sku, name, category, uom, unit_cost, discontinued_on, is_active) VALUES ('ABCD-123', 'X', 'RAW', 'EA', 1, '2024-01-01', true)"))
      .rejects.toThrow(/discontinued_means_inactive/)
  })
})
