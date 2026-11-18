// Shared item schema: field definitions, header auto-mapping, and validation.
// Used by the browser (instant feedback) and the server (source of truth on import).

export const CATEGORIES = ['RAW', 'COMP', 'FG', 'PKG', 'CONS']
export const UOMS = ['EA', 'BX', 'KG', 'M', 'L']
const SKU_RE = /^[A-Z]{4}-[A-Z0-9]{3}$/
const DECIMAL_RE = /^\d+(\.\d{1,4})?$/
const INT_RE = /^\d+$/
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export const FIELDS = [
  { key: 'sku', label: 'SKU', required: true, aliases: ['sku', 'item sku', 'item code', 'part number', 'part no', 'code'] },
  { key: 'name', label: 'Name', required: true, aliases: ['name', 'item name', 'product name', 'title', 'item'] },
  { key: 'description', label: 'Description', aliases: ['description', 'desc', 'details'] },
  { key: 'category', label: 'Category', required: true, aliases: ['category', 'cat', 'type', 'item type'] },
  { key: 'uom', label: 'Unit of measure', required: true, aliases: ['uom', 'unit of measure', 'unit', 'units'] },
  { key: 'unit_cost', label: 'Unit cost', required: true, aliases: ['unit cost', 'cost', 'price', 'unit price'] },
  { key: 'quantity_on_hand', label: 'Qty on hand', aliases: ['quantity on hand', 'qty on hand', 'qty', 'quantity', 'on hand', 'stock'] },
  { key: 'reorder_point', label: 'Reorder point', aliases: ['reorder point', 'reorder pt', 'reorder', 'min qty', 'reorder level'] },
  { key: 'is_active', label: 'Active', aliases: ['is active', 'active', 'enabled', 'status'] },
  { key: 'lot_tracked', label: 'Lot tracked', aliases: ['lot tracked', 'lot tracking', 'lot', 'tracked'] },
  { key: 'tags', label: 'Tags', aliases: ['tags', 'tag', 'labels', 'keywords'] },
  { key: 'first_received_on', label: 'First received', aliases: ['first received on', 'first received', 'received on', 'received date', 'first received date'] },
  { key: 'discontinued_on', label: 'Discontinued on', aliases: ['discontinued on', 'discontinued', 'discontinued date', 'end date'] },
  { key: 'dimensions', label: 'Dimensions (JSON)', aliases: ['dimensions', 'dims', 'size'] },
  { key: 'vendors', label: 'Vendors (JSON)', aliases: ['vendors', 'suppliers', 'vendor', 'supplier'] },
]
export const FIELD_KEYS = FIELDS.map((f) => f.key)

