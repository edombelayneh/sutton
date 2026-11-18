// Who imported / edited / deleted, taken from the session (never from the browser).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startServer, signedIn, resetData, loadSample, pool, T200 } from '../helpers.js'

let server, one, two
const clean = loadSample('items_clean.csv')

beforeAll(async () => {
  server = await startServer()
  await resetData()
  one = await signedIn(server.base) // T100
  two = await signedIn(server.base, T200)
})
afterAll(async () => { await server.close(); await pool.end() })

describe('imported by', () => {
  let u1, u2, edited
  beforeAll(async () => {
    // T100 imports 5 and tries to fake the importer; T200 imports 3 and edits one of T100's items.
    u1 = await one('POST', '/import', { rows: clean.slice(0, 5).map((r) => ({ ...r, imported_by: 999 })), files: ['a.csv'], imported_by: 2 })
    u2 = await two('POST', '/import', { rows: clean.slice(5, 8), files: ['b.csv'] })
    edited = await two('PUT', `/items/${clean[0].sku}`, { row: { ...clean[0], name: 'Edited by two' } })
  })

  it('credits each item to whoever was signed in; values sent by the browser are ignored', async () => {
    const items = (await one('GET', '/items')).data
    expect(items.filter((i) => i.imported_by?.employee_id === 'T100')).toHaveLength(5)
    expect(items.filter((i) => i.imported_by?.employee_id === 'T200')).toHaveLength(3)
    expect(items.find((i) => i.sku === clean[1].sku).imported_by).toEqual({ id: expect.any(Number), employee_id: 'T100', name: 'Test Person' })
  })

  it('an edit keeps the original importer and records the editor', () => {
    expect(edited.data.imported_by.employee_id).toBe('T100')
    expect(edited.data.updated_by.employee_id).toBe('T200')
  })

  it('upload history records who uploaded', async () => {
    const hist = (await one('GET', '/batches')).data
    expect(hist.find((b) => b.id === u1.data.batch).imported_by.employee_id).toBe('T100')
    expect(hist.find((b) => b.id === u2.data.batch).imported_by.employee_id).toBe('T200')
  })

  it('restore keeps who imported, and reverses who edited', async () => {
    await one('POST', `/batches/${u2.data.batch}/restore`)
    const items = (await one('GET', '/items')).data
    expect(items).toHaveLength(5)
    expect(items.every((i) => i.imported_by?.employee_id === 'T100')).toBe(true)
    const first = items.find((i) => i.sku === clean[0].sku)
    expect(first.name).not.toBe('Edited by two')
    expect(first.updated_by).toBeUndefined()
  })

  it('the change log records who made every change', async () => {
    await two('DELETE', `/items/${clean[1].sku}`)
    const { rows } = await pool.query('SELECT c.kind, e.employee_id FROM item_changes c JOIN employees e ON e.id = c.changed_by ORDER BY c.id')
    expect(rows.map((r) => `${r.kind}|${r.employee_id}`)).toEqual([...Array(5).fill('import|T100'), 'delete|T200'])
  })
})
