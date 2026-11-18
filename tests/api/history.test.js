// Upload history and "restore to before this upload".
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { startServer, signedIn, resetData, loadSample, pool } from '../helpers.js'

let server, api
const clean = loadSample('items_clean.csv')
const messy = loadSample('items_messy.csv')
// Items without updated_at, sorted: what "exactly the same inventory" means.
const snapshot = async () => JSON.stringify((await api('GET', '/items')).data.map(({ updated_at: _ignored, ...i }) => i).sort((x, y) => x.sku.localeCompare(y.sku)))

beforeAll(async () => { server = await startServer(); api = await signedIn(server.base) })
beforeEach(resetData)
afterAll(async () => { await server.close(); await pool.end() })

describe('undo an import (results page)', () => {
  it('undoing an update restores the previous version and its upload', async () => {
    await api('POST', '/import', { rows: clean.slice(0, 3) })
    const before = (await api('GET', '/items')).data.find((i) => i.sku === clean[0].sku)
    const upd = await api('POST', '/import', { rows: [{ ...clean[0], quantity_on_hand: '999' }], updates: [clean[0].sku] })
    const undo = await api('POST', `/import/${upd.data.batch}/undo`)
    expect(undo.data).toMatchObject({ uploadsUndone: 1, changesUndone: 1 })
    const now = (await api('GET', '/items')).data.find((i) => i.sku === clean[0].sku)
    expect(now.quantity_on_hand).toBe(before.quantity_on_hand)
    expect(now.batch).toBe(before.batch)
    expect((await api('POST', `/import/${upd.data.batch}/undo`)).status).toBe(404)
  })

  it('undoing the first import empties the inventory, including later edits and deletes', async () => {
    const imp = await api('POST', '/import', { rows: messy })
    const [a, b] = (await api('GET', '/items')).data
    await api('PUT', `/items/${a.sku}`, { row: { ...messy.find((r) => r.sku.trim() === a.sku), name: 'Edited' } })
    await api('DELETE', `/items/${b.sku}`)
    expect((await api('POST', `/import/${imp.data.batch}/undo`)).status).toBe(200)
    expect((await api('GET', '/items')).data).toHaveLength(0)
    expect((await api('GET', '/batches')).data).toHaveLength(0)
  })
})

describe('restore to before an upload', () => {
  it('3 uploads + edit + delete + rename, restore to before upload 2 -> exactly as after upload 1', async () => {
    const u1 = await api('POST', '/import', { rows: clean.slice(0, 10), files: ['first.csv'] })
    const afterUpload1 = await snapshot()
    const u2 = await api('POST', '/import', {
      rows: [...clean.slice(5, 10).map((r) => ({ ...r, quantity_on_hand: '777' })), ...clean.slice(10, 15)],
      updates: clean.slice(5, 10).map((r) => r.sku), files: ['second.csv', 'extra.xlsx'],
    })
    expect(u2.data.updated).toBe(5)
    expect(u2.data.imported).toHaveLength(10)
    await api('PUT', `/items/${clean[0].sku}`, { row: { ...clean[0], name: 'Edited after upload 2' } })
    await api('DELETE', `/items/${clean[1].sku}`)
    expect((await api('PUT', `/items/${clean[2].sku}`, { row: { ...clean[2], sku: 'ZZZZ-999' } })).status).toBe(200)
    await api('POST', '/import', { rows: clean.slice(15, 20), files: ['third.csv'] })

    const hist = (await api('GET', '/batches')).data
    expect(hist.map((h) => h.files[0])).toEqual(['third.csv', 'second.csv', 'first.csv'])
    expect(hist.find((h) => h.id === u2.data.batch)).toMatchObject({
      added: 5, updated: 5, later_uploads: 1, later_edits: 3, files: ['second.csv', 'extra.xlsx'], // a rename counts as one edit
    })

    const back = await api('POST', `/batches/${u2.data.batch}/restore`)
    expect(back.data.uploadsUndone).toBe(2)
    expect(await snapshot()).toBe(afterUpload1)
    expect((await api('GET', '/batches')).data.map((h) => h.id)).toEqual([u1.data.batch])
    expect((await api('POST', `/batches/${u2.data.batch}/restore`)).status).toBe(404)

    // Work continues normally afterwards
    const u4 = await api('POST', '/import', { rows: clean.slice(10, 12), files: ['fourth.csv'] })
    expect(u4.data.imported).toHaveLength(2)
    expect((await api('GET', '/batches')).data).toHaveLength(2)
  })

  // Regression: items from an upload with no change-log record (made before the log existed) were left behind.
  it('regression: deletes an upload\'s items even when the change log has no record of them', async () => {
    await pool.query("INSERT INTO import_batches (id, imported_at) VALUES ('legacy1', now())")
    for (const r of clean.slice(0, 3))
      await pool.query("INSERT INTO items (sku, name, category, uom, unit_cost, batch_id) VALUES ($1, 'Legacy', 'RAW', 'EA', 1, 'legacy1')", [r.sku])
    expect((await api('GET', '/items')).data).toHaveLength(3)
    expect((await api('POST', '/batches/legacy1/restore')).status).toBe(200)
    expect((await api('GET', '/items')).data).toHaveLength(0)
  })
})
