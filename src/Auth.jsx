import { useEffect, useState } from 'react'

// If any API call comes back 401 (session expired or signed out elsewhere), go back to the sign-in screen.
const realFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const res = await realFetch(input, init)
  const url = typeof input === 'string' ? input : input?.url || ''
  if (res.status === 401 && url.startsWith('/api/') && !url.startsWith('/api/auth/')) window.dispatchEvent(new Event('auth:expired'))
  return res
}

/** Shows the sign-in screen until someone is signed in, then renders children(employee, signOut). */
export function AuthGate({ children }) {
  const [me, setMe] = useState(undefined) // undefined = checking, null = signed out
  const [expired, setExpired] = useState(false)
  useEffect(() => {
    fetch('/api/auth/me').then((r) => (r.ok ? r.json() : null)).then(setMe).catch(() => setMe(null))
    const onExpired = () => { setMe((cur) => { if (cur) setExpired(true); return null }) }
    window.addEventListener('auth:expired', onExpired)
    return () => window.removeEventListener('auth:expired', onExpired)
  }, [])
  const signOut = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {})
    setExpired(false); setMe(null)
  }
  if (me === undefined) return <div className="min-h-screen grid place-items-center text-sm text-slate-500">Loading…</div>
  if (!me) return <SignIn expired={expired} onSignedIn={(e) => { setExpired(false); setMe(e) }} />
  return children(me, signOut)
}

function SignIn({ expired, onSignedIn }) {
  const [login, setLogin] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true); setError('')
    try {
      const r = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: login.trim(), password }),
      })
      const data = await r.json().catch(() => ({}))
      if (!r.ok) { setError(data.error || 'Sign-in failed'); setPassword(''); return }
      onSignedIn(data)
    } catch {
      setError("Can't reach the server. Is it running?")
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="min-h-screen grid place-items-center px-6">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-2xl border border-slate-200 shadow-sm p-8 space-y-5 animate-rise">
        <div className="flex items-center gap-2.5">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 2 3 7v10l9 5 9-5V7l-9-5Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
            <path d="m3 7 9 5 9-5M12 12v10" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" opacity=".55" />
          </svg>
          <span className="font-medium tracking-tight">Sutton<span className="text-slate-500"> / Import</span></span>
        </div>
        <div>
          <h1 className="text-2xl font-medium tracking-tight">Sign in</h1>
          <p className="text-sm text-slate-500 mt-1">Use your work email or employee ID.</p>
        </div>
        {expired && !error && <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-sm text-amber-900">Your session ended. Please sign in again.</div>}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Email or employee ID</span>
          <input autoFocus required autoComplete="username" value={login} onChange={(e) => setLogin(e.target.value)} placeholder="you@company.com or E1001"
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400" />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Password</span>
          <input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-slate-300 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-violet-400" />
        </label>
        {error && <div role="alert" className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm text-red-800">{error}</div>}
        <button disabled={busy} className="w-full px-5 py-2.5 rounded-full bg-slate-950 text-white font-medium hover:bg-slate-800 transition-colors disabled:opacity-50">
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="text-xs text-slate-500">No account? Ask an admin to add you.</p>
      </form>
    </div>
  )
}
