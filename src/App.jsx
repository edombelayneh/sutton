import { useEffect, useMemo, useState } from 'react'
import Papa from 'papaparse'
import { FIELDS, FIELD_KEYS, autoMapHeaders, applyMapping, validateRows } from '../shared/schema.js'
import { autoFixRow, generateSku } from '../shared/autofix.js'
import { EditPanel, CAT_LABEL, FIELD_LABEL, money, count, sizeText, vendorsText } from './review-ui.jsx'

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
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-slate-200 text-slate-900">
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
                {i > 0 && <span className={`w-6 h-px ${i <= step ? 'bg-slate-400' : 'bg-slate-200'}`} />}
                <span className={`flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors ${i === step ? 'bg-slate-900 text-white' : i < step ? 'text-slate-600' : 'text-slate-400'}`}>
                  <span className="font-mono text-[11px]">{i < step ? '✓' : String(i + 1).padStart(2, '0')}</span>{s}
                </span>
              </li>
            ))}
          </ol>
          <span className="md:hidden ml-auto label text-slate-500">{String(step + 1).padStart(2, '0')} / {String(STEPS.length).padStart(2, '0')}</span>
        </div>
        <div className="h-0.5 bg-slate-100"><div className="h-full bg-gradient-to-r from-sky-400 via-violet-400 to-emerald-400 seg" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
      </header>
      <main key={step} className="max-w-6xl mx-auto px-6 py-8 animate-rise">
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
  const [openRow, setOpenRow] = useState(null)
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

  const attentionIdx = rows.map((_, i) => i).filter((i) => !status[i].ready)
  const step = (dir) => {
    if (!attentionIdx.length) return setOpenRow(null)
    const cur = openRow ?? -1
    const next = dir > 0 ? attentionIdx.find((i) => i > cur) ?? attentionIdx[0] : [...attentionIdx].reverse().find((i) => i < cur) ?? attentionIdx.at(-1)
    setOpenRow(next)
  }

  const badge = (st) =>
    st.errs > 0 ? <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-700"><i className="w-2 h-2 rounded-full bg-red-500" />Needs you</span>
      : st.aiChecks > 0 ? <span className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-700"><i className="w-2 h-2 rounded-full bg-violet-500" />Check AI</span>
      : st.checks > 0 ? <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-700"><i className="w-2 h-2 rounded-full bg-amber-500" />Check fix</span>
      : <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-700"><i className="w-2 h-2 rounded-full bg-emerald-500" />Ready</span>

  // Plain-English chips describing what's going on in a row.
  const notes = (i) => {
    const row = rows[i]
    const out = []
    const dupMsg = dupOf[i] && (dupOf[i].identical ? 'Identical to another row' : dupOf[i].existing ? 'SKU already in system' : `SKU shared with row ${dupOf[i].idx.filter((j) => j !== i).map((j) => j + 1).join(', ')}`)
    if (dupMsg) out.push(['orange', dupMsg])
    for (const [k, msg] of Object.entries(results[i].errors)) {
      if (k === 'sku' && dupMsg) continue
      out.push(['red', `${FIELD_LABEL[k]}: ${msg}`])
    }
    const ai = aiPending(row).length
    if (ai) out.push(['violet', `${ai} AI suggestion${ai > 1 ? 's' : ''}`])
    const fx = pendingFixes(row)
    if (fx.length) out.push([fx.some(([, f]) => f.warn) ? 'amber' : 'emerald', `${fx.length} auto-fix${fx.length > 1 ? 'es' : ''}`])
    if (!out.length && aiTargetSet.has(i)) out.push(['violet', 'AI can help'])
    return out
  }
  const chipCls = {
    red: 'bg-red-50 text-red-700 ring-red-200', orange: 'bg-orange-50 text-orange-800 ring-orange-200',
    violet: 'bg-violet-50 text-violet-700 ring-violet-200', amber: 'bg-amber-50 text-amber-800 ring-amber-200', emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  }

  const needYou = status.filter((st) => st.errs > 0).length
  const chips = [
    ['errors', 'red', `${attentionCount} need attention`, attentionCount, showErrors],
    ['dups', 'orange', `${dupItems} duplicate SKUs`, dupItems],
    ['ai', 'violet', `${aiRows} AI can help`, aiRows],
    ['fixed', 'emerald', `${pendingRows} auto-fixed`, pendingRows],
    ['all', 'slate', `All ${rows.length}`, 1],
  ]
  const dot = { red: 'bg-red-500', orange: 'bg-orange-500', violet: 'bg-violet-500', emerald: 'bg-emerald-500', slate: 'bg-slate-400' }

  const o = openRow !== null && rows[openRow] ? openRow : null
  const og = o !== null ? dupOf[o] : null

  return (
    <div className="space-y-5">
      {/* Progress + summary */}
      <div className="rounded-2xl bg-white border border-slate-200 p-5 space-y-4">
        <div className="flex items-end gap-6 flex-wrap">
          <div className="flex-1 min-w-[260px] space-y-2">
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-semibold tracking-tight tabular-nums">{readyCount}</span>
              <span className="text-slate-500">of {rows.length} rows ready to import</span>
            </div>
            <div className="flex h-1.5 rounded-full overflow-hidden bg-slate-100">
              <div className="seg bg-emerald-500" style={{ width: `${(readyCount / Math.max(rows.length, 1)) * 100}%` }} />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            {dupItems > 0 && <button className="px-3 py-2 rounded-lg text-sm font-medium bg-orange-50 text-orange-800 hover:bg-orange-100" onClick={resolveAll}>Resolve {dupGroups.length} duplicate SKUs</button>}
            {aiTargets.length > 0 && aiOn && <button disabled={ai.busy} className="px-3 py-2 rounded-lg text-sm font-medium bg-violet-50 text-violet-800 hover:bg-violet-100 disabled:opacity-60" onClick={askAi}>{ai.busy ? 'AI is reviewing…' : `Ask AI to fix ${aiTargets.length} rows`}</button>}
            {aiTotal > 0 && <button className="px-3 py-2 rounded-lg text-sm font-medium bg-violet-600 text-white hover:bg-violet-700" onClick={() => keepAll(true)}>Accept {aiTotal} AI suggestions</button>}
            {pendingTotal > 0 && <button className="px-3 py-2 rounded-lg text-sm font-medium bg-emerald-600 text-white hover:bg-emerald-700" onClick={() => keepAll(false)}>Confirm {pendingTotal} auto-fixes</button>}
          </div>
        </div>
        {(ai.msg || (!aiOn && aiTargets.length > 0)) && (
          <p className="text-xs text-violet-700">{ai.msg || 'AI suggestions are off (add OPENROUTER_API_KEY to .env). You can still fix rows by hand.'}</p>
        )}
        {checkTotal > 0 && <p className="text-xs text-amber-700">{checkTotal} of our fixes were guesses (e.g. ambiguous dates). Confirm them before they import.</p>}
        <div className="flex flex-wrap gap-1.5 border-t border-slate-100 pt-4">
          {chips.filter(([, , , n]) => n > 0).map(([key, color, label, , onClick]) => (
            <button key={key} onClick={onClick || (() => setFilter(key))}
              className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm transition-colors ${filter === key ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}>
              <i className={`w-1.5 h-1.5 rounded-full ${dot[color]}`} />{label}
            </button>
          ))}
        </div>
      </div>

      {/* Readable list */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <div className="overflow-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white z-10 text-left text-xs text-slate-400 border-b border-slate-100">
              <tr>
                <th className="py-3 pl-5 pr-3 font-medium">Status</th><th className="px-3 font-medium">SKU</th><th className="px-3 font-medium">Item</th>
                <th className="px-3 font-medium">Category</th><th className="px-3 font-medium text-right">Cost</th><th className="px-3 font-medium text-right">In stock</th>
                <th className="px-3 font-medium">What's going on</th><th />
              </tr>
            </thead>
            <tbody>
              {visible.map((i) => {
                const r = rows[i]
                const sub = [sizeText(r.dimensions), vendorsText(r.vendors)].filter(Boolean).join(' · ')
                return (
                  <tr key={i} onClick={() => setOpenRow(i)} className={`border-b border-slate-50 cursor-pointer hover:bg-slate-50 ${o === i ? 'bg-indigo-50/60' : ''}`}>
                    <td className="py-3 pl-5 pr-3 whitespace-nowrap">{badge(status[i])}<div className="text-[11px] text-slate-400 mt-0.5">Row {i + 1}</div></td>
                    <td className="px-3 font-mono text-xs whitespace-nowrap">{r.sku || <span className="text-red-500">missing</span>}</td>
                    <td className="px-3 max-w-[260px]">
                      <div className="font-medium truncate">{r.name || <span className="text-red-500">No name</span>}</div>
                      {sub && <div className="text-xs text-slate-400 truncate">{sub}</div>}
                    </td>
                    <td className="px-3 whitespace-nowrap">{CAT_LABEL[r.category] || <span className="text-red-500">{r.category || 'missing'}</span>}</td>
                    <td className="px-3 text-right tabular-nums whitespace-nowrap">{money(r.unit_cost)}</td>
                    <td className="px-3 text-right tabular-nums whitespace-nowrap">{count(r.quantity_on_hand)}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1 max-w-md">
                        {notes(i).slice(0, 3).map(([c, t], n) => <span key={n} className={`px-2 py-0.5 rounded-md text-xs ring-1 ring-inset ${chipCls[c]}`}>{t}</span>)}
                        {notes(i).length > 3 && <span className="text-xs text-slate-400">+{notes(i).length - 3} more</span>}
                      </div>
                    </td>
                    <td className="pr-5 text-slate-300 text-right">›</td>
                  </tr>
                )
              })}
              {visible.length === 0 && <tr><td className="p-10 text-center text-slate-500" colSpan={8}>Nothing here. 🎉</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex gap-3 items-center">
        <button className="px-4 py-2.5 rounded-lg border border-slate-200 bg-white text-sm hover:bg-slate-50" onClick={onBack}>Back</button>
        <button disabled={!readyCount || busy} className="px-5 py-2.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800 disabled:opacity-50" onClick={doImport}>
          {busy ? 'Importing…' : `Import ${readyCount} ready item${readyCount === 1 ? '' : 's'}`}
        </button>
        {attentionCount > 0 && <span className="text-sm text-slate-500">{attentionCount} rows will be held back. Click any row to fix it{needYou ? '' : ''}.</span>}
      </div>

      {o !== null && (
        <EditPanel
          i={o} row={rows[o]} errors={results[o].errors} statusBadge={badge(status[o])}
          onEdit={(k, v) => edit(o, k, v)} onKeep={(k) => keepFix(o, k)} onUndo={(k) => undoFix(o, k)}
          onClose={() => setOpenRow(null)} onPrev={() => step(-1)} onNext={() => step(1)}
          onSkip={() => { remove(o); setOpenRow(null) }}
          dup={og && (og.identical ? 'This row is identical to another row.' : og.existing ? `SKU ${og.sku} already exists in the system.` : `SKU ${og.sku} is also used by row ${og.idx.filter((j) => j !== o).map((j) => j + 1).join(', ')} (${og.idx.filter((j) => j !== o).map((j) => rows[j].name).join(', ')}).`)}
          dupActions={og && (
            <div className="flex gap-2 mt-2">
              {og.identical && o !== og.idx[0]
                ? <button className="px-2.5 py-1 rounded-md bg-white border border-orange-300 text-xs font-medium" onClick={() => { remove(o); setOpenRow(null) }}>Remove this copy</button>
                : <>
                    {!og.existing && <button className="px-2.5 py-1 rounded-md bg-white border border-orange-300 text-xs font-medium" onClick={() => keepSku(og, o)}>Keep SKU for this item</button>}
                    <button className="px-2.5 py-1 rounded-md bg-white border border-orange-300 text-xs font-medium" onClick={() => newSku(o)}>Give this item a new SKU</button>
                  </>}
            </div>
          )}
        />
      )}
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
