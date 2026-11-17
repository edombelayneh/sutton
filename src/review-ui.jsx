// Human-friendly presentation for the Review step: labels, formatting, the edit panel.
// Data is still stored as the raw CSV strings (dimensions/vendors as JSON); nothing here shows JSON.
import { createPortal } from 'react-dom'
import { FIELDS } from '../shared/schema.js'

export const CAT_LABEL = { RAW: 'Raw material', COMP: 'Component', FG: 'Finished good', PKG: 'Packaging', CONS: 'Consumable' }
export const UOM_LABEL = { EA: 'Each', BX: 'Box', KG: 'Kilogram', M: 'Meter', L: 'Liter' }
export const FIELD_LABEL = Object.fromEntries(FIELDS.map((f) => [f.key, f.label.replace(' (JSON)', '')]))
FIELD_LABEL.dimensions = 'Size'
FIELD_LABEL.vendors = 'Vendors'

export const tryJson = (s) => { try { return { ok: true, v: JSON.parse(s) } } catch { return { ok: false } } }
const num = (s) => (s !== '' && !isNaN(Number(s)) ? Number(s) : null)
export const money = (s) => (num(s) !== null ? `$${Number(s).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })}` : s || '–')
export const count = (s) => (num(s) !== null ? Number(s).toLocaleString() : s || '0')

export function sizeText(s) {
  if (!s?.trim()) return ''
  const r = tryJson(s)
  if (!r.ok || !r.v || typeof r.v !== 'object') return 'size unreadable'
  const d = r.v
  return [d.length, d.width, d.height].map((x) => x ?? '?').join(' × ') + ` ${d.unit || 'cm'}`
}
export function vendorsText(s) {
  if (!s?.trim()) return ''
  const r = tryJson(s)
  if (!r.ok || !Array.isArray(r.v)) return 'vendor list unreadable'
  const pref = r.v.find((v) => v.is_preferred)
  return `${r.v.length} vendor${r.v.length === 1 ? '' : 's'}${pref ? ` · ★ ${pref.vendor_name}` : ''}`
}

/** Best-effort recovery of vendor names from broken JSON, so the user doesn't retype everything. */
function recoverVendors(s) {
  const out = []
  const re = /\{[^{}]*?"vendor_name"\s*:\s*"([^"]*)"[^{}]*?(?:"unit_cost"\s*:\s*([\d.]+))?/g
  let m
  while ((m = re.exec(s))) out.push({ vendor_name: m[1], unit_cost: m[2] ? Number(m[2]) : '' })
  return out
}

const inputCls = (tone) =>
  `w-full rounded-lg border px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-indigo-300 ${tone}`

function FixNote({ fix, onKeep, onUndo }) {
  const c = fix.ai ? 'bg-violet-50 text-violet-900 border-violet-200' : fix.warn ? 'bg-amber-50 text-amber-900 border-amber-200' : 'bg-emerald-50 text-emerald-900 border-emerald-200'
  return (
    <div className={`mt-1.5 flex items-start gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${c}`}>
      <div className="flex-1">
        <b>{fix.ai ? 'AI suggestion' : fix.warn ? 'Please check' : 'Auto-fixed'}</b>: {fix.why}
        {fix.from && <span className="opacity-70"> (was “{fix.from.length > 40 ? fix.from.slice(0, 40) + '…' : fix.from}”)</span>}
      </div>
      <button className="font-medium hover:underline" onClick={onKeep}>Keep</button>
      <button className="hover:underline opacity-70" onClick={onUndo}>Undo</button>
    </div>
  )
}

function Field({ k, row, err, onEdit, onKeep, onUndo, children, hideFixFrom }) {
  const fix = row._fixes?.[k]
  const active = fix && !fix.confirmed && row[k] === fix.to
  const tone = err ? 'border-red-300 bg-red-50/40' : active ? (fix.ai ? 'border-violet-300' : fix.warn ? 'border-amber-300' : 'border-emerald-300') : 'border-slate-200'
  return (
    <label className="block">
      <span className="text-xs font-medium text-slate-500">{FIELD_LABEL[k]}{FIELDS.find((f) => f.key === k)?.required ? ' *' : ''}</span>
      <div className="mt-1">{children ? children(tone) : <input className={inputCls(tone)} value={row[k]} onChange={(e) => onEdit(k, e.target.value)} />}</div>
      {err && <p className="mt-1 text-xs text-red-600">{err}</p>}
      {active && <FixNote fix={hideFixFrom ? { ...fix, from: '' } : fix} onKeep={() => onKeep(k)} onUndo={() => onUndo(k)} />}
    </label>
  )
}