// "Unit Cost ($)" -> "unit cost", "SKU " -> "sku", "Active?" -> "active"
export const normalizeHeader = (h) =>
  String(h ?? '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[_\-]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

/** Map file headers -> field keys. Returns { [header]: fieldKey | null } */
export function autoMapHeaders(headers) {
  const used = new Set()
  const mapping = {}
  for (const h of headers) {
    const n = normalizeHeader(h)
    const field = FIELDS.find((f) => !used.has(f.key) && (f.key.replace(/_/g, ' ') === n || f.aliases.includes(n)))
    mapping[h] = field ? field.key : null
    if (field) used.add(field.key)
  }
  return mapping
}

// ---- Multiple files ----
// "SKU", "SKU " and "sku" in different files are the same column. Grouping is deliberately
// gentler than normalizeHeader, so "Size (cm)" and "Size (in)" stay separate columns.
export const columnKey = (h) => String(h ?? '').trim().toLowerCase().replace(/[\s_\-]+/g, ' ')

/**
 * Combine parsed files into one batch with one column per header variant group.
 * files: [{ name, fields: [header], data: [row] }]
 * Returns { columns: [{ name, files: [fileName], variants: [header] }], rows: [{ [column.name]: value, __file }] }
 */
export function combineFiles(files) {
  const columns = []
  const byKey = new Map()
  const rows = []
  for (const { name, fields, data } of files) {
    const rename = {} // this file's header -> column name
    const taken = new Set() // column names already claimed in this file
    for (const h of fields || []) {
      if (h === '' || h == null) continue
      const k = columnKey(h)
      let col = byKey.get(k)
      // Same file has two headers that look alike (e.g. "SKU" and "sku "): keep them apart.
      if (col && taken.has(col.name)) col = null
      if (!col) {
        let display = String(h).trim() || String(h)
        while (columns.some((c) => c.name === display)) display += ' ' // unique display name
        col = { name: display, files: [], variants: [] }
        columns.push(col)
        if (!byKey.has(k)) byKey.set(k, col)
      }
      if (!col.files.includes(name)) col.files.push(name)
      if (!col.variants.includes(h)) col.variants.push(h)
      rename[h] = col.name
      taken.add(col.name)
    }
    for (const r of data) {
      const out = { __file: name }
      for (const [h, v] of Object.entries(r)) if (rename[h] !== undefined) out[rename[h]] = v
      rows.push(out)
    }
  }
  return { columns, rows }
}

/** Two columns may map to the same field only if no file contains both. */
export function canMapColumn(mapping, columns, colName, field) {
  if (!field) return true
  const mine = columns.find((c) => c.name === colName)?.files || []
  return !columns.some((c) => c.name !== colName && mapping[c.name] === field && c.files.some((f) => mine.includes(f)))
}

/** Auto-map each file on its own (so every file can claim SKU etc.), then merge. */
export function autoMapColumns(columns) {
  const mapping = Object.fromEntries(columns.map((c) => [c.name, null]))
  const fileNames = [...new Set(columns.flatMap((c) => c.files))]
  for (const file of fileNames) {
    const cols = columns.filter((c) => c.files.includes(file))
    const auto = autoMapHeaders(cols.map((c) => c.name))
    for (const c of cols) {
      if (mapping[c.name] || !auto[c.name]) continue
      if (canMapColumn(mapping, columns, c.name, auto[c.name])) mapping[c.name] = auto[c.name]
    }
  }
  return mapping
}

const shareFile = (a, b) => a.files.some((f) => b.files.includes(f))

/**
 * Merge columns into one. pairs: [{ keep, drop, by: 'match' | 'ai', why }].
 * A pair is skipped if both columns appear in the same file (that would mix two real columns).
 * Returns new { columns, rows, mapping }; every row's value moves to the kept column's name.
 */
export function mergeColumns(columns, rows, mapping, pairs) {
  let cols = columns.map((c) => ({ ...c, files: [...c.files], variants: [...c.variants], merged: [...(c.merged || [])] }))
  const map = { ...mapping }
  const renames = {} // dropped column name -> kept column name
  const find = (n) => { while (renames[n]) n = renames[n]; return n }
  for (const { keep, drop, by, why } of pairs) {
    const k = cols.find((c) => c.name === find(keep))
    const d = cols.find((c) => c.name === find(drop))
    if (!k || !d || k === d || shareFile(k, d)) continue
    k.files.push(...d.files)
    for (const v of d.variants) if (!k.variants.includes(v)) k.variants.push(v)
    k.merged.push({ name: d.name, files: d.files, by, why: why || '' }, ...d.merged)
    if (!map[k.name] && map[d.name]) map[k.name] = map[d.name]
    delete map[d.name]
    renames[d.name] = k.name
    cols = cols.filter((c) => c !== d)
  }
  if (!Object.keys(renames).length) return { columns, rows, mapping }
  const out = rows.map((r) => {
    const o = {}
    for (const [h, v] of Object.entries(r)) o[h === '__file' ? h : find(h)] = v
    return o
  })
  return { columns: cols, rows: out, mapping: map }
}

/** Columns from different files that map to the same field are the same column: merge them. */
export function mergeByField(columns, rows, mapping) {
  const pairs = []
  for (const key of FIELD_KEYS) {
    const same = columns.filter((c) => mapping[c.name] === key)
    for (const c of same.slice(1)) pairs.push({ keep: same[0].name, drop: c.name, by: 'match', why: `both are ${key}` })
  }
  return mergeColumns(columns, rows, mapping, pairs)
}

/** Turn a parsed CSV row into { fieldKey: rawString } using the mapping. */
export function applyMapping(row, mapping) {
  const raw = {}
  for (const key of FIELD_KEYS) raw[key] = ''
  // Only use columns this row actually has, so a column from another file can't blank out the value.
  for (const [header, key] of Object.entries(mapping)) if (key && row[header] !== undefined && raw[key] === '') raw[key] = row[header] ?? ''
  return raw
}

const isValidDate = (s) => {
  if (!DATE_RE.test(s)) return false
  const d = new Date(s + 'T00:00:00Z')
  return !isNaN(d) && d.toISOString().slice(0, 10) === s
}

const parseBool = (s) => (s === 'true' ? true : s === 'false' ? false : undefined)

/**
 * Validate one row of raw strings (exact CSV encoding rules, no guessing).
 * Returns { item, errors } where errors is { fieldKey: message }.
 */
export function parseRow(raw) {
  const errors = {}
  const item = {}
  const v = (k) => String(raw[k] ?? '')
  const empty = (k) => v(k).trim() === ''

  // sku
  if (empty('sku')) errors.sku = 'SKU is required'
  else if (!SKU_RE.test(v('sku'))) errors.sku = 'Must look like ABCD-1X2 (4 capital letters, dash, 3 letters/digits)'
  else item.sku = v('sku')

  // name
  const name = v('name').trim()
  if (!name) errors.name = 'Name is required'
  else if (name.length > 120) errors.name = `Name is ${name.length} characters (max 120)`
  else item.name = name

  if (!empty('description')) item.description = v('description')

  for (const [k, list] of [['category', CATEGORIES], ['uom', UOMS]]) {
    if (empty(k)) errors[k] = `${k === 'uom' ? 'Unit of measure' : 'Category'} is required`
    else if (!list.includes(v(k))) errors[k] = `Must be one of ${list.join(', ')}`
    else item[k] = v(k)
  }

  // unit_cost
  if (empty('unit_cost')) errors.unit_cost = 'Unit cost is required'
  else if (!DECIMAL_RE.test(v('unit_cost'))) errors.unit_cost = 'Must be a number ≥ 0 with up to 4 decimals (e.g. 12.5)'
  else item.unit_cost = Number(v('unit_cost'))

  // integers
  for (const k of ['quantity_on_hand', 'reorder_point']) {
    if (empty(k)) continue
    if (!INT_RE.test(v(k))) errors[k] = 'Must be a whole number ≥ 0'
    else item[k] = Number(v(k))
  }
  if (item.quantity_on_hand === undefined && !errors.quantity_on_hand) item.quantity_on_hand = 0

  // booleans
  for (const [k, def] of [['is_active', true], ['lot_tracked', false]]) {
    if (empty(k)) { item[k] = def; continue }
    const b = parseBool(v(k))
    if (b === undefined) errors[k] = 'Must be true or false'
    else item[k] = b
  }

  // tags
  if (!empty('tags')) {
    const tags = v('tags').split(';').map((t) => t.trim()).filter(Boolean)
    if (tags.some((t) => /[A-Z]/.test(t))) errors.tags = 'Tags must be lowercase'
    else if (new Set(tags).size !== tags.length) errors.tags = 'Tags must be unique'
    else if (tags.length) item.tags = tags
  }

  // dates
  for (const k of ['first_received_on', 'discontinued_on']) {
    if (empty(k)) continue
    if (!isValidDate(v(k))) errors[k] = 'Must be a real date as YYYY-MM-DD'
    else item[k] = v(k)
  }
  if (item.discontinued_on && item.is_active === true)
    errors.is_active = 'Discontinued items must have Active = false'

  // dimensions
  if (!empty('dimensions')) {
    let d
    try { d = JSON.parse(v('dimensions')) } catch { errors.dimensions = 'Not valid JSON' }
    if (d !== undefined) {
      const err = checkDimensions(d)
      if (err) errors.dimensions = err
      else item.dimensions = { length: d.length, width: d.width, height: d.height, unit: d.unit ?? 'cm' }
    }
  }

  // vendors
  if (!empty('vendors')) {
    let arr
    try { arr = JSON.parse(v('vendors')) } catch { errors.vendors = 'Not valid JSON' }
    if (arr !== undefined) {
      const err = checkVendors(arr)
      if (err) errors.vendors = err
      else item.vendors = arr
    }
  }

  return { item, errors }
}

function checkDimensions(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'Must be an object {length, width, height, unit}'
  const extra = Object.keys(d).filter((k) => !['length', 'width', 'height', 'unit'].includes(k))
  if (extra.length) return `Unknown keys: ${extra.join(', ')}`
  const missing = ['length', 'width', 'height'].filter((k) => d[k] === undefined || d[k] === null)
  if (missing.length) return `Missing ${missing.join(', ')} (give all three together)`
  for (const k of ['length', 'width', 'height'])
    if (typeof d[k] !== 'number' || !(d[k] > 0)) return `${k} must be a number greater than 0`
  if (d.unit !== undefined && !['cm', 'in'].includes(d.unit)) return 'unit must be cm or in'
  return null
}

const is4dp = (n) => typeof n === 'number' && n >= 0 && DECIMAL_RE.test(String(n))

function checkVendors(arr) {
  if (!Array.isArray(arr)) return 'Must be a JSON array of vendors'
  if (arr.length > 3) return `Has ${arr.length} vendors (max 3)`
  const allowed = ['vendor_name', 'vendor_sku', 'unit_cost', 'lead_time_days', 'is_preferred']
  for (const [i, x] of arr.entries()) {
    const n = `Vendor ${i + 1}`
    if (!x || typeof x !== 'object' || Array.isArray(x)) return `${n} must be an object`
    const extra = Object.keys(x).filter((k) => !allowed.includes(k))
    if (extra.length) return `${n}: unknown keys ${extra.join(', ')}`
    if (typeof x.vendor_name !== 'string' || !x.vendor_name.trim()) return `${n}: vendor_name is required`
    if (x.vendor_sku !== undefined && typeof x.vendor_sku !== 'string') return `${n}: vendor_sku must be text`
    if (!is4dp(x.unit_cost)) return `${n}: unit_cost must be a number ≥ 0 (max 4 decimals)`
    if (x.lead_time_days !== undefined && !(Number.isInteger(x.lead_time_days) && x.lead_time_days >= 0))
      return `${n}: lead_time_days must be a whole number ≥ 0`
    if (x.is_preferred !== undefined && typeof x.is_preferred !== 'boolean') return `${n}: is_preferred must be true/false`
  }
  if (arr.filter((x) => x.is_preferred).length > 1) return 'Only one vendor can be preferred'
  return null
}

/**
 * Validate all rows, including cross-row rules.
 * existingSkus: Set of SKUs already in the system.
 * Returns [{ item, errors, valid }]
 */
export function validateRows(rawRows, existingSkus = new Set()) {
  const results = rawRows.map(parseRow)
  const counts = {}
  for (const r of results) if (r.item.sku) counts[r.item.sku] = (counts[r.item.sku] || 0) + 1
  for (const r of results) {
    const sku = r.item.sku
    if (!sku) continue
    if (existingSkus.has(sku)) r.errors.sku = 'This SKU already exists in the system'
    else if (counts[sku] > 1) r.errors.sku = `Duplicate SKU: appears ${counts[sku]} times in this file`
  }
  return results.map((r) => ({ ...r, valid: Object.keys(r.errors).length === 0 }))
}
