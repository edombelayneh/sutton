// Shared helpers for API tests: start the real app on a random port, sign in, call the API, load samples.
import { once } from 'node:events'
import { app } from '../server/index.js'
import { pool } from '../server/db.js'
import { EMPLOYEES } from './global-setup.js'
export { loadSample, parsedSample } from './samples.js'

export { pool, EMPLOYEES }
export const [T100, T200] = EMPLOYEES

/** Start the app on a free port. Returns { base, close }. */
export async function startServer() {
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  return { base: `http://127.0.0.1:${server.address().port}/api`, close: () => new Promise((r) => server.close(r)) }
}

/** Empty the item tables. Employees and sessions stay, so signed-in test clients keep working. */
export const resetData = () => pool.query('TRUNCATE items, item_changes, import_batches')

/** Raw request. Returns { status, data, setCookie }. */
export async function call(base, method, url, { body, cookie } = {}) {
  const r = await fetch(base + url, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) }, body: body && JSON.stringify(body),
  })
  return { status: r.status, data: await r.json().catch(() => null), setCookie: r.headers.get('set-cookie') }
}

/** Sign in and return a function api(method, url, body) that sends the session cookie. */
export async function signedIn(base, { employee_id, password } = T100) {
  const r = await call(base, 'POST', '/auth/login', { body: { login: employee_id, password } })
  if (r.status !== 200) throw new Error(`Sign-in as ${employee_id} failed: ${r.status} ${JSON.stringify(r.data)}`)
  const cookie = r.setCookie.split(';')[0]
  const api = async (method, url, body) => { const res = await call(base, method, url, { body, cookie }); return res }
  api.cookie = cookie
  return api
}
