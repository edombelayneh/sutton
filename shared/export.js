// Export items exactly as the brief defines them, so the admin can check what got in
// (and an exported CSV with all item fields can be imported again unchanged).
//  - JSON: the canonical shape, nested objects and arrays.
//  - CSV: the brief's encoding. Tags joined with ";", booleans true/false, dimensions and vendors as JSON
//    in one cell, empty cell = not provided.
// The caller picks which columns: any schema field, plus audit columns (who/when) that aren't in the schema.
import Papa from 'papaparse'
import { FIELDS, FIELD_KEYS } from './schema.js'

const person = (p) => (p ? `${p.name} (${p.employee_id})` : '')
/** Columns outside the schema: who imported/edited and when. */
export const AUDIT_COLUMNS = [
  { key: 'imported_by', label: 'Imported by', csv: (it) => person(it.imported_by), json: (it) => it.imported_by && { employee_id: it.imported_by.employee_id, name: it.imported_by.name } },
  { key: 'imported_at', label: 'Imported at', csv: (it) => it.imported_at ?? '', json: (it) => it.imported_at },
  { key: 'updated_by', label: 'Last edited by', csv: (it) => person(it.updated_by), json: (it) => it.updated_by && { employee_id: it.updated_by.employee_id, name: it.updated_by.name } },
  { key: 'updated_at', label: 'Last edited at', csv: (it) => it.updated_at ?? '', json: (it) => it.updated_at },
]
const AUDIT = Object.fromEntries(AUDIT_COLUMNS.map((c) => [c.key, c]))
export const EXPORT_COLUMNS = [...FIELDS.map((f) => ({ key: f.key, label: f.label, required: Boolean(f.required) })), ...AUDIT_COLUMNS]
/** Fields an import needs. If any is left out, the exported file can't be imported back as is. */
export const REQUIRED_KEYS = FIELDS.filter((f) => f.required).map((f) => f.key)

// Keep the order of EXPORT_COLUMNS whatever order the caller lists them in; ignore unknown keys.
// Anything that isn't a list means "all schema fields" (e.g. items.map(toCanonical) passes the index here).
const ordered = (columns) => {
  const pick = Array.isArray(columns) ? columns : FIELD_KEYS
  return EXPORT_COLUMNS.map((c) => c.key).filter((k) => pick.includes(k))
}

/** Only the chosen fields (schema fields by default), in a fixed order. Drops batch and other internals. */
export function toCanonical(item, columns = FIELD_KEYS) {
  const out = {}
  for (const k of ordered(columns)) {
    const v = AUDIT[k] ? AUDIT[k].json(item) : item[k]
    if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

/** One item as CSV cell strings. */
export function toCsvRecord(item, columns = FIELD_KEYS) {
  const cell = (k) => {
    if (AUDIT[k]) return AUDIT[k].csv(item)
    const v = item[k]
    if (v === undefined || v === null) return ''
    if (k === 'tags') return v.join(';')
    if (k === 'dimensions' || k === 'vendors') return JSON.stringify(v)
    return String(v)
  }
  return Object.fromEntries(ordered(columns).map((k) => [k, cell(k)]))
}

// A cell starting with = + - @ (or tab/CR) can run as a formula when opened in Excel. Neutralize it with a leading '.
const FORMULA = /^[=+\-@\t\r]/
const TEXT_FIELDS = new Set(['name', 'description', 'imported_by', 'updated_by'])

export function itemsToCsv(items, columns = FIELD_KEYS) {
  const keys = ordered(columns)
  const rows = items.map((it) => {
    const r = toCsvRecord(it, keys)
    return keys.map((k) => (TEXT_FIELDS.has(k) && FORMULA.test(r[k]) ? `'${r[k]}` : r[k]))
  })
  return Papa.unparse({ fields: keys, data: rows })
}

export const itemsToJson = (items, columns = FIELD_KEYS) => JSON.stringify(items.map((it) => toCanonical(it, columns)), null, 2)
