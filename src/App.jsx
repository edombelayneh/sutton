import { useEffect, useMemo, useRef, useState } from 'react'
import Papa from 'papaparse'
import * as XLSX from 'xlsx'
import { FIELDS, FIELD_KEYS, applyMapping, validateRows, parseRow, combineFiles, autoMapColumns, canMapColumn, mergeColumns, mergeByField } from '../shared/schema.js'
import { autoFixRow, generateSku } from '../shared/autofix.js'
import { createPortal } from 'react-dom'
import { EditPanel, CAT_LABEL, FIELD_LABEL, money, count, sizeText, vendorsText } from './review-ui.jsx'

// Rows carry their auto-fix log in `_fixes`; strip it before sending/exporting.
const clean = ({ _fixes, _file, _update, ...r }) => r

// Read a CSV or Excel file as CSV text (Excel: first sheet).
const fileToText = async (f) => {
  if (/\.(xlsx|xls)$/i.test(f.name)) {
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' })
    return XLSX.utils.sheet_to_csv(wb.Sheets[wb.SheetNames[0]])
  }
  return f.text()
}

const STEPS = ['Upload', 'Map columns', 'Review & fix', 'Results']

export default function App() {
  const [step, setStep] = useState(0)
  const [fileName, setFileName] = useState('')
  const [columns, setColumns] = useState([]) // [{ name, files, variants }]
  const [csvRows, setCsvRows] = useState([])
  const [mapping, setMapping] = useState({})
  const [rows, setRows] = useState([]) // raw strings per field, editable
  const [existingSkus, setExistingSkus] = useState(new Set())
  const [result, setResult] = useState(null)
  const [aiMap, setAiMap] = useState({ busy: false, notes: {}, msg: '' })

  const refreshExisting = () =>
    fetch('/api/items').then((r) => r.json()).then((items) => setExistingSkus(new Set(items.map((i) => i.sku))))
  useEffect(() => { refreshExisting() }, [])

  const loadText = (text, name) => loadFiles([{ text, name }])
  // One or more files become one combined batch; each row remembers its source file.
  const loadId = useRef(0) // ignore AI replies for an upload the user has already replaced
  const loadFiles = (files) => {
    const id = ++loadId.current
    // 1. Headers that look alike across files ("SKU", "SKU ", "sku") become one column.
    const combined = combineFiles(files.map(({ text, name }) => {
      const p = Papa.parse(text, { header: true, skipEmptyLines: 'greedy' })
      return { name, fields: p.meta.fields, data: p.data }
    }))
    // 2. Different names that our aliases place on the same field ("SKU" in one file, "Item Code" in another) merge too.
    const { columns: cols, rows: all, mapping: auto } = mergeByField(combined.columns, combined.rows, autoMapColumns(combined.columns))
    const hs = cols.map((c) => c.name)
    setFileName(files.length > 1 ? `${files.length} files` : files[0].name)
    setColumns(cols)
    setCsvRows(all)
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
        unmapped: unmapped.map((h) => ({ header: h, files: cols.find((c) => c.name === h).files, samples: all.map((r) => r[h]).filter(Boolean).slice(0, 3) })),
        // 3. With several files, AI also checks whether a leftover column is the same data as another file's column.
        others: cols.map((c) => c.name).filter((h) => !unmapped.includes(h))
          .map((h) => ({ header: h, files: cols.find((c) => c.name === h).files, samples: all.map((r) => r[h]).filter(Boolean).slice(0, 3) })),
        // A field only counts as taken if every file already has it mapped (file B can still use SKU when only file A has it).
        used: FIELD_KEYS.filter((k) => [...new Set(cols.flatMap((c) => c.files))].every((f) => cols.some((c) => auto[c.name] === k && c.files.includes(f)))),
      }),
    })
      .then(async (r) => {
        const data = await r.json()
        if (id !== loadId.current) return
        if (!r.ok) throw new Error(data.error)
        const notes = {}
        for (const m of data.mappings) notes[m.header] = m
        // AI field picks first, then merge: columns AI says are the same, and columns now on the same field.
        const next = { ...auto }
        for (const m of data.mappings) if (m.field && !next[m.header] && canMapColumn(next, cols, m.header, m.field)) next[m.header] = m.field
        const pairs = data.mappings.filter((m) => m.same_as).map((m) => ({ keep: m.same_as, drop: m.header, by: 'ai', why: m.why }))
        const viaAi = mergeColumns(cols, all, next, pairs)
        const final = mergeByField(viaAi.columns, viaAi.rows, viaAi.mapping)
        // Same-field merges of AI-mapped columns count as AI merges.
        for (const c of final.columns) for (const g of c.merged || []) if (g.by === 'match' && notes[g.name]?.field) { g.by = 'ai'; g.why = notes[g.name].why }
        setColumns(final.columns)
        setCsvRows(final.rows)
        setMapping(final.mapping)
        setAiMap({ busy: false, notes, msg: '' })
      })
      .catch((e) => id === loadId.current && setAiMap({ busy: false, notes: {}, msg: /AI is off/.test(e.message) ? 'off' : e.message }))
  }

  const confirmMapping = () => {
    setRows(csvRows.map((r) => {
      const { row, fixes } = autoFixRow(applyMapping(r, mapping))
      return { ...row, _fixes: fixes, _file: r.__file }
    }))
    setStep(2)
  }

  const [showItems, setShowItems] = useState(false)
  // Go back to an earlier step. Leaving Map/Review throws away in-progress edits, so ask first.
  const goTo = (i) => {
    if (i >= step || step === 3 && i !== 0) return
    if ((step === 1 || step === 2) && !window.confirm('Leave this import? Your changes to this file will be lost.')) return
    if (i === 0) reset()
    else setStep(i)
  }

  const reset = () => { setStep(0); setResult(null); setRows([]); refreshExisting() }

  return (
    <div className="min-h-screen text-slate-900">
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur border-b border-slate-200 text-slate-900">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center gap-8">
          <button className="flex items-center gap-2.5 shrink-0" onClick={() => goTo(0)} title="Back to upload">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
              <path d="m3 7 9 5 9-5M12 12v10" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" opacity=".55" />
            </svg>
            <span className="font-medium tracking-tight">Sutton<span className="text-slate-500"> / Import</span></span>
          </button>
          <ol className="hidden md:flex items-center gap-1 text-sm ml-auto">
            {STEPS.map((s, i) => (
              <li key={s} className="flex items-center gap-1">
                {i > 0 && <span className={`w-6 h-px ${i <= step ? 'bg-slate-400' : 'bg-slate-200'}`} />}
                <button disabled={!(i < step && (step !== 3 || i === 0))} onClick={() => goTo(i)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors ${i === step ? 'bg-slate-900 text-white' : i < step ? 'text-slate-600 enabled:hover:bg-slate-100' : 'text-slate-400'}`}>
                  <span className="font-mono text-[11px]">{i < step ? '✓' : String(i + 1).padStart(2, '0')}</span>{s}
                </button>
              </li>
            ))}
          </ol>
          <button onClick={() => setShowItems(true)} className="shrink-0 px-3 py-1.5 rounded-full text-sm border border-slate-200 hover:bg-slate-50 md:ml-2">Imported items <span className="text-slate-400 tabular-nums">{existingSkus.size}</span></button>
          <span className="md:hidden ml-auto label text-slate-500">{String(step + 1).padStart(2, '0')} / {String(STEPS.length).padStart(2, '0')}</span>
        </div>
        <div className="h-0.5 bg-slate-100"><div className="h-full bg-gradient-to-r from-sky-400 via-violet-400 to-emerald-400 seg" style={{ width: `${((step + 1) / STEPS.length) * 100}%` }} /></div>
      </header>
      <main key={step} className="max-w-6xl mx-auto px-6 py-8 animate-rise">
        {step === 0 && <Upload onText={loadText} onFiles={loadFiles} existingCount={existingSkus.size} onViewItems={() => setShowItems(true)} />}
        {step === 1 && (
          <MapColumns aiMap={aiMap} fileName={fileName} columns={columns} rows={csvRows} mapping={mapping}
            setMapping={setMapping} onBack={() => setStep(0)} onNext={confirmMapping} />
        )}
        {step === 2 && (
          <Review rows={rows} setRows={setRows} existingSkus={existingSkus} onBack={() => setStep(1)}
            onImported={(res, sent) => { setResult({ ...res, sent }); setStep(3); refreshExisting() }} />
        )}
        {step === 3 && result && <Results result={result} onRestart={reset} onViewItems={() => setShowItems(true)} />}
      </main>
      {showItems && <ImportedItems onClose={() => setShowItems(false)} onChanged={refreshExisting}
        onImportAnother={() => { if (step === 1 || step === 2) { if (!window.confirm('Leave this import? Your changes to this file will be lost.')) return } setShowItems(false); reset() }} />}
    </div>
  )
}

// Decorative 3D spreadsheet: messy (red) cells flip to clean (green) one by one, then reset.
const SHEET = [
  ['fxbu-khm', 'FXBU-KHM'], ['$23.98', '23.98'], ['yes', 'true'], ['Jan 7, 24', '2024-01-07'],
  ['ea', 'EA'], ['1,200', '1200'], ['0,26', '0.26'], [' Oak Cart ', 'Oak Cart'],
  ['TRUE', 'true'], ['Raw Mat.', 'RAW'], ['METAL', 'metal'], ['$14.31', '14.31'],
]
function SpinningSheet() {
  const [done, setDone] = useState(0)
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setDone(SHEET.length); return }
    const t = setInterval(() => setDone((n) => (n >= SHEET.length + 3 ? 0 : n + 1)), 650)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="sheet-stage w-[260px] select-none" aria-hidden>
      <div className="sheet rounded-xl bg-white shadow-[0_30px_60px_-20px_rgba(15,23,42,.35)] border border-slate-200 overflow-hidden">
        <div className="bg-emerald-600 text-white px-3 py-1.5 flex items-center gap-2 text-[11px] font-medium">
          <span className="w-3.5 h-3.5 rounded-sm bg-white text-emerald-700 grid place-items-center text-[9px] font-bold">X</span>
          inventory.xlsx
          <span className="ml-auto opacity-80 tabular-nums">{Math.min(done, SHEET.length)}/{SHEET.length} fixed</span>
        </div>
        <div className="grid grid-cols-[18px_repeat(3,1fr)] text-[10px] font-mono">
          <span className="bg-slate-50 border-b border-r border-slate-200" />
          {['A', 'B', 'C'].map((c) => <span key={c} className="bg-slate-50 border-b border-r border-slate-200 text-center text-slate-400 py-0.5">{c}</span>)}
          {[0, 1, 2, 3].map((r) => [
            <span key={'r' + r} className="bg-slate-50 border-b border-r border-slate-200 text-center text-slate-400 py-1.5">{r + 1}</span>,
            ...[0, 1, 2].map((c) => {
              const n = r * 3 + c
              const ok = n < done
              return (
                <span key={`${n}-${ok}`} className={`cell-flip border-b border-r border-slate-200 px-1.5 py-1.5 truncate ${ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-600'}`}>
                  {ok ? '✓ ' + SHEET[n][1] : SHEET[n][0]}
                </span>
              )
            }),
          ])}
        </div>
      </div>
    </div>
  )
}

