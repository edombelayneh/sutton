import { useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import { FIELDS, FIELD_KEYS, autoMapHeaders, applyMapping, validateRows } from '../shared/schema.js'
import { autoFixRow, generateSku } from '../shared/autofix.js'

// Rows carry their auto-fix log in `_fixes`; strip it before sending/exporting.
const clean = ({ _fixes, ...r }) => r

const STEPS = ['Upload', 'Map columns', 'Review & fix', 'Results']

export default function App() {
  const [step, setStep] = useState(0)
  const [fileName, setFileName] = useState('')
  const [headers, setHeaders] = useState([])
  const [csvRows, setCsvRows] = useState([])
  const [mapping, setMapping] = useState({})
  const [rows, setRows] = useState([]) // raw strings per field, editable
  const [existingSkus, setExistingSkus] = useState(new Set())
  const [result, setResult] = useState(null)

  const refreshExisting = () =>
    fetch('/api/items').then((r) => r.json()).then((items) => setExistingSkus(new Set(items.map((i) => i.sku))))
  useEffect(() => { refreshExisting() }, [])

  const loadText = (text, name) => {
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' })
    const hs = parsed.meta.fields.filter((h) => h !== '')
    setFileName(name)
    setHeaders(hs)
    setCsvRows(parsed.data)
    setMapping(autoMapHeaders(hs))
    setResult(null)
    setStep(1)
  }

  const confirmMapping = () => {
    setRows(csvRows.map((r) => {
      const { row, fixes } = autoFixRow(applyMapping(r, mapping))
      return { ...row, _fixes: fixes }
    }))
    setStep(2)
  }

  const reset = () => { setStep(0); setResult(null); setRows([]); refreshExisting() }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-800">
      <header className="border-b bg-white">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <h1 className="text-xl font-semibold">Inventory Import</h1>
          <ol className="flex gap-4 text-sm">
            {STEPS.map((s, i) => (
              <li key={s} className={i === step ? 'font-semibold text-blue-600' : i < step ? 'text-slate-600' : 'text-slate-400'}>
                {i + 1}. {s}
              </li>
            ))}
          </ol>
        </div>
      </header>
      <main className="max-w-7xl mx-auto px-6 py-8">
        {step === 0 && <Upload onText={loadText} existingCount={existingSkus.size} />}
        {step === 1 && (
          <MapColumns fileName={fileName} headers={headers} sample={csvRows[0]} mapping={mapping}
            setMapping={setMapping} onBack={() => setStep(0)} onNext={confirmMapping} />
        )}
        {step === 2 && (
          <Review rows={rows} setRows={setRows} existingSkus={existingSkus} onBack={() => setStep(1)}
            onImported={(res, sent) => { setResult({ ...res, sent }); setStep(3); refreshExisting() }} />
        )}
        {step === 3 && result && <Results result={result} onRestart={reset} />}
      </main>
    </div>
  )
}

function Upload({ onText, existingCount }) {
  const [drag, setDrag] = useState(false)
  const readFile = (f) => f && f.text().then((t) => onText(t, f.name))
  const loadSample = (name) => fetch(`/samples/${name}`).then((r) => r.text()).then((t) => onText(t, name))
  return (
    <div className="space-y-6">
      <label
        onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => { e.preventDefault(); setDrag(false); readFile(e.dataTransfer.files[0]) }}
        className={`block border-2 border-dashed rounded-xl p-16 text-center cursor-pointer bg-white ${drag ? 'border-blue-500 bg-blue-50' : 'border-slate-300'}`}
      >
        <input type="file" accept=".csv,text/csv" className="hidden" onChange={(e) => readFile(e.target.files[0])} />
        <p className="text-lg font-medium">Drop your inventory CSV here</p>
        <p className="text-slate-500 mt-1">or click to choose a file</p>
      </label>
      <div className="text-sm text-slate-600 flex gap-3 items-center">
        Try a sample:
        <button className="underline text-blue-600" onClick={() => loadSample('items_clean.csv')}>clean file</button>
        <button className="underline text-blue-600" onClick={() => loadSample('items_messy.csv')}>messy file</button>
        <span className="ml-auto">{existingCount} items already in the system</span>
      </div>
    </div>
  )
}

