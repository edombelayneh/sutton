// One-time setup: `npm run setup`. Safe to run again: it never deletes data or changes existing accounts.
// 1. Creates the database (from DATABASE_URL, default postgres://localhost/sutton) if it doesn't exist.
// 2. Creates/updates the tables (migrations/*.sql).
// 3. Adds a demo account so you can sign in right away.
import 'dotenv/config'
import { pool, migrate, ensureDatabase, DATABASE_URL } from './db.js'
import { hashPassword } from './auth.js'

export const DEMO = { employee_id: 'DEMO', email: 'demo@example.com', name: 'Demo Admin', password: 'try-sutton-123' }
const dbName = new URL(DATABASE_URL).pathname.slice(1)

try {
  const created = await ensureDatabase()
  console.log(created ? `✓ Created database "${dbName}"` : `✓ Database "${dbName}" exists`)
  await migrate()
  console.log('✓ Tables are up to date')
  const { rowCount } = await pool.query('SELECT 1 FROM employees WHERE lower(employee_id) = lower($1) OR lower(email) = lower($2)', [DEMO.employee_id, DEMO.email])
  if (!rowCount) {
    await pool.query('INSERT INTO employees (employee_id, email, name, password_hash) VALUES ($1, $2, $3, $4)',
      [DEMO.employee_id, DEMO.email, DEMO.name, await hashPassword(DEMO.password)])
    console.log('✓ Added the demo account')
  } else {
    console.log('✓ Demo account already exists (left unchanged)')
  }
  console.log(`
Done. Start the app with:  npm run dev

Sign in with:   ${DEMO.employee_id}  (or ${DEMO.email})
Password:       ${DEMO.password}   (unless you changed it)

Add real people with:  npm run employee -- add --id E1001 --name "Your Name" --email you@company.com
`)
} catch (e) {
  process.exitCode = 1
  if (e.code === 'ECONNREFUSED' || e.code === 'ENOENT') {
    console.error(`
✗ Can't reach PostgreSQL at ${DATABASE_URL.replace(/:[^:@/]*@/, ':***@')}.

  macOS (Homebrew):   brew install postgresql@18 && brew services start postgresql@18
  Docker:             docker run -d --name sutton-pg -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:18
                      then put DATABASE_URL=postgres://postgres@localhost/sutton in .env

Then run  npm run setup  again.
`)
  } else if (e.code === '28000' || e.code === '3D000' || e.code === '28P01') {
    console.error(`\n✗ PostgreSQL refused the connection (${e.message}).\n  Check DATABASE_URL in .env (user, password, database name).\n`)
  } else {
    console.error(`\n✗ Setup failed: ${e.message}\n`)
  }
} finally {
  await pool.end()
}