function Upload({ onText, onFiles, existingCount, onViewItems }) {
  const [drag, setDrag] = useState(false)
  const readFiles = async (list) => {
    const files = [...(list || [])].filter((f) => /\.(csv|xlsx|xls)$/i.test(f.name))
    if (!files.length) return
    onFiles(await Promise.all(files.map(async (f) => ({ name: f.name, text: await fileToText(f) }))))
  }
  const loadSample = (name) => fetch(`/samples/${name}`).then((r) => r.text()).then((t) => onText(t, name))
  const DEMO = [
    ['SKU', 'fxbu-khm', 'FXBU-KHM', 'emerald'],
    ['Unit cost', '$23.98', '23.98', 'emerald'],
    ['Received', 'Jan 7, 2024', '2024-01-07', 'emerald'],
    ['Category', 'Raw Material', 'Raw material', 'emerald'],
    ['Active', 'yes', 'Yes', 'emerald'],
    ['Tags', 'Metal;metal; METAL', 'metal', 'emerald'],
    ['Cost', 'TBD', '$84.44 · from preferred vendor', 'violet'],
    ['SKU', 'KLFP-AX4 ×2', 'Oak Tool Cart → OAKT-92H', 'orange'],
  ]
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
    const t = setInterval(() => setTick((n) => n + 1), 2200)
    return () => clearInterval(t)
  }, [])
  const [label, from, to, tone] = DEMO[tick % DEMO.length]
  const WORDS = ['mess.', 'typos.', 'duplicates.', '$ signs.', 'dates.', 'Excel quirks.']
  const word = WORDS[tick % WORDS.length]
  const FRAGS = ['$23.98', 'yes', 'ea', 'Jan 7, 2024', '1,200', 'fxbu-khm', '0,26', 'TRUE', 'Raw Material', ' Oak Cart ', 'TBD', 'METAL']
  const [stat, setStat] = useState(0)
  useEffect(() => { let n = 0; const t = setInterval(() => { n += 1; setStat(n); if (n >= 30) clearInterval(t) }, 30); return () => clearInterval(t) }, [])
  const S = (target) => Math.round((target * Math.min(stat, 30)) / 30)
  const onMove = (e) => {
    const el = e.currentTarget, r = el.getBoundingClientRect()
    el.style.setProperty('--px', ((e.clientX - r.left) / r.width * 2 - 1).toFixed(3))
    el.style.setProperty('--py', ((e.clientY - r.top) / r.height * 2 - 1).toFixed(3))
  }
  const toneCls = { emerald: 'text-emerald-600', violet: 'text-violet-600', orange: 'text-orange-600' }[tone]
  const toneTag = { emerald: 'Auto-fixed', violet: 'AI suggestion', orange: 'Duplicate resolved' }[tone]
  return (
    <div className="relative landing" onMouseMove={onMove} onMouseLeave={(e) => { e.currentTarget.style.setProperty('--px', 0); e.currentTarget.style.setProperty('--py', 0) }}>
      <div aria-hidden className="absolute -inset-x-40 -top-24 h-[680px] -z-10 overflow-hidden">
        <div className="px absolute inset-0" style={{ '--d': '-40px' }}><div className="aurora w-[520px] h-[520px] bg-violet-300 left-[8%] top-0" /></div>
        <div className="px absolute inset-0" style={{ '--d': '30px' }}><div className="aurora w-[460px] h-[460px] bg-emerald-200 right-[6%] top-24" style={{ animationDelay: '-5s' }} /></div>
        <div className="px absolute inset-0" style={{ '--d': '-20px' }}><div className="aurora w-[380px] h-[380px] bg-sky-200 left-[40%] top-56" style={{ animationDelay: '-9s' }} /></div>
        {FRAGS.map((f, n) => (
          <span key={f} className="frag font-mono text-xs px-2 py-1 rounded-md bg-white/70 backdrop-blur border border-red-200 text-red-500/80 shadow-sm"
            style={{ left: `${(n * 83) % 100}%`, '--t': `${12 + (n % 5) * 2}s`, '--delay': `${-n * 1.7}s`, '--r': `${(n % 2 ? 1 : -1) * (4 + n % 6)}deg` }}>{f}</span>
        ))}
      </div>
    <div className="grid lg:grid-cols-[1fr_1.1fr] gap-12 items-center min-h-[calc(100vh-10rem)] stagger">
      <div className="space-y-6">
        <span className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/70 backdrop-blur border border-slate-200 text-xs text-slate-600">
          <i className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />Bulk import · CSV &amp; Excel
        </span>
        <h1 className="text-5xl md:text-6xl font-semibold tracking-[-0.04em] leading-[0.98]">
          Bring the spreadsheet.<br />
          <span className="bg-gradient-to-r from-violet-600 via-sky-500 to-emerald-500 bg-clip-text text-transparent">We'll handle the </span>
          <span key={word} className="word bg-gradient-to-r from-sky-500 to-emerald-500 bg-clip-text text-transparent">{word}</span>
        </h1>
        <p className="text-lg text-slate-600 max-w-md leading-relaxed">
          Drop in your inventory files as they are. We map the columns, fix what's safe, and you approve the rest. You'll know exactly what got in.
        </p>
        <div className="flex gap-6 text-sm">
          {[[200, 'rows checked'], [34, 'auto-fixes'], [6, 'duplicates caught'], [0, 'surprises']].map(([n, l]) => (
            <div key={l}><div className="text-2xl font-semibold tabular-nums tracking-tight">{S(n)}</div><div className="text-slate-500 text-xs">{l}</div></div>
          ))}
        </div>
        <div className="px rounded-2xl bg-white/80 backdrop-blur border border-slate-200 shadow-[0_20px_40px_-24px_rgba(15,23,42,.25)] p-5 max-w-md" style={{ '--d': '8px' }} aria-live="polite">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">Live preview</span>
            <span className={`text-xs font-medium ${toneCls}`} key={'t' + tick}>{toneTag}</span>
          </div>
          <div key={tick} className="swap grid grid-cols-[90px_1fr] gap-x-4 gap-y-1.5 items-baseline">
            <span className="text-xs text-slate-400">{label}</span>
            <span className="font-mono text-sm text-slate-400 line-through decoration-red-400/70">{from}</span>
            <span />
            <span className={`font-mono text-sm font-medium ${toneCls}`}>→ {to}</span>
          </div>
          <div className="flex gap-1 mt-4">
            {DEMO.map((_, n) => (
              <button key={n} aria-label={`Show example ${n + 1}`} onClick={() => setTick(n)}
                className={`h-1 flex-1 rounded-full transition-colors ${n === tick % DEMO.length ? 'bg-slate-900' : 'bg-slate-200 hover:bg-slate-300'}`} />
            ))}
          </div>
        </div>
      </div>
      <div className="space-y-4 relative">
        <div className="px hidden xl:block absolute -top-24 -right-16 z-10 hover:z-20" style={{ '--d': '-22px' }}>
          <SpinningSheet />
        </div>
        <label
          onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`); e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`) }}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); readFiles(e.dataTransfer.files) }}
          className={`tilt dropzone-ring relative overflow-hidden ${drag ? 'is-drag scale-[1.01]' : ''} group block rounded-3xl px-10 py-20 text-center cursor-pointer shadow-[0_1px_2px_rgba(15,23,42,.04),0_24px_48px_-24px_rgba(15,23,42,.18)] transition-transform duration-300 focus-within:ring-2 focus-within:ring-violet-400`}
        >
          <div aria-hidden className="spot absolute inset-0 pointer-events-none" />
          <input type="file" multiple accept=".csv,.xlsx,.xls,text/csv" className="sr-only" onChange={(e) => readFiles(e.target.files)} />
          <div className="mx-auto mb-6 w-14 h-14 rounded-2xl bg-slate-950 text-white grid place-items-center transition-transform duration-300 group-hover:-translate-y-1">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 16V4m0 0-4.5 4.5M12 4l4.5 4.5M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <p className="text-xl font-medium tracking-tight">{drag ? 'Drop them.' : 'Drop your inventory files here'}</p>
          <p className="text-slate-500 mt-1.5">or <span className="text-slate-900 underline underline-offset-4 decoration-slate-300">browse your computer</span></p>
          <p className="text-xs text-slate-400 mt-3">CSV or Excel · several files at once are reviewed together</p>
        </label>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-slate-500 mr-1">No file handy?</span>
          <button className="px-3 py-1.5 rounded-full border border-slate-200 bg-white hover:border-slate-400 transition-colors" onClick={() => loadSample('items_clean.csv')}>Clean sample</button>
          <button className="px-3 py-1.5 rounded-full border border-slate-200 bg-white hover:border-slate-400 transition-colors" onClick={() => loadSample('items_messy.csv')}>Messy sample</button>
          <button onClick={onViewItems} className="ml-auto text-sm text-slate-600 hover:text-slate-900 underline underline-offset-4 decoration-slate-300">View {existingCount} imported items →</button>
        </div>
      </div>
    </div>
    </div>
  )
}

