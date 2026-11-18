// The `npm run employee` script that admins use to manage accounts.
import { describe, it, expect, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pool } from '../../server/db.js'
import { verifyPassword } from '../../server/auth.js'

const run = async (args, password) => {
  try {
    const { stdout } = await promisify(execFile)('node', ['server/employees.js', ...args], {
      env: { ...process.env, ...(password !== undefined && { EMPLOYEE_PASSWORD: password }) },
    })
    return { code: 0, out: stdout }
  } catch (e) {
    return { code: e.code, out: e.stdout + e.stderr }
  }
}

afterAll(async () => {
  await pool.query("DELETE FROM employees WHERE employee_id LIKE 'CLI%'")
  await pool.end()
})

describe('npm run employee', () => {
  it('adds an employee with a scrypt-hashed password', async () => {
    const r = await run(['add', '--id', 'CLI1', '--name', 'Cli Person', '--email', 'cli1@example.com'], 'long enough 1')
    expect(r.code).toBe(0)
    const { rows } = await pool.query("SELECT * FROM employees WHERE employee_id = 'CLI1'")
    expect(rows[0].password_hash).toMatch(/^scrypt\$/)
    expect(await verifyPassword('long enough 1', rows[0].password_hash)).toBe(true)
  })

  it.each([
    ['a short password', ['add', '--id', 'CLI2', '--name', 'X', '--email', 'cli2@example.com'], 'short', /at least 8/],
    ['a duplicate ID', ['add', '--id', 'cli1', '--name', 'X', '--email', 'other@example.com'], 'long enough 1', /already exists/],
    ['a duplicate email', ['add', '--id', 'CLI3', '--name', 'X', '--email', 'CLI1@example.com'], 'long enough 1', /already exists/],
    ['a bad ID', ['add', '--id', 'bad id', '--name', 'X', '--email', 'x@example.com'], 'long enough 1', /Employee ID/],
    ['a bad email', ['add', '--id', 'CLI4', '--name', 'X', '--email', 'nope'], 'long enough 1', /email/],
  ])('refuses %s', async (_label, args, pw, msg) => {
    const r = await run(args, pw)
    expect(r.code).not.toBe(0)
    expect(r.out).toMatch(msg)
  })

  it('password change and deactivate sign the person out everywhere', async () => {
    const { rows: [e] } = await pool.query("SELECT id FROM employees WHERE employee_id = 'CLI1'")
    await pool.query("INSERT INTO sessions (token_hash, employee_id, expires_at) VALUES ('x1', $1, now() + interval '1 hour')", [e.id])
    expect((await run(['password', 'CLI1'], 'brand new pw 2')).code).toBe(0)
    expect((await pool.query('SELECT 1 FROM sessions WHERE employee_id = $1', [e.id])).rowCount).toBe(0)

    await pool.query("INSERT INTO sessions (token_hash, employee_id, expires_at) VALUES ('x2', $1, now() + interval '1 hour')", [e.id])
    expect((await run(['deactivate', 'cli1@example.com'])).code).toBe(0)
    expect((await pool.query('SELECT active FROM employees WHERE id = $1', [e.id])).rows[0].active).toBe(false)
    expect((await pool.query('SELECT 1 FROM sessions WHERE employee_id = $1', [e.id])).rowCount).toBe(0)
  })

  it('list shows employees and marks deactivated ones', async () => {
    const r = await run(['list'])
    expect(r.out).toMatch(/CLI1.*\(deactivated\)/)
    expect(r.out).toMatch(/T100/)
  })
})