function MapColumns({ fileName, headers, sample, mapping, setMapping, onBack, onNext }) {
  const used = Object.values(mapping).filter(Boolean)
  const missingRequired = FIELDS.filter((f) => f.required && !used.includes(f.key))
  return (
    <div className="space-y-4">
      <h2 className="text-lg font-semibold">Map the columns in <span className="font-mono">{fileName}</span></h2>
      <p className="text-slate-600 text-sm">We matched your columns automatically. Change any that look wrong.</p>
      <table className="w-full bg-white rounded-lg shadow-sm text-sm">
        <thead className="text-left text-slate-500"><tr><th className="p-3">Your column</th><th className="p-3">Example value</th><th className="p-3">Imports as</th></tr></thead>
        <tbody>
          {headers.map((h) => (
            <tr key={h} className="border-t">
              <td className="p-3 font-mono">{h}</td>
              <td className="p-3 text-slate-500 truncate max-w-xs">{String(sample?.[h] ?? '').slice(0, 60)}</td>
              <td className="p-3">
                <select className="border rounded px-2 py-1" value={mapping[h] ?? ''}
                  onChange={(e) => setMapping({ ...mapping, [h]: e.target.value || null })}>
                  <option value="">— Don't import —</option>
                  {FIELDS.map((f) => (
                    <option key={f.key} value={f.key} disabled={used.includes(f.key) && mapping[h] !== f.key}>
                      {f.label}{f.required ? ' *' : ''}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {missingRequired.length > 0 && (
        <p className="text-amber-700 text-sm">Required fields not mapped: {missingRequired.map((f) => f.label).join(', ')}. Those rows will need values in the next step.</p>
      )}
      <div className="flex gap-3">
        <button className="px-4 py-2 rounded border" onClick={onBack}>Back</button>
        <button className="px-4 py-2 rounded bg-blue-600 text-white" onClick={onNext}>Continue</button>
      </div>
    </div>
  )
}

function Review({ rows, setRows, existingSkus, onBack, onImported }) {
  const [filter, setFilter] = useState('errors')
  const [busy, setBusy] = useState(false)
  // Rows the user has edited stay visible in "Needs attention" until they re-click the filter,
  // so a row doesn't vanish mid-typing the moment it becomes valid.
  const [touched, setTouched] = useState(new Set())
  const results = useMemo(() => validateRows(rows, existingSkus), [rows, existingSkus])

  // A fix is "active" while the cell still holds the fixed value; "pending" until the user keeps it.
  const activeFixes = (row) => Object.entries(row._fixes || {}).filter(([k, f]) => row[k] === f.to)
  const pendingFixes = (row) => activeFixes(row).filter(([, f]) => !f.confirmed)
  const status = rows.map((row, i) => {
    const errs = Object.keys(results[i].errors).length
    const checks = pendingFixes(row).filter(([, f]) => f.warn).length
    return { errs, checks, ready: errs === 0 && checks === 0 }
  })
  const readyCount = status.filter((s) => s.ready).length
  const attentionCount = rows.length - readyCount
  const pendingTotal = rows.reduce((n, r) => n + pendingFixes(r).length, 0)
  const pendingRows = rows.filter((r) => pendingFixes(r).length).length
  const checkTotal = status.reduce((n, s) => n + s.checks, 0)


  const touch = (i) => { if (!touched.has(i)) setTouched(new Set(touched).add(i)) }
  const edit = (i, key, value) => { setRows(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r))); touch(i) }
  const undoFix = (i, key) => edit(i, key, rows[i]._fixes[key].from)
  const keepFix = (i, key) => {
    setRows(rows.map((r, j) => (j === i ? { ...r, _fixes: { ...r._fixes, [key]: { ...r._fixes[key], confirmed: true } } } : r)))
    touch(i)
  }
  const keepAll = () => setRows(rows.map((r) => {
    const f = { ...(r._fixes || {}) }
    for (const [k] of activeFixes(r)) f[k] = { ...f[k], confirmed: true }
    return { ...r, _fixes: f }
  }))
  // Remove several rows at once, keeping the "touched" indices aligned.
  const removeMany = (idxs, base = rows) => {
    const drop = new Set(idxs)
    setRows(base.filter((_, j) => !drop.has(j)))
    const shift = (t) => t - idxs.filter((d) => d < t).length
    setTouched(new Set([...touched].filter((t) => !drop.has(t)).map(shift)))
  }
  const remove = (i) => removeMany([i])

  // ---- Duplicate SKUs (within the file, or already in the system) ----
  const dupGroups = useMemo(() => {
    const by = {}
    rows.forEach((r, i) => { const k = r.sku.trim(); if (k) (by[k] = by[k] || []).push(i) })
    return Object.entries(by)
      .filter(([sku, idx]) => idx.length > 1 || existingSkus.has(sku))
      .map(([sku, idx]) => {
        const sig = (i) => JSON.stringify(clean(rows[i]))
        return { sku, idx, existing: existingSkus.has(sku), identical: idx.length > 1 && idx.every((i) => sig(i) === sig(idx[0])) }
      })
  }, [rows, existingSkus])

  const dupOf = useMemo(() => {
    const m = {}
    dupGroups.forEach((g) => g.idx.forEach((i) => { m[i] = g }))
    return m
  }, [dupGroups])
  const dupItems = Object.keys(dupOf).length

  const visibleRaw = rows.map((r, i) => i).filter((i) =>
    filter === 'all' ? true
      : filter === 'fixed' ? pendingFixes(rows[i]).length > 0
      : filter === 'dups' ? dupOf[i] || touched.has(i)
      : !status[i].ready || touched.has(i))
  // In the Duplicates view, keep items that share a SKU next to each other.
  const visible = filter === 'dups'
    ? [...visibleRaw].sort((a, b) => (dupOf[a]?.idx[0] ?? a) - (dupOf[b]?.idx[0] ?? b) || a - b)
    : visibleRaw

  // Give rows new SKUs (recorded as an amber "please check" fix so the user confirms them).
  const reassign = (base, idxs) => {
    const taken = new Set([...existingSkus, ...base.map((r) => r.sku.trim())])
    const next = [...base]
    for (const i of idxs) {
      const old = next[i].sku
      const sku = generateSku(next[i].name, taken)
      taken.add(sku)
      next[i] = { ...next[i], sku, _fixes: { ...next[i]._fixes, sku: { from: old, to: sku, why: `New SKU: "${old.trim()}" was already used`, warn: true } } }
    }
    return next
  }
  const newSku = (i) => { setRows(reassign(rows, [i])); touch(i) }
  const keepSku = (g, keepIdx) => {
    setRows(reassign(rows, g.existing ? g.idx : g.idx.filter((i) => i !== keepIdx)))
    setTouched(new Set([...touched, ...g.idx]))
  }
  const resolveAll = () => {
    let next = rows
    const drop = []
    for (const g of dupGroups) {
      if (g.identical && !g.existing) { drop.push(...g.idx.slice(1)); continue }
      const validFormat = /^[A-Z]{4}-[A-Z0-9]{3}$/.test(g.sku)
      next = reassign(next, g.existing || !validFormat ? g.idx : g.idx.slice(1))
    }
    if (drop.length) removeMany(drop, next)
    else setRows(next)
  }
  const showErrors = () => { setFilter('errors'); setTouched(new Set()) }

  const doImport = async () => {
    setBusy(true)
    const readyRows = rows.filter((_, i) => status[i].ready)
    const res = await fetch('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: readyRows.map(clean) }),
    }).then((r) => r.json())
    const skipped = rows.map((r, i) => ({ r, i })).filter(({ i }) => !status[i].ready)
      .map(({ r, i }) => ({
        row: clean(r), line: i + 1,
        errors: status[i].errs ? results[i].errors : { _: 'Auto-fix not confirmed (ambiguous value)' },
      }))
    setBusy(false)
    onImported(res, { skipped })
  }

  const tab = (key, label, onClick) => (
    <button className={`px-3 py-1 rounded ${filter === key ? 'bg-slate-800 text-white' : 'border bg-white'}`} onClick={onClick || (() => setFilter(key))}>{label}</button>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="text-lg"><span className="font-semibold text-green-700">{readyCount} ready</span>{' · '}
          <span className="font-semibold text-red-600">{attentionCount} need attention</span>{' · '}{rows.length} rows</div>
        <div className="ml-auto flex gap-2 text-sm">
          {tab('errors', `Needs attention (${attentionCount})`, showErrors)}
          {dupItems > 0 && tab('dups', `Duplicates (${dupItems})`)}
          {tab('fixed', `Auto-fixed (${pendingRows})`)}
          {tab('all', 'All rows')}
        </div>
      </div>
      {dupGroups.length > 0 && (
        <div className="bg-orange-50 border-2 border-orange-400 rounded-lg px-4 py-3 flex items-center gap-4 flex-wrap">
          <div>
            <div className="font-semibold text-orange-900">⚠ {dupGroups.length} SKU{dupGroups.length > 1 ? 's are' : ' is'} shared by {dupItems} items</div>
            <div className="text-sm text-orange-900">A SKU must be unique{dupGroups.some((g) => g.existing) ? ' (some already exist in the system)' : ''}. These rows can't import until each one is resolved.</div>
          </div>
          <div className="ml-auto flex gap-2">
            <button className="px-3 py-2 rounded border border-orange-400 bg-white text-orange-900 text-sm" onClick={() => setFilter('dups')}>Review duplicates</button>
            <button className="px-3 py-2 rounded bg-orange-600 text-white text-sm font-medium" onClick={resolveAll}
              title="Identical copies are removed. Otherwise the first item keeps the SKU and the others get new SKUs for you to confirm.">✨ Resolve all</button>
          </div>
        </div>
      )}
      {pendingTotal > 0 && (
        <div className="bg-emerald-50 border-2 border-emerald-300 rounded-lg px-4 py-3 flex items-center gap-4 flex-wrap">
          <div>
            <div className="font-semibold text-emerald-800">✨ We fixed {pendingTotal} values in {pendingRows} rows for you</div>
            <div className="text-sm text-emerald-900">Spacing, casing, $ signs, number and date formats, yes/no values.
              {checkTotal > 0 && <> <b className="text-amber-700">{checkTotal} {checkTotal === 1 ? 'is a guess' : 'are guesses'} you need to confirm</b> before {checkTotal === 1 ? 'it imports' : 'they import'}.</>}</div>
          </div>
          <div className="ml-auto flex gap-2">
            <button className="px-3 py-2 rounded border border-emerald-400 bg-white text-emerald-800 text-sm" onClick={() => setFilter('fixed')}>Review fixes</button>
            <button className="px-3 py-2 rounded bg-emerald-600 text-white text-sm font-medium" onClick={keepAll}>✓ Confirm all {pendingTotal} fixes</button>
          </div>
        </div>
      )}
      <div className="overflow-auto max-h-[65vh] bg-white rounded-lg shadow-sm">
        <table className="text-xs">
          <thead className="sticky top-0 bg-slate-100 text-left z-10">
            <tr><th className="p-2">Row</th><th className="p-2">Status</th>{FIELDS.map((f) => <th key={f.key} className="p-2 whitespace-nowrap">{f.label}{f.required ? ' *' : ''}</th>)}<th /></tr>
          </thead>
          <tbody>
            {visible.map((i) => {
              const st = status[i]
              return (
                <tr key={i} className={`border-t align-top ${st.ready && touched.has(i) ? 'bg-green-50/60' : ''}`}>
                  <td className="p-2 text-slate-400">{i + 1}</td>
                  <td className="p-2 whitespace-nowrap">
                    {st.errs > 0 ? <span className="px-2 py-0.5 rounded-full bg-red-100 text-red-700 font-medium">● Needs you: {st.errs} field{st.errs > 1 ? 's' : ''}</span>
                      : st.checks > 0 ? <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">● Check {st.checks} fix{st.checks > 1 ? 'es' : ''}</span>
                      : <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">● Ready</span>}
                    {dupOf[i] && (() => {
                      const g = dupOf[i]
                      const others = g.idx.filter((j) => j !== i).map((j) => j + 1)
                      return (
                        <div className="mt-1.5 p-1.5 rounded bg-orange-100 text-orange-900 w-44 whitespace-normal leading-tight">
                          <div className="font-semibold">⚠ Duplicate SKU</div>
                          <div>{g.identical ? `Identical to row ${others.join(', ')}` : others.length ? `Shared with row ${others.join(', ')}` : 'Already in the system'}</div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {g.identical && i !== g.idx[0]
                              ? <button className="px-1.5 rounded bg-white border font-medium" onClick={() => remove(i)}>Remove copy</button>
                              : <>
                                  {!g.existing && <button className="px-1.5 rounded bg-white border" title="This item keeps the SKU; the others get new ones" onClick={() => keepSku(g, i)}>Keep SKU</button>}
                                  <button className="px-1.5 rounded bg-white border" title="Generate a new unique SKU for this item" onClick={() => newSku(i)}>✨ New SKU</button>
                                  <button className="px-1.5 rounded bg-white border text-slate-500" title="Leave this row out of the import" onClick={() => remove(i)}>Skip</button>
                                </>}
                          </div>
                        </div>
                      )
                    })()}
                  </td>
                  {FIELD_KEYS.map((k) => {
                    const err = results[i].errors[k]
                    const fix = rows[i]._fixes?.[k]
                    const fixed = fix && !fix.confirmed && rows[i][k] === fix.to
                    const tone = fixed ? (fix.warn ? 'border-amber-400 bg-amber-50' : 'border-emerald-400 bg-emerald-50')
                      : err ? 'border-red-400 bg-red-50' : 'border-transparent hover:border-slate-200'
                    return (
                      <td key={k} className="p-1">
                        <input title={err || (fixed ? `Was "${fix.from}": ${fix.why}` : '')} value={rows[i][k]} onChange={(e) => edit(i, k, e.target.value)}
                          className={`w-36 px-2 py-1 rounded border font-mono ${tone}`} />
                        {fixed && (
                          <div className={`w-36 mt-1 p-1.5 rounded leading-tight ${fix.warn ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'}`}>
                            <div className="font-semibold">{fix.warn ? '⚠ Please check' : '✨ Fixed'}</div>
                            <div>was <span className="font-mono line-through">{fix.from.trim() === '' ? '(spaces)' : fix.from}</span></div>
                            <div className="opacity-75">{fix.why}</div>
                            <div className="flex gap-1 mt-1">
                              <button className="px-1.5 rounded bg-white border font-medium" onClick={() => keepFix(i, k)}>✓ Keep</button>
                              <button className="px-1.5 rounded bg-white border" onClick={() => undoFix(i, k)}>↶ Undo</button>
                            </div>
                          </div>
                        )}
                        {err && (fixed
                          ? <div className="text-orange-700 w-36 mt-1 leading-tight">Still needs you: {err}</div>
                          : <div className="text-red-600 w-36 mt-0.5 leading-tight">{err}</div>)}
                      </td>
                    )
                  })}
                  <td className="p-2"><button className="text-slate-400 hover:text-red-600" title="Skip this row" onClick={() => remove(i)}>✕</button></td>
                </tr>
              )
            })}
            {visible.length === 0 && <tr><td className="p-6 text-slate-500" colSpan={FIELDS.length + 3}>Nothing here. 🎉</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex gap-3 items-center">
        <button className="px-4 py-2 rounded border" onClick={onBack}>Back</button>
        <button disabled={!readyCount || busy} className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50" onClick={doImport}>
          {busy ? 'Importing…' : `Import ${readyCount} item${readyCount === 1 ? '' : 's'}`}
        </button>
        {attentionCount > 0 && <span className="text-sm text-slate-600">{attentionCount} rows will be held back. You can fix them now, or import the ready ones and download the rest afterwards.</span>}
      </div>
    </div>
  )
}

function Results({ result, onRestart }) {
  const skipped = result.sent.skipped
  const downloadSkipped = () => {
    const csv = Papa.unparse(skipped.map((s) => ({ ...s.row, _errors: Object.entries(s.errors).map(([k, v]) => `${k}: ${v}`).join(' | ') })))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = 'not_imported.csv'
    a.click()
  }
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-green-50 border border-green-200 rounded-lg p-6"><div className="text-3xl font-semibold text-green-700">{result.imported.length}</div><div>items imported</div></div>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6"><div className="text-3xl font-semibold text-red-600">{skipped.length + result.rejected.length}</div><div>rows not imported</div></div>
      </div>
      {result.imported.length > 0 && (
        <details className="bg-white rounded-lg p-4 shadow-sm"><summary className="cursor-pointer font-medium">Imported SKUs</summary>
          <p className="font-mono text-xs mt-2">{result.imported.join(', ')}</p></details>
      )}
      {skipped.length > 0 && (
        <div className="bg-white rounded-lg p-4 shadow-sm space-y-2">
          <div className="flex items-center"><h3 className="font-medium">Not imported</h3>
            <button className="ml-auto text-sm underline text-blue-600" onClick={downloadSkipped}>Download as CSV</button></div>
          <ul className="text-sm space-y-1 max-h-80 overflow-auto">
            {skipped.map((s) => (
              <li key={s.line}><span className="font-mono">Row {s.line} {s.row.sku || '(no SKU)'}</span>: {Object.values(s.errors).join('; ')}</li>
            ))}
          </ul>
        </div>
      )}
      <button className="px-4 py-2 rounded bg-blue-600 text-white" onClick={onRestart}>Import another file</button>
    </div>
  )
}