function Select({ value, options, onChange, tone }) {
  const known = options.some(([v]) => v === value)
  return (
    <select className={inputCls(tone)} value={value} onChange={(e) => onChange(e.target.value)}>
      {!known && <option value={value}>{value ? `“${value}” (not valid)` : 'Choose…'}</option>}
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  )
}

function SizeEditor({ value, onChange, tone }) {
  const r = value?.trim() ? tryJson(value) : { ok: true, v: {} }
  const d = r.ok && r.v && typeof r.v === 'object' ? r.v : {}
  const set = (patch) => {
    const next = { ...d, ...patch }
    const out = {}
    for (const k of ['length', 'width', 'height']) if (next[k] !== '' && next[k] !== undefined) out[k] = num(String(next[k])) ?? next[k]
    if (Object.keys(out).length === 0) return onChange('')
    out.unit = next.unit || 'cm'
    onChange(JSON.stringify(out))
  }
  return (
    <div>
      {!r.ok && <p className="text-xs text-amber-700 mb-1">We couldn't read the saved size. Please re-enter it.</p>}
      <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr_84px] items-center gap-2">
        {['length', 'width', 'height'].map((k, i) => [
          i > 0 && <span key={k + 'x'} className="text-slate-400">×</span>,
          <input key={k} aria-label={k} placeholder={k[0].toUpperCase() + k.slice(1)} className={inputCls(tone) + ' min-w-0'} value={d[k] ?? ''} onChange={(e) => set({ [k]: e.target.value })} />,
        ])}
        <select className={inputCls(tone)} value={d.unit || 'cm'} onChange={(e) => set({ unit: e.target.value })}>
          <option value="cm">cm</option><option value="in">in</option>
        </select>
      </div>
    </div>
  )
}

function VendorEditor({ value, onChange }) {
  const r = value?.trim() ? tryJson(value) : { ok: true, v: [] }
  const broken = !r.ok || !Array.isArray(r.v)
  const list = broken ? recoverVendors(value) : r.v
  const write = (next) => onChange(next.length ? JSON.stringify(next.map((v) => {
    const o = { vendor_name: v.vendor_name ?? '' }
    if (v.vendor_sku) o.vendor_sku = v.vendor_sku
    o.unit_cost = num(String(v.unit_cost ?? '')) ?? v.unit_cost ?? ''
    if (v.lead_time_days !== '' && v.lead_time_days !== undefined) o.lead_time_days = num(String(v.lead_time_days)) ?? v.lead_time_days
    if (v.is_preferred) o.is_preferred = true
    return o
  })) : '')
  const upd = (i, patch) => write(list.map((v, j) => (j === i ? { ...v, ...patch } : v)))
  return (
    <div className="space-y-2">
      {broken && <p className="text-xs text-amber-700">The vendor list in your file was cut off. We recovered what we could; please check it.</p>}
      {list.length > 0 && (
        <div className="grid grid-cols-[1fr_90px_80px_70px_28px_20px] gap-1.5 text-[11px] text-slate-400 px-0.5">
          <span>Vendor</span><span>Vendor SKU</span><span>Cost ($)</span><span>Lead days</span><span title="Preferred">★</span><span />
        </div>
      )}
      {list.map((v, i) => (
        <div key={i} className="grid grid-cols-[1fr_90px_80px_70px_28px_20px] gap-1.5 items-center">
          <input className={inputCls('border-slate-200')} value={v.vendor_name ?? ''} onChange={(e) => upd(i, { vendor_name: e.target.value })} />
          <input className={inputCls('border-slate-200')} value={v.vendor_sku ?? ''} onChange={(e) => upd(i, { vendor_sku: e.target.value })} />
          <input className={inputCls('border-slate-200')} value={v.unit_cost ?? ''} onChange={(e) => upd(i, { unit_cost: e.target.value })} />
          <input className={inputCls('border-slate-200')} value={v.lead_time_days ?? ''} onChange={(e) => upd(i, { lead_time_days: e.target.value })} />
          <button title="Make preferred (only one allowed)" className={`text-lg ${v.is_preferred ? 'text-amber-500' : 'text-slate-300 hover:text-slate-500'}`}
            onClick={(e) => { e.preventDefault(); write(list.map((x, j) => ({ ...x, is_preferred: j === i ? !v.is_preferred : false }))) }}>★</button>
          <button title="Remove vendor" className="text-slate-400 hover:text-red-600" onClick={(e) => { e.preventDefault(); write(list.filter((_, j) => j !== i)) }}>✕</button>
        </div>
      ))}
      {list.length < 3 && (
        <button className="text-sm text-indigo-600 hover:underline" onClick={(e) => { e.preventDefault(); write([...list, { vendor_name: '', unit_cost: '' }]) }}>+ Add vendor</button>
      )}
    </div>
  )
}

