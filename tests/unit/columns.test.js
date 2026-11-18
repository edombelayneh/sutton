// Column mapping across multiple files: merge by spelling, by field, and by AI's same_as.
import { describe, it, expect } from 'vitest'
import Papa from 'papaparse'
import { combineFiles, autoMapColumns, applyMapping, canMapColumn, mergeColumns, mergeByField } from '../../shared/schema.js'
import { parsedSample } from '../samples.js'

const file = (name, text) => {
  const p = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' })
  return { name, fields: p.meta.fields, data: p.data }
}
const skus = (rows, mapping) => rows.map((r) => applyMapping(r, mapping).sku).join()

describe('combineFiles: same header, different spelling', () => {
  it('merges "SKU", "SKU " and "sku" into one column, and every file keeps its SKU', () => {
    const { columns, rows } = combineFiles([file('a.csv', 'SKU,Name\nAAAA-111,One'), file('b.csv', '"SKU ",name\nBBBB-222,Two'), file('c.csv', 'sku,NAME\nCCCC-333,Three')])
    expect(columns.map((c) => c.name)).toEqual(['SKU', 'Name'])
    expect(skus(rows, autoMapColumns(columns))).toBe('AAAA-111,BBBB-222,CCCC-333')
  })

  it('keeps look-alike headers in the SAME file apart (no data overwritten)', () => {
    const { columns, rows } = combineFiles([file('a.csv', 'SKU,sku \nX,Y')])
    expect(columns).toHaveLength(2)
    expect(rows[0][columns[0].name]).toBe('X')
    expect(rows[0][columns[1].name]).toBe('Y')
  })

  // Regression: before the fix, only the first file's SKU column was mapped, so later files imported with blank SKUs.
  it('regression: the second file\'s rows do not lose their SKU', () => {
    const { columns, rows } = combineFiles([parsedSample('items_messy.csv'), parsedSample('items_clean.csv')])
    const m = autoMapColumns(columns)
    const fromClean = rows.filter((r) => r.__file === 'items_clean.csv')
    expect(fromClean.length).toBeGreaterThan(0)
    expect(fromClean.every((r) => applyMapping(r, m).sku.trim() !== '')).toBe(true)
  })
})

describe('different names for the same field', () => {
  it('maps "SKU" and "Item Code" from different files both to sku, keeping both files\' data', () => {
    const { columns, rows } = combineFiles([file('a.csv', 'SKU,Name\nAAAA-111,One'), file('b.csv', 'Item Code,Item Name\nBBBB-222,Two')])
    const m = autoMapColumns(columns)
    expect(m['SKU']).toBe('sku')
    expect(m['Item Code']).toBe('sku')
    expect(skus(rows, m)).toBe('AAAA-111,BBBB-222')
    expect(rows.map((r) => applyMapping(r, m).name).join()).toBe('One,Two')
  })

  it('mergeByField turns them into one column that lists both names', () => {
    const c = combineFiles([file('a.csv', 'SKU,Name\nAAAA-111,One'), file('b.csv', 'Item Code,Item Name\nBBBB-222,Two')])
    const r = mergeByField(c.columns, c.rows, autoMapColumns(c.columns))
    expect(r.columns).toHaveLength(2)
    expect(r.columns[0].variants).toEqual(['SKU', 'Item Code'])
    expect(skus(r.rows, r.mapping)).toBe('AAAA-111,BBBB-222')
  })

  it('within ONE file, two columns cannot take the same field', () => {
    const { columns } = combineFiles([file('a.csv', 'SKU,Item Code\nX,Y')])
    const m = autoMapColumns(columns)
    expect(m).toEqual({ SKU: 'sku', 'Item Code': null })
    expect(canMapColumn(m, columns, 'Item Code', 'sku')).toBe(false)
  })

  it('a column the aliases miss (Part #) can still be mapped to SKU by hand, and all files then contribute', () => {
    const { columns, rows } = combineFiles([parsedSample('items_messy.csv'), parsedSample('items_clean.csv'), parsedSample('items_odd_headers.csv')])
    const m = autoMapColumns(columns)
    expect(m['Part #']).toBeNull()
    expect(canMapColumn(m, columns, 'Part #', 'sku')).toBe(true)
    m['Part #'] = 'sku'
    const perFile = {}
    for (const r of rows) if (applyMapping(r, m).sku.trim()) perFile[r.__file] = (perFile[r.__file] || 0) + 1
    expect(perFile).toEqual({ 'items_messy.csv': 198, 'items_clean.csv': 25, 'items_odd_headers.csv': 25 })
  })
})

describe('mergeColumns (used for AI "same_as")', () => {
  it('never merges two columns from the same file', () => {
    const c = combineFiles([file('a.csv', 'SKU,Item Code\nX,Y')])
    const r = mergeColumns(c.columns, c.rows, { SKU: 'sku', 'Item Code': null }, [{ keep: 'SKU', drop: 'Item Code', by: 'ai' }])
    expect(r.columns).toHaveLength(2)
  })

  it('merges unmapped columns and their values', () => {
    const c = combineFiles([file('a.csv', 'SKU,Internal Notes\nAAAA-111,fragile'), file('b.csv', 'SKU,Comments\nBBBB-222,heavy')])
    const r = mergeColumns(c.columns, c.rows, autoMapColumns(c.columns), [{ keep: 'Internal Notes', drop: 'Comments', by: 'ai', why: 'notes' }])
    expect(r.columns).toHaveLength(2)
    expect(r.rows.map((x) => x['Internal Notes'])).toEqual(['fragile', 'heavy'])
    expect(r.columns.find((x) => x.name === 'Internal Notes').merged[0]).toMatchObject({ name: 'Comments', by: 'ai' })
  })

  it('follows chains: C into B, then B into A, ends as one column with all values', () => {
    const c = combineFiles([file('a', 'Part #\n1'), file('b', 'Item Code\n2'), file('c', 'Code Num\n3')])
    const r = mergeColumns(c.columns, c.rows, {}, [{ keep: 'Item Code', drop: 'Code Num', by: 'ai' }, { keep: 'Part #', drop: 'Item Code', by: 'ai' }])
    expect(r.columns).toHaveLength(1)
    expect(r.rows.map((x) => x['Part #'])).toEqual(['1', '2', '3'])
  })
})
