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
  const [aiMap, setAiMap] = useState({ busy: false, notes: {}, msg: '' })

  const refreshExisting = () =>
    fetch('/api/items').then((r) => r.json()).then((items) => setExistingSkus(new Set(items.map((i) => i.sku))))
  useEffect(() => { refreshExisting() }, [])

  const loadText = (text, name) => {
    const parsed = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' })
    const hs = parsed.meta.fields.filter((h) => h !== '')
    setFileName(name)
    setHeaders(hs)
    setCsvRows(parsed.data)
    const auto = autoMapHeaders(hs)
    setMapping(auto)
    setResult(null)
    setStep(1)
    // Fallback: ask AI about columns our alias matching couldn't place (judging by header + sample values).
    const unmapped = hs.filter((h) => !auto[h])
    setAiMap({ busy: unmapped.length > 0, notes: {}, msg: '' })
    if (!unmapped.length) return
    fetch('/api/ai/map', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        unmapped: unmapped.map((h) => ({ header: h, samples: parsed.data.map((r) => r[h]).filter(Boolean).slice(0, 3) })),
        used: Object.values(auto).filter(Boolean),
      }),
    })
      .then(async (r) => {
        const data = await r.json()
        if (!r.ok) throw new Error(data.error)
        const notes = {}
        for (const m of data.mappings) notes[m.header] = m
        setMapping((cur) => {
          const next = { ...cur }
          const used = new Set(Object.values(next).filter(Boolean))
          for (const m of data.mappings) if (m.field && !next[m.header] && !used.has(m.field)) { next[m.header] = m.field; used.add(m.field) }
          return next
        })
        setAiMap({ busy: false, notes, msg: '' })
      })
      .catch((e) => setAiMap({ busy: false, notes: {}, msg: /AI is off/.test(e.message) ? 'off' : e.message }))
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
    <div className="min-h-screen text-slate-900">
      <header className="sticky top-0 z-30 bg-slate-950 text-white">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center gap-8">
          <div className="flex items-center gap-2.5 shrink-0">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="m3 7 9 5 9-5M12 12v10" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" opacity=".55" />
            </svg>
            <span className="font-medium tracking-tight">Sutton<span className="text-slate-500"> / Import</span></span>
          </div>
          <ol className="hidden md:flex items-center gap-1 text-sm ml-auto">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-1">
                {i > 0 && <span className={`w-6 h-px ${i <= step ? 'bg-white/60' : 'bg-white/15'}`} />}
                <span className={`flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors ${i === step ? 'bg-white text-slate-950' : i < step ? 'text-white/80' : 'text-white/35'}`}>
                  <span className="font-mono text-[11px]">{i < step ? '✓' : String(i + 1).padStart(2, '0')}</span>{s}
                </span>
              </li>
            ))}
          </ol>
          <span className="md:hidden ml-auto label text-white/60">{String(step + 1).padStart(2, '0')} / {String(STEPS.length).padStart(2, '0')}</span>
        </div>
        <div className="h-0.5 bg-white/10"><div className="h-full bg-gradient-to-r from-sky-400 via-violet-400 to-emerald-400 seg" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
      </header>
      <main key={step} className="max-w-7xl mx-auto px-6 py-10 animate-rise">
        {step === 0 && <Upload onText={loadText} existingCount={existingSkus.size} />}
        {step === 1 && (
          <MapColumns aiMap={aiMap} fileName={fileName} headers={headers} sample={csvRows[0]} mapping={mapping}
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
  const steps = [
    ['Map', 'We match your column names to ours, with AI for the odd ones.'],
    ['Fix', 'Safe fixes happen automatically. You approve anything we guessed.'],
    ['Trust', 'Only clean rows import. You get a list of everything that didn\'t.'],
  ]
  return (
    <div className="grid lg:grid-cols-[1fr_1.1fr] gap-12 items-center min-h-[calc(100vh-10rem)] stagger">
      <div className="space-y-6">
        <span className="label text-slate-500">Bulk import · Inventory items</span>
        <h1 className="text-5xl md:text-6xl font-medium tracking-[-0.035em] leading-[0.98]">
          Bring the spreadsheet.<br /><span className="text-slate-400">We'll handle the mess.</span>
        </h1>
        <p className="text-lg text-slate-600 max-w-md leading-relaxed">
          Drop in your inventory file as it is. Renamed columns, odd formats and duplicate SKUs are all fine. You'll know exactly what got in.
        </p>
        <ul className="space-y-3 pt-2">
          {steps.map(([t, d], i) => (
            <li key={t} className="flex gap-4 items-baseline">
              <span className="font-mono text-xs text-slate-400 w-6">{String(i + 1).padStart(2, '0')}</span>
              <span><span className="font-medium">{t}.</span> <span className="text-slate-600">{d}</span></span>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-4">
        <label
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); readFile(e.dataTransfer.files[0]) }}
          className={`dropzone-ring ${drag ? 'is-drag scale-[1.01]' : ''} group block rounded-3xl px-10 py-20 text-center cursor-pointer shadow-[0_1px_2px_rgba(15,23,42,.04),0_24px_48px_-24px_rgba(15,23,42,.18)] transition-transform duration-300 focus-within:ring-2 focus-within:ring-violet-400`}
        >
          <input type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => readFile(e.target.files[0])} />
          <div className="mx-auto mb-6 w-14 h-14 rounded-2xl bg-slate-950 text-white grid place-items-center transition-transform duration-300 group-hover:-translate-y-1">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-xl font-medium tracking-tight">{drag ? 'Drop it.' : 'Drop your inventory CSV here'}</p>
          <p className="text-slate-500 mt-1.5">or <span className="text-slate-900 underline underline-offset-4 decoration-slate-300">browse your computer</span></p>
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500 mr-1">No file handy?</span>
          <button className="px-3 py-1.5 rounded-full border border-slate-200 bg-white hover:border-slate-400 transition-colors" onClick={() => loadSample('items_clean.csv')}>Clean sample</button>
          <button className="px-3 py-1.5 rounded-full border border-slate-200 bg-white hover:border-slate-400 transition-colors" onClick={() => loadSample('items_messy.csv')}>Messy sample</button>
          <span className="ml-auto label text-slate-400">{existingCount} items in system</span>
        </div>
      </div>
    </div>
  )
}

