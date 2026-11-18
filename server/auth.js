// Sign-in: scrypt password hashes, random session tokens in an httpOnly cookie, sessions stored hashed.
import crypto from 'node:crypto'
import { promisify } from 'node:util'
import { pool } from './db.js'

const scrypt = promisify(crypto.scrypt)
const KEYLEN = 64
const SESSION_HOURS = 12
export const COOKIE = 'sutton_session'

// ---- Passwords: "scrypt$<salt hex>$<hash hex>" ----
export async function hashPassword(password) {
  const salt = crypto.randomBytes(16)
  const hash = await scrypt(password, salt, KEYLEN)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}
export async function verifyPassword(password, stored) {
  const [algo, saltHex, hashHex] = String(stored).split('$')
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false
  const hash = await scrypt(password, Buffer.from(saltHex, 'hex'), KEYLEN)
  return crypto.timingSafeEqual(hash, Buffer.from(hashHex, 'hex'))
}
export const passwordProblem = (p) =>
  typeof p !== 'string' || p.length < 8 ? 'Password must be at least 8 characters'
    : p.length > 200 ? 'Password is too long' : null

// A real hash to compare against when the account doesn't exist, so a wrong ID takes as long as a wrong password.
const DUMMY = hashPassword(crypto.randomBytes(16).toString('hex'))

// ---- Failed-login throttle, per 15 minutes: 5 failures per account, 100 overall ----
// (Not per IP: behind the Vite proxy every request comes from 127.0.0.1, so one person's typos would lock out everyone.)
const WINDOW_MS = 15 * 60 * 1000
const limitFor = (key) => (key === 'all' ? 100 : 5)
const fails = new Map() // key -> [timestamps]
const recent = (key) => (fails.get(key) || []).filter((t) => Date.now() - t < WINDOW_MS)
export const isThrottled = (keys) => keys.some((k) => recent(k).length >= limitFor(k))
export const noteFailure = (keys) => { for (const k of keys) fails.set(k, [...recent(k), Date.now()]) }
export const clearFailures = (keys) => { for (const k of keys) if (k !== 'all') fails.delete(k) }

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex')

/** Find an active employee by email or employee ID (either, case-insensitive) and check the password. */
export async function checkLogin(login, password) {
  const { rows } = await pool.query(
    'SELECT * FROM employees WHERE active AND (lower(email) = lower($1) OR lower(employee_id) = lower($1))', [login])
  const emp = rows[0]
  const ok = await verifyPassword(password, emp ? emp.password_hash : await DUMMY)
  return ok && emp ? emp : null
}

export async function createSession(employeeId) {
  const token = crypto.randomBytes(32).toString('base64url')
  await pool.query("INSERT INTO sessions (token_hash, employee_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))",
    [sha256(token), employeeId, SESSION_HOURS])
  await pool.query('DELETE FROM sessions WHERE expires_at < now()') // tidy up old ones
  return token
}
export const endSession = (token) => token && pool.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)])

export function readCookie(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === COOKIE) return decodeURIComponent(v.join('='))
  }
  return null
}
// httpOnly: page scripts can't read it. SameSite=Lax: other sites can't send it with a POST.
export const sessionCookie = (token) =>
  `${COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 3600}`
export const clearedCookie = () => `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`

/** The signed-in employee for this request, or null. */
export async function currentEmployee(req) {
  const token = readCookie(req)
  if (!token) return null
  const { rows } = await pool.query(
    `SELECT e.id, e.employee_id, e.email, e.name FROM sessions s JOIN employees e ON e.id = s.employee_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND e.active`, [sha256(token)])
  return rows[0] || null
}

export const publicEmployee = (e) => ({ id: e.id, employee_id: e.employee_id, email: e.email, name: e.name })