function MapColumns({ aiMap, fileName, columns, rows, mapping, setMapping, onBack, onNext }) {
  const used = Object.values(mapping).filter(Boolean)
  const multi = new Set(columns.flatMap((c) => c.files)).size > 1
  const example = (h) => rows.find((r) => r[h] != null && String(r[h]).trim() !== '')?.[h] ?? ''
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
          {columns.map(({ name: h, files, variants, merged = [] }) => (
            <tr key={h} className="border-t">
              <td className="p-3">
                <div className="font-mono">{h}</div>
                {multi && <div className="text-xs text-slate-500 mt-1">In {files.length === 1 ? files[0] : `${files.length} files: ${files.join(', ')}`}</div>}
                {variants.length > 1 && <div className="text-xs text-slate-500">Named {variants.map((v) => `"${v}"`).join(', ')}</div>}
                {merged.map((g) => (
                  <div key={g.name} className={`text-xs mt-0.5 ${g.by === 'ai' ? 'text-violet-700' : 'text-emerald-700'}`}>
                    {g.by === 'ai' ? '🤖 AI merged' : '✓ Merged'} "{g.name}" ({g.files.join(', ')}){g.why ? `: ${g.why}` : ''}
                  </div>
                ))}
              </td>
              <td className="p-3 text-slate-500 truncate max-w-xs">{String(example(h)).slice(0, 60)}</td>
              <td className="p-3">
                <select disabled={aiMap.busy} className="border border-slate-300 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-violet-400 disabled:opacity-50" value={mapping[h] ?? ''}
                  onChange={(e) => setMapping({ ...mapping, [h]: e.target.value || null })}>
                  <option value="">— Don't import —</option>
                  {FIELDS.map((f) => (
                    <option key={f.key} value={f.key} disabled={mapping[h] !== f.key && !canMapColumn(mapping, columns, h, f.key)}>
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
  const results = useMemo(() => {
    const updating = new Set(rows.filter((r) => r._update).map((r) => r.sku.trim()))
    return validateRows(rows, new Set([...existingSkus].filter((k) => !updating.has(k))))
  }, [rows, existingSkus])

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
      .filter(([sku, idx]) => idx.length > 1 || (existingSkus.has(sku) && !idx.every((i) => rows[i]._update)))
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
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: aiTargets.slice(0, 200) }), // server also caps at 200
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
      setAi({ busy: false, msg: `AI suggested ${data.suggestions.length} fixes. They're marked 🤖 for you to Keep or Undo.${aiTargets.length > 200 ? ` It looked at the first 200 rows; ask again for the rest.` : ''}${data.failedBatches ? ` (${data.failedBatches} batch(es) failed; try again.)` : ''}` })
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
  const markUpdate = (i) => { setRows(rows.map((r, j) => (j === i ? { ...r, _update: true } : r))); touch(i) }
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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rows: readyRows.map(clean), updates: readyRows.filter((r) => r._update).map((r) => r.sku.trim()), files: [...new Set(rows.map((r) => r._file).filter(Boolean))] }),
    }).then((r) => r.json())
    const skipped = rows.map((r, i) => ({ r, i })).filter(({ i }) => !status[i].ready)
      .map(({ r, i }) => ({
        row: clean(r), line: i + 1,
        errors: status[i].errs ? results[i].errors : { _: 'Auto-fix not confirmed (ambiguous value)' },
      }))
    setBusy(false)
    onImported(res, { skipped })
  }

  const multiFile = new Set(rows.map((r) => r._file)).size > 1
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
    if (row._update) out.push(['sky', 'Will update the existing item'])
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
    violet: 'bg-violet-50 text-violet-700 ring-violet-200', sky: 'bg-sky-50 text-sky-700 ring-sky-200', amber: 'bg-amber-50 text-amber-800 ring-amber-200', emerald: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
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
          <p className="text-xs text-violet-700">{ai.msg || 'AI suggestions are off (add GROQ_API_KEY to .env). You can still fix rows by hand.'}</p>
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
                const sub = [multiFile && r._file, sizeText(r.dimensions), vendorsText(r.vendors)].filter(Boolean).join(' · ')
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
                    {og.existing && og.idx.length === 1 && <button className="px-2.5 py-1 rounded-md bg-orange-600 text-white text-xs font-medium" onClick={() => markUpdate(o)}>Update the existing item</button>}
                    <button className="px-2.5 py-1 rounded-md bg-white border border-orange-300 text-xs font-medium" onClick={() => newSku(o)}>Give this item a new SKU</button>
                  </>}
            </div>
          )}
        />
      )}
    </div>
  )
}

