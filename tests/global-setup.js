// Runs once before all tests: make sure the test database exists, is migrated, and has the test employees.
import pg from 'pg'
import { TEST_DATABASE_URL } from '../vitest.config.js'

export const EMPLOYEES = [
  { employee_id: 'T100', email: 'test@example.com', name: 'Test Person', password: 'correct horse 1' },
  { employee_id: 'T200', email: 'two@example.com', name: 'Second Person', password: 'other pass 22' },
]

export default async function setup() {
  const url = new URL(TEST_DATABASE_URL)
  const dbName = url.pathname.slice(1)
  // Safety: tests wipe tables. Refuse to run against anything that isn't clearly a test database.
  if (!dbName.endsWith('_test')) throw new Error(`Refusing to run tests against "${dbName}": the database name must end in _test`)

  // Create the test database if it doesn't exist yet.
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: '/postgres' }).toString() })
  await admin.connect()
  const exists = (await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName])).rowCount
  if (!exists) await admin.query(`CREATE DATABASE "${dbName.replace(/"/g, '')}"`)
  await admin.end()

  process.env.DATABASE_URL = TEST_DATABASE_URL // before db.js creates its pool
  const { pool, migrate } = await import('../server/db.js')
  const { hashPassword } = await import('../server/auth.js')
  await migrate()
  await pool.query('TRUNCATE items, item_changes, import_batches, sessions, employees RESTART IDENTITY CASCADE')
  for (const e of EMPLOYEES)
    await pool.query('INSERT INTO employees (employee_id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [e.employee_id, e.email, e.name, await hashPassword(e.password)])
  await pool.end()
}