const bool = [['true', 'Yes'], ['false', 'No']]

export function EditPanel({ i, row, errors, statusBadge, dup, onEdit, onKeep, onUndo, onClose, onPrev, onNext, onSkip, dupActions }) {
  const F = (k, children, extra = {}) => (
    <Field k={k} row={row} err={errors[k]} onEdit={onEdit} onKeep={onKeep} onUndo={onUndo} {...extra}>{children}</Field>
  )
  return createPortal(
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-label={`Edit row ${i + 1}`}>
      <div className="absolute inset-0 bg-slate-900/20 backdrop-blur-[1px]" onClick={onClose} />
      <aside className="relative w-full max-w-xl h-full bg-white shadow-2xl flex flex-col animate-slide">
        <header className="px-6 py-4 border-b border-slate-100 flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-xs text-slate-400">Row {i + 1}</div>
            <div className="font-semibold truncate">{row.name || 'Unnamed item'}</div>
          </div>
          {statusBadge}
          <div className="flex gap-1">
            <button className="w-8 h-8 rounded-lg border border-slate-200 hover:bg-slate-50" title="Previous row needing attention" onClick={onPrev}>↑</button>
            <button className="w-8 h-8 rounded-lg border border-slate-200 hover:bg-slate-50" title="Next row needing attention" onClick={onNext}>↓</button>
            <button className="w-8 h-8 rounded-lg hover:bg-slate-100" title="Close" onClick={onClose}>✕</button>
          </div>
        </header>
        <div className="flex-1 overflow-auto px-6 py-5 space-y-6">
          {dup && <div className="rounded-xl border border-orange-200 bg-orange-50 p-3 text-sm text-orange-900">{dup}{dupActions}</div>}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Basics</h3>
            <div className="grid grid-cols-2 gap-3">
              {F('sku')}
              {F('name')}
              {F('category', (t) => <Select tone={t} value={row.category} options={Object.entries(CAT_LABEL)} onChange={(v) => onEdit('category', v)} />)}
              {F('uom', (t) => <Select tone={t} value={row.uom} options={Object.entries(UOM_LABEL)} onChange={(v) => onEdit('uom', v)} />)}
            </div>
            {F('description', (t) => <textarea rows={2} className={inputCls(t)} value={row.description} onChange={(e) => onEdit('description', e.target.value)} />)}
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Stock & cost</h3>
            <div className="grid grid-cols-3 gap-3">
              {F('unit_cost')}
              {F('quantity_on_hand')}
              {F('reorder_point')}
              {F('is_active', (t) => <Select tone={t} value={row.is_active} options={[['', 'Yes (default)'], ...bool]} onChange={(v) => onEdit('is_active', v)} />)}
              {F('lot_tracked', (t) => <Select tone={t} value={row.lot_tracked} options={[['', 'No (default)'], ...bool]} onChange={(v) => onEdit('lot_tracked', v)} />)}
              {F('tags')}
            </div>
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Dates</h3>
            <div className="grid grid-cols-2 gap-3">
              {F('first_received_on', (t) => <input type="text" placeholder="YYYY-MM-DD" className={inputCls(t)} value={row.first_received_on} onChange={(e) => onEdit('first_received_on', e.target.value)} />)}
              {F('discontinued_on', (t) => <input type="text" placeholder="YYYY-MM-DD" className={inputCls(t)} value={row.discontinued_on} onChange={(e) => onEdit('discontinued_on', e.target.value)} />)}
            </div>
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Size</h3>
            {F('dimensions', (t) => <SizeEditor tone={t} value={row.dimensions} onChange={(v) => onEdit('dimensions', v)} />, { hideFixFrom: true })}
          </section>
          <section className="space-y-3">
            <h3 className="text-sm font-semibold">Vendors <span className="font-normal text-slate-400">(up to 3, one preferred)</span></h3>
            {F('vendors', () => <VendorEditor value={row.vendors} onChange={(v) => onEdit('vendors', v)} />, { hideFixFrom: true })}
          </section>
        </div>
        <footer className="px-6 py-3 border-t border-slate-100 flex items-center">
          <button className="text-sm text-slate-500 hover:text-red-600" onClick={onSkip}>Skip this row</button>
          <button className="ml-auto px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium" onClick={onNext}>Next issue →</button>
        </footer>
      </aside>
    </div>,
    document.body,
  )
}
