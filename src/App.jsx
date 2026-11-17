import { useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import { FIELDS, FIELD_KEYS, autoMapHeaders, applyMapping, validateRows } from '../shared/schema.js'

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
    setRows(csvRows.map((r) => applyMapping(r, mapping)))
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
  const validCount = results.filter((r) => r.valid).length
  const errorCount = rows.length - validCount
  const visible = rows.map((r, i) => i).filter((i) => filter === 'all' || !results[i].valid || touched.has(i))

  const edit = (i, key, value) => {
    setRows(rows.map((r, j) => (j === i ? { ...r, [key]: value } : r)))
    if (!touched.has(i)) setTouched(new Set(touched).add(i))
  }
  const remove = (i) => {
    setRows(rows.filter((_, j) => j !== i))
    setTouched(new Set([...touched].filter((t) => t !== i).map((t) => (t > i ? t - 1 : t))))
  }
  const showErrors = () => { setFilter('errors'); setTouched(new Set()) }

  const doImport = async () => {
    setBusy(true)
    const validRows = rows.filter((_, i) => results[i].valid)
    const res = await fetch('/api/import', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: validRows }),
    }).then((r) => r.json())
    const skipped = rows.map((r, i) => ({ r, i })).filter(({ i }) => !results[i].valid)
      .map(({ r, i }) => ({ row: r, line: i + 1, errors: results[i].errors }))
    setBusy(false)
    onImported(res, { skipped })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4 flex-wrap">
        <div className="text-lg"><span className="font-semibold text-green-700">{validCount} ready</span>{' · '}
          <span className="font-semibold text-red-600">{errorCount} need attention</span>{' · '}{rows.length} rows</div>
        <div className="ml-auto flex gap-2 text-sm">
          <button className={`px-3 py-1 rounded ${filter === 'errors' ? 'bg-slate-800 text-white' : 'border'}`} onClick={showErrors}>Needs attention</button>
          <button className={`px-3 py-1 rounded ${filter === 'all' ? 'bg-slate-800 text-white' : 'border'}`} onClick={() => setFilter('all')}>All rows</button>
        </div>
      </div>
      <div className="overflow-auto max-h-[65vh] bg-white rounded-lg shadow-sm">
        <table className="text-xs">
          <thead className="sticky top-0 bg-slate-100 text-left">
            <tr><th className="p-2">Row</th>{FIELDS.map((f) => <th key={f.key} className="p-2 whitespace-nowrap">{f.label}{f.required ? ' *' : ''}</th>)}<th /></tr>
          </thead>
          <tbody>
            {visible.map((i) => (
              <tr key={i} className={`border-t align-top ${results[i].valid && touched.has(i) ? 'bg-green-50' : ''}`}>
                <td className="p-2 text-slate-400 whitespace-nowrap">
                  {i + 1}
                  {results[i].valid && (touched.has(i)
                    ? <div className="text-green-700 font-medium">✓ Fixed</div>
                    : ' ✓')}
                </td>
                {FIELD_KEYS.map((k) => {
                  const err = results[i].errors[k]
                  return (
                    <td key={k} className="p-1">
                      <input title={err || ''} value={rows[i][k]} onChange={(e) => edit(i, k, e.target.value)}
                        className={`w-36 px-2 py-1 rounded border font-mono ${err ? 'border-red-400 bg-red-50' : 'border-transparent hover:border-slate-200'}`} />
                      {err && <div className="text-red-600 w-36 mt-0.5 leading-tight">{err}</div>}
                    </td>
                  )
                })}
                <td className="p-2"><button className="text-slate-400 hover:text-red-600" title="Skip this row" onClick={() => remove(i)}>✕</button></td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td className="p-6 text-slate-500" colSpan={FIELDS.length + 2}>Nothing needs attention. 🎉</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="flex gap-3 items-center">
        <button className="px-4 py-2 rounded border" onClick={onBack}>Back</button>
        <button disabled={!validCount || busy} className="px-4 py-2 rounded bg-blue-600 text-white disabled:opacity-50" onClick={doImport}>
          {busy ? 'Importing…' : `Import ${validCount} item${validCount === 1 ? '' : 's'}`}
        </button>
        {errorCount > 0 && <span className="text-sm text-slate-600">{errorCount} rows with problems will not be imported until fixed.</span>}
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
