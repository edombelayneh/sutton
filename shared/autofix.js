// Safe, deterministic auto-fixes. Each fix only changes a value when the intent is unambiguous
// (or flags the assumption in its reason). Every change is recorded so the user can see and undo it.

import { CATEGORIES, UOMS } from './schema.js'

const CATEGORY_WORDS = {
  'raw': 'RAW', 'raw material': 'RAW', 'raw materials': 'RAW',
  'comp': 'COMP', 'component': 'COMP', 'components': 'COMP',
  'fg': 'FG', 'finished good': 'FG', 'finished goods': 'FG', 'finished': 'FG',
  'pkg': 'PKG', 'packaging': 'PKG', 'package': 'PKG',
  'cons': 'CONS', 'consumable': 'CONS', 'consumables': 'CONS',
}
const UOM_WORDS = {
  'ea': 'EA', 'each': 'EA', 'pc': 'EA', 'pcs': 'EA', 'piece': 'EA', 'pieces': 'EA', 'unit': 'EA', 'units': 'EA',
  'bx': 'BX', 'box': 'BX', 'boxes': 'BX',
  'kg': 'KG', 'kgs': 'KG', 'kilogram': 'KG', 'kilograms': 'KG',
  'm': 'M', 'meter': 'M', 'meters': 'M', 'metre': 'M', 'metres': 'M',
  'l': 'L', 'liter': 'L', 'liters': 'L', 'litre': 'L', 'litres': 'L',
}
const TRUE_WORDS = ['true', 'yes', 'y', '1', 't']
const FALSE_WORDS = ['false', 'no', 'n', '0', 'f']
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']
const pad = (n) => String(n).padStart(2, '0')

function fixDecimal(s) {
  let t = s.trim().replace(/^\$\s*/, '').replace(/\s*(usd)$/i, '').trim()
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return { v: t.replace(/,/g, ''), why: 'Removed thousands separators' }
  if (/^\d+,\d{1,4}$/.test(t)) return { v: t.replace(',', '.'), why: 'Comma decimal → dot decimal' }
  if (t !== s) return { v: t, why: s.includes('$') ? 'Removed $ sign' : 'Trimmed spaces' }
  return null
}

function fixInt(s) {
  const t = s.trim()
  if (/^\d{1,3}(,\d{3})+$/.test(t)) return { v: t.replace(/,/g, ''), why: 'Removed thousands separators' }
  if (/^\d+\.0+$/.test(t)) return { v: t.replace(/\.0+$/, ''), why: 'Whole number written with .0' }
  if (t !== s) return { v: t, why: 'Trimmed spaces' }
  return null
}

function fixBoolLoose(s) {
  if (s === 'true' || s === 'false') return null
  const t = s.trim().toLowerCase()
  if (TRUE_WORDS.includes(t)) return { v: 'true', why: `"${s}" means true` }
  if (FALSE_WORDS.includes(t)) return { v: 'false', why: `"${s}" means false` }
  return null
}

function fixDate(s) {
  const t = s.trim()
  let m
  if ((m = t.match(/^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/)) || (m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/))) {
    const v = `${m[1]}-${pad(m[2])}-${pad(m[3])}`
    return v === s ? null : { v, why: 'Reformatted to YYYY-MM-DD' }
  }
  if ((m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/))) {
    const a = +m[1], b = +m[2]
    if (a > 12 && b <= 12) return { v: `${m[3]}-${pad(b)}-${pad(a)}`, why: 'DD/MM/YYYY → YYYY-MM-DD' }
    if (a <= 12 && b > 12) return { v: `${m[3]}-${pad(a)}-${pad(b)}`, why: 'MM/DD/YYYY → YYYY-MM-DD' }
    return { v: `${m[3]}-${pad(a)}-${pad(b)}`, why: 'Assumed US MM/DD/YYYY. Please double-check', warn: true }
  }
  if ((m = t.match(/^([A-Za-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/))) {
    const mi = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase())
    if (mi >= 0) return { v: `${m[3]}-${pad(mi + 1)}-${pad(m[2])}`, why: 'Month name → YYYY-MM-DD' }
  }
  if ((m = t.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?,?\s+(\d{4})$/))) {
    const mi = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase())
    if (mi >= 0) return { v: `${m[3]}-${pad(mi + 1)}-${pad(m[1])}`, why: 'Month name → YYYY-MM-DD' }
  }
  return t !== s ? { v: t, why: 'Trimmed spaces' } : null
}

function fixEnum(s, list, words, label) {
  const t = s.trim()
  if (list.includes(t)) return t !== s ? { v: t, why: 'Trimmed spaces' } : null
  if (list.includes(t.toUpperCase())) return { v: t.toUpperCase(), why: 'Uppercased' }
  const w = words[t.toLowerCase().replace(/\s+/g, ' ')]
  if (w) return { v: w, why: `"${t}" is ${label} ${w}` }
  return null
}

const FIXERS = {
  sku: (s) => {
    const t = s.trim().toUpperCase().replace(/\s+/g, '').replace(/_/g, '-')
    if (t === s) return null
    return { v: t, why: s.trim() !== s ? 'Trimmed spaces / uppercased' : 'Uppercased' }
  },
  name: (s) => {
    const t = s.trim().replace(/\s+/g, ' ')
    return t !== s ? { v: t, why: 'Trimmed extra spaces' } : null
  },
  category: (s) => fixEnum(s, CATEGORIES, CATEGORY_WORDS, 'category'),
  uom: (s) => fixEnum(s, UOMS, UOM_WORDS, 'unit'),
  unit_cost: fixDecimal,
  quantity_on_hand: fixInt,
  reorder_point: fixInt,
  is_active: fixBoolLoose,
  lot_tracked: fixBoolLoose,
  tags: (s) => {
    const parts = s.split(/[;,|]/).map((x) => x.trim().toLowerCase()).filter(Boolean)
    const t = [...new Set(parts)].join(';')
    return t !== s ? { v: t, why: 'Lowercased, trimmed and de-duplicated tags' } : null
  },
  first_received_on: fixDate,
  discontinued_on: fixDate,
  dimensions: (s) => (s.trim() !== s ? { v: s.trim(), why: 'Trimmed spaces' } : null),
  vendors: (s) => (s.trim() !== s ? { v: s.trim(), why: 'Trimmed spaces' } : null),
}

/**
 * Apply safe fixes to one mapped row.
 * Returns { row, fixes } where fixes is { field: { from, to, why, warn? } }.
 */
export function autoFixRow(raw) {
  const row = { ...raw }
  const fixes = {}
  for (const [k, fn] of Object.entries(FIXERS)) {
    const s = String(row[k] ?? '')
    if (s === '') continue
    const r = fn(s)
    if (r && r.v !== s) {
      row[k] = r.v
      fixes[k] = { from: s, to: r.v, why: r.why, warn: Boolean(r.warn) }
    }
  }
  return { row, fixes }
}

const SKU_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
/** Generate a valid, unique SKU from an item name, e.g. "Fiberglass Hex Bolt" -> "FIBE-7K2". */
export function generateSku(name, taken) {
  let prefix = String(name || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4)
  while (prefix.length < 4) prefix += 'X'
  for (let n = 0; n < 1000; n++) {
    let suffix = ''
    for (let j = 0; j < 3; j++) suffix += SKU_CHARS[Math.floor(Math.random() * SKU_CHARS.length)]
    const sku = `${prefix}-${suffix}`
    if (!taken.has(sku)) return sku
  }
  throw new Error('Could not generate a unique SKU')
}
