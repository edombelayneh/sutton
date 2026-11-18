// Export items exactly as the brief defines them, so the admin can check what got in
// (and an exported CSV can be imported again unchanged).
//  - JSON: the canonical shape, nested objects and arrays, schema fields only.
//  - CSV: the brief's encoding. Tags joined with ";", booleans true/false, dimensions and vendors as JSON
//    in one cell, empty cell = not provided.
import Papa from 'papaparse'
import { FIELD_KEYS } from './schema.js'

/** Only the schema's fields, in schema order (drops batch, imported_at, imported_by, …). */
export function toCanonical(item) {
  const out = {}
  for (const k of FIELD_KEYS) if (item[k] !== undefined && item[k] !== null) out[k] = item[k]
  return out
}

/** One item as CSV cell strings. */
export function toCsvRecord(item) {
  const c = toCanonical(item)
  const cell = (k) => {
    const v = c[k]
    if (v === undefined) return ''
    if (k === 'tags') return v.join(';')
    if (k === 'dimensions' || k === 'vendors') return JSON.stringify(v)
    return String(v)
  }
  return Object.fromEntries(FIELD_KEYS.map((k) => [k, cell(k)]))
}

// A cell starting with = + - @ (or tab/CR) can run as a formula when opened in Excel. Neutralize it with a leading '.
const FORMULA = /^[=+\-@\t\r]/
const TEXT_FIELDS = new Set(['name', 'description'])

export function itemsToCsv(items) {
  const rows = items.map((it) => {
    const r = toCsvRecord(it)
    return FIELD_KEYS.map((k) => (TEXT_FIELDS.has(k) && FORMULA.test(r[k]) ? `'${r[k]}` : r[k]))
  })
  return Papa.unparse({ fields: FIELD_KEYS, data: rows })
}

export const itemsToJson = (items) => JSON.stringify(items.map(toCanonical), null, 2)
