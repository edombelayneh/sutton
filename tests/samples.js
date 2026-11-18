// Load sample files the way the browser does. No database needed.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Papa from 'papaparse'
import { combineFiles, autoMapColumns, applyMapping } from '../shared/schema.js'
import { autoFixRow } from '../shared/autofix.js'

const SAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples')
/** Parse a sample file the way the browser does: parse -> map columns -> auto-fix. Returns rows of raw strings. */
export function loadSample(name) {
  const p = Papa.parse(fs.readFileSync(path.join(SAMPLES, name), 'utf8'), { header: true, skipEmptyLines: 'greedy' })
  const c = combineFiles([{ name, fields: p.meta.fields, data: p.data }])
  const mapping = autoMapColumns(c.columns)
  return c.rows.map((r) => autoFixRow(applyMapping(r, mapping)).row)
}
/** Parse a sample into the shape combineFiles takes. */
export function parsedSample(name) {
  const p = Papa.parse(fs.readFileSync(path.join(SAMPLES, name), 'utf8'), { header: true, skipEmptyLines: 'greedy' })
  return { name, fields: p.meta.fields, data: p.data }
}
