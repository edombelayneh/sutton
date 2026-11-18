// Sign-in, sessions, lockout, and every route being locked without a session.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { startServer, call, signedIn, pool, T100, T200 } from '../helpers.js'

let server, base
const login = (l, p) => call(base, 'POST', '/auth/login', { body: { login: l, password: p } })
const cookieOf = (r) => r.setCookie?.split(';')[0]

beforeAll(async () => { server = await startServer(); base = server.base })
afterAll(async () => {
  await pool.query('UPDATE employees SET active = true') // leave the test employees usable
  await server.close(); await pool.end()
})

describe('locked without a session', () => {
  it.each([
    ['GET', '/items'], ['POST', '/import'], ['DELETE', '/items'], ['PUT', '/items/AAAA-111'], ['DELETE', '/items/AAAA-111'],
    ['GET', '/batches'], ['POST', '/batches/x/restore'], ['POST', '/import/x/undo'], ['POST', '/ai/suggest'], ['POST', '/ai/map'],
  ])('%s %s -> 401', async (m, u) => {
    expect((await call(base, m, u)).status).toBe(401)
  })
  it('health stays public; /auth/me says not signed in', async () => {
    expect((await call(base, 'GET', '/health')).status).toBe(200)
    expect((await call(base, 'GET', '/auth/me')).status).toBe(401)
  })
})

describe('sign in', () => {
  it('works with the employee ID or the email, any case, and never returns the hash', async () => {
    const byId = await login(T100.employee_id.toLowerCase(), T100.password)
    expect(byId.status).toBe(200)
    expect(byId.data).toEqual({ id: expect.any(Number), employee_id: 'T100', email: T100.email, name: T100.name })
    expect((await login(T100.email.toUpperCase(), T100.password)).status).toBe(200)
  })

  it('sets an HttpOnly, SameSite=Lax cookie that unlocks the API', async () => {
    const r = await login(T100.employee_id, T100.password)
    expect(r.setCookie).toMatch(/HttpOnly/)
    expect(r.setCookie).toMatch(/SameSite=Lax/)
    const cookie = cookieOf(r)
    expect((await call(base, 'GET', '/auth/me', { cookie })).data.employee_id).toBe('T100')
    expect((await call(base, 'GET', '/items', { cookie })).status).toBe(200)
  })

  it('gives the same message for a wrong password and an unknown account', async () => {
    const wrong = await login(T100.employee_id, 'nope nope nope')
    const unknown = await login('ghost@example.com', 'whatever123')
    expect(wrong.status).toBe(401)
    expect(unknown.status).toBe(401)
    expect(wrong.data.error).toBe(unknown.data.error)
    expect((await login(T100.employee_id, '')).setCookie).toBeNull()
  })

  it('rejects a forged token', async () => {
    expect((await call(base, 'GET', '/items', { cookie: 'sutton_session=forged' })).status).toBe(401)
  })

  it('stores only a SHA-256 of the session token', async () => {
    const token = decodeURIComponent(cookieOf(await login(T100.employee_id, T100.password)).split('=')[1])
    const { rows } = await pool.query('SELECT token_hash FROM sessions')
    expect(rows.every((r) => /^[0-9a-f]{64}$/.test(r.token_hash) && r.token_hash !== token)).toBe(true)
  })
})

describe('sessions end', () => {
  it('logout clears the cookie and kills the session server-side', async () => {
    const api = await signedIn(base)
    const out = await call(base, 'POST', '/auth/logout', { cookie: api.cookie })
    expect(out.setCookie).toMatch(/Max-Age=0/)
    expect((await call(base, 'GET', '/items', { cookie: api.cookie })).status).toBe(401)
  })

  it('an expired session is refused', async () => {
    const api = await signedIn(base)
    await pool.query("UPDATE sessions SET expires_at = now() - interval '1 minute'")
    expect((await api('GET', '/items')).status).toBe(401)
  })

  it('deactivating an employee signs them out and blocks sign-in; reactivating allows it again', async () => {
    const api = await signedIn(base)
    await pool.query("UPDATE employees SET active = false WHERE employee_id = 'T100'")
    expect((await api('GET', '/items')).status).toBe(401)
    expect((await login(T100.employee_id, T100.password)).status).toBe(401)
    await pool.query("UPDATE employees SET active = true WHERE employee_id = 'T100'")
    expect((await login(T100.employee_id, T100.password)).status).toBe(200)
  })
})

describe('lockout', () => {
  it('5 failures lock that account (even the right password), other accounts unaffected', async () => {
    for (let i = 0; i < 5; i++) await login(T200.employee_id, 'bad password ' + i)
    const locked = await login(T200.employee_id, T200.password)
    expect(locked.status).toBe(429)
    expect((await login(T100.employee_id, T100.password)).status).toBe(200)
  })
})