function ImportedItems({ onClose, onChanged, onImportAnother }) {
  const [items, setItems] = useState(null)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(null)
  const [editing, setEditing] = useState(null) // raw-string row being edited
  const [serverErr, setServerErr] = useState({})
  const [tab, setTab] = useState('items')
  const reload = () => fetch('/api/items').then((r) => r.json()).then(setItems).catch(() => setItems([]))
  useEffect(() => { reload() }, [])

  // Turn a stored item back into the raw-string row the edit panel understands.
  const toRaw = (it) => ({
    sku: it.sku, name: it.name ?? '', description: it.description ?? '', category: it.category ?? '', uom: it.uom ?? '',
    unit_cost: it.unit_cost != null ? String(it.unit_cost) : '', quantity_on_hand: it.quantity_on_hand != null ? String(it.quantity_on_hand) : '',
    reorder_point: it.reorder_point != null ? String(it.reorder_point) : '', is_active: it.is_active === false ? 'false' : 'true',
    lot_tracked: it.lot_tracked ? 'true' : 'false', tags: (it.tags || []).join(';'),
    first_received_on: it.first_received_on ?? '', discontinued_on: it.discontinued_on ?? '',
    dimensions: it.dimensions ? JSON.stringify(it.dimensions) : '', vendors: it.vendors?.length ? JSON.stringify(it.vendors) : '',
  })
  const clearAll = async () => {
    if (!window.confirm(`Delete ALL ${items.length} imported items from the system? This can't be undone, and the upload history is cleared too.`)) return
    await fetch('/api/items', { method: 'DELETE' })
    setSel(null); reload(); onChanged?.()
  }
  const del = async (it) => {
    if (!window.confirm(`Delete ${it.sku} (${it.name}) from the system? This can't be undone.`)) return
    await fetch(`/api/items/${encodeURIComponent(it.sku)}`, { method: 'DELETE' })
    setSel(null); reload(); onChanged?.()
  }
  const saveEdit = async () => {
    const res = await fetch(`/api/items/${encodeURIComponent(sel.sku)}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ row: editing }),
    })
    const data = await res.json()
    if (!res.ok) return setServerErr(data.errors || { name: data.error })
    setEditing(null); setServerErr({}); setSel(data); reload(); onChanged?.()
  }
  const editErrors = editing ? { ...parseRow(editing).errors, ...serverErr } : {}
  const list = (items || []).slice().reverse()
    .filter((it) => !q || `${it.sku} ${it.name}`.toLowerCase().includes(q.toLowerCase()))
  const dims = (d) => (d ? `${d.length} × ${d.width} × ${d.height} ${d.unit || 'cm'}` : '')
  const vend = (v) => (v?.length ? `${v.length} vendor${v.length > 1 ? 's' : ''}${v.find((x) => x.is_preferred) ? ` · ★ ${v.find((x) => x.is_preferred).vendor_name}` : ''}` : '')
  return createPortal(
    <div className="fixed inset-0 z-50 bg-slate-50 flex flex-col animate-rise" role="dialog" aria-label="Imported items">
      <header className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-4 flex-wrap">
          <button className="px-3 py-2 rounded-lg text-sm text-slate-600 hover:bg-slate-100" onClick={onClose}>← Back</button>
          <div>
            <div className="text-xl font-semibold tracking-tight">Imported items</div>
            <div className="text-xs text-slate-500">{items ? `${items.length} items in the system · click any item to view, edit or delete` : 'Loading…'}</div>
          </div>
          <div className="flex rounded-lg bg-slate-100 p-1 text-sm" role="tablist">
            {[['items', 'Items'], ['history', 'Upload history']].map(([k, label]) => (
              <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                className={`px-3 py-1.5 rounded-md transition-colors ${tab === k ? 'bg-white shadow-sm font-medium text-slate-900' : 'text-slate-500 hover:text-slate-900'}`}>{label}</button>
            ))}
          </div>
          {tab === 'items' && <input autoFocus placeholder="Search SKU or name…" value={q} onChange={(e) => setQ(e.target.value)}
            className="ml-auto w-72 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-300" />}
          {tab === 'items' && items?.length > 0 && <button className="px-3 py-2 rounded-lg border border-red-200 text-red-600 text-sm hover:bg-red-50" onClick={clearAll}>Clear all</button>}
          <button className={`${tab === 'history' ? 'ml-auto ' : ''}px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800`} onClick={onImportAnother}>Import another file</button>
        </div>
      </header>
      {tab === 'history' ? <UploadHistory onRestored={() => { setSel(null); reload(); onChanged?.() }} /> : (
      <div className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto px-6 py-6">
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white text-left text-xs text-slate-400 border-b border-slate-100">
              <tr><th className="py-3 pl-6 pr-3 font-medium">SKU</th><th className="px-3 font-medium">Item</th><th className="px-3 font-medium">Category</th>
                <th className="px-3 font-medium text-right">Cost</th><th className="px-3 font-medium text-right">In stock</th><th className="px-3 pr-6 font-medium">Imported</th></tr>
            </thead>
            <tbody>
              {list.map((it) => (
                <tr key={it.sku} onClick={() => setSel(it)} className={`border-b border-slate-50 cursor-pointer hover:bg-slate-50 ${sel?.sku === it.sku ? 'bg-indigo-50/60' : ''}`}>
                  <td className="py-3 pl-6 pr-3 font-mono text-xs whitespace-nowrap">{it.sku}</td>
                  <td className="px-3 max-w-[280px]">
                    <div className="font-medium truncate">{it.name}{it.is_active === false && <span className="ml-2 text-xs text-slate-400">inactive</span>}</div>
                    <div className="text-xs text-slate-400 truncate">{[dims(it.dimensions), vend(it.vendors), (it.tags || []).join(', ')].filter(Boolean).join(' · ')}</div>
                  </td>
                  <td className="px-3 whitespace-nowrap">{CAT_LABEL[it.category] || it.category}</td>
                  <td className="px-3 text-right tabular-nums">{money(String(it.unit_cost))}</td>
                  <td className="px-3 text-right tabular-nums">{count(String(it.quantity_on_hand ?? 0))}</td>
                  <td className="px-3 pr-6 text-xs text-slate-500 whitespace-nowrap">{it.imported_at ? new Date(it.imported_at).toLocaleString() : '–'}</td>
                </tr>
              ))}
              {items && list.length === 0 && <tr><td colSpan={6} className="p-10 text-center text-slate-500">{q ? 'No items match your search.' : 'Nothing imported yet.'}</td></tr>}
            </tbody>
          </table>
        </div>
        </div>
      </div>
      )}
      {sel && !editing && <ItemDetail item={sel} onClose={() => setSel(null)} onEdit={() => { setServerErr({}); setEditing(toRaw(sel)) }} onDelete={() => del(sel)} />}
      {editing && (
        <EditPanel i={0} title={`Editing ${sel.sku}`} row={editing} errors={editErrors}
          statusBadge={Object.keys(editErrors).length ? <span className="text-xs font-medium text-red-700">{Object.keys(editErrors).length} to fix</span> : <span className="text-xs font-medium text-emerald-700">Looks good</span>}
          onEdit={(k, v) => { setServerErr({}); setEditing({ ...editing, [k]: v }) }} onKeep={() => {}} onUndo={() => {}}
          onClose={() => setEditing(null)}
          footer={
            <footer className="px-6 py-3 border-t border-slate-100 flex items-center gap-2">
              <button className="text-sm text-slate-500 hover:text-slate-900" onClick={() => setEditing(null)}>Cancel</button>
              <button disabled={Object.keys(parseRow(editing).errors).length > 0} onClick={saveEdit}
                className="ml-auto px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium disabled:opacity-40">Save changes</button>
            </footer>
          } />
      )}
    </div>,
    document.body,
  )
}

// Every upload, newest first. "Restore to before this" puts the inventory back exactly as it was
// before that upload: it undoes that upload, every later one, and any edits/deletes made since.
function UploadHistory({ onRestored }) {
  const [list, setList] = useState(null)
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState('')
  const load = () => fetch('/api/batches').then((r) => r.json()).then(setList).catch(() => setList([]))
  useEffect(() => { load() }, [])
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  const restore = async (b) => {
    const also = [b.later_uploads && plural(b.later_uploads, 'later upload'), b.later_edits && plural(b.later_edits, 'edit or delete') + ' made since'].filter(Boolean)
    if (!window.confirm(`Go back to how the inventory was before the upload of ${new Date(b.imported_at).toLocaleString()}?\n\n`
      + `This undoes that upload${also.length ? `, plus ${also.join(' and ')}` : ''}. This can't be undone.`)) return
    setBusy(b.id); setMsg('')
    const r = await fetch(`/api/batches/${encodeURIComponent(b.id)}/restore`, { method: 'POST' })
    const data = await r.json().catch(() => ({}))
    setBusy(null)
    setMsg(r.ok ? `Restored. ${plural(data.uploadsUndone, 'upload')} undone.` : data.error || 'Restore failed')
    load(); if (r.ok) onRestored?.()
  }
  return (
    <div className="flex-1 overflow-auto">
      <div className="max-w-6xl mx-auto px-6 py-6 space-y-3">
        <p className="text-sm text-slate-600">Every upload, newest first. <b>Restore to before this</b> puts the inventory back exactly as it was before that upload.</p>
        {msg && <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2 text-sm text-emerald-900">{msg}</div>}
        <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-slate-400 border-b border-slate-100">
              <tr><th className="py-3 pl-6 pr-3 font-medium">Uploaded</th><th className="px-3 font-medium">Files</th><th className="px-3 font-medium">Result</th><th className="px-3 pr-6" /></tr>
            </thead>
            <tbody>
              {(list || []).map((b, i) => (
                <tr key={b.id} className="border-b border-slate-50 align-top">
                  <td className="py-3 pl-6 pr-3 whitespace-nowrap">
                    <div>{new Date(b.imported_at).toLocaleString()}</div>
                    {i === 0 && <div className="text-xs text-slate-400">Latest</div>}
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-slate-600">{b.files.length ? b.files.join(', ') : '–'}</td>
                  <td className="px-3 py-3 text-xs">
                    <span className="text-emerald-700">{b.added} added</span>
                    {b.updated > 0 && <span className="text-sky-700"> · {b.updated} updated</span>}
                    {b.rejected > 0 && <span className="text-slate-500"> · {b.rejected} not imported</span>}
                  </td>
                  <td className="px-3 pr-6 py-2 text-right">
                    <button disabled={busy !== null} onClick={() => restore(b)} title={
                      b.later_uploads || b.later_edits ? `Also undoes ${[b.later_uploads && plural(b.later_uploads, 'later upload'), b.later_edits && plural(b.later_edits, 'edit or delete')].filter(Boolean).join(' and ')}` : 'Undoes just this upload'}
                      className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 hover:border-red-300 hover:text-red-700 hover:bg-red-50 disabled:opacity-40 whitespace-nowrap">
                      {busy === b.id ? 'Restoring…' : '↶ Restore to before this'}
                    </button>
                  </td>
                </tr>
              ))}
              {list && list.length === 0 && <tr><td colSpan={4} className="p-10 text-center text-slate-500">No uploads yet.</td></tr>}
              {!list && <tr><td colSpan={4} className="p-10 text-center text-slate-500">Loading…</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

const UOM_WORD = { EA: 'Each', BX: 'Box', KG: 'Kilogram', M: 'Meter', L: 'Liter' }

function ItemDetail({ item: it, onClose, onEdit, onDelete }) {
  const Row = ({ label, children }) => (
    <div className="flex py-2 border-b border-slate-50 text-sm">
      <span className="w-40 shrink-0 text-slate-500">{label}</span>
      <span className="flex-1">{children ?? <span className="text-slate-300">–</span>}</span>
    </div>
  )
  const d = it.dimensions
  return (
    <aside className="fixed right-0 top-[77px] bottom-0 w-full max-w-md bg-white shadow-2xl border-l border-slate-200 flex flex-col animate-slide z-10" aria-label={`Item ${it.sku}`}>
      <header className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-mono text-xs text-slate-400">{it.sku}</div>
          <div className="font-semibold truncate">{it.name}</div>
        </div>
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${it.is_active === false ? 'bg-slate-100 text-slate-500' : 'bg-emerald-50 text-emerald-700'}`}>{it.is_active === false ? 'Inactive' : 'Active'}</span>
        <button className="w-8 h-8 rounded-lg hover:bg-slate-100" title="Close" onClick={onClose}>✕</button>
      </header>
      <div className="px-6 py-3 border-b border-slate-100 flex gap-2">
        <button className="px-3 py-1.5 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-800" onClick={onEdit}>Edit item</button>
        <button className="px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-sm hover:bg-red-50" onClick={onDelete}>Delete</button>
      </div>
      <div className="flex-1 overflow-auto px-6 py-4 space-y-6">
        <section>
          <h3 className="text-sm font-semibold mb-1">Basics</h3>
          <Row label="Category">{CAT_LABEL[it.category] || it.category}</Row>
          <Row label="Unit of measure">{UOM_WORD[it.uom] || it.uom}</Row>
          <Row label="Description">{it.description}</Row>
          <Row label="Tags">{it.tags?.length ? <span className="flex flex-wrap gap-1">{it.tags.map((t) => <span key={t} className="px-2 py-0.5 rounded-md bg-slate-100 text-xs">{t}</span>)}</span> : null}</Row>
        </section>
        <section>
          <h3 className="text-sm font-semibold mb-1">Stock & cost</h3>
          <Row label="Unit cost">{money(String(it.unit_cost))}</Row>
          <Row label="Quantity on hand">{count(String(it.quantity_on_hand ?? 0))}</Row>
          <Row label="Reorder point">{it.reorder_point != null ? count(String(it.reorder_point)) : null}</Row>
          <Row label="Lot tracked">{it.lot_tracked ? 'Yes' : 'No'}</Row>
        </section>
        <section>
          <h3 className="text-sm font-semibold mb-1">Dates</h3>
          <Row label="First received">{it.first_received_on}</Row>
          <Row label="Discontinued">{it.discontinued_on}</Row>
          <Row label="Imported">{it.imported_at ? new Date(it.imported_at).toLocaleString() : null}</Row>
        </section>
        <section>
          <h3 className="text-sm font-semibold mb-1">Size</h3>
          <Row label="L × W × H">{d ? `${d.length} × ${d.width} × ${d.height} ${d.unit || 'cm'}` : null}</Row>
        </section>
        <section>
          <h3 className="text-sm font-semibold mb-2">Vendors</h3>
          {it.vendors?.length ? (
            <div className="rounded-xl border border-slate-200 divide-y divide-slate-100">
              {it.vendors.map((v, n) => (
                <div key={n} className="px-3 py-2.5 text-sm flex items-center gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{v.is_preferred && <span className="text-amber-500" title="Preferred">★ </span>}{v.vendor_name}</div>
                    <div className="text-xs text-slate-400">{[v.vendor_sku, v.lead_time_days != null && `${v.lead_time_days} day lead time`].filter(Boolean).join(' · ') || 'No vendor SKU'}</div>
                  </div>
                  <div className="tabular-nums">{money(String(v.unit_cost))}</div>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-slate-300">No vendors</p>}
        </section>
      </div>
    </aside>
  )
}

function Results({ result, onRestart, onViewItems }) {
  const [undone, setUndone] = useState(false)
  const undo = async () => {
    // Undo = restore to before this import, so warn if anything has changed since.
    const me = await fetch('/api/batches').then((r) => r.json()).then((l) => l.find((b) => b.id === result.batch)).catch(() => null)
    const since = [me?.later_uploads && `${me.later_uploads} later upload${me.later_uploads > 1 ? 's' : ''}`, me?.later_edits && `${me.later_edits} edit${me.later_edits > 1 ? 's' : ''}/delete${me.later_edits > 1 ? 's' : ''} made since`].filter(Boolean)
    if (!window.confirm(`Undo this import? ${result.imported.length} items will be removed${result.updated ? ` and ${result.updated} updated items restored` : ''}.${since.length ? `\n\nThis also undoes ${since.join(' and ')}.` : ''}`)) return
    const r = await fetch(`/api/import/${result.batch}/undo`, { method: 'POST' })
    if (r.ok) setUndone(true)
    else window.alert((await r.json().catch(() => ({}))).error || 'Undo failed')
  }
  const skipped = result.sent.skipped
  const downloadSkipped = () => {
    // Neutralize spreadsheet formulas (=, +, -, @) so opening the file in Excel can't run anything.
    const safe = (v) => (typeof v === 'string' && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v)
    const csv = Papa.unparse(skipped.map((s) => Object.fromEntries(Object.entries({ ...s.row, _errors: Object.entries(s.errors).map(([k, v]) => `${k}: ${v}`).join(' | ') }).map(([k, v]) => [k, safe(v)]))))
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = 'not_imported.csv'
    a.click()
  }
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <span className="label text-slate-500">Import complete</span>
        <h2 className="text-4xl md:text-5xl font-medium tracking-[-0.03em]">{undone ? 'Import undone.' : `${result.imported.length} items are in.`}</h2>
        {!undone && result.updated > 0 && <p className="text-sky-700">{result.updated} of them updated existing items.</p>}
        {undone ? <p className="text-slate-600">Everything from this import was removed{result.updated ? ' and the items it changed were restored' : ''}.</p>
          : result.batch && result.imported.length > 0 && <button className="text-sm underline underline-offset-4 text-slate-600 hover:text-red-600" onClick={undo}>Undo this import</button>}
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
      <div className="flex flex-wrap gap-3">
        <button className="px-5 py-2.5 rounded-full bg-slate-950 text-white font-medium hover:bg-slate-800 transition-colors shadow-sm" onClick={onRestart}>Import another file</button>
        <button className="px-5 py-2.5 rounded-full border border-slate-300 bg-white font-medium hover:border-slate-500 transition-colors" onClick={onViewItems}>View imported items</button>
      </div>
    </div>
  )
}