function MapColumns({ aiMap, fileName, headers, sample, mapping, setMapping, onBack, onNext }) {
  const used = Object.values(mapping).filter(Boolean)
  const missingRequired = FIELDS.filter((f) => f.required && !used.includes(f.key))
  return (
    <div className="space-y-4">
      <h2 className="text-3xl font-medium tracking-tight">Map the columns in <span className="font-mono">{fileName}</span></h2>
      <p className="text-slate-600 text-sm">We matched your columns automatically. Change any that look wrong.</p>
      {aiMap.busy && <div className="bg-violet-50 border border-violet-200 rounded-lg px-4 py-2 text-sm text-violet-900">🤖 AI is looking at the columns we couldn't match…</div>}
      {aiMap.msg && aiMap.msg !== 'off' && <div className="bg-slate-100 rounded-lg px-4 py-2 text-sm text-slate-600">AI column matching unavailable ({aiMap.msg}). You can pick fields by hand.</div>}
      <table className="w-full bg-white rounded-2xl border border-slate-200 shadow-sm text-sm overflow-hidden">
        <thead className="text-left text-slate-500 bg-slate-50"><tr><th className="p-3 label font-normal">Your column</th><th className="p-3 label font-normal">Example value</th><th className="p-3 label font-normal">Imports as</th></tr></thead>
        <tbody>
          {headers.map((h) => (
            <tr key={h} className="border-t">
              <td className="p-3 font-mono">{h}</td>
              <td className="p-3 text-slate-500 truncate max-w-xs">{String(sample?.[h] ?? '').slice(0, 60)}</td>
              <td className="p-3">
                <select className="border border-slate-300 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-violet-400" value={mapping[h] ?? ''}
                  onChange={(e) => setMapping({ ...mapping, [h]: e.target.value || null })}>
                  <option value="">— Don't import —</option>
                  {FIELDS.map((f) => (
                    <option key={f.key} value={f.key} disabled={used.includes(f.key) && mapping[h] !== f.key}>
                      {f.label}{f.required ? ' *' : ''}
                    </option>
                  ))}
                </select>
                {aiMap.notes[h] && (
                  <div className="text-xs text-violet-700 mt-1">
                    🤖 {aiMap.notes[h].field
                      ? (mapping[h] === aiMap.notes[h].field ? `AI matched this: ${aiMap.notes[h].why}` : `AI suggested ${aiMap.notes[h].field}`)
                      : `AI: not an item field${aiMap.notes[h].why ? `, ${aiMap.notes[h].why}` : ''}`}
                  </div>
                )}
                {!mapping[h] && !aiMap.notes[h] && !aiMap.busy && <div className="text-xs text-slate-500 mt-1">Not imported</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {missingRequired.length > 0 && (
        <p className="text-amber-700 text-sm">Required fields not mapped: {missingRequired.map((f) => f.label).join(', ')}. Those rows will need values in the next step.</p>
      )}
      <div className="flex gap-3">
        <button className="px-5 py-2.5 rounded-full border border-slate-300 bg-white hover:border-slate-500 transition-colors" onClick={onBack}>Back</button>
        <button className="px-5 py-2.5 rounded-full bg-slate-950 text-white font-medium hover:bg-slate-800 transition-colors shadow-sm" onClick={onNext}>Continue</button>
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
  const [aiOn, setAiOn] = useState(false)
  const [ai, setAi] = useState({ busy: false, msg: '' })
  useEffect(() => { fetch('/api/health').then((r) => r.json()).then((h) => setAiOn(h.ai)).catch(() => {}) }, [])
  const results = useMemo(() => validateRows(rows, existingSkus), [rows, existingSkus])

  // A fix is "active" while the cell still holds the fixed value; "pending" until the user keeps it.
  const activeFixes = (row) => Object.entries(row._fixes || {}).filter(([k, f]) => row[k] === f.to)
  const pendingAll = (row) => activeFixes(row).filter(([, f]) => !f.confirmed)
  const pendingFixes = (row) => pendingAll(row).filter(([, f]) => !f.ai) // our deterministic fixes
  const aiPending = (row) => pendingAll(row).filter(([, f]) => f.ai) // AI suggestions awaiting approval
  const status = rows.map((row, i) => {
    const errs = Object.keys(results[i].errors).length
    const checks = pendingFixes(row).filter(([, f]) => f.warn).length
    const aiChecks = aiPending(row).length
    return { errs, checks, aiChecks, ready: errs === 0 && checks === 0 && aiChecks === 0 }
  })
  const aiTotal = rows.reduce((n, r) => n + aiPending(r).length, 0)
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
  const keepAll = (ai = false) => setRows(rows.map((r) => {
    const f = { ...(r._fixes || {}) }
    for (const [k, x] of activeFixes(r)) if (Boolean(x.ai) === ai) f[k] = { ...f[k], confirmed: true }
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


  // ---- AI: rows with problems other than duplicate SKUs (those have their own flow) ----
  const aiTargets = rows.map((r, i) => {
    const errors = { ...results[i].errors }
    if (dupOf[i] && /Duplicate|already exists/.test(errors.sku || '')) delete errors.sku
    return { index: i, row: clean(r), errors }
  }).filter((t) => Object.keys(t.errors).length)

  const aiTargetSet = new Set(aiTargets.map((t) => t.index))
  const aiRows = rows.filter((r, i) => aiPending(r).length > 0 || aiTargetSet.has(i)).length

  const visibleRaw = rows.map((r, i) => i).filter((i) =>
    filter === 'all' ? true
      : filter === 'fixed' ? pendingFixes(rows[i]).length > 0
      : filter === 'dups' ? dupOf[i] || touched.has(i)
      : filter === 'ai' ? aiPending(rows[i]).length > 0 || aiTargetSet.has(i) || touched.has(i)
      : !status[i].ready || touched.has(i))
  // In the Duplicates view, keep items that share a SKU next to each other.
  const visible = filter === 'dups'
    ? [...visibleRaw].sort((a, b) => (dupOf[a]?.idx[0] ?? a) - (dupOf[b]?.idx[0] ?? b) || a - b)
    : visibleRaw

  const askAi = async () => {
    setAi({ busy: true, msg: '' })
    try {
      const res = await fetch('/api/ai/suggest', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: aiTargets }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'AI request failed')
      let applied = 0
      setRows((cur) => {
        const next = [...cur]
        for (const sug of data.suggestions) {
          const i = sug.index, k = sug.field
          if (!next[i] || !FIELD_KEYS.includes(k) || typeof sug.value !== 'string' || next[i][k] === sug.value) continue
          const from = next[i][k]
          next[i] = { ...next[i], [k]: sug.value, _fixes: { ...next[i]._fixes, [k]: { from, to: sug.value, why: sug.why || 'AI suggestion', warn: true, ai: true } } }
          applied++
        }
        return next
      })
      setTouched(new Set([...touched, ...aiTargets.map((t) => t.index)]))
      setAi({ busy: false, msg: `AI suggested ${data.suggestions.length} fixes. They're marked 🤖 for you to Keep or Undo.${data.failedBatches ? ` (${data.failedBatches} batch(es) failed; try again.)` : ''}` })
      void applied
    } catch (e) {
      setAi({ busy: false, msg: `AI couldn't help this time: ${e.message}` })
    }
  }

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
    <button className={`px-3.5 py-1.5 rounded-full transition-colors ${filter === key ? 'bg-slate-950 text-white' : 'border border-slate-200 bg-white hover:border-slate-400'}`} onClick={onClick || (() => setFilter(key))}>{label}</button>
  )

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-6 flex-wrap">
        <div className="space-y-3 min-w-[280px] flex-1 max-w-xl">
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-medium tracking-tight tabular-nums">{readyCount}<span className="text-slate-400">/{rows.length}</span></span>
            <span className="text-slate-600">rows ready to import</span>
          </div>
          <div className="flex h-2 rounded-full overflow-hidden bg-slate-200" role="img" aria-label={`${readyCount} ready, ${attentionCount} need attention`}>
            <div className="seg bg-emerald-500" style={{ width: `${(readyCount / Math.max(rows.length, 1)) * 100}%` }} />
            <div className="seg bg-red-400" style={{ width: `${(attentionCount / Math.max(rows.length, 1)) * 100}%` }} />
          </div>
          <div className="flex gap-4 text-xs text-slate-500">
            <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full bg-emerald-500" />{readyCount} ready</span>
            <span className="flex items-center gap-1.5"><i className="w-2 h-2 rounded-full bg-red-400" />{attentionCount} need attention</span>
          </div>
        </div>
        <div className="ml-auto flex gap-2 text-sm">
          {tab('errors', `Needs attention (${attentionCount})`, showErrors)}
          {dupItems > 0 && tab('dups', `Duplicates (${dupItems})`)}
          {aiRows > 0 && tab('ai', `🤖 AI (${aiRows})`)}
          {tab('fixed', `Auto-fixed (${pendingRows})`)}
          {tab('all', 'All rows')}
        </div>
      </div>
      {dupGroups.length > 0 && (
        <div className="bg-orange-50 border-2 border-orange-400 rounded-xl px-4 py-2.5 flex items-center gap-x-4 gap-y-2 flex-wrap">
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
      {(aiTargets.length > 0 || aiTotal > 0) && (
        <div className="bg-violet-50 border-2 border-violet-300 rounded-xl px-4 py-2.5 flex items-center gap-x-4 gap-y-2 flex-wrap">
          <div>
            <div className="font-semibold text-violet-900">🤖 {aiTotal > 0
              ? `${aiTotal} AI suggestion${aiTotal > 1 ? 's' : ''} waiting for your approval`
              : `${aiTargets.length} row${aiTargets.length > 1 ? 's still have' : ' still has'} problems we can't fix safely on our own`}</div>
            <div className="text-sm text-violet-900">
              {ai.msg || (aiOn
                ? 'AI can suggest values from the rest of the row (e.g. a category from the name, a cost from the preferred vendor). You approve each one.'
                : 'AI is off. Add OPENROUTER_API_KEY to .env and restart to get suggestions. You can still fix these by hand.')}
            </div>
          </div>
          <div className="ml-auto flex gap-2">
            <button className="px-3 py-2 rounded border border-violet-400 bg-white text-violet-900 text-sm" onClick={() => setFilter('ai')}>Review {aiTotal > 0 ? 'AI suggestions' : 'these rows'}</button>
            {aiTargets.length > 0 && (
              <button disabled={!aiOn || ai.busy} onClick={askAi}
                className={`px-3 py-2 rounded text-sm font-medium disabled:opacity-50 ${aiTotal > 0 ? 'border border-violet-400 bg-white text-violet-900' : 'bg-violet-600 text-white'}`}>
                {ai.busy ? `AI is reviewing ${aiTargets.length} rows…` : `🤖 Suggest fixes for ${aiTargets.length} rows`}
              </button>
            )}
            {aiTotal > 0 && <button className="px-3 py-2 rounded bg-violet-600 text-white text-sm font-medium" onClick={() => keepAll(true)}>✓ Accept all {aiTotal}</button>}
          </div>
        </div>
      )}
      {pendingTotal > 0 && (
        <div className="bg-emerald-50 border-2 border-emerald-300 rounded-xl px-4 py-2.5 flex items-center gap-x-4 gap-y-2 flex-wrap">
          <div>
            <div className="font-semibold text-emerald-800">✨ We fixed {pendingTotal} values in {pendingRows} rows for you</div>
            <div className="text-sm text-emerald-900">Spacing, casing, $ signs, number and date formats, yes/no values.
              {checkTotal > 0 && <> <b className="text-amber-700">{checkTotal} {checkTotal === 1 ? 'is a guess' : 'are guesses'} you need to confirm</b> before {checkTotal === 1 ? 'it imports' : 'they import'}.</>}</div>
          </div>
          <div className="ml-auto flex gap-2">
            <button className="px-3 py-2 rounded border border-emerald-400 bg-white text-emerald-800 text-sm" onClick={() => setFilter('fixed')}>Review fixes</button>
            <button className="px-3 py-2 rounded bg-emerald-600 text-white text-sm font-medium" onClick={() => keepAll(false)}>✓ Confirm all {pendingTotal} fixes</button>
          </div>
        </div>
      )}
      <div className="overflow-auto max-h-[65vh] bg-white rounded-2xl border border-slate-200 shadow-sm">
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
                      : st.aiChecks > 0 ? <span className="px-2 py-0.5 rounded-full bg-violet-100 text-violet-800 font-medium">● Check {st.aiChecks} AI suggestion{st.aiChecks > 1 ? 's' : ''}</span>
                      : st.checks > 0 ? <span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-medium">● Check {st.checks} fix{st.checks > 1 ? 'es' : ''}</span>
                      : <span className="px-2 py-0.5 rounded-full bg-green-100 text-green-700 font-medium">● Ready</span>}
                    {st.errs > 0 && st.aiChecks > 0 && <div className="mt-1 text-violet-700">🤖 {st.aiChecks} AI suggestion{st.aiChecks > 1 ? 's' : ''} to check</div>}
                    {st.aiChecks === 0 && aiTargetSet.has(i) && <div className="mt-1 text-violet-700">🤖 AI can suggest a fix</div>}
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
                    const tone = fixed ? (fix.ai ? 'border-violet-400 bg-violet-50' : fix.warn ? 'border-amber-400 bg-amber-50' : 'border-emerald-400 bg-emerald-50')
                      : err ? 'border-red-400 bg-red-50' : 'border-transparent hover:border-slate-200'
                    return (
                      <td key={k} className="p-1">
                        <input title={err || (fixed ? `Was "${fix.from}": ${fix.why}` : '')} value={rows[i][k]} onChange={(e) => edit(i, k, e.target.value)}
                          className={`w-36 px-2 py-1 rounded border font-mono ${tone}`} />
                        {fixed && (
                          <div className={`w-36 mt-1 p-1.5 rounded leading-tight ${fix.ai ? 'bg-violet-100 text-violet-900' : fix.warn ? 'bg-amber-100 text-amber-900' : 'bg-emerald-100 text-emerald-900'}`}>
                            <div className="font-semibold">{fix.ai ? '🤖 AI suggestion' : fix.warn ? '⚠ Please check' : '✨ Fixed'}</div>
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
        <button className="px-5 py-2.5 rounded-full border border-slate-300 bg-white hover:border-slate-500 transition-colors" onClick={onBack}>Back</button>
        <button disabled={!readyCount || busy} className="px-5 py-2.5 rounded-full bg-slate-950 text-white font-medium hover:bg-slate-800 transition-colors shadow-sm disabled:opacity-50" onClick={doImport}>
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
      <div className="space-y-2">
        <span className="label text-slate-500">Import complete</span>
        <h2 className="text-4xl md:text-5xl font-medium tracking-[-0.03em]">{result.imported.length} items are in.</h2>
        <p className="text-slate-600">{skipped.length + result.rejected.length > 0 ? 'Here is exactly what got in, and what didn\'t and why.' : 'Everything in the file was imported.'}</p>
      </div>
      <div className="grid sm:grid-cols-2 gap-4 stagger">
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm"><span className="label text-emerald-700">Imported</span><div className="text-5xl font-medium tracking-tight tabular-nums mt-2">{result.imported.length}</div></div>
        <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm"><span className="label text-red-600">Not imported</span><div className="text-5xl font-medium tracking-tight tabular-nums mt-2">{skipped.length + result.rejected.length}</div></div>
      </div>
      {result.imported.length > 0 && (
        <details className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm"><summary className="cursor-pointer font-medium">Imported SKUs</summary>
          <p className="font-mono text-xs mt-2">{result.imported.join(', ')}</p></details>
      )}
      {skipped.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm space-y-2">
          <div className="flex items-center"><h3 className="font-medium">Not imported</h3>
            <button className="ml-auto text-sm underline text-blue-600" onClick={downloadSkipped}>Download as CSV</button></div>
          <ul className="text-sm space-y-1 max-h-80 overflow-auto">
            {skipped.map((s) => (
              <li key={s.line}><span className="font-mono">Row {s.line} {s.row.sku || '(no SKU)'}</span>: {Object.values(s.errors).join('; ')}</li>
            ))}
          </ul>
        </div>
      )}
      <button className="px-5 py-2.5 rounded-full bg-slate-950 text-white font-medium hover:bg-slate-800 transition-colors shadow-sm" onClick={onRestart}>Import another file</button>
    </div>
  )
}
